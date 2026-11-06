import type { ApiClient } from '@rent/contracts/client';
import { AGE_BUCKETS, AGE_BUCKET_LABELS, type AgeBucket } from '@rent/domain/billing';
import type { RemittanceMethod } from '@rent/domain/ledger';
import { UNIT_TYPE_LABELS, UNIT_TYPES } from '@rent/domain/portfolio';
import type { CollectionMethod } from '@rent/domain/reporting';
import { formatMinor } from './tenancy-format';

// Owner reporting and the dashboard (M9: AC-02 to AC-05, DA-01, DA-02, DA-06, Gate 1). Every
// figure is the API's, from the ledger or the nightly snapshot. A ratio arrives as numerator,
// denominator and basis points; the screen never divides, it only writes basis points as a
// percentage, and shows "—" when there was nothing to divide by.

export type Ratio = {
  readonly numerator: number;
  readonly denominator: number;
  readonly bps: number | null;
};
export type Dashboard = Awaited<ReturnType<ApiClient['dashboard']['get']>>;
export type Gate1 = NonNullable<Dashboard['gate1']>;

export const NO_RATIO = '—';

/**
 * Basis points as a percentage, exactly, with no floating point: 8750 is "87.5%", 10000 is
 * "100%", 1234 is "12.34%", 5 is "0.05%". Null (nothing to divide by) is "—".
 */
export function bpsText(bps: number | null): string {
  if (bps === null || !Number.isSafeInteger(bps)) return NO_RATIO;
  const negative = bps < 0;
  const magnitude = Math.abs(bps);
  const whole = Math.floor(magnitude / 100);
  const rest = String(magnitude % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${rest ? `.${rest}` : ''}%`;
}

export const ratioText = (ratio: Ratio): string => bpsText(ratio.bps);

/** "35 of 40", the counts behind a share. */
export const ratioCounts = (ratio: Ratio, noun?: string): string =>
  `${ratio.numerator.toLocaleString('en-GB')} of ${ratio.denominator.toLocaleString('en-GB')}${noun ? ` ${noun}` : ''}`;

/** "GH₵1,200.00 of GH₵1,500.00", an amount share. */
export const ratioAmounts = (ratio: Ratio): string =>
  `${formatMinor(ratio.numerator)} of ${formatMinor(ratio.denominator)}`;

/**
 * A bar's two parts as flex weights (the browser shares the width out; nothing is divided here):
 * the share and the rest of 10,000 basis points. Null when there is no share.
 */
export function barParts(
  bps: number | null,
): { readonly filled: number; readonly empty: number } | null {
  if (bps === null || !Number.isSafeInteger(bps)) return null;
  const filled = Math.min(Math.max(bps, 0), 10_000);
  return { filled, empty: 10_000 - filled };
}

/** "0.8 s", "1.2 s", "45 s", "2 min 5 s" for a duration in milliseconds. */
export function durationText(ms: number | null): string {
  if (ms === null || !Number.isSafeInteger(ms) || ms < 0) return NO_RATIO;
  if (ms < 60_000) {
    const tenths = Math.floor(ms / 100);
    return `${Math.floor(tenths / 10)}.${tenths % 10} s`;
  }
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** "3.5 months" for the median months paid ahead; "—" when nobody is paid ahead. */
export function monthsText(months: number | null): string {
  if (months === null || !Number.isFinite(months)) return NO_RATIO;
  const whole = Math.trunc(months);
  return `${whole === months ? whole : months.toLocaleString('en-GB', { maximumFractionDigits: 1 })} ${months === 1 ? 'month' : 'months'}`;
}

export const ageBucketLabel = (bucket: AgeBucket): string => AGE_BUCKET_LABELS[bucket];

/** Arrears by age, in the buckets' order. */
export function bucketsOf(
  byBucket: Readonly<Record<AgeBucket, number>>,
): { bucket: AgeBucket; label: string; amountMinor: number }[] {
  return AGE_BUCKETS.map((bucket) => ({
    bucket,
    label: AGE_BUCKET_LABELS[bucket],
    amountMinor: byBucket[bucket] ?? 0,
  }));
}

export const COLLECTION_METHOD_LABELS: Record<CollectionMethod, string> = {
  momo: 'Mobile money',
  card: 'Card',
  bank_transfer: 'Bank transfer',
  cash: 'Cash',
  cheque: 'Cheque',
  test: 'Test payments',
};

export const REMITTANCE_METHOD_LABELS: Record<RemittanceMethod, string> = {
  bank: 'Bank transfer',
  momo: 'Mobile money',
  cheque: 'Cheque',
  cash: 'Cash',
};

/** A unit type for people, when the API sends a key the register knows; otherwise as sent. */
export const unitTypeText = (type: string): string =>
  (UNIT_TYPES as readonly string[]).includes(type)
    ? UNIT_TYPE_LABELS[type as (typeof UNIT_TYPES)[number]]
    : type;

// Dashboard filters (DA-06) -------------------------------------------------------------------

export interface DashboardFilters {
  readonly ownerId: string;
  readonly propertyId: string;
  readonly region: string;
  readonly unitType: string;
}

export const NO_FILTERS: DashboardFilters = {
  ownerId: '',
  propertyId: '',
  region: '',
  unitType: '',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The query for the filters chosen: only what is set, and only values the API offered. */
export function dashboardQuery(
  filters: DashboardFilters,
  options?: Dashboard['filterOptions'] | null,
): { ownerId?: string; propertyId?: string; region?: string; unitType?: string } {
  const query: { ownerId?: string; propertyId?: string; region?: string; unitType?: string } = {};
  if (
    UUID.test(filters.ownerId) &&
    (!options || options.owners.some((o) => o.id === filters.ownerId))
  )
    query.ownerId = filters.ownerId;
  if (
    UUID.test(filters.propertyId) &&
    (!options || options.properties.some((p) => p.id === filters.propertyId))
  )
    query.propertyId = filters.propertyId;
  const region = filters.region.trim().slice(0, 60);
  if (region && (!options || options.regions.includes(region))) query.region = region;
  const unitType = filters.unitType.trim().slice(0, 40);
  if (unitType && (!options || options.unitTypes.includes(unitType))) query.unitType = unitType;
  return query;
}

export const anyFilter = (filters: DashboardFilters): boolean =>
  Object.values(filters).some((v) => v.trim() !== '');

/** DA-02: the expiry rows in order, 3, 6 and 12 months, with those not yet offered a renewal. */
export function expiryRows(expiries: Dashboard['expiries']): {
  withinMonths: 3 | 6 | 12;
  leases: number;
  renewalOffered: number;
  renewed: number;
  notOffered: number;
}[] {
  return [3, 6, 12]
    .map((m) => expiries.find((e) => e.withinMonths === m))
    .filter((e): e is Dashboard['expiries'][number] => e !== undefined)
    .map((e) => ({
      withinMonths: e.withinMonths,
      leases: e.leases,
      renewalOffered: e.renewalOffered,
      renewed: e.renewed,
      notOffered: Math.max(e.leases - e.renewalOffered - e.renewed, 0),
    }));
}

// Exports (DA-06) ---------------------------------------------------------------------------

export type DashboardExport = Awaited<ReturnType<ApiClient['dashboard']['exportGet']>>;

/** What to do with an export's latest state: open it, wait and ask again, or say it failed. */
export function exportNext(
  exported: Pick<DashboardExport, 'status' | 'url'>,
): 'open' | 'wait' | 'failed' {
  if (exported.status === 'failed') return 'failed';
  if (exported.status === 'ready' && exported.url) return 'open';
  return 'wait';
}

export const EXPORT_POLL_MS = 2_000;
export const EXPORT_POLL_TRIES = 30;

// Gate 1 (PRD section 19; decisions 9 and 10) ---------------------------------------------------

export interface Gate1Row {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly bps: number | null;
}

/** The six Gate 1 measures as rows: the share, and the counts or amounts behind it. */
export function gate1Rows(g: Gate1): Gate1Row[] {
  return [
    {
      key: 'collection',
      label: 'Collection rate',
      value: ratioText(g.collectionRate.rate),
      detail: `${formatMinor(g.collectionRate.collectedMinor)} collected of ${formatMinor(g.collectionRate.dueMinor)} due`,
      bps: g.collectionRate.rate.bps,
    },
    {
      key: 'digital',
      label: 'Paid digitally',
      value: ratioText(g.digitalShare.share),
      detail: `${formatMinor(g.digitalShare.digitalMinor)} by mobile money, card or bank, of ${formatMinor(g.digitalShare.totalMinor)}`,
      bps: g.digitalShare.share.bps,
    },
    {
      key: 'auto_match',
      label: 'Provider payments matched automatically',
      value: ratioText(g.autoMatch.provider.rate),
      detail: `${g.autoMatch.provider.automatic} automatically, ${g.autoMatch.provider.byPerson} by a person, ${g.autoMatch.provider.unmatched} unmatched`,
      bps: g.autoMatch.provider.rate.bps,
    },
    {
      key: 'direct',
      label: 'Direct transfers matched to a lease',
      value: ratioText(g.autoMatch.directTransfers.rate),
      detail: `${g.autoMatch.directTransfers.againstLease} matched, ${g.autoMatch.directTransfers.unmatched} unmatched`,
      bps: g.autoMatch.directTransfers.rate.bps,
    },
    {
      key: 'receipt',
      label: 'Receipts sent within a minute',
      value: ratioText(g.timeToReceipt.share),
      detail: `${g.timeToReceipt.withinTarget} of ${g.timeToReceipt.receipts} receipts; median ${durationText(g.timeToReceipt.medianMs)}, 95th percentile ${durationText(g.timeToReceipt.p95Ms)}`,
      bps: g.timeToReceipt.share.bps,
    },
    {
      key: 'notice',
      label: 'Notices e-signed within 7 days',
      value: ratioText(g.noticeAcknowledgement.rate),
      detail: `${g.noticeAcknowledgement.met} signed in time, ${g.noticeAcknowledgement.missed} not, ${g.noticeAcknowledgement.pending} still within the 7 days`,
      bps: g.noticeAcknowledgement.rate.bps,
    },
    {
      key: 'repair',
      label: 'Emergency repairs started within target',
      value: ratioText(g.repairResponse.rate),
      detail: `${g.repairResponse.met} in time, ${g.repairResponse.missed} late, ${g.repairResponse.pending} still within target`,
      bps: g.repairResponse.rate.bps,
    },
  ];
}
