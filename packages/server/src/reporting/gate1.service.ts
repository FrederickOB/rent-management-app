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
  collectionRateByPeriod,
  COLLECTION_METHODS,
  combineArrearsOver60,
  combineWeeklyActiveManagers,
  combineWhatsappAdoption,
  digitalPaymentShare,
  gate1Targets,
  isCollectionMethod,
  netRevenueRetention,
  noticeAcknowledgement,
  ratioOf,
  repairResponse,
  reportMonth,
  timeToReceipt,
  timeToReceiptDelivered,
  type ArrearsOver60,
  type ArrearsSnapshotRow,
  type CollectionMethod,
  type Gate1Targets,
  type NetRevenueRetention,
  type NoticeForMetric,
  type PeriodCollectionLine,
  type Ratio,
  type RepairJobForMetric,
  type SubscriptionRevenue,
  type TimeToReceiptDelivered,
  type WeeklyActiveManagers,
  type WhatsappAdoption,
  type WindowedShare,
} from '@rent/domain/reporting';
import { parseCompanySettings } from '@rent/domain/settings';
import { companyRecord, staffActor } from '../companies/companies.service';
import type { Clock } from '../core/clock';
import { forbidden, invalid } from '../core/errors';
import { CLOCK, DATABASE } from '../core/tokens';
import { partyKeyOf } from '../notices/records';
import { PolicyService, staffContext } from '../policy/policy.service';
import {
  arrearsOver60In,
  cutOverDateIn,
  receiptDeliveredLatenciesIn,
  weeklyActiveManagersIn,
  whatsappAdoptionIn,
} from './gate1-m11';

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
  // M11 decision 4: stored from M11 on; months rolled up before have none. The M9 figures above
  // stay as they were.
  readonly arrearsOver60?: ArrearsOver60;
  readonly weeklyActiveManagers?: WeeklyActiveManagers;
  readonly whatsappAdoption?: WhatsappAdoption;
  readonly timeToReceiptDelivered?: TimeToReceiptDelivered;
}

/** What the figures were worked out from, kept beside them so a total across companies is exact. */
export interface Gate1Inputs {
  /** The moment the figures are as of: only what was recorded by then counts. */
  readonly asOf: string;
  /**
   * For a month already final: when its notices and repairs were last worked out again, while any
   * of their windows was still open on the 1st (M9 review). Absent until then.
   */
  readonly windowsAsOf?: string;
  readonly collectionLines: number;
  readonly payments: number;
  readonly providerPayments: number;
  readonly directTransfers: number;
  /** Each receipt's time to reach the tenant; null for one never sent (choice 20). */
  readonly receiptLatenciesMs: readonly (number | null)[];
  readonly notices: number;
  readonly emergencyJobs: number;
  /** M11: each receipt's time to be delivered; null for one never delivered. */
  readonly receiptDeliveredLatenciesMs?: readonly (number | null)[];
  /** M11: the company's cut-over date when the figures were worked out (decision 3). */
  readonly cutOverDate?: string | null;
}

/** A `metric_daily.figures` document. */
export interface StoredGate1 {
  readonly gate1: Gate1Figures;
  readonly inputs: Gate1Inputs;
}

export interface Gate1View extends Gate1Figures {
  /**
   * `final` once the month is over and its figures were worked out after its end (on the 1st, or
   * the first rollup after it); `provisional` until then (M9 review).
   */
  readonly status: 'final' | 'provisional';
  readonly finalisedAt: Date | null;
  readonly computedAt: Date;
  /** M11 decision 4: the two Gate 1 targets, met or not, from the figures above. */
  readonly targets: Gate1Targets;
  /** M11 decision 4: platform-wide only, once 12 months of subscription invoices exist. */
  readonly netRevenueRetention?: NetRevenueRetention;
}

/** Whether a stored month still has a notice or repair window open at its last working out. */
export const hasPendingWindows = (g: Gate1Figures): boolean =>
  g.noticeAcknowledgement.pending > 0 || g.repairResponse.pending > 0;

export interface PlatformGate1View {
  readonly month: string;
  readonly companies: readonly {
    readonly company: { readonly id: string; readonly name: string };
    readonly gate1: Gate1View | null;
  }[];
  /**
   * Every company's figures added up from their inputs; null when no company has any yet. Its
   * `computedAt` is the oldest company's, and it is final only when every company's month is.
   */
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

/** M11 decision 4: the Gate 1 targets from a month's figures (any month, M9's included). */
export const targetsOf = (g: Gate1Figures): Gate1Targets =>
  gate1Targets({ collectionRate: g.collectionRate.rate, autoMatch: g.autoMatch.provider.rate });

/** A stored row as read back, for the view. */
function viewOf(row: {
  figures: StoredGate1;
  computed_at: Date | string;
  finalised_at: Date | string | null;
}): Gate1View {
  return {
    ...row.figures.gate1,
    status: row.finalised_at === null ? 'provisional' : 'final',
    finalisedAt: row.finalised_at === null ? null : asDate(row.finalised_at),
    computedAt: asDate(row.computed_at),
    targets: targetsOf(row.figures.gate1),
  };
}

/** Each part's figure, or null unless every part has it (an M11 measure covers every company). */
function everyPart<T>(
  all: readonly StoredGate1[],
  pick: (x: StoredGate1) => T | undefined,
): T[] | null {
  const parts: T[] = [];
  for (const x of all) {
    const part = pick(x);
    if (part === undefined) return null;
    parts.push(part);
  }
  return parts;
}

/**
 * M11 decision 4: net revenue retention from the platform's subscription invoices (PB-07), each
 * invoice net of VAT and of its credit notes, by the month it bills. Read in the platform
 * company's context.
 */
export async function subscriptionRevenueIn(tx: Tx): Promise<SubscriptionRevenue[]> {
  const rows = await tx.execute<{ company_id: string; month: string; amount_minor: number }>(
    sql`select i.subscriber_company_id as company_id, i.month,
          greatest(0, i.net_minor - coalesce((select sum(c.net_minor) from subscription_credit_note c
                                               where c.company_id = i.company_id and c.invoice_id = i.id), 0))::bigint
            as amount_minor
        from subscription_invoice i where i.status <> 'void'`,
  );
  return rows.rows.map((r) => ({
    companyId: r.company_id,
    month: r.month,
    amountMinor: Number(r.amount_minor),
  }));
}

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
    ...combineM11(all),
  };
}

/**
 * M11 decision 4 across companies: each measure added up exactly by the domain's `combine…`, and
 * time to receipt delivered from every receipt's latency, as time to receipt is. A measure some
 * company's month lacks (rolled up before M11) is left out of the total.
 */
function combineM11(all: readonly StoredGate1[]): Partial<Gate1Figures> {
  const out: {
    arrearsOver60?: ArrearsOver60;
    weeklyActiveManagers?: WeeklyActiveManagers;
    whatsappAdoption?: WhatsappAdoption;
    timeToReceiptDelivered?: TimeToReceiptDelivered;
  } = {};
  const arrears = everyPart(all, (x) => x.gate1.arrearsOver60);
  const combinedArrears = arrears && combineArrearsOver60(arrears);
  if (combinedArrears) out.arrearsOver60 = combinedArrears;
  const weekly = everyPart(all, (x) => x.gate1.weeklyActiveManagers);
  const combinedWeekly = weekly && combineWeeklyActiveManagers(weekly);
  if (combinedWeekly) out.weeklyActiveManagers = combinedWeekly;
  const whatsapp = everyPart(all, (x) => x.gate1.whatsappAdoption);
  const combinedWhatsapp = whatsapp && combineWhatsappAdoption(whatsapp);
  if (combinedWhatsapp) out.whatsappAdoption = combinedWhatsapp;
  const delivered = everyPart(all, (x) => x.inputs.receiptDeliveredLatenciesMs);
  if (delivered)
    out.timeToReceiptDelivered = timeToReceiptDelivered(
      delivered.flat().map((latencyMs) => ({ latencyMs })),
    );
  return out;
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
    /** M11: the rollup's own snapshot of today (not stored yet), for this month's arrears. */
    extra: { readonly arrearsRows?: readonly ArrearsSnapshotRow[] } = {},
  ): Promise<StoredGate1> {
    const range = reportMonth(month);
    const window = monthWindow(month, timeZone);

    // Collection rate (F2, founder decision 2026-11-06; replaces decision 9's due-date basis): the
    // rent and service-charge lines whose charge period starts in the month, whatever the billing
    // cycle, and what of them was settled by its end, counting only what was recorded by `asOf`.
    const lineRows = await tx.execute<{
      id: string;
      kind: LineKind;
      period_start: string;
      amount_minor: number;
      created_at: Date | string;
    }>(
      sql`select l.id, l.kind, l.period_start::text as period_start, l.amount_minor, l.created_at
          from invoice_line l
          where l.kind in ('rent', 'service_charge')
            and l.period_start between ${range.firstDay}::date and ${range.lastDay}::date
            -- M11 (P25): arrears brought in at the cut-over are from before the platform.
            and not exists (select 1 from invoice i where i.company_id = l.company_id
                             and i.id = l.invoice_id and i.kind = 'opening')`,
    );
    const allocationRows = await tx.execute<{
      invoice_line_id: string;
      source: AllocationSource;
      amount_minor: number;
      value_date: string;
      created_at: Date | string;
      opening: boolean;
    }>(
      sql`select a.invoice_line_id, a.source, a.amount_minor, a.value_date::text as value_date,
            a.created_at,
            exists (select 1 from payment p where p.company_id = a.company_id and p.id = a.payment_id
                    and p.source_type = 'opening_balance') as opening
          from allocation a
          join invoice_line l on l.company_id = a.company_id and l.id = a.invoice_line_id
          where l.kind in ('rent', 'service_charge')
            and l.period_start between ${range.firstDay}::date and ${range.lastDay}::date`,
    );
    const byLine = new Map<string, PeriodCollectionLine['allocations'][number][]>();
    // M11 (P25): what an opening payment (money received before the platform) pays of a month is
    // neither due through the platform nor collected by it: it is left out of the month altogether.
    const openingPaid = new Map<string, number>();
    for (const a of allocationRows.rows) {
      if (a.opening) {
        openingPaid.set(
          a.invoice_line_id,
          (openingPaid.get(a.invoice_line_id) ?? 0) + Number(a.amount_minor),
        );
        continue;
      }
      const list = byLine.get(a.invoice_line_id) ?? [];
      list.push({
        source: a.source,
        amountMinor: Number(a.amount_minor),
        valueDate: a.value_date,
        recordedAt: asDate(a.created_at),
      });
      byLine.set(a.invoice_line_id, list);
    }
    const collection = collectionRateByPeriod({
      month,
      lines: lineRows.rows.map((l) => ({
        lineId: l.id,
        kind: l.kind,
        periodStart: l.period_start,
        amountMinor: Math.max(0, Number(l.amount_minor) - (openingPaid.get(l.id) ?? 0)),
        recordedAt: asDate(l.created_at),
        allocations: byLine.get(l.id) ?? [],
      })),
      asOf: await this.inDatabaseClock(tx, asOf),
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

    // Notice acknowledgement and repair response (decision 10, choices 21 and 22).
    const windows = await this.windowsIn(tx, companyId, month, asOf, timeZone);

    // M11 decision 4: arrears over 60 days, weekly active managers, WhatsApp adoption and time to
    // receipt delivered.
    const asOfDate = toIsoDate(businessDateOf(instantFrom(asOf), timeZone));
    const cutOverDate = await cutOverDateIn(tx);
    const arrears = await arrearsOver60In(tx, {
      month,
      asOfDate,
      cutOverDate,
      ...(extra.arrearsRows ? { rows: extra.arrearsRows } : {}),
    });
    const weekly = await weeklyActiveManagersIn(tx, this.policy, companyId, month, asOfDate);
    const whatsapp = await whatsappAdoptionIn(
      tx,
      companyId,
      month,
      window,
      await this.inDatabaseClock(tx, asOf),
      timeZone,
    );
    const delivered = await receiptDeliveredLatenciesIn(tx, window);

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
        noticeAcknowledgement: windows.noticeAcknowledgement,
        repairResponse: windows.repairResponse,
        arrearsOver60: arrears,
        weeklyActiveManagers: weekly,
        whatsappAdoption: whatsapp,
        timeToReceiptDelivered: timeToReceiptDelivered(
          delivered.map((latencyMs) => ({ latencyMs })),
        ),
      },
      inputs: {
        asOf: asOf.toISOString(),
        collectionLines: collection.lines,
        payments: received.length,
        providerPayments: providerRows.rows.length,
        directTransfers: transferRows.rows.length,
        receiptLatenciesMs: latencies,
        notices: windows.notices,
        emergencyJobs: windows.emergencyJobs,
        receiptDeliveredLatenciesMs: delivered,
        cutOverDate,
      },
    };
  }

  /**
   * `asOf` (by CLOCK) on the database's clock, which stamps `created_at`: shifted by the offset
   * between the two read now, so "recorded by `asOf`" compares one clock with itself. In
   * production the offset is a few milliseconds; a test's fixed clock may be well behind.
   */
  private async inDatabaseClock(tx: Tx, asOf: Date): Promise<Date> {
    const [row] = (await tx.execute<{ now: Date | string }>(sql`select now() as now`)).rows;
    const offset = asDate(row!.now).getTime() - this.clock.now().getTime();
    return new Date(asOf.getTime() + offset);
  }

  /**
   * The month's notices and emergency repairs as of an instant (decision 10, choices 21 and 22):
   * met, missed, and pending only while a window is still open at `asOf`. A month already final
   * has these worked out again daily until none is pending (M9 review).
   */
  async windowsIn(
    tx: Tx,
    companyId: string,
    month: string,
    asOf: Date,
    timeZone: string,
  ): Promise<{
    readonly noticeAcknowledgement: WindowedShare;
    readonly repairResponse: WindowedShare;
    readonly notices: number;
    readonly emergencyJobs: number;
  }> {
    const window = monthWindow(month, timeZone);
    const notices = await this.noticesIn(tx, window);
    // Repair response (decision 10; founder decision: attended means work started).
    const jobs = await this.emergencyJobsIn(tx, companyId, window);
    return {
      noticeAcknowledgement: noticeAcknowledgement({ notices, asOf }),
      repairResponse: repairResponse({ jobs, asOf }),
      notices: notices.length,
      emergencyJobs: jobs.length,
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
    const rows = await tx.execute<{
      figures: StoredGate1;
      computed_at: Date | string;
      finalised_at: Date | string | null;
    }>(
      sql`select figures, computed_at, finalised_at from metric_daily where month = ${month}
          order by metric_date desc limit 1`,
    );
    const row = rows.rows[0];
    return row ? viewOf(row) : null;
  }

  /**
   * Past months to finalise (M9 review): each month before `thisMonth` the rollup stored figures
   * for and never marked final. Normally last month, on the 1st; a month a failed run left behind
   * is caught by the next run. In the caller's transaction (company context).
   */
  async monthsToFinaliseIn(tx: Tx, thisMonth: string): Promise<string[]> {
    const rows = await tx.execute<{ month: string }>(
      sql`select month from metric_daily where month < ${thisMonth}
          group by month having bool_and(finalised_at is null) order by month`,
    );
    return rows.rows.map((r) => r.month);
  }

  /**
   * Final months whose notices or repairs were still inside their windows when last worked out:
   * their latest row, to work those two out again (M9 review).
   */
  async unsettledIn(
    tx: Tx,
    thisMonth: string,
  ): Promise<{ month: string; metricDate: string; figures: StoredGate1 }[]> {
    const rows = await tx.execute<{
      month: string;
      metric_date: string;
      figures: StoredGate1;
      finalised_at: Date | string | null;
    }>(
      sql`select distinct on (month) month, metric_date::text as metric_date, figures, finalised_at
          from metric_daily where month < ${thisMonth}
          order by month, metric_date desc`,
    );
    return rows.rows
      .filter((r) => r.finalised_at !== null && hasPendingWindows(r.figures.gate1))
      .map((r) => ({ month: r.month, metricDate: r.metric_date, figures: r.figures }));
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
   * M11 decision 4: the company's Gate 1 figures month by month, from `from` (default: the month
   * of its cut-over, or its first rolled-up month) to `to` (default: this month), each the month's
   * latest stored figures with the targets met or not. A person limited to some owners or
   * properties gets no months, as `gate1` gives them none (decision 15).
   */
  async gate1Trend(
    actor: Actor | null,
    range: { readonly from?: string; readonly to?: string } = {},
  ): Promise<{ months: { month: string; gate1: Gate1View | null }[] }> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'dashboard.read');
    checkRange(range);
    if (this.policy.scopeFor(staff) !== null) return { months: [] };
    return withCompany(
      this.database,
      staffContext(staff),
      async (tx) => {
        const company = await companyRecord(tx, staff.companyId);
        const to = range.to ?? this.thisMonth(company?.timeZone ?? DEFAULT_TIME_ZONE);
        let from = range.from;
        if (from === undefined) {
          const cutOver = await cutOverDateIn(tx);
          const first = await tx.execute<{ month: string | null }>(
            sql`select min(month) as month from metric_daily`,
          );
          from = cutOver?.slice(0, 7) ?? first.rows[0]?.month ?? to;
          if (from > to) from = to;
          // The default never asks for more than the longest range allowed.
          const earliest = shiftMonth(to, 1 - MAX_TREND_MONTHS);
          if (from < earliest) from = earliest;
        }
        checkSpan(from, to);
        const months = monthsBetween(from, to);
        const rows = await tx.execute<{
          month: string;
          figures: StoredGate1;
          computed_at: Date | string;
          finalised_at: Date | string | null;
        }>(
          sql`select distinct on (month) month, figures, computed_at, finalised_at from metric_daily
              where month between ${from} and ${to} order by month, metric_date desc`,
        );
        const byMonth = new Map(rows.rows.map((r) => [r.month, viewOf(r)]));
        return { months: months.map((month) => ({ month, gate1: byMonth.get(month) ?? null })) };
      },
      { accessMode: 'read only' },
    );
  }

  /**
   * Gate 1 across companies for platform admins (`metrics.platform.read`; decision 13). The caller
   * is checked first, then the figures come through `app.platform_gate1`, which checks again that
   * the session is a platform admin's (ADR-002). M11: the total carries the targets and net
   * revenue retention, from the platform's own subscription invoices.
   */
  async platformGate1(actor: Actor | null, month?: string): Promise<PlatformGate1View> {
    const admin = this.platformAdmin(actor);
    if (month !== undefined && !MONTH.test(month))
      throw invalid('bad_month', 'Use a month such as 2026-10');
    const wanted = month ?? this.thisMonth(DEFAULT_TIME_ZONE);
    const [view] = await this.platformMonths(admin, [wanted]);
    return view!;
  }

  /**
   * M11 decision 4: Gate 1 month by month, per pilot company and platform-wide, with the targets.
   * Default: the 12 months to this one, less the leading months no company has figures for.
   */
  async platformGate1Trend(
    actor: Actor | null,
    range: { readonly from?: string; readonly to?: string } = {},
  ): Promise<{ months: PlatformGate1View[] }> {
    const admin = this.platformAdmin(actor);
    checkRange(range);
    const to = range.to ?? this.thisMonth(DEFAULT_TIME_ZONE);
    const from = range.from ?? shiftMonth(to, -11);
    checkSpan(from, to);
    const views = await this.platformMonths(admin, monthsBetween(from, to));
    if (range.from !== undefined) return { months: views };
    const first = views.findIndex((v) => v.total !== null);
    return { months: first < 0 ? views.slice(-1) : views.slice(first) };
  }

  private platformAdmin(actor: Actor | null): Extract<Actor, { kind: 'platform_admin' }> {
    if (!actor) throw forbidden();
    this.policy.assert(actor, 'metrics.platform.read');
    switch (actor.kind) {
      case 'platform_admin':
        return actor;
      default:
        throw forbidden();
    }
  }

  /** Each month across companies, through `app.platform_gate1`, with net revenue retention. */
  private async platformMonths(
    admin: Extract<Actor, { kind: 'platform_admin' }>,
    months: readonly string[],
  ): Promise<PlatformGate1View[]> {
    const perMonth = await withSystem(
      this.database,
      { personId: admin.personId, actorKind: 'platform_admin' },
      async (tx) => {
        const out: PlatformRow[][] = [];
        for (const month of months)
          out.push(
            (
              await tx.execute<PlatformRow>(
                sql`select company_id, display_name, figures, computed_at, finalised_at
                    from app.platform_gate1(${month})`,
              )
            ).rows,
          );
        return out;
      },
    );
    // Net revenue retention reads the platform's own invoices, in the platform company (decision 4).
    const invoices = await withCompany(
      this.database,
      { companyId: admin.companyId, personId: admin.personId, actorKind: 'platform_admin' },
      (tx) => subscriptionRevenueIn(tx),
      { accessMode: 'read only' },
    );
    return months.map((month, i) =>
      platformViewOf(month, perMonth[i]!, netRevenueRetention({ month, invoices })),
    );
  }
}

type PlatformRow = {
  company_id: string;
  display_name: string;
  figures: StoredGate1 | null;
  computed_at: Date | string | null;
  finalised_at: Date | string | null;
};

/** One month across companies: each company's stored view, and the total added up exactly. */
function platformViewOf(
  month: string,
  rows: readonly PlatformRow[],
  nrr: NetRevenueRetention,
): PlatformGate1View {
  const companies = rows.map((r) => ({
    company: { id: r.company_id, name: r.display_name },
    gate1:
      r.figures && r.computed_at
        ? viewOf({ figures: r.figures, computed_at: r.computed_at, finalised_at: r.finalised_at })
        : null,
  }));
  const views = companies.flatMap((c) => (c.gate1 ? [c.gate1] : []));
  const stored = rows.flatMap((r) => (r.figures ? [r.figures] : []));
  const total = combineGate1(month, stored);
  if (!total) return { month, companies, total: null };
  // The total is only as fresh as its stalest part, and final only once every part is.
  const oldest = Math.min(...views.map((v) => v.computedAt.getTime()));
  const final = views.every((v) => v.status === 'final');
  const lastFinalised = Math.max(...views.map((v) => v.finalisedAt?.getTime() ?? 0));
  return {
    month,
    companies,
    total: {
      ...total,
      status: final ? 'final' : 'provisional',
      finalisedAt: final ? new Date(lastFinalised) : null,
      computedAt: new Date(oldest),
      targets: targetsOf(total),
      netRevenueRetention: nrr,
    },
  };
}

/** The longest trend one request may ask for. */
export const MAX_TREND_MONTHS = 36;

const shiftMonth = (month: string, by: number): string =>
  toIsoDate(addMonths(parseBusinessDate(`${month}-01`), by)).slice(0, 7);

/** Every month from `from` to `to`, both included. */
function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to; m = shiftMonth(m, 1)) out.push(m);
  return out;
}

function checkRange(range: { readonly from?: string; readonly to?: string }): void {
  for (const m of [range.from, range.to])
    if (m !== undefined && !MONTH.test(m))
      throw invalid('bad_month', 'Use a month such as 2026-10');
}

/** A range asked for: in order, and no longer than `MAX_TREND_MONTHS`. */
function checkSpan(from: string, to: string): void {
  if (from > to) throw invalid('bad_range', 'The first month comes before the last one');
  if (shiftMonth(from, MAX_TREND_MONTHS - 1) < to)
    throw invalid('bad_range', `Choose ${MAX_TREND_MONTHS} months or fewer`);
}
