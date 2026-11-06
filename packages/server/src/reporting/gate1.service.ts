import { Inject, Injectable } from '@nestjs/common';
import { sql, withCompany, withSystem, type Database, type Tx } from '@rent/db';
import {
  addMonths,
  businessDateOf,
  DEFAULT_TIME_ZONE,
  instantFrom,
  instantToDate,
  minutesBetween,
  parseBusinessDate,
  startOfDay,
  toIsoDate,
} from '@rent/domain/dates';
import type { LineKind, AllocationSource } from '@rent/domain/billing';
import { maintenanceSettingsOf } from '@rent/domain/maintenance';
import type { NoticeType } from '@rent/domain/notices';
import type { Actor } from '@rent/domain/policy';
import {
  autoMatchRate,
  collectionRate,
  COLLECTION_METHODS,
  digitalPaymentShare,
  isCollectionMethod,
  noticeAcknowledgement,
  ratioOf,
  repairResponse,
  reportMonth,
  timeToReceipt,
  type CollectionLine,
  type CollectionMethod,
  type NoticeForMetric,
  type Ratio,
  type RepairJobForMetric,
  type WindowedShare,
} from '@rent/domain/reporting';
import { parseCompanySettings } from '@rent/domain/settings';
import { companyRecord, staffActor } from '../companies/companies.service';
import type { Clock } from '../core/clock';
import { forbidden, invalid } from '../core/errors';
import { CLOCK, DATABASE } from '../core/tokens';
import { partyKeyOf } from '../notices/records';
import { PolicyService, staffContext } from '../policy/policy.service';

/**
 * The Gate 1 metrics (PRD section 19; M9 plan decisions 9, 10 and 13) for a company and a month,
 * worked out by the daily rollup from the ledger's sub-ledgers, payments, receipts (M4b's latency),
 * notices (M7) and maintenance jobs (M8), and stored with their inputs in `metric_daily`. The
 * definitions are the domain's (`@rent/domain/reporting`); this service only selects the month's
 * facts. Across companies, platform admins read them through one narrow system function
 * (`app.platform_gate1`, ADR-002), never through a company's own context.
 */

/** The Gate 1 figures as the contract's `gate1Schema` carries them, before `computedAt`. */
export interface Gate1Figures {
  readonly month: string;
  readonly collectionRate: {
    readonly dueMinor: number;
    readonly collectedMinor: number;
    readonly rate: Ratio;
  };
  readonly digitalShare: {
    readonly byMethod: Readonly<Record<CollectionMethod, number>>;
    readonly digitalMinor: number;
    readonly totalMinor: number;
    readonly share: Ratio;
  };
  readonly autoMatch: {
    readonly provider: {
      readonly automatic: number;
      readonly byPerson: number;
      readonly unmatched: number;
      readonly rate: Ratio;
    };
    readonly directTransfers: {
      readonly againstLease: number;
      readonly unmatched: number;
      readonly rate: Ratio;
    };
  };
  readonly timeToReceipt: {
    readonly receipts: number;
    readonly sent: number;
    readonly withinTarget: number;
    readonly share: Ratio;
    readonly medianMs: number | null;
    readonly p95Ms: number | null;
  };
  readonly noticeAcknowledgement: WindowedShare;
  readonly repairResponse: WindowedShare;
}

/** What the figures were worked out from, kept beside them so a total across companies is exact. */
export interface Gate1Inputs {
  readonly asOf: string;
  readonly collectionLines: number;
  readonly payments: number;
  readonly providerPayments: number;
  readonly directTransfers: number;
  /** Each receipt's time to reach the tenant; null for one never sent (choice 20). */
  readonly receiptLatenciesMs: readonly (number | null)[];
  readonly notices: number;
  readonly emergencyJobs: number;
}

/** A `metric_daily.figures` document. */
export interface StoredGate1 {
  readonly gate1: Gate1Figures;
  readonly inputs: Gate1Inputs;
}

export interface Gate1View extends Gate1Figures {
  readonly computedAt: Date;
}

export interface PlatformGate1View {
  readonly month: string;
  readonly companies: readonly {
    readonly company: { readonly id: string; readonly name: string };
    readonly gate1: Gate1View | null;
  }[];
  /** Every company's figures added up from their inputs; null when no company has any yet. */
  readonly total: Gate1View | null;
}

/** Payments a provider confirmed (M4a's test harness, M4b's intents and charges). */
const PROVIDER_SOURCES = ['payment_intent', 'provider_charge', 'provider_test'];
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The first instant of a month and of the next, in the company's time zone. */
function monthWindow(month: string, timeZone: string): { from: Date; to: Date } {
  const first = parseBusinessDate(reportMonth(month).firstDay);
  return {
    from: instantToDate(startOfDay(first, timeZone)),
    to: instantToDate(startOfDay(addMonths(first, 1), timeZone)),
  };
}

const asDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

/** Adds windowed shares (notices, repairs) across companies. */
function addWindowed(all: readonly WindowedShare[]): WindowedShare {
  const met = all.reduce((s, w) => s + w.met, 0);
  const missed = all.reduce((s, w) => s + w.missed, 0);
  const pending = all.reduce((s, w) => s + w.pending, 0);
  return { met, missed, pending, rate: ratioOf(met, met + missed) };
}

/**
 * Gate 1 across companies (decision 13): counts and amounts added up, shares worked out again from
 * the sums, and time to receipt from every receipt's latency, so the total is exact rather than an
 * average of averages. Null when nothing was stored.
 */
export function combineGate1(month: string, all: readonly StoredGate1[]): Gate1Figures | null {
  if (all.length === 0) return null;
  const sum = (f: (g: Gate1Figures) => number) => all.reduce((s, x) => s + f(x.gate1), 0);
  const due = sum((g) => g.collectionRate.dueMinor);
  const collected = sum((g) => g.collectionRate.collectedMinor);
  const digital = digitalPaymentShare(
    COLLECTION_METHODS.map((method) => ({
      method,
      amountMinor: sum((g) => g.digitalShare.byMethod[method]),
    })),
  );
  const auto = {
    automatic: sum((g) => g.autoMatch.provider.automatic),
    byPerson: sum((g) => g.autoMatch.provider.byPerson),
    unmatched: sum((g) => g.autoMatch.provider.unmatched),
  };
  const direct = {
    againstLease: sum((g) => g.autoMatch.directTransfers.againstLease),
    unmatched: sum((g) => g.autoMatch.directTransfers.unmatched),
  };
  const receipts = timeToReceipt(
    all.flatMap((x) => x.inputs.receiptLatenciesMs.map((latencyMs) => ({ latencyMs }))),
  );
  return {
    month,
    collectionRate: { dueMinor: due, collectedMinor: collected, rate: ratioOf(collected, due) },
    digitalShare: digital,
    autoMatch: {
      provider: {
        ...auto,
        rate: ratioOf(auto.automatic, auto.automatic + auto.byPerson + auto.unmatched),
      },
      directTransfers: {
        ...direct,
        rate: ratioOf(direct.againstLease, direct.againstLease + direct.unmatched),
      },
    },
    timeToReceipt: receipts,
    noticeAcknowledgement: addWindowed(all.map((x) => x.gate1.noticeAcknowledgement)),
    repairResponse: addWindowed(all.map((x) => x.gate1.repairResponse)),
  };
}

@Injectable()
export class Gate1Service {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * A company's Gate 1 figures for a month as of an instant, with their inputs, in the caller's
   * transaction (the rollup's, in the company's context). Reads only; posts and alerts nothing.
   */
  async compute(
    tx: Tx,
    companyId: string,
    month: string,
    asOf: Date,
    timeZone: string,
  ): Promise<StoredGate1> {
    const range = reportMonth(month);
    const window = monthWindow(month, timeZone);

    // Collection rate (decision 9): rent and service-charge lines due in the month.
    const lineRows = await tx.execute<{
      id: string;
      kind: LineKind;
      due_date: string;
      amount_minor: number;
    }>(
      sql`select l.id, l.kind, l.due_date::text as due_date, l.amount_minor from invoice_line l
          where l.kind in ('rent', 'service_charge')
            and l.due_date between ${range.firstDay}::date and ${range.lastDay}::date`,
    );
    const allocationRows = await tx.execute<{
      invoice_line_id: string;
      source: AllocationSource;
      amount_minor: number;
      value_date: string;
    }>(
      sql`select a.invoice_line_id, a.source, a.amount_minor, a.value_date::text as value_date
          from allocation a
          join invoice_line l on l.company_id = a.company_id and l.id = a.invoice_line_id
          where l.kind in ('rent', 'service_charge')
            and l.due_date between ${range.firstDay}::date and ${range.lastDay}::date`,
    );
    const byLine = new Map<string, CollectionLine['allocations'][number][]>();
    for (const a of allocationRows.rows) {
      const list = byLine.get(a.invoice_line_id) ?? [];
      list.push({
        source: a.source,
        amountMinor: Number(a.amount_minor),
        valueDate: a.value_date,
      });
      byLine.set(a.invoice_line_id, list);
    }
    const collection = collectionRate({
      month,
      lines: lineRows.rows.map((l) => ({
        lineId: l.id,
        kind: l.kind,
        dueDate: l.due_date,
        amountMinor: Number(l.amount_minor),
        allocations: byLine.get(l.id) ?? [],
      })),
    });

    // Digital share (decision 10, choice 18): money received in the month, reversed money left out.
    const paymentRows = await tx.execute<{ method: string; amount_minor: number }>(
      sql`select p.method, p.amount_minor from payment p
          where p.received_on between ${range.firstDay}::date and ${range.lastDay}::date
            and not exists (select 1 from payment_reversal r
                            where r.company_id = p.company_id and r.payment_id = p.id)`,
    );
    const received = paymentRows.rows.flatMap((p) =>
      isCollectionMethod(p.method)
        ? [{ method: p.method, amountMinor: Number(p.amount_minor) }]
        : [],
    );
    const digital = digitalPaymentShare(received);

    // Auto-match (decision 10, choice 19): every provider payment of the month, reversed or not.
    const providerRows = await tx.execute<{ lease_id: string | null; matched: boolean }>(
      sql`select p.lease_id,
            exists (select 1 from payment_match m where m.company_id = p.company_id and m.payment_id = p.id) as matched
          from payment p
          where p.received_on between ${range.firstDay}::date and ${range.lastDay}::date
            and p.source_type = any(${`{${PROVIDER_SOURCES.join(',')}}`}::text[])`,
    );
    const transferRows = await tx.execute<{ against_lease: boolean }>(
      sql`select d.lease_id is not null as against_lease from direct_receipt d
          where d.received_on between ${range.firstDay}::date and ${range.lastDay}::date
            and exists (select 1 from payment p where p.company_id = d.company_id
                        and p.source_type = 'direct_receipt' and p.source_id = d.id)`,
    );
    const auto = autoMatchRate({
      providerPayments: providerRows.rows.map((p) => ({
        match: p.lease_id ? 'automatic' : p.matched ? 'by_person' : 'unmatched',
      })),
      directTransfers: transferRows.rows.map((t) => ({ recordedAgainstLease: t.against_lease })),
    });

    // Time to receipt (decision 10, choice 20): receipts issued in the month.
    const receiptRows = await tx.execute<{ latency_ms: number | null }>(
      sql`select d.latency_ms from receipt r
          left join receipt_delivery d on d.company_id = r.company_id and d.receipt_id = r.id
          where r.kind = 'receipt' and r.issued_at >= ${window.from} and r.issued_at < ${window.to}
          order by r.issued_at, r.id`,
    );
    const latencies = receiptRows.rows.map((r) =>
      r.latency_ms === null ? null : Number(r.latency_ms),
    );
    const receipts = timeToReceipt(latencies.map((latencyMs) => ({ latencyMs })));

    // Notice acknowledgement (decision 10, choice 21).
    const notices = await this.noticesIn(tx, window);
    const acknowledgement = noticeAcknowledgement({ notices, asOf });

    // Repair response (decision 10; founder decision: attended means work started).
    const jobs = await this.emergencyJobsIn(tx, companyId, window);
    const repairs = repairResponse({ jobs, asOf });

    return {
      gate1: {
        month,
        collectionRate: {
          dueMinor: collection.dueMinor,
          collectedMinor: collection.collectedMinor,
          rate: collection.rate,
        },
        digitalShare: digital,
        autoMatch: auto,
        timeToReceipt: receipts,
        noticeAcknowledgement: acknowledgement,
        repairResponse: repairs,
      },
      inputs: {
        asOf: asOf.toISOString(),
        collectionLines: collection.lines,
        payments: received.length,
        providerPayments: providerRows.rows.length,
        directTransfers: transferRows.rows.length,
        receiptLatenciesMs: latencies,
        notices: notices.length,
        emergencyJobs: jobs.length,
      },
    };
  }

  /**
   * The notices issued in the month, each as the metric reads it. A building-wide notice counts
   * once per party (a tenant, a company's signatories together, each co-tenant alone); any other
   * notice counts once, acknowledged when its completion rule was met (any one party, or each).
   */
  private async noticesIn(tx: Tx, window: { from: Date; to: Date }): Promise<NoticeForMetric[]> {
    const rows = await tx.execute<{
      id: string;
      type: NoticeType;
      completion: string;
      issued_at: Date | string;
    }>(
      sql`select n.id, n.type, n.completion, n.issued_at from notice n
          where n.issued_at is not null and n.issued_at >= ${window.from} and n.issued_at < ${window.to}
            and n.type <> 'tenant_originated'
          order by n.issued_at, n.id`,
    );
    if (rows.rows.length === 0) return [];
    const ids = `{${rows.rows.map((r) => r.id).join(',')}}`;
    const recipients = await tx.execute<{
      id: string;
      notice_id: string;
      kind: string;
      tenant_id: string;
      tenant_contact_id: string | null;
    }>(
      sql`select r.id, r.notice_id, r.kind, r.tenant_id, r.tenant_contact_id from notice_recipient r
          where r.notice_id = any(${ids}::uuid[])`,
    );
    const signed = await tx.execute<{ recipient_id: string; at: Date | string }>(
      sql`select e.recipient_id, min(e.occurred_at) as at from notice_event e
          where e.notice_id = any(${ids}::uuid[]) and e.kind = 'signed' and e.recipient_id is not null
          group by e.recipient_id`,
    );
    const signedAt = new Map(signed.rows.map((s) => [s.recipient_id, asDate(s.at).getTime()]));
    return rows.rows.map((n) => {
      const parties = new Map<string, number | null>();
      for (const r of recipients.rows.filter((x) => x.notice_id === n.id)) {
        const key = partyKeyOf({
          kind: r.kind,
          tenantId: r.tenant_id,
          tenantContactId: r.tenant_contact_id,
        } as Parameters<typeof partyKeyOf>[0]);
        const at = signedAt.get(r.id) ?? null;
        const before = parties.has(key) ? parties.get(key)! : null;
        parties.set(key, before === null ? at : at === null ? before : Math.min(before, at));
      }
      const times = [...parties.values()];
      const one = (): number | null => {
        const done = times.filter((t): t is number => t !== null);
        if (n.completion === 'any_one') return done.length > 0 ? Math.min(...done) : null;
        return done.length === times.length && done.length > 0 ? Math.max(...done) : null;
      };
      const recipientsOf =
        n.type === 'building_wide'
          ? times.map((t) => ({ signedAt: t === null ? null : new Date(t) }))
          : [{ signedAt: ((t) => (t === null ? null : new Date(t)))(one()) }];
      return { type: n.type, issuedAt: asDate(n.issued_at), recipients: recipientsOf };
    });
  }

  /**
   * Emergency jobs whose response clock started in the month, cancelled ones left out. The clock
   * starts when the job was reported, with M8's target from the report (`respond_by`); for a job
   * raised to emergency after its report, when it was raised, with the company's emergency target.
   * Work started is the first move to In progress (`started`), never the assignment.
   */
  private async emergencyJobsIn(
    tx: Tx,
    companyId: string,
    window: { from: Date; to: Date },
  ): Promise<RepairJobForMetric[]> {
    const rows = await tx.execute<{
      created_at: Date | string;
      raised_at: Date | string | null;
      respond_by: Date | string | null;
      started_at: Date | string | null;
    }>(
      sql`select j.created_at, j.raised_at, j.respond_by, j.started_at from (
            select j.created_at, j.respond_by,
              (select max(e.at) from maintenance_job_event e
               where e.company_id = j.company_id and e.job_id = j.id and e.kind = 'priority_changed'
                 and e.data->>'to' = 'emergency') as raised_at,
              (select min(e.at) from maintenance_job_event e
               where e.company_id = j.company_id and e.job_id = j.id and e.kind = 'started') as started_at,
              j.id
            from maintenance_job j
            where j.priority = 'emergency' and j.status <> 'cancelled') j
          where coalesce(j.raised_at, j.created_at) >= ${window.from}
            and coalesce(j.raised_at, j.created_at) < ${window.to}
          order by coalesce(j.raised_at, j.created_at), j.id`,
    );
    if (rows.rows.length === 0) return [];
    const company = await companyRecord(tx, companyId);
    const target = maintenanceSettingsOf(parseCompanySettings(company?.settings ?? {})).targets
      .emergency;
    return rows.rows.map((r) => {
      const reported = asDate(r.created_at);
      const raised = r.raised_at === null ? null : asDate(r.raised_at);
      const targetMinutes =
        raised === null && r.respond_by
          ? Math.max(0, minutesBetween(instantFrom(reported), instantFrom(asDate(r.respond_by))))
          : target.respondHours * 60;
      return {
        priority: 'emergency' as const,
        clockStartedAt: raised ?? reported,
        targetMinutes,
        workStartedAt: r.started_at === null ? null : asDate(r.started_at),
      };
    });
  }

  /** The latest stored figures of a month, in the caller's transaction (company context). */
  async latestIn(tx: Tx, month: string): Promise<Gate1View | null> {
    const rows = await tx.execute<{ figures: StoredGate1; computed_at: Date | string }>(
      sql`select figures, computed_at from metric_daily where month = ${month}
          order by metric_date desc limit 1`,
    );
    const row = rows.rows[0];
    return row ? { ...row.figures.gate1, computedAt: asDate(row.computed_at) } : null;
  }

  private thisMonth(timeZone: string): string {
    return toIsoDate(businessDateOf(instantFrom(this.clock.now()), timeZone)).slice(0, 7);
  }

  /**
   * The company's Gate 1 figures for a month (default this month), from the rollup. They are the
   * whole company's, so a person who sees only some owners or properties gets none: the
   * company-wide totals would show them other owners' figures (decision 15).
   */
  async gate1(actor: Actor | null, month?: string): Promise<Gate1View | null> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'dashboard.read');
    if (month !== undefined && !MONTH.test(month))
      throw invalid('bad_month', 'Use a month such as 2026-10');
    if (this.policy.scopeFor(staff) !== null) return null;
    return withCompany(
      this.database,
      staffContext(staff),
      async (tx) => {
        const company = await companyRecord(tx, staff.companyId);
        return this.latestIn(tx, month ?? this.thisMonth(company?.timeZone ?? DEFAULT_TIME_ZONE));
      },
      { accessMode: 'read only' },
    );
  }

  /**
   * Gate 1 across companies for platform admins (`metrics.platform.read`; decision 13). The caller
   * is checked first, then the figures come through `app.platform_gate1`, which checks again that
   * the session is a platform admin's (ADR-002).
   */
  async platformGate1(actor: Actor | null, month?: string): Promise<PlatformGate1View> {
    if (!actor) throw forbidden();
    this.policy.assert(actor, 'metrics.platform.read');
    let personId: string;
    switch (actor.kind) {
      case 'platform_admin':
        personId = actor.personId;
        break;
      default:
        throw forbidden();
    }
    if (month !== undefined && !MONTH.test(month))
      throw invalid('bad_month', 'Use a month such as 2026-10');
    const wanted = month ?? this.thisMonth(DEFAULT_TIME_ZONE);
    const rows = await withSystem(this.database, { personId, actorKind: 'platform_admin' }, (tx) =>
      tx.execute<{
        company_id: string;
        display_name: string;
        figures: StoredGate1 | null;
        computed_at: Date | string | null;
      }>(
        sql`select company_id, display_name, figures, computed_at from app.platform_gate1(${wanted})`,
      ),
    );
    const companies = rows.rows.map((r) => ({
      company: { id: r.company_id, name: r.display_name },
      gate1:
        r.figures && r.computed_at
          ? { ...r.figures.gate1, computedAt: asDate(r.computed_at) }
          : null,
    }));
    const stored = rows.rows.flatMap((r) => (r.figures ? [r.figures] : []));
    const total = combineGate1(wanted, stored);
    const latest = rows.rows
      .flatMap((r) => (r.computed_at ? [asDate(r.computed_at).getTime()] : []))
      .reduce((a, b) => Math.max(a, b), 0);
    return {
      month: wanted,
      companies,
      total: total ? { ...total, computedAt: new Date(latest) } : null,
    };
  }
}
