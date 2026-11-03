import { DomainError } from '../errors';
import { accountAllowedIn, type AccountCode, type BookKind } from './accounts';

/** The posting rules (architecture section 5). M4a posts P01 to P10, P21, P23, P24, P27 to P29 and P32. */
export const POSTING_RULES = [
  'P01',
  'P02',
  'P03',
  'P04',
  'P05',
  'P06',
  'P07',
  'P08',
  'P09',
  'P10',
  'P11',
  'P12',
  'P13',
  'P14',
  'P15',
  'P16',
  'P17',
  'P18',
  'P19',
  'P20',
  'P21',
  'P22',
  'P23',
  'P24',
  'P25',
  'P26',
  'P27',
  'P28',
  'P29',
  'P30',
  'P31',
  'P32',
  'P33',
] as const;
export type PostingRule = (typeof POSTING_RULES)[number];

/**
 * Dimensions on a journal line. They form the sub-ledgers: there are no per-tenant accounts
 * (architecture section 4).
 */
export interface LineDimensions {
  readonly propertyId?: string | null;
  readonly unitId?: string | null;
  readonly leaseId?: string | null;
  readonly tenantId?: string | null;
  readonly invoiceLineId?: string | null;
  readonly paymentId?: string | null;
  readonly collectorId?: string | null;
  readonly provider?: string | null;
  readonly settlementAccountId?: string | null;
  readonly settlementId?: string | null;
}

export const DIMENSION_KEYS = [
  'propertyId',
  'unitId',
  'leaseId',
  'tenantId',
  'invoiceLineId',
  'paymentId',
  'collectorId',
  'provider',
  'settlementAccountId',
  'settlementId',
] as const satisfies readonly (keyof LineDimensions)[];

/** One journal line: debit positive, credit negative, in minor units (ADR-003, ADR-004). */
export interface JournalLineDraft extends LineDimensions {
  readonly bookId: string;
  readonly accountCode: AccountCode;
  readonly amountMinor: number;
}

/**
 * Checks an entry before it is written (invariant 1): two lines or more, each a non-zero safe
 * integer, each account allowed in its kind of book, and a zero sum within every book. The
 * database checks the zero sum again at commit.
 */
export function checkEntry(
  lines: readonly JournalLineDraft[],
  bookKind: (bookId: string) => BookKind,
): void {
  if (lines.length < 2)
    throw new DomainError('ledger.too_few_lines', 'A journal entry needs two lines or more');
  const totals = new Map<string, bigint>();
  for (const line of lines) {
    if (!Number.isSafeInteger(line.amountMinor) || line.amountMinor === 0)
      throw new DomainError(
        'ledger.bad_amount',
        'Every journal line is a non-zero whole number of pesewas',
      );
    if (!accountAllowedIn(line.accountCode, bookKind(line.bookId)))
      throw new DomainError(
        'ledger.account_not_in_book',
        `Account ${line.accountCode} cannot be used in a ${bookKind(line.bookId)} book`,
      );
    totals.set(line.bookId, (totals.get(line.bookId) ?? 0n) + BigInt(line.amountMinor));
  }
  for (const [bookId, total] of totals)
    if (total !== 0n)
      throw new DomainError(
        'ledger.unbalanced',
        `The entry does not balance in book ${bookId} (off by ${total} pesewas)`,
      );
}

/**
 * Drops zero lines and merges lines that share a book, an account and every dimension, so a
 * posting function can build its lines simply. The order of first appearance is kept.
 */
export function compactLines(lines: readonly JournalLineDraft[]): JournalLineDraft[] {
  const merged = new Map<string, JournalLineDraft>();
  for (const line of lines) {
    if (line.amountMinor === 0) continue;
    const key = [line.bookId, line.accountCode, ...DIMENSION_KEYS.map((k) => line[k] ?? '')].join(
      '|',
    );
    const existing = merged.get(key);
    merged.set(
      key,
      existing ? { ...existing, amountMinor: existing.amountMinor + line.amountMinor } : line,
    );
  }
  return [...merged.values()].filter((l) => l.amountMinor !== 0);
}

/** P21(a): a correction of an entry nothing has used since: every line, sign flipped. */
export function reversalLines(lines: readonly JournalLineDraft[]): JournalLineDraft[] {
  return lines.map((line) => ({ ...line, amountMinor: -line.amountMinor }));
}

/**
 * The balance of the lines that match a filter: an in-memory query for tests and checks. A filter
 * value of null matches lines without that dimension.
 */
export function balanceOf(
  lines: readonly JournalLineDraft[],
  filter: Partial<Pick<JournalLineDraft, 'bookId' | 'accountCode'>> & LineDimensions,
): number {
  const wanted = Object.entries(filter).filter(([, value]) => value !== undefined);
  let total = 0n;
  for (const line of lines) {
    const fields = line as unknown as Record<string, unknown>;
    if (wanted.every(([key, value]) => (fields[key] ?? null) === value))
      total += BigInt(line.amountMinor);
  }
  return Number(total);
}
