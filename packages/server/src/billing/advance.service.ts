import { Inject, Injectable } from '@nestjs/common';
import { and, eq, schema, sql, withCompany, type Database, type Tx } from '@rent/db';
import { daysBetween, formatBusinessDate, parseBusinessDate } from '@rent/domain/dates';
import type { Actor } from '@rent/domain/policy';
import { paidUntilPromptDaysOf, parseCompanySettings } from '@rent/domain/settings';
import type { VerificationStatus } from '@rent/domain/rules';
import { companyRecord, staffActor } from '../companies/companies.service';
import type { Clock } from '../core/clock';
import { queueMessage } from '../core/messages';
import { CLOCK, DATABASE } from '../core/tokens';
import { subscriptionEnded } from '../core/subscription-ended';
import { membersWhoCan } from '../policy/members';
import { PolicyService, staffContext } from '../policy/policy.service';
import { leaseIdsIn } from '../tenancy/billing-facts';
import { BillingEngine } from './engine';
import { isoNow, leaseGroup, lockLeases } from './records';

export interface AdvanceComplianceRow {
  readonly leaseId: string;
  readonly unitCode: string;
  readonly propertyName: string;
  readonly tenantName: string;
  readonly paymentId: string;
  readonly receivedOn: string;
  readonly monthsAhead: number;
  readonly limitMonths: number;
  readonly policy: 'warn' | 'block';
  readonly rule: {
    readonly ruleId: string;
    readonly key: string;
    readonly verificationStatus: VerificationStatus;
  } | null;
  readonly createdAt: Date;
}

export interface PaidUntilEnding {
  readonly leaseId: string;
  readonly unitCode: string;
  readonly propertyName: string;
  readonly tenantName: string;
  readonly endDate: string;
  readonly paidUntil: string;
  readonly daysLeft: number;
  /** When AR-06's prompt went for this paid-until date, if it has. */
  readonly promptedOn: string | null;
}

/** Leases a prompt runs over: signed and not over. */
const CURRENT = ['signed', 'active', 'ending', 'holding_over'] as const;
/** A missed daily run still prompts within this many days of the lead (once per date). */
const CATCH_UP_DAYS = 7;

/**
 * Advance rent and paid-until (AR-05, AR-06; M5 plan 5.5, decisions 4 and 5). The compliance
 * report lists payments flagged over the advance limit under `warn` or `block`, with the rule
 * version and its status; the product never calls an advance compliant. The paid-until prompt
 * (`billing.paid-until-prompt`, daily 08:00) finds leases whose paid-until is the company's lead
 * (90 days) away and, once per lease and paid-until date, puts them in the list, emails whoever
 * manages the lease and messages the tenant where consent is recorded.
 */
@Injectable()
export class AdvanceService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(BillingEngine) private readonly engine: BillingEngine,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** AR-05's compliance report: payments over the limit, flagged under `warn` or `block`. */
  async complianceReport(
    actor: Actor | null,
  ): Promise<{ readonly policy: 'off' | 'warn' | 'block'; readonly rows: AdvanceComplianceRow[] }> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.view');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const company = await companyRecord(tx, staff.companyId);
      const rows = await tx.execute<{
        lease_id: string;
        unit_code: string;
        property_name: string;
        tenant_name: string | null;
        payment_id: string;
        value_date: string;
        months_ahead: number;
        limit_months: number;
        policy: 'warn' | 'block';
        rule_id: string | null;
        rule_key: string | null;
        verification_status: VerificationStatus | null;
        created_at: Date | string;
      }>(
        sql`select a.lease_id, u.code as unit_code, p.name as property_name,
              coalesce(t.legal_name, t.display_name) as tenant_name, a.payment_id, a.value_date::text,
              a.months_ahead, a.limit_months, a.policy, a.rule_id, r.key as rule_key, r.verification_status,
              a.created_at
            from payment_advance a
            join lease l on l.company_id = a.company_id and l.id = a.lease_id
            join unit u on u.company_id = l.company_id and u.id = l.unit_id
            join property p on p.company_id = l.company_id and p.id = l.property_id
            left join tenant t on t.company_id = l.company_id and t.id = l.tenant_id
            left join rule r on r.id = a.rule_id
            where a.flagged
            order by a.value_date desc, a.created_at desc`,
      );
      return {
        policy: parseCompanySettings(company?.settings).advanceRentPolicy,
        rows: rows.rows.map((r) => ({
          leaseId: r.lease_id,
          unitCode: r.unit_code,
          propertyName: r.property_name,
          tenantName: r.tenant_name ?? '',
          paymentId: r.payment_id,
          receivedOn: r.value_date,
          monthsAhead: r.months_ahead,
          limitMonths: r.limit_months,
          policy: r.policy,
          rule:
            r.rule_id && r.rule_key && r.verification_status
              ? { ruleId: r.rule_id, key: r.rule_key, verificationStatus: r.verification_status }
              : null,
          // Raw queries return timestamps as text: the contract wants an ISO instant.
          createdAt: new Date(r.created_at),
        })),
      };
    });
  }

  /** AR-05 on the lease page: months paid ahead now, the limit, and flagged payments. */
  async leaseAdvance(actor: Actor | null, leaseId: string) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.view');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const state = await this.engine.load(tx, staff.companyId, leaseId);
      return { leaseId, ...(await this.engine.advanceStatus(tx, state)) };
    });
  }

  /** AR-05 on the payment page: the months a payment paid ahead, as recorded when it arrived. */
  async paymentAdvance(actor: Actor | null, paymentId: string) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.view');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const rows = await tx.execute<{
        payment_id: string;
        lease_id: string;
        value_date: string;
        months_ahead: number;
        policy: 'off' | 'warn' | 'block';
        limit_months: number | null;
        over_limit: boolean;
        flagged: boolean;
        rule_id: string | null;
        rule_key: string | null;
        verification_status: VerificationStatus | null;
      }>(
        sql`select a.payment_id, a.lease_id, a.value_date::text, a.months_ahead, a.policy, a.limit_months,
              a.over_limit, a.flagged, a.rule_id, r.key as rule_key, r.verification_status
            from payment_advance a left join rule r on r.id = a.rule_id
            where a.payment_id = ${paymentId}`,
      );
      const r = rows.rows[0];
      if (!r) return null;
      return {
        paymentId: r.payment_id,
        leaseId: r.lease_id,
        valueDate: r.value_date,
        monthsAhead: r.months_ahead,
        policy: r.policy,
        limitMonths: r.limit_months,
        overLimit: r.over_limit,
        flagged: r.flagged,
        rule:
          r.rule_id && r.rule_key && r.verification_status
            ? { ruleId: r.rule_id, key: r.rule_key, verificationStatus: r.verification_status }
            : null,
      };
    });
  }

  // AR-06 ---------------------------------------------------------------------------------------

  /** `billing.paid-until-prompt` for one company and day. Returns the prompts sent. */
  async runPaidUntilPrompts(companyId: string, today?: string): Promise<number> {
    // M10 decision 12: no automatic tenant messages once the subscription has ended.
    if (await subscriptionEnded(this.database, companyId)) return 0;
    const ctx = { companyId, actorKind: 'system' as const };
    const { ids, day, lead } = await withCompany(this.database, ctx, async (tx) => {
      const company = await companyRecord(tx, companyId);
      return {
        ids: await leaseIdsIn(tx, CURRENT),
        day: today ?? isoNow(this.clock, company!.timeZone),
        lead: paidUntilPromptDaysOf(parseCompanySettings(company?.settings)),
      };
    });
    let sent = 0;
    for (const leaseId of ids)
      sent += await withCompany(this.database, ctx, async (tx) => {
        await lockLeases(tx, companyId, await leaseGroup(tx, leaseId));
        return this.promptLease(tx, companyId, leaseId, day, lead);
      });
    return sent;
  }

  private async promptLease(
    tx: Tx,
    companyId: string,
    leaseId: string,
    today: string,
    lead: number,
  ): Promise<number> {
    const state = await this.engine.load(tx, companyId, leaseId);
    if (state.book.kind !== 'book') return 0;
    const paidUntil = this.engine.walk(state).paidUntil;
    if (!paidUntil) return 0;
    const days = daysBetween(parseBusinessDate(today), parseBusinessDate(paidUntil));
    if (days > lead || days <= lead - CATCH_UP_DAYS) return 0;
    // Once per lease and paid-until date: under the lease's lock, so the check holds.
    const [done] = await tx
      .select({ id: schema.paidUntilPrompt.id })
      .from(schema.paidUntilPrompt)
      .where(
        and(
          eq(schema.paidUntilPrompt.leaseId, leaseId),
          eq(schema.paidUntilPrompt.paidUntil, paidUntil),
        ),
      );
    if (done) return 0;
    const company = state.company;
    const managers = await membersWhoCan(tx, this.policy, company, 'lease.manage', {
      propertyId: state.lease.propertyId,
      ownerId: state.book.ownerId,
    });
    const until = formatBusinessDate(paidUntil);
    for (const personId of managers)
      await queueMessage(tx, companyId, {
        recipient: { type: 'staff', personId },
        purpose: 'staff_notice',
        subject: `${state.lease.unitCode} is paid until ${until}`,
        body: `${state.lease.tenantName}'s rent at ${state.lease.unitCode}, ${state.lease.propertyName}, is paid until ${until}, ${days} days from now. Talk to them about renewing or paying the next period (AR-06).`,
        channels: ['email'],
        propertyId: state.lease.propertyId,
        related: { type: 'lease', id: leaseId },
        requestedBy: null,
      });
    // The tenant, on every channel in the business order where consent is recorded (the
    // messaging core checks it); M6 gives it its own purpose and WhatsApp template (plan 4.9).
    const tenantMessageId = await queueMessage(tx, companyId, {
      recipient: { type: 'tenant', tenantId: state.lease.tenantId },
      purpose: 'paid_until_prompt',
      subject: `Your rent is paid until ${until}`,
      body: `${company.displayName}: your rent for ${state.lease.unitCode} is paid until ${until}. Contact us to renew or to pay the next period.`,
      channels: ['push', 'whatsapp', 'sms', 'email'],
      templateParams: { paid_until: until },
      propertyId: state.lease.propertyId,
      related: { type: 'lease', id: leaseId },
      requestedBy: null,
    });
    await tx.insert(schema.paidUntilPrompt).values({
      companyId,
      propertyId: state.lease.propertyId,
      tenantId: state.lease.tenantId,
      leaseId,
      paidUntil,
      promptedOn: today,
      staffMessages: managers.length,
      tenantMessageId,
    });
    return 1;
  }

  /** AR-06's list: leases whose paid-until is within the lead, with the prompt that went. */
  async paidUntilEnding(actor: Actor | null, days?: number): Promise<PaidUntilEnding[]> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'lease.view');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const company = await companyRecord(tx, staff.companyId);
      const today = isoNow(this.clock, company!.timeZone);
      const window = Math.min(
        Math.max(
          Math.trunc(days ?? paidUntilPromptDaysOf(parseCompanySettings(company?.settings))),
          1,
        ),
        366,
      );
      const out: PaidUntilEnding[] = [];
      for (const leaseId of await leaseIdsIn(tx, CURRENT)) {
        const state = await this.engine.load(tx, staff.companyId, leaseId);
        if (state.book.kind !== 'book') continue;
        const paidUntil = this.engine.walk(state).paidUntil;
        if (!paidUntil) continue;
        const left = daysBetween(parseBusinessDate(today), parseBusinessDate(paidUntil));
        if (left < 0 || left > window) continue;
        const [prompt] = await tx
          .execute<{ prompted_on: string }>(
            sql`select prompted_on::text from paid_until_prompt where lease_id = ${leaseId}
              and paid_until = ${paidUntil}::date limit 1`,
          )
          .then((r) => r.rows);
        out.push({
          leaseId,
          unitCode: state.lease.unitCode,
          propertyName: state.lease.propertyName,
          tenantName: state.lease.tenantName,
          endDate: state.lease.endDate,
          paidUntil,
          daysLeft: left,
          promptedOn: prompt?.prompted_on ?? null,
        });
      }
      return out.sort((a, b) => a.daysLeft - b.daysLeft);
    });
  }
}
