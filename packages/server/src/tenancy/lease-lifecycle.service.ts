import { Inject, Injectable } from '@nestjs/common';
import { and, eq, schema, sql, withCompany, type Database, type Tx } from '@rent/db';
import { compareDates, parseBusinessDate } from '@rent/domain/dates';
import { DomainError } from '@rent/domain/errors';
import type { Actor } from '@rent/domain/policy';
import {
  holdingOverSchedule,
  leaseTrackers,
  rentSchedule,
  scheduledTransition,
  type ChargePeriod,
  type LeaseStatus,
  type LeaseUse,
} from '@rent/domain/tenancy';
import { AuditService } from '../audit/audit.service';
import { staffActor } from '../companies/companies.service';
import type { Clock } from '../core/clock';
import { conflict, invalid } from '../core/errors';
import { enqueueOutbox } from '../core/outbox';
import { CLOCK, DATABASE } from '../core/tokens';
import { EsignService } from '../esign/esign.service';
import { PolicyService, staffContext } from '../policy/policy.service';
import { RulesService, type ResolvedRule } from '../rules/rules.service';
import {
  assertNoOverlap,
  companyFacts,
  dateIn,
  leaseRow,
  leaseWriteError,
  termsOf,
  todayIn,
  type LeaseRow,
} from './lease-records';

/** The event other modules (and the e-signing phase's copies to parties) react to. */
export const LEASE_SIGNED_EVENT = 'lease.signed';
export const LEASE_ENDED_EVENT = 'lease.ended';

export interface MarkSignedInput {
  readonly leaseId: string;
  /** The server time of the last required signature, or the paper signing day. */
  readonly signedAt: Date;
  /** `esign` from pending signatures (TL-07); `paper` from a draft (decision 7). */
  readonly source: 'esign' | 'paper';
  /** The final signed PDF, or for paper the scan. Required for paper. */
  readonly signedDocumentId?: string | null;
}

export interface TrackerRuleSet {
  readonly rentControl: ResolvedRule | null;
  readonly stampDuty: ResolvedRule | null;
  readonly writingExemption: ResolvedRule | null;
}

/**
 * The lease lifecycle (M3 plan 4.6, 4.7, 4.10 and 4.11): signing, the schedule, the daily
 * transitions, holding over, ending and move-out. Occupancy follows by database trigger, and
 * every status change is checked there against the lease machine.
 */
@Injectable()
export class LeaseLifecycleService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(RulesService) private readonly rules: RulesService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(EsignService) private readonly esign: EsignService,
  ) {}

  /**
   * Marks a lease signed, in the caller's transaction: the one place a lease becomes signed.
   * Paper leases call it now; the e-signing phase calls it when a signing request completes.
   *
   * - checks the lease is in the state the source expects and overlaps no lease holding the unit;
   * - records the trackers' deadlines from the rules in force on the signing date (TX-05, OQ-45,
   *   OQ-44), with the rule versions used;
   * - generates the rent schedule (TL-06), audits `lease.signed` and emits it through the outbox;
   * - starts the lease at once if its start date has come (and holds it over if its end has
   *   passed), so a paper lease for an existing tenancy is active straight away.
   */
  async markSigned(tx: Tx, input: MarkSignedInput): Promise<void> {
    const row = await leaseRow(tx, input.leaseId, { lock: true });
    const expected: LeaseStatus = input.source === 'paper' ? 'draft' : 'pending_signatures';
    if (row.status !== expected)
      throw conflict(
        'lease_not_signable',
        `Only a lease that is ${expected.replace('_', ' ')} can be signed this way`,
      );
    if (input.source === 'paper' && !input.signedDocumentId)
      throw invalid('scan_required', 'Upload the signed lease');
    await assertNoOverlap(tx, row);
    const company = await companyFacts(tx, row.companyId);
    const signedOn = dateIn(input.signedAt, company.timeZone);
    const terms = await termsOf(tx, row);
    const rules = await this.trackerRules(company.countryCode, signedOn);
    const trackers = leaseTrackers(
      {
        signedOn,
        use: row.use as LeaseUse,
        periodCount: terms.periodCount,
        rentControlCommercial: company.settings.rentControlCommercial,
      },
      {
        rentControlDays: valueOf(rules.rentControl, 'days'),
        stampDutyMonths: valueOf(rules.stampDuty, 'months'),
        writingExemptionMaxYears: valueOf(rules.writingExemption, 'years'),
      },
    );
    await this.statusReason(
      tx,
      input.source === 'paper' ? 'Lease signed on paper' : 'Lease signed',
    );
    try {
      await tx
        .update(schema.lease)
        .set({
          status: 'signed',
          signedAt: input.signedAt,
          signingMethod: input.source,
          signedDocumentId: input.signedDocumentId ?? null,
          rentControlApplies: trackers.rentControl.applies,
          rentControlDeadline: trackers.rentControl.deadline,
          rentControlRuleId: trackers.rentControl.applies
            ? (rules.rentControl?.ruleId ?? null)
            : null,
          stampDeadline: trackers.stamping.deadline,
          stampRuleId: rules.stampDuty?.ruleId ?? null,
          formalRequired: trackers.formalLease.required,
          formalRuleId: rules.writingExemption?.ruleId ?? null,
          updatedAt: this.clock.now(),
        })
        .where(eq(schema.lease.id, row.id));
    } catch (error) {
      throw leaseWriteError(error);
    }
    const periods = rentSchedule(terms);
    await this.insertPeriods(tx, row, periods, 'schedule');
    await this.audit.append(tx, {
      companyId: row.companyId,
      action: LEASE_SIGNED_EVENT,
      recordType: 'lease',
      recordId: row.id,
      data: {
        source: input.source,
        signedAt: input.signedAt.toISOString(),
        periods: periods.length,
      },
    });
    await enqueueOutbox(tx, {
      companyId: row.companyId,
      type: LEASE_SIGNED_EVENT,
      payload: { leaseId: row.id, source: input.source },
      idempotencyKey: `${LEASE_SIGNED_EVENT}:${row.id}`,
    });
    await this.advance(tx, row.companyId, todayIn(this.clock, company.timeZone), {
      unitId: row.unitId,
    });
  }

  /**
   * A signing request completed (TL-07). The e-signing module sits below tenancy in the layer
   * map, so it reports completion as an outbox event (signing.completed) and this consumer marks
   * the lease signed. Idempotent: a lease already signed electronically is left alone. When the
   * event names its request, the request's state is checked in the e-signing engine (tenancy
   * cannot read its tables): it must be this lease's, completed, with no newer request out, so a
   * late event never acts on a lease that was re-issued.
   */
  async onSigningCompleted(
    companyId: string,
    input: {
      readonly leaseId: string;
      readonly signingRequestId?: string | null;
      readonly completedAt: Date;
      readonly finalDocumentId: string;
    },
  ): Promise<void> {
    await withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const row = await leaseRow(tx, input.leaseId, { lock: true });
      if (row.signingMethod === 'esign' && row.status !== 'pending_signatures') return;
      if (
        input.signingRequestId &&
        !(await this.eventStillApplies(tx, row.id, input.signingRequestId, 'completed'))
      )
        return;
      await this.markSigned(tx, {
        leaseId: input.leaseId,
        signedAt: input.completedAt,
        source: 'esign',
        signedDocumentId: input.finalDocumentId,
      });
    });
  }

  /**
   * A signer declined (TL-07): the e-signing module closed the request in the transaction that
   * emitted signing.declined, and the lease goes back to draft, once. A late event for a request
   * that has since been replaced is ignored.
   */
  async onSigningDeclined(
    companyId: string,
    input: { readonly leaseId: string; readonly signingRequestId?: string | null },
  ): Promise<void> {
    await withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const row = await leaseRow(tx, input.leaseId, { lock: true });
      if (row.status !== 'pending_signatures') return;
      if (
        input.signingRequestId &&
        !(await this.eventStillApplies(tx, row.id, input.signingRequestId, 'declined'))
      )
        return;
      await this.returnToDraft(tx, input.leaseId, 'declined');
    });
  }

  /** Whether an e-signing event about `requestId` still speaks for the lease (see above). */
  private async eventStillApplies(
    tx: Tx,
    leaseId: string,
    requestId: string,
    expected: 'completed' | 'declined',
  ): Promise<boolean> {
    const state = await this.esign.requestState(tx, requestId);
    if (!state || state.leaseId !== leaseId || state.status !== expected) return false;
    const open = await this.esign.openRequestFor(tx, leaseId);
    return open === null;
  }

  /**
   * Back to draft after a recall or a decline (plan 4.7), in the caller's transaction. The terms
   * become editable again; the e-signing phase voids the request and its links. Idempotent.
   */
  async returnToDraft(tx: Tx, leaseId: string, reason: 'recalled' | 'declined'): Promise<void> {
    const row = await leaseRow(tx, leaseId, { lock: true });
    if (row.status === 'draft') return;
    if (row.status !== 'pending_signatures')
      throw conflict('lease_not_pending', 'Only a lease waiting for signatures goes back to draft');
    await tx
      .update(schema.lease)
      .set({ status: 'draft', updatedAt: this.clock.now() })
      .where(eq(schema.lease.id, leaseId));
    await this.audit.append(tx, {
      companyId: row.companyId,
      action: `lease.${reason}`,
      recordType: 'lease',
      recordId: leaseId,
      data: {},
    });
  }

  /** The `tenancy.lease-transitions` job for one company (daily at 00:05; plan 4.17). */
  async runTransitions(companyId: string, today?: string): Promise<number> {
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const company = await companyFacts(tx, companyId);
      return this.advance(tx, companyId, today ?? todayIn(this.clock, company.timeZone));
    });
  }

  /**
   * Moves leases on as the days pass (plan 4.7): signed leases start, leases whose renewal has
   * started end, others hold over past their end date, and held-over leases gain a month of
   * schedule at a time at the last rate (OQ-12). Idempotent: run twice, it changes nothing more.
   */
  async advance(
    tx: Tx,
    companyId: string,
    today: string,
    filter: { readonly unitId?: string } = {},
  ): Promise<number> {
    let changes = 0;
    const unit = filter.unitId ? sql`and l.unit_id = ${filter.unitId}` : sql``;
    // 1. Signed leases whose start date has come (renewals first, so the old lease can end).
    const starting = await tx.execute<{ id: string; start_date: string }>(
      sql`select l.id, l.start_date from lease l
          where l.company_id = ${companyId} and l.status = 'signed' and l.start_date <= ${today}::date ${unit}
          order by l.start_date`,
    );
    for (const lease of starting.rows) {
      await this.statusReason(tx, 'Lease started');
      await tx
        .update(schema.lease)
        .set({ status: 'active', activatedOn: lease.start_date, updatedAt: this.clock.now() })
        .where(and(eq(schema.lease.id, lease.id), eq(schema.lease.status, 'signed')));
      changes += 1;
    }
    // 2. Leases past their end date: ended by their renewal, or held over.
    const ending = await tx.execute<{
      id: string;
      status: LeaseStatus;
      start_date: string;
      end_date: string;
      renewal_start: string | null;
    }>(
      sql`select l.id, l.status, l.start_date, l.end_date,
            (select r.start_date from lease r where r.company_id = l.company_id and r.renews_lease_id = l.id
               and r.status in ('signed', 'active', 'ending', 'holding_over') limit 1) as renewal_start
          from lease l
          where l.company_id = ${companyId} and l.status in ('active', 'holding_over')
            and l.end_date < ${today}::date ${unit}`,
    );
    for (const lease of ending.rows) {
      const next = scheduledTransition(
        {
          status: lease.status,
          startDate: lease.start_date,
          endDate: lease.end_date,
          renewalStart: lease.renewal_start,
        },
        today,
      );
      if (!next) continue;
      if (next.to === 'holding_over') {
        await this.statusReason(tx, 'Holding over after the end date');
        await tx
          .update(schema.lease)
          .set({
            status: 'holding_over',
            holdingOverSince: next.holdingOverSince,
            updatedAt: this.clock.now(),
          })
          .where(and(eq(schema.lease.id, lease.id), eq(schema.lease.status, 'active')));
      } else if (next.to === 'ended') {
        await this.statusReason(tx, 'Renewed');
        await tx
          .update(schema.lease)
          .set({
            status: 'ended',
            endReason: 'renewed',
            endedOn: next.endedOn,
            updatedAt: this.clock.now(),
          })
          .where(and(eq(schema.lease.id, lease.id), eq(schema.lease.status, lease.status)));
      }
      changes += 1;
    }
    // 3. A month of schedule at a time for tenancies held over (OQ-12), up to today.
    const held = await tx.execute<{ id: string }>(
      sql`select l.id from lease l
          where l.company_id = ${companyId} and l.status in ('holding_over', 'ending')
            and l.end_date < ${today}::date ${unit}`,
    );
    for (const { id } of held.rows) changes += await this.extendHoldingOver(tx, id, today);
    return changes;
  }

  /** Staff record non-renewal or a notice (plan 4.7): the lease is ending. */
  async recordEnding(
    actor: Actor | null,
    leaseId: string,
    input: { readonly reason: 'non_renewal' | 'notice'; readonly note?: string | null },
  ): Promise<void> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'lease.manage');
    await withCompany(this.database, staffContext(staff), async (tx) => {
      const row = await leaseRow(tx, leaseId, { lock: true });
      if (row.status !== 'active' && row.status !== 'holding_over')
        throw conflict('lease_not_current', 'Only an active or held-over lease can be ending');
      await tx
        .update(schema.lease)
        .set({
          status: 'ending',
          endingReason: input.reason,
          endingNote: input.note?.trim().slice(0, 500) || null,
          endingRecordedAt: this.clock.now(),
          updatedAt: this.clock.now(),
        })
        .where(eq(schema.lease.id, leaseId));
    });
  }

  /**
   * Records that the tenant has moved out (the minimal TL-11 hook; the full move-out is M8). The
   * lease ends and the unit is freed. A move-out before the end date stays on the lease, and the
   * schedule rows after it are left for M4a's invoicing and M5's early-termination rules.
   */
  async recordMoveOut(
    actor: Actor | null,
    leaseId: string,
    input: { readonly moveOutDate: string; readonly note?: string | null },
  ): Promise<void> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'lease.manage');
    await withCompany(this.database, staffContext(staff), async (tx) => {
      const row = await leaseRow(tx, leaseId, { lock: true });
      if (!['active', 'holding_over', 'ending'].includes(row.status))
        throw conflict('lease_not_current', 'Only a current lease can record a move-out');
      const company = await companyFacts(tx, row.companyId);
      const date = parseBusinessDate(input.moveOutDate);
      if (
        compareDates(date, parseBusinessDate(row.startDate)) < 0 ||
        compareDates(date, parseBusinessDate(todayIn(this.clock, company.timeZone))) > 0
      )
        throw invalid(
          'move_out_date',
          'The move-out date is between the start of the lease and today',
        );
      await this.statusReason(
        tx,
        input.note?.trim() ? `Moved out: ${input.note.trim()}` : 'Moved out',
      );
      await tx
        .update(schema.lease)
        .set({
          status: 'ended',
          endReason: 'moved_out',
          moveOutDate: input.moveOutDate,
          endedOn: input.moveOutDate,
          updatedAt: this.clock.now(),
        })
        .where(eq(schema.lease.id, leaseId));
      await this.audit.append(tx, {
        companyId: row.companyId,
        action: 'lease.moved_out',
        recordType: 'lease',
        recordId: leaseId,
        data: { moveOutDate: input.moveOutDate },
      });
      await enqueueOutbox(tx, {
        companyId: row.companyId,
        type: LEASE_ENDED_EVENT,
        payload: { leaseId, reason: 'moved_out' },
        idempotencyKey: `${LEASE_ENDED_EVENT}:${leaseId}`,
      });
    });
  }

  /** The three tracker rules in force on a date, each null if the rules table has none. */
  async trackerRules(countryCode: string, asOf: string): Promise<TrackerRuleSet> {
    const date = parseBusinessDate(asOf);
    const find = async (key: string) => {
      try {
        return await this.rules.resolve(countryCode, key, date);
      } catch (error) {
        if (error instanceof DomainError && error.code === 'rule.missing') return null;
        throw error;
      }
    };
    return {
      rentControl: await find('rent_control.registration_days'),
      stampDuty: await find('stamp_duty.deadline_months'),
      writingExemption: await find('lease.writing_exemption_max_years'),
    };
  }

  /** Names the reason the occupancy trigger records for this transaction's status changes. */
  async statusReason(tx: Tx, reason: string): Promise<void> {
    await tx.execute(sql`select set_config('app.status_reason', ${reason.slice(0, 300)}, true)`);
  }

  private async extendHoldingOver(tx: Tx, leaseId: string, today: string): Promise<number> {
    const row = await leaseRow(tx, leaseId);
    const terms = await termsOf(tx, row);
    return this.insertPeriods(tx, row, holdingOverSchedule(terms, today), 'holding_over');
  }

  private async insertPeriods(
    tx: Tx,
    row: LeaseRow,
    periods: readonly ChargePeriod[],
    source: 'schedule' | 'holding_over',
  ): Promise<number> {
    if (periods.length === 0) return 0;
    const inserted = await tx
      .insert(schema.chargePeriod)
      .values(
        periods.map((p) => ({
          companyId: row.companyId,
          propertyId: row.propertyId,
          tenantId: row.tenantId,
          leaseId: row.id,
          sequence: p.sequence,
          chargeType: p.chargeType,
          periodStart: p.periodStart,
          periodEnd: p.periodEnd,
          amountMinor: p.amountMinor,
          prorated: p.prorated,
          source,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: schema.chargePeriod.id });
    return inserted.length;
  }
}

function valueOf(rule: ResolvedRule | null, field: 'days' | 'months' | 'years'): number | null {
  const value = (rule?.value as Record<string, unknown> | null | undefined)?.[field];
  return typeof value === 'number' ? value : null;
}
