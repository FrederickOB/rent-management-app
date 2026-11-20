import { compareDates, parseBusinessDate, toIsoDate } from '../dates';
import { DomainError } from '../errors';
import type { ConsentChannel } from '../messaging/channels';
import { parseAmount } from '../money/money';
import { normalisePhone, type E164 } from '../phone/phone';
import { checkUnitLabel, parseUnitCode } from '../portfolio/codes';
import { cellText, type ImportIssue } from '../portfolio/import-rows';
import { checkOwnerReference, OWNER_KINDS, type OwnerKind } from '../portfolio/owners';
import { checkIdNumber, checkTin, ID_TYPES, type IdType } from '../tenancy/identity-numbers';
import {
  checkLeaseTerms,
  LEASE_USES,
  MAX_NOTICE_DAYS,
  RENT_CYCLE_LABELS,
  RENT_CYCLES,
  type LeaseUse,
  type RentCycle,
} from '../tenancy/lease-terms';
import { BALANCE_SHEETS, TENANCY_SHEETS } from './constants';

/**
 * The row rules of the onboarding workbooks (M11 decisions 2 and 3; plan 4.1 and 4.2): given the
 * cells of each sheet, the typed rows and every problem by sheet, row and column, in the register
 * import's shape (PR-08). Pure: what needs the database (owners, units, tenants and leases already
 * recorded, a unit's active lease, what an opening item has had paid or drawn) is the server's.
 * Row numbers are spreadsheet rows: the header is row 1. Amounts are integer pesewas, parsed
 * exactly by packages/domain/money; dates are business dates (`YYYY-MM-DD`, or a date cell).
 *
 * Every row carries a matching key, so importing the same file again finds the same records and
 * the server can count what a commit creates, updates or leaves unchanged. Keys hold phone numbers
 * and TINs: keep them in memory, never in a log.
 *
 * Messages never repeat a cell's value, so a report never copies a phone, ID number or TIN.
 */

/** The sheets of the onboarding workbooks. Owners is the register import's step 1 sheet. */
export const ONBOARDING_SHEETS = {
  owners: 'Owners',
  tenants: TENANCY_SHEETS[0],
  leases: TENANCY_SHEETS[1],
  arrears: BALANCE_SHEETS[0],
  advances: BALANCE_SHEETS[1],
  deposits: BALANCE_SHEETS[2],
  withholding: BALANCE_SHEETS[3],
  ownerItems: BALANCE_SHEETS[4],
} as const;
export type OnboardingSheetKey = keyof typeof ONBOARDING_SHEETS;

/** The most rows a sheet may hold: 5,000 units' tenancies, and several periods per lease. */
export const MAX_ONBOARDING_ROWS: Readonly<Record<OnboardingSheetKey, number>> = {
  owners: 1_000,
  tenants: 5_000,
  leases: 5_000,
  arrears: 30_000,
  advances: 5_000,
  deposits: 5_000,
  withholding: 30_000,
  ownerItems: 1_000,
};

/** A sheet's column: `required` means the header must be there; cells have their own rules. */
export interface OnboardingColumn {
  readonly key: string;
  readonly header: string;
  readonly required: boolean;
  readonly example: string;
}

export const OWNER_COLUMNS = [
  { key: 'reference', header: 'Owner reference', required: true, example: 'OWN-01' },
  { key: 'kind', header: 'Kind', required: true, example: 'Individual' },
  { key: 'displayName', header: 'Name', required: true, example: 'Ama Owusu' },
  { key: 'legalName', header: 'Legal name', required: false, example: '' },
  { key: 'phone', header: 'Phone', required: false, example: '024 000 0001' },
  { key: 'email', header: 'Email', required: false, example: '' },
  { key: 'tin', header: 'TIN', required: false, example: '' },
] as const satisfies readonly OnboardingColumn[];

export const TENANT_COLUMNS = [
  { key: 'kind', header: 'Kind', required: true, example: 'Individual' },
  { key: 'name', header: 'Name', required: true, example: 'Kofi Asante' },
  { key: 'legalName', header: 'Legal name', required: false, example: '' },
  { key: 'phone', header: 'Phone', required: true, example: '024 000 0002' },
  { key: 'whatsappPhone', header: 'WhatsApp phone', required: false, example: '' },
  { key: 'email', header: 'Email', required: false, example: '' },
  { key: 'occupation', header: 'Occupation or business type', required: false, example: '' },
  { key: 'registrationNumber', header: 'Registration number', required: false, example: '' },
  { key: 'tin', header: 'TIN', required: false, example: '' },
  { key: 'idType', header: 'ID type', required: false, example: '' },
  { key: 'idNumber', header: 'ID number', required: false, example: '' },
  { key: 'idCountry', header: 'ID country', required: false, example: '' },
  { key: 'consentWhatsapp', header: 'WhatsApp consent', required: false, example: 'Yes' },
  { key: 'consentSms', header: 'SMS consent', required: false, example: 'Yes' },
  { key: 'consentEmail', header: 'Email consent', required: false, example: 'No' },
] as const satisfies readonly OnboardingColumn[];

export const LEASE_COLUMNS = [
  { key: 'unit', header: 'Unit', required: true, example: 'ACC-LEG-B1-04' },
  { key: 'tenantPhone', header: 'Tenant phone', required: false, example: '024 000 0002' },
  { key: 'tenantName', header: 'Tenant name', required: false, example: 'Kofi Asante' },
  { key: 'tenantTin', header: 'Tenant TIN', required: false, example: '' },
  { key: 'startDate', header: 'Start date', required: true, example: '2026-01-01' },
  { key: 'endDate', header: 'End date', required: true, example: '2026-12-31' },
  { key: 'monthlyRent', header: 'Monthly rent', required: true, example: '1500' },
  { key: 'cycle', header: 'Rent cycle', required: true, example: 'Annually' },
  { key: 'deposit', header: 'Deposit', required: false, example: '' },
  { key: 'serviceCharge', header: 'Monthly service charge', required: false, example: '' },
  { key: 'use', header: 'Use', required: false, example: 'Residential' },
  { key: 'noticeDays', header: 'Notice days', required: true, example: '90' },
  { key: 'signedOn', header: 'Signed on', required: true, example: '2025-12-15' },
] as const satisfies readonly OnboardingColumn[];

/** Every Balances sheet names its lease by unit and start date, as the Leases sheet does. */
const LEASE_REF_COLUMNS = [
  { key: 'unit', header: 'Unit', required: true, example: 'ACC-LEG-B1-04' },
  { key: 'leaseStart', header: 'Lease start', required: true, example: '2026-01-01' },
] as const satisfies readonly OnboardingColumn[];

export const ARREARS_COLUMNS = [
  ...LEASE_REF_COLUMNS,
  { key: 'periodStart', header: 'Period start', required: true, example: '2026-09-01' },
  { key: 'kind', header: 'Kind', required: true, example: 'Rent' },
  { key: 'amount', header: 'Amount', required: true, example: '1500' },
  { key: 'dueDate', header: 'Due date', required: false, example: '2026-09-01' },
] as const satisfies readonly OnboardingColumn[];

export const ADVANCE_COLUMNS = [
  ...LEASE_REF_COLUMNS,
  { key: 'amount', header: 'Amount', required: false, example: '' },
  { key: 'paidThrough', header: 'Paid through', required: false, example: '2026-12-31' },
] as const satisfies readonly OnboardingColumn[];

export const DEPOSIT_COLUMNS = [
  ...LEASE_REF_COLUMNS,
  { key: 'amount', header: 'Amount held', required: true, example: '3000' },
] as const satisfies readonly OnboardingColumn[];

export const WITHHOLDING_COLUMNS = [
  ...LEASE_REF_COLUMNS,
  { key: 'amount', header: 'Amount', required: true, example: '120' },
  { key: 'withheldOn', header: 'Withheld on', required: false, example: '2026-10-05' },
  { key: 'periodStart', header: 'Period start', required: true, example: '2026-10-01' },
] as const satisfies readonly OnboardingColumn[];

export const OWNER_ITEM_COLUMNS = [
  { key: 'owner', header: 'Owner reference', required: true, example: 'OWN-01' },
  { key: 'agentCash', header: 'Agent-held cash', required: false, example: '' },
  { key: 'rentTax', header: 'Rent tax outstanding', required: false, example: '' },
  { key: 'rentTaxDueOn', header: 'Rent tax due date', required: false, example: '' },
] as const satisfies readonly OnboardingColumn[];

/** A workbook's sheet: its name and its columns, in order. */
export interface OnboardingWorkbookSheet {
  readonly key: OnboardingSheetKey;
  readonly sheet: string;
  readonly columns: readonly OnboardingColumn[];
}

const BALANCE_WORKBOOK: readonly OnboardingWorkbookSheet[] = [
  { key: 'arrears', sheet: ONBOARDING_SHEETS.arrears, columns: ARREARS_COLUMNS },
  { key: 'advances', sheet: ONBOARDING_SHEETS.advances, columns: ADVANCE_COLUMNS },
  { key: 'deposits', sheet: ONBOARDING_SHEETS.deposits, columns: DEPOSIT_COLUMNS },
  { key: 'withholding', sheet: ONBOARDING_SHEETS.withholding, columns: WITHHOLDING_COLUMNS },
  { key: 'ownerItems', sheet: ONBOARDING_SHEETS.ownerItems, columns: OWNER_ITEM_COLUMNS },
];

/**
 * Every onboarding workbook, sheet by sheet with its headers in order. The template generator and
 * the e2e specs both build from this, so they cannot drift. `register` is the sheet the register
 * import gains (its Properties and Units sheets are `IMPORT_SHEETS` in portfolio). The adjustment
 * workbook has the Balances sheets and headers, with signed amounts (a minus sign lowers); an
 * advance there is an amount only.
 */
export const ONBOARDING_WORKBOOKS: Readonly<
  Record<'register' | 'tenancies' | 'balances' | 'adjustment', readonly OnboardingWorkbookSheet[]>
> = {
  register: [{ key: 'owners', sheet: ONBOARDING_SHEETS.owners, columns: OWNER_COLUMNS }],
  tenancies: [
    { key: 'tenants', sheet: ONBOARDING_SHEETS.tenants, columns: TENANT_COLUMNS },
    { key: 'leases', sheet: ONBOARDING_SHEETS.leases, columns: LEASE_COLUMNS },
  ],
  balances: BALANCE_WORKBOOK,
  adjustment: BALANCE_WORKBOOK,
};

/** A workbook's sheet names and header rows, for building a file (`[sheet, headers]`). */
export const onboardingWorkbookHeaders = (
  workbook: keyof typeof ONBOARDING_WORKBOOKS,
): { sheet: string; headers: string[] }[] =>
  ONBOARDING_WORKBOOKS[workbook].map((s) => ({
    sheet: s.sheet,
    headers: s.columns.map((c) => c.header),
  }));

/** A sheet's non-empty rows, as the server maps them from the header (the register's shape). */
export type OnboardingSheetRows = readonly {
  readonly row: number;
  readonly values: Readonly<Record<string, unknown>>;
}[];

export interface CheckedRows<T> {
  readonly rows: T[];
  readonly issues: ImportIssue[];
}

// Matching keys -------------------------------------------------------------------------------

const nameKey = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, ' ');

/** Owners are matched by reference (decision 2). */
export const ownerMatchKey = (reference: string): string => `owner:${reference}`;
/** Tenants are matched by phone (E.164) within the company… */
export const tenantPhoneKey = (phone: string): string => `tenant:phone:${phone}`;
/** …or, for a company tenant, by name (ignoring case and spacing) and TIN. */
export const companyTenantKey = (name: string, tin: string): string =>
  `tenant:company:${nameKey(name)}|${tin}`;
/** Leases are matched by unit and start date; the Balances sheets name them the same way. */
export const leaseMatchKey = (unitCode: string, startDate: string): string =>
  `lease:${unitCode}|${startDate}`;
export const arrearsMatchKey = (leaseKey: string, periodStart: string, kind: ArrearsKind) =>
  `arrears:${leaseKey}|${periodStart}|${kind}`;
export const advanceMatchKey = (leaseKey: string): string => `advance:${leaseKey}`;
export const depositMatchKey = (leaseKey: string): string => `deposit:${leaseKey}`;
export const withholdingMatchKey = (leaseKey: string, periodStart: string): string =>
  `withholding:${leaseKey}|${periodStart}`;
export const ownerItemsMatchKey = (reference: string): string => `owner-items:${reference}`;

// Reading cells -------------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_HINT = 'Use a date such as 2026-11-01';
const AMOUNT_HINT = 'Enter an amount such as 1500 or 1500.50, with at most two decimal places';
const YES = new Set(['yes', 'y', 'true']);
const NO = new Set(['no', 'n', 'false']);

const listKey = (text: string) =>
  text
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')
    .trim();

/** Matches a list value by its id or its label, ignoring case and spacing (as PR-08 does). */
function fromList<T extends string>(
  text: string,
  values: readonly T[],
  labels: Readonly<Record<T, string>>,
): T | null {
  const wanted = listKey(text);
  return (
    values.find((v) => v.replace(/_/g, ' ') === wanted || listKey(labels[v]) === wanted) ?? null
  );
}

const before = (a: string, b: string) =>
  compareDates(parseBusinessDate(a), parseBusinessDate(b)) < 0;

/** `positive`: above zero. `nonNegative`: zero or more. `signed`: a change other than zero. */
type Sign = 'positive' | 'nonNegative' | 'signed';

class CellReader {
  readonly issues: ImportIssue[] = [];
  constructor(
    private readonly sheet: string,
    private readonly row: number,
    private readonly values: Readonly<Record<string, unknown>>,
    private readonly headers: Readonly<Record<string, string>>,
  ) {}

  problem(column: string | null, message: string): void {
    this.issues.push({
      sheet: this.sheet,
      row: this.row,
      column: column ? (this.headers[column] ?? column) : null,
      message,
    });
  }

  has(column: string): boolean {
    return cellText(this.values[column]) != null;
  }

  text(column: string, required: boolean, max: number, min = 1): string | null {
    const text = cellText(this.values[column]);
    if (!text) {
      if (required) this.problem(column, 'Required');
      return null;
    }
    if (text.length > max) {
      this.problem(column, `At most ${max} characters`);
      return null;
    }
    if (text.length < min) {
      this.problem(column, `At least ${min} characters`);
      return null;
    }
    return text;
  }

  /** Runs a domain check; a DomainError becomes an issue on this cell. */
  check<T>(column: string | null, fn: () => T): T | null {
    try {
      return fn();
    } catch (error) {
      if (error instanceof DomainError) {
        this.problem(column, error.message);
        return null;
      }
      throw error;
    }
  }

  oneOf<T extends string>(
    column: string,
    required: boolean,
    values: readonly T[],
    labels: Readonly<Record<T, string>>,
  ): T | null {
    const text = this.text(column, required, 60);
    if (!text) return null;
    const value = fromList(text, values, labels);
    if (!value) this.problem(column, 'Use one of the values on the Lists sheet');
    return value;
  }

  date(column: string, required: boolean): string | null {
    const text = cellText(this.values[column]);
    if (!text) {
      if (required) this.problem(column, 'Required');
      return null;
    }
    if (ISO_DATE.test(text))
      try {
        return toIsoDate(parseBusinessDate(text));
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
      }
    this.problem(column, DATE_HINT);
    return null;
  }

  /**
   * An amount in pesewas, parsed exactly. `positive`: above zero (a minus sign belongs in the
   * adjustment workbook). `nonNegative`: zero or more. `signed`: a change other than zero, where
   * a minus sign lowers.
   */
  amount(column: string, required: boolean, sign: Sign): number | null {
    const text = cellText(this.values[column]);
    if (!text) {
      if (required) this.problem(column, 'Required');
      return null;
    }
    const cleaned = text.replace(/^(-?)\s*(?:GH₵|GH¢|GHS|GHC|₵)\s*/i, '$1');
    let minor: number;
    try {
      minor = parseAmount(cleaned).amountMinor;
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      this.problem(column, AMOUNT_HINT);
      return null;
    }
    if (sign === 'positive' && minor <= 0) {
      this.problem(
        column,
        minor < 0
          ? 'Amounts here are above zero; lower an amount with the adjustment workbook'
          : 'Enter an amount above zero, or leave it out',
      );
      return null;
    }
    if (sign === 'nonNegative' && minor < 0) {
      this.problem(column, 'Enter an amount of zero or more');
      return null;
    }
    if (sign === 'signed' && minor === 0) {
      this.problem(column, 'Enter a change other than zero; a minus sign lowers');
      return null;
    }
    return minor;
  }

  wholeNumber(column: string, required: boolean, max: number): number | null {
    const text = cellText(this.values[column]);
    if (!text) {
      if (required) this.problem(column, 'Required');
      return null;
    }
    if (!/^\d+$/.test(text) || Number(text) > max) {
      this.problem(column, `Enter a whole number from 0 to ${max}`);
      return null;
    }
    return Number(text);
  }

  /** Yes or no; blank is null (nothing to record). */
  yesNo(column: string): boolean | null {
    const text = cellText(this.values[column]);
    if (!text) return null;
    const value = text.toLowerCase();
    if (YES.has(value)) return true;
    if (NO.has(value)) return false;
    this.problem(column, 'Use Yes or No, or leave it blank');
    return null;
  }

  phone(column: string, required: boolean): E164 | null {
    const text = this.text(column, required, 30);
    return text ? this.check(column, () => normalisePhone(text)) : null;
  }

  email(column: string): string | null {
    const text = this.text(column, false, 254);
    if (!text) return null;
    const value = text.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      this.problem(column, 'Enter a valid email address');
      return null;
    }
    return value;
  }

  tin(column: string): string | null {
    const text = this.text(column, false, 30);
    return text ? this.check(column, () => checkTin(text)) : null;
  }

  unitCode(column: string): string | null {
    const text = this.text(column, true, 20);
    if (!text) return null;
    const parts = parseUnitCode(text.toUpperCase().replace(/\s/g, ''));
    const label = parts ? this.check(column, () => checkUnitLabel(parts.unit)) : null;
    if (!parts || !label) {
      if (!parts) this.problem(column, 'Use a unit code such as ACC-LEG-B1-04');
      return null;
    }
    return `${parts.area}-${parts.property}-${parts.block}-${label}`;
  }
}

const headersOf = (columns: readonly OnboardingColumn[]) =>
  Object.fromEntries(columns.map((c) => [c.key, c.header]));

function tooMany(sheet: OnboardingSheetKey, count: number): ImportIssue[] {
  const max = MAX_ONBOARDING_ROWS[sheet];
  return count > max
    ? [{ sheet: ONBOARDING_SHEETS[sheet], row: null, column: null, message: `At most ${max} rows` }]
    : [];
}

/** Remembers the first row of each key; a later row with the same key is a duplicate. */
class FirstRows {
  private readonly seen = new Map<string, number>();
  /** The earlier row with this key, or null (and the key is now this row's). */
  claim(key: string, row: number): number | null {
    const first = this.seen.get(key);
    if (first !== undefined) return first;
    this.seen.set(key, row);
    return null;
  }
}

// Step 1: the Owners sheet (register import, for agencies) --------------------------------------

const OWNER_KIND_LABELS: Record<OwnerKind, string> = {
  individual: 'Individual',
  company: 'Company',
};

export interface OwnerImportRow {
  readonly row: number;
  readonly reference: string;
  readonly kind: OwnerKind;
  readonly displayName: string;
  /** Blank optional cells are null: an owner already recorded keeps what it has. */
  readonly legalName: string | null;
  readonly phone: E164 | null;
  readonly email: string | null;
  /** Stored encrypted by the server; null keeps an existing owner's TIN. */
  readonly tin: string | null;
  readonly matchKey: string;
}

/**
 * The register import's Owners sheet (M11 decision 2, step 1; PR-08): an agency's owners, matched
 * by reference, so the Properties sheet can name them in the same file. The server reads it before
 * the Properties sheet; the property and unit rules are unchanged.
 */
export function checkOwnerRows(rows: OnboardingSheetRows): CheckedRows<OwnerImportRow> {
  const sheet = ONBOARDING_SHEETS.owners;
  const headers = headersOf(OWNER_COLUMNS);
  const out: OwnerImportRow[] = [];
  const issues = tooMany('owners', rows.length);
  const first = new FirstRows();
  for (const { row, values } of rows) {
    const r = new CellReader(sheet, row, values, headers);
    const referenceText = r.text('reference', true, 20);
    const reference = referenceText
      ? r.check('reference', () => checkOwnerReference(referenceText))
      : null;
    if (reference) {
      const earlier = first.claim(ownerMatchKey(reference), row);
      if (earlier) r.problem('reference', `Owner ${reference} is already on row ${earlier}`);
    }
    const kind = r.oneOf('kind', true, OWNER_KINDS, OWNER_KIND_LABELS);
    const displayName = r.text('displayName', true, 120, 2);
    const legalName = r.text('legalName', false, 160);
    const phone = r.phone('phone', false);
    const email = r.email('email');
    const tin = r.tin('tin');
    issues.push(...r.issues);
    if (r.issues.length || !reference || !kind || !displayName) continue;
    out.push({
      row,
      reference,
      kind,
      displayName,
      legalName,
      phone,
      email,
      tin,
      matchKey: ownerMatchKey(reference),
    });
  }
  return { rows: out, issues };
}

/** The owner fields an import row can change. */
export interface OwnerImportFields {
  readonly kind: OwnerKind;
  readonly displayName: string;
  readonly legalName: string | null;
  readonly phone: string | null;
  readonly email: string | null;
}

/**
 * What a row leaves on an owner already recorded: a blank optional cell keeps the owner's value,
 * so a re-import never wipes a phone or an email (as PR-08 does for properties). The TIN works the
 * same way (null keeps it), on the server, because it is stored encrypted.
 */
export function ownerFieldsAfterImport(
  existing: OwnerImportFields,
  row: OwnerImportRow,
): OwnerImportFields {
  return {
    kind: row.kind,
    displayName: row.displayName,
    legalName: row.legalName ?? existing.legalName,
    phone: row.phone ?? existing.phone,
    email: row.email ?? existing.email,
  };
}

// Step 2: the Tenants sheet --------------------------------------------------------------------

export const IMPORT_TENANT_KINDS = ['individual', 'company'] as const;
export type ImportTenantKind = (typeof IMPORT_TENANT_KINDS)[number];
const TENANT_KIND_LABELS: Record<ImportTenantKind, string> = {
  individual: 'Individual',
  company: 'Company',
};
const ID_TYPE_LABELS: Record<IdType, string> = { ghana_card: 'Ghana Card', passport: 'Passport' };

/** The channels the Tenants sheet records consent on; push is granted in the app only. */
export const IMPORT_CONSENT_CHANNELS = [
  'whatsapp',
  'sms',
  'email',
] as const satisfies readonly ConsentChannel[];
export type ImportConsentChannel = (typeof IMPORT_CONSENT_CHANNELS)[number];
const CONSENT_COLUMN: Record<ImportConsentChannel, string> = {
  whatsapp: 'consentWhatsapp',
  sms: 'consentSms',
  email: 'consentEmail',
};

export interface TenantImportRow {
  readonly row: number;
  readonly kind: ImportTenantKind;
  readonly displayName: string;
  /** Blank optional cells are null: a tenant already recorded keeps what it has. */
  readonly legalName: string | null;
  readonly phone: E164 | null;
  readonly whatsappPhone: E164 | null;
  readonly email: string | null;
  /** The occupation column, for an individual. */
  readonly occupation: string | null;
  /** The same column, for a company. */
  readonly businessType: string | null;
  readonly registrationNumber: string | null;
  /** Stored encrypted by the server. */
  readonly tin: string | null;
  /** Optional; encrypted on write by the server, never logged. */
  readonly identity: {
    readonly type: IdType;
    readonly number: string;
    readonly country: string;
  } | null;
  /**
   * Consent per channel, recorded like the new-tenant form's ticks with the import as its source
   * (decision 2): true grants, false withdraws, null records nothing.
   */
  readonly consent: Readonly<Record<ImportConsentChannel, boolean | null>>;
  /** The key the tenant is matched by: its phone, or a company's name and TIN. */
  readonly matchKey: string;
  /** Every key that names it (phone, and name and TIN for a company with a TIN), for the Leases sheet. */
  readonly keys: readonly string[];
}

/**
 * The Tenants sheet (decision 2, step 2; TL-01, CM-09): individuals and companies, matched by
 * phone within the company, or by name and TIN for a company tenant. An individual needs a phone;
 * a company a phone or a TIN. Registration details are for companies. Consent is a Yes or No per
 * channel, and needs the address it is for.
 */
export function checkTenantRows(rows: OnboardingSheetRows): CheckedRows<TenantImportRow> {
  const sheet = ONBOARDING_SHEETS.tenants;
  const headers = headersOf(TENANT_COLUMNS);
  const out: TenantImportRow[] = [];
  const issues = tooMany('tenants', rows.length);
  const first = new FirstRows();
  for (const { row, values } of rows) {
    const r = new CellReader(sheet, row, values, headers);
    const kind = r.oneOf('kind', true, IMPORT_TENANT_KINDS, TENANT_KIND_LABELS);
    const company = kind === 'company';
    const displayName = r.text('name', true, 160, 2);
    const legalName = r.text('legalName', false, 200);
    const phone = r.phone('phone', false);
    const whatsappPhone = r.phone('whatsappPhone', false);
    const email = r.email('email');
    const occupation = r.text('occupation', false, 120);
    const registrationNumber = r.text('registrationNumber', false, 40);
    const tin = r.tin('tin');
    if (kind === 'individual') {
      if (!r.has('phone')) r.problem('phone', 'Required: tenants are matched by their phone');
      if (legalName) r.problem('legalName', 'For company tenants only');
      if (registrationNumber) r.problem('registrationNumber', 'For company tenants only');
    }
    if (company && !r.has('phone') && !r.has('tin'))
      r.problem('phone', 'Give the phone or the TIN, so the tenant can be matched');

    const idTypeValue = r.oneOf('idType', false, ID_TYPES, ID_TYPE_LABELS);
    const idNumber = r.text('idNumber', false, 32);
    const idCountry = r.text('idCountry', false, 2);
    let identity: TenantImportRow['identity'] = null;
    if (idTypeValue && idNumber)
      identity = r.check('idNumber', () => {
        const checked = checkIdNumber(idTypeValue, idNumber, idCountry);
        return { type: idTypeValue, number: checked.number, country: checked.country };
      });
    else if (idNumber && !r.has('idType')) r.problem('idType', 'Give the ID type with the number');
    else if (idTypeValue && !idNumber) r.problem('idNumber', 'Give the ID number with its type');

    const consent = {} as Record<ImportConsentChannel, boolean | null>;
    for (const channel of IMPORT_CONSENT_CHANNELS)
      consent[channel] = r.yesNo(CONSENT_COLUMN[channel]);
    if (consent.whatsapp && !r.has('phone') && !r.has('whatsappPhone'))
      r.problem('consentWhatsapp', 'WhatsApp consent needs a phone or a WhatsApp phone');
    if (consent.sms && !r.has('phone')) r.problem('consentSms', 'SMS consent needs a phone');
    if (consent.email && !r.has('email')) r.problem('consentEmail', 'Email consent needs an email');

    const keys: string[] = [];
    if (phone) keys.push(tenantPhoneKey(phone));
    if (company && displayName && tin) keys.push(companyTenantKey(displayName, tin));
    for (const key of keys) {
      const earlier = first.claim(key, row);
      if (earlier)
        r.problem(
          key.startsWith('tenant:phone:') ? 'phone' : 'tin',
          `This tenant is already on row ${earlier}`,
        );
    }
    issues.push(...r.issues);
    if (r.issues.length || !kind || !displayName || keys.length === 0) continue;
    out.push({
      row,
      kind,
      displayName,
      legalName: company ? legalName : null,
      phone,
      whatsappPhone,
      email,
      occupation: company ? null : occupation,
      businessType: company ? occupation : null,
      registrationNumber: company ? registrationNumber : null,
      tin,
      identity,
      consent,
      matchKey: keys[0]!,
      keys,
    });
  }
  return { rows: out, issues };
}

/** The tenant fields an import row can change. */
export interface TenantImportFields {
  readonly displayName: string;
  readonly legalName: string | null;
  readonly phone: string | null;
  readonly whatsappPhone: string | null;
  readonly email: string | null;
  readonly occupation: string | null;
  readonly businessType: string | null;
  readonly registrationNumber: string | null;
}

/**
 * What a row leaves on a tenant already recorded: a blank optional cell keeps the tenant's value,
 * so a re-import never wipes an address. The name always comes from the row. The TIN and ID
 * number work the same way (null keeps them), on the server, because they are stored encrypted.
 */
export function tenantFieldsAfterImport(
  existing: TenantImportFields,
  row: TenantImportRow,
): TenantImportFields {
  return {
    displayName: row.displayName,
    legalName: row.legalName ?? existing.legalName,
    phone: row.phone ?? existing.phone,
    whatsappPhone: row.whatsappPhone ?? existing.whatsappPhone,
    email: row.email ?? existing.email,
    occupation: row.occupation ?? existing.occupation,
    businessType: row.businessType ?? existing.businessType,
    registrationNumber: row.registrationNumber ?? existing.registrationNumber,
  };
}

// Step 2: the Leases sheet ---------------------------------------------------------------------

/** How a Leases row names its tenant: by phone, or by a company tenant's name and TIN. */
export type LeaseTenantRef =
  | { readonly by: 'phone'; readonly phone: E164 }
  | { readonly by: 'name_and_tin'; readonly name: string; readonly tin: string };

export const tenantRefKey = (ref: LeaseTenantRef): string =>
  ref.by === 'phone' ? tenantPhoneKey(ref.phone) : companyTenantKey(ref.name, ref.tin);

const USE_LABELS: Record<LeaseUse, string> = {
  residential: 'Residential',
  commercial: 'Commercial',
};

export interface LeaseImportRow {
  readonly row: number;
  readonly unitCode: string;
  readonly tenant: LeaseTenantRef;
  readonly tenantKey: string;
  /** The Tenants row it names in the same file; null when the server must find it recorded. */
  readonly tenantRow: number | null;
  readonly startDate: string;
  readonly endDate: string;
  readonly monthlyRentMinor: number;
  readonly cycle: RentCycle;
  /** The deposit the lease asks for (the deposit held is a Balances item). */
  readonly depositMinor: number | null;
  readonly serviceChargeMonthlyMinor: number | null;
  /** Null: from the unit's billing band, as a paper lease entered by hand. */
  readonly use: LeaseUse | null;
  readonly noticeDays: number;
  readonly signedOn: string;
  readonly matchKey: string;
}

/** Lease-term problems, on the cell they are about. */
const TERM_COLUMNS: Readonly<Record<string, string>> = {
  'lease.end_before_start': 'endDate',
  'lease.term_too_long': 'endDate',
  'lease.rent_invalid': 'monthlyRent',
  'lease.cycle_invalid': 'cycle',
  'lease.cycle_longer_than_term': 'cycle',
  'lease.deposit_invalid': 'deposit',
  'lease.service_charge_invalid': 'serviceCharge',
  'lease.notice_invalid': 'noticeDays',
  'lease.use_invalid': 'use',
};

/**
 * The Leases sheet (decision 2, step 2; TL-06): leases signed on paper, matched by unit and start
 * date, with the lease-term rules of a lease entered by hand. A tenant is named by phone, or by a
 * company's name and TIN, and found on the Tenants sheet when it is there (`tenants`). Signed on
 * is never after `today`. Two leases on one unit may not overlap: within the file here; against
 * the unit's recorded leases on the server.
 */
export function checkLeaseRows(
  rows: OnboardingSheetRows,
  options: { readonly today: string; readonly tenants?: readonly TenantImportRow[] },
): CheckedRows<LeaseImportRow> {
  const sheet = ONBOARDING_SHEETS.leases;
  const today = toIsoDate(parseBusinessDate(options.today));
  const headers = headersOf(LEASE_COLUMNS);
  const tenantRows = new Map<string, number>();
  for (const t of options.tenants ?? []) for (const key of t.keys) tenantRows.set(key, t.row);
  const out: LeaseImportRow[] = [];
  const issues = tooMany('leases', rows.length);
  const first = new FirstRows();
  const byUnit = new Map<string, { start: string; end: string; row: number }[]>();
  for (const { row, values } of rows) {
    const r = new CellReader(sheet, row, values, headers);
    const unitCode = r.unitCode('unit');
    let tenant: LeaseTenantRef | null = null;
    if (r.has('tenantPhone')) {
      const phone = r.phone('tenantPhone', true);
      if (phone) tenant = { by: 'phone', phone };
    } else {
      const name = r.text('tenantName', false, 160, 2);
      const tin = r.tin('tenantTin');
      if (name && tin) tenant = { by: 'name_and_tin', name, tin };
      else if (!r.has('tenantName') && !r.has('tenantTin'))
        r.problem('tenantPhone', 'Give the tenant’s phone, or a company tenant’s name and TIN');
      else if (!r.has('tenantTin')) r.problem('tenantTin', 'Give the TIN with the tenant’s name');
      else if (!r.has('tenantName')) r.problem('tenantName', 'Give the name with the TIN');
    }
    const startDate = r.date('startDate', true);
    const endDate = r.date('endDate', true);
    const monthlyRentMinor = r.amount('monthlyRent', true, 'positive');
    const cycle = r.oneOf('cycle', true, RENT_CYCLES, RENT_CYCLE_LABELS);
    // A deposit of zero is none, as on the lease form.
    const depositMinor = r.amount('deposit', false, 'nonNegative') || null;
    const serviceChargeMonthlyMinor = r.amount('serviceCharge', false, 'positive');
    const use = r.oneOf('use', false, LEASE_USES, USE_LABELS);
    const noticeDays = r.wholeNumber('noticeDays', true, MAX_NOTICE_DAYS);
    const signedOn = r.date('signedOn', true);
    if (signedOn && before(today, signedOn))
      r.problem('signedOn', 'The signing date cannot be in the future');
    if (startDate && endDate && monthlyRentMinor && cycle && noticeDays !== null)
      try {
        checkLeaseTerms({
          startDate,
          endDate,
          monthlyRentMinor,
          cycle,
          depositMinor,
          serviceChargeMonthlyMinor,
          noticeDays,
          use: use ?? 'residential',
        });
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        r.problem(TERM_COLUMNS[error.code] ?? null, error.message);
      }
    if (unitCode && startDate) {
      const earlier = first.claim(leaseMatchKey(unitCode, startDate), row);
      if (earlier)
        r.problem(
          'startDate',
          `The lease of ${unitCode} from this date is already on row ${earlier}`,
        );
      else if (endDate && !before(endDate, startDate)) {
        const leases = byUnit.get(unitCode) ?? [];
        const overlap = leases.find((l) => !before(endDate, l.start) && !before(l.end, startDate));
        if (overlap)
          r.problem(
            'startDate',
            `${unitCode} already has a lease from ${overlap.start} to ${overlap.end} on row ${overlap.row}; a unit holds one lease at a time`,
          );
        leases.push({ start: startDate, end: endDate, row });
        byUnit.set(unitCode, leases);
      }
    }
    issues.push(...r.issues);
    if (
      r.issues.length ||
      !unitCode ||
      !tenant ||
      !startDate ||
      !endDate ||
      !monthlyRentMinor ||
      !cycle ||
      noticeDays === null ||
      !signedOn
    )
      continue;
    const tenantKey = tenantRefKey(tenant);
    out.push({
      row,
      unitCode,
      tenant,
      tenantKey,
      tenantRow: tenantRows.get(tenantKey) ?? null,
      startDate,
      endDate,
      monthlyRentMinor,
      cycle,
      depositMinor,
      serviceChargeMonthlyMinor,
      use,
      noticeDays,
      signedOn,
      matchKey: leaseMatchKey(unitCode, startDate),
    });
  }
  return { rows: out, issues };
}

/** A recorded lease's terms, as the Leases sheet states them. */
export interface LeaseImportTerms {
  readonly endDate: string;
  readonly monthlyRentMinor: number;
  readonly cycle: RentCycle;
  readonly depositMinor: number | null;
  readonly serviceChargeMonthlyMinor: number | null;
  readonly use: LeaseUse;
  readonly noticeDays: number;
  readonly signedOn: string;
}

/**
 * The headers of the terms a row states differently from the lease already recorded for its unit
 * and start date; empty when it is unchanged. A signed lease is never changed by an import, so
 * the server reports a difference as an issue on the row.
 */
export function leaseImportDifferences(existing: LeaseImportTerms, row: LeaseImportRow): string[] {
  const header = Object.fromEntries(LEASE_COLUMNS.map((c) => [c.key, c.header]));
  const differs: string[] = [];
  if (existing.endDate !== row.endDate) differs.push(header.endDate!);
  if (existing.monthlyRentMinor !== row.monthlyRentMinor) differs.push(header.monthlyRent!);
  if (existing.cycle !== row.cycle) differs.push(header.cycle!);
  if ((existing.depositMinor ?? null) !== row.depositMinor) differs.push(header.deposit!);
  if ((existing.serviceChargeMonthlyMinor ?? null) !== row.serviceChargeMonthlyMinor)
    differs.push(header.serviceCharge!);
  if (row.use !== null && existing.use !== row.use) differs.push(header.use!);
  if (existing.noticeDays !== row.noticeDays) differs.push(header.noticeDays!);
  if (existing.signedOn !== row.signedOn) differs.push(header.signedOn!);
  return differs;
}

// Step 3: the Balances workbook, and its adjustment ---------------------------------------------

/**
 * `balances`: the opening balances, every amount above zero. `adjustment`: the same sheets after
 * commit, each amount a signed change (a minus sign lowers; plan 4.2). Whether a lowering goes
 * below what has been paid or drawn needs the database, so it is checked on the server.
 */
export type BalanceWorkbookMode = 'balances' | 'adjustment';

export interface BalanceOptions {
  /** The company's cut-over: every opening entry is dated it. */
  readonly cutOverDate: string;
  readonly mode: BalanceWorkbookMode;
}

export const ARREARS_KINDS = ['rent', 'service_charge'] as const;
export type ArrearsKind = (typeof ARREARS_KINDS)[number];
const ARREARS_KIND_LABELS: Record<ArrearsKind, string> = {
  rent: 'Rent',
  service_charge: 'Service charge',
};

/** The lease a Balances row is for, as the Leases sheet names it. */
export interface BalanceLeaseRef {
  readonly unitCode: string;
  readonly leaseStart: string;
  /** `leaseMatchKey(unitCode, leaseStart)`: the same key as the lease's own. */
  readonly leaseKey: string;
}

export interface ArrearsImportRow extends BalanceLeaseRef {
  readonly row: number;
  readonly periodStart: string;
  readonly kind: ArrearsKind;
  /** Above zero; in an adjustment, the signed change. */
  readonly amountMinor: number;
  /** The original due date; null only when an adjustment lowers an item. */
  readonly dueDate: string | null;
  readonly matchKey: string;
}

export interface AdvanceImportRow extends BalanceLeaseRef {
  readonly row: number;
  /** Exactly one of the two in the Balances workbook; an adjustment gives the amount. */
  readonly amountMinor: number | null;
  /** The last day the rent is paid to, on or after the cut-over. */
  readonly paidThrough: string | null;
  readonly matchKey: string;
}

export interface DepositImportRow extends BalanceLeaseRef {
  readonly row: number;
  readonly amountMinor: number;
  readonly matchKey: string;
}

export interface WithholdingImportRow extends BalanceLeaseRef {
  readonly row: number;
  readonly amountMinor: number;
  /** On or before the cut-over; null only when an adjustment lowers an item. */
  readonly withheldOn: string | null;
  /** The rent period it was withheld on. */
  readonly periodStart: string;
  readonly matchKey: string;
}

export interface OwnerItemsImportRow {
  readonly row: number;
  readonly ownerReference: string;
  /** Cash the agency holds for the owner (1070); null when none is given. */
  readonly agentCashMinor: number | null;
  /** Rent tax the owner still owes (2200); null when none is given. */
  readonly rentTaxOutstandingMinor: number | null;
  /** Its due date; null with no rent tax, or when an adjustment lowers it. */
  readonly rentTaxDueOn: string | null;
  readonly matchKey: string;
}

const signOf = (mode: BalanceWorkbookMode): Sign => (mode === 'adjustment' ? 'signed' : 'positive');

/** Reads a row's lease (unit and lease start). */
function leaseRef(r: CellReader): BalanceLeaseRef | null {
  const unitCode = r.unitCode('unit');
  const leaseStart = r.date('leaseStart', true);
  return unitCode && leaseStart
    ? { unitCode, leaseStart, leaseKey: leaseMatchKey(unitCode, leaseStart) }
    : null;
}

/** A date on or before the cut-over: something that happened before the platform. */
function byCutOver(
  r: CellReader,
  column: string,
  date: string | null,
  cutOver: string,
  what: string,
) {
  if (date && before(cutOver, date))
    r.problem(column, `${what} on or before the cut-over (${cutOver})`);
}

function balanceSheet<T>(
  key: OnboardingSheetKey,
  columns: readonly OnboardingColumn[],
  rows: OnboardingSheetRows,
  read: (r: CellReader, row: number) => (T & { readonly matchKey: string }) | null,
  duplicate: (row: T) => { column: string; message: string },
): CheckedRows<T> {
  const sheet = ONBOARDING_SHEETS[key];
  const headers = headersOf(columns);
  const out: T[] = [];
  const issues = tooMany(key, rows.length);
  const first = new FirstRows();
  for (const { row, values } of rows) {
    const r = new CellReader(sheet, row, values, headers);
    const value = read(r, row);
    if (value) {
      const earlier = first.claim(value.matchKey, row);
      if (earlier) {
        const d = duplicate(value);
        r.problem(d.column, `${d.message} is already on row ${earlier}`);
      }
    }
    issues.push(...r.issues);
    if (value && !r.issues.length) out.push(value);
  }
  return { rows: out, issues };
}

const cutOverOf = (options: BalanceOptions) => toIsoDate(parseBusinessDate(options.cutOverDate));

/**
 * Arrears (P25): one row per lease, period and kind, for a rent period that started before the
 * cut-over (later periods are billed on the platform) and within the lease, due on or before the
 * cut-over. They arrive as opening invoice lines at their original due dates, so ageing works.
 */
export function checkArrearsRows(
  rows: OnboardingSheetRows,
  options: BalanceOptions,
): CheckedRows<ArrearsImportRow> {
  const cutOver = cutOverOf(options);
  return balanceSheet<ArrearsImportRow>(
    'arrears',
    ARREARS_COLUMNS,
    rows,
    (r, row) => {
      const lease = leaseRef(r);
      const periodStart = r.date('periodStart', true);
      if (periodStart && !before(periodStart, cutOver))
        r.problem(
          'periodStart',
          `Arrears are for rent periods that started before the cut-over (${cutOver}); later periods are billed on the platform`,
        );
      if (periodStart && lease && before(periodStart, lease.leaseStart))
        r.problem('periodStart', 'The period starts before the lease');
      const kind = r.oneOf('kind', true, ARREARS_KINDS, ARREARS_KIND_LABELS);
      const amountMinor = r.amount('amount', true, signOf(options.mode));
      const lowering = amountMinor !== null && amountMinor < 0;
      const dueDate = r.date('dueDate', !lowering && amountMinor !== null);
      byCutOver(r, 'dueDate', dueDate, cutOver, 'Arrears fall due');
      if (!lease || !periodStart || !kind || amountMinor === null) return null;
      if (!dueDate && !lowering) return null;
      return {
        ...lease,
        row,
        periodStart,
        kind,
        amountMinor,
        dueDate,
        matchKey: arrearsMatchKey(lease.leaseKey, periodStart, kind),
      };
    },
    (a) => ({
      column: 'periodStart',
      message: `${ARREARS_KIND_LABELS[a.kind]} for this lease and period`,
    }),
  );
}

/**
 * Advances (P25): what a lease has paid ahead, as an amount or as the last day it is paid to
 * (exactly one; on or after the cut-over). An adjustment gives the change as an amount. It
 * arrives as an opening payment held in 2010, which later months draw on as usual.
 */
export function checkAdvanceRows(
  rows: OnboardingSheetRows,
  options: BalanceOptions,
): CheckedRows<AdvanceImportRow> {
  const cutOver = cutOverOf(options);
  return balanceSheet<AdvanceImportRow>(
    'advances',
    ADVANCE_COLUMNS,
    rows,
    (r, row) => {
      const lease = leaseRef(r);
      const hasAmount = r.has('amount');
      const hasDate = r.has('paidThrough');
      if (options.mode === 'adjustment' && hasDate) {
        r.problem('paidThrough', 'In an adjustment, give the change as an amount');
        return null;
      }
      if (hasAmount === hasDate) {
        r.problem(
          'amount',
          hasAmount
            ? 'Give the amount or the paid-through date, not both'
            : 'Give the amount paid ahead or the date it is paid through',
        );
        return null;
      }
      const amountMinor = hasAmount ? r.amount('amount', true, signOf(options.mode)) : null;
      const paidThrough = hasDate ? r.date('paidThrough', true) : null;
      if (paidThrough && before(paidThrough, cutOver))
        r.problem(
          'paidThrough',
          `A lease paid through a date before the cut-over (${cutOver}) has nothing paid ahead`,
        );
      if (paidThrough && lease && before(paidThrough, lease.leaseStart))
        r.problem('paidThrough', 'The date is before the lease starts');
      if (!lease || (amountMinor === null && paidThrough === null)) return null;
      return {
        ...lease,
        row,
        amountMinor,
        paidThrough,
        matchKey: advanceMatchKey(lease.leaseKey),
      };
    },
    () => ({ column: 'unit', message: 'An advance for this lease' }),
  );
}

/** Deposits held (P25): one row per lease; a settled opening deposit, so move-out works. */
export function checkDepositRows(
  rows: OnboardingSheetRows,
  options: BalanceOptions,
): CheckedRows<DepositImportRow> {
  cutOverOf(options);
  return balanceSheet<DepositImportRow>(
    'deposits',
    DEPOSIT_COLUMNS,
    rows,
    (r, row) => {
      const lease = leaseRef(r);
      const amountMinor = r.amount('amount', true, signOf(options.mode));
      if (!lease || amountMinor === null) return null;
      return { ...lease, row, amountMinor, matchKey: depositMatchKey(lease.leaseKey) };
    },
    () => ({ column: 'unit', message: 'The deposit for this lease' }),
  );
}

/**
 * Withholding outstanding (P25): tax a corporate tenant withheld before the cut-over, with its
 * certificate still to come; one row per lease and rent period.
 */
export function checkWithholdingRows(
  rows: OnboardingSheetRows,
  options: BalanceOptions,
): CheckedRows<WithholdingImportRow> {
  const cutOver = cutOverOf(options);
  return balanceSheet<WithholdingImportRow>(
    'withholding',
    WITHHOLDING_COLUMNS,
    rows,
    (r, row) => {
      const lease = leaseRef(r);
      const amountMinor = r.amount('amount', true, signOf(options.mode));
      const lowering = amountMinor !== null && amountMinor < 0;
      const withheldOn = r.date('withheldOn', !lowering && amountMinor !== null);
      byCutOver(r, 'withheldOn', withheldOn, cutOver, 'Tax was withheld');
      const periodStart = r.date('periodStart', true);
      if (periodStart && lease && before(periodStart, lease.leaseStart))
        r.problem('periodStart', 'The period starts before the lease');
      if (!lease || amountMinor === null || !periodStart) return null;
      if (!withheldOn && !lowering) return null;
      return {
        ...lease,
        row,
        amountMinor,
        withheldOn,
        periodStart,
        matchKey: withholdingMatchKey(lease.leaseKey, periodStart),
      };
    },
    () => ({ column: 'periodStart', message: 'Withholding for this lease and period' }),
  );
}

/**
 * Owner items (P25): per owner, the cash the agency holds for them (1070) and the rent tax they
 * still owe (2200) with its due date. One row per owner; at least one of the two.
 */
export function checkOwnerItemRows(
  rows: OnboardingSheetRows,
  options: BalanceOptions,
): CheckedRows<OwnerItemsImportRow> {
  cutOverOf(options);
  return balanceSheet<OwnerItemsImportRow>(
    'ownerItems',
    OWNER_ITEM_COLUMNS,
    rows,
    (r, row) => {
      const referenceText = r.text('owner', true, 20);
      const ownerReference = referenceText
        ? r.check('owner', () => checkOwnerReference(referenceText))
        : null;
      const sign = signOf(options.mode);
      const agentCashMinor = r.amount('agentCash', false, sign);
      const rentTaxOutstandingMinor = r.amount('rentTax', false, sign);
      if (!r.has('agentCash') && !r.has('rentTax'))
        r.problem('agentCash', 'Give the agent-held cash, the rent tax outstanding, or both');
      const raisingTax = rentTaxOutstandingMinor !== null && rentTaxOutstandingMinor > 0;
      const rentTaxDueOn = r.date('rentTaxDueOn', raisingTax);
      if (rentTaxDueOn && !r.has('rentTax'))
        r.problem('rentTaxDueOn', 'Leave the due date blank when no rent tax is outstanding');
      if (!ownerReference) return null;
      if (agentCashMinor === null && rentTaxOutstandingMinor === null) return null;
      if (raisingTax && !rentTaxDueOn) return null;
      return {
        row,
        ownerReference,
        agentCashMinor,
        rentTaxOutstandingMinor,
        rentTaxDueOn: rentTaxOutstandingMinor === null ? null : rentTaxDueOn,
        matchKey: ownerItemsMatchKey(ownerReference),
      };
    },
    (o) => ({ column: 'owner', message: `Owner ${o.ownerReference}` }),
  );
}

export interface BalanceSheetsInput {
  readonly arrears?: OnboardingSheetRows;
  readonly advances?: OnboardingSheetRows;
  readonly deposits?: OnboardingSheetRows;
  readonly withholding?: OnboardingSheetRows;
  readonly ownerItems?: OnboardingSheetRows;
}

export interface BalanceRows {
  readonly arrears: ArrearsImportRow[];
  readonly advances: AdvanceImportRow[];
  readonly deposits: DepositImportRow[];
  readonly withholding: WithholdingImportRow[];
  readonly ownerItems: OwnerItemsImportRow[];
  /** Every sheet's problems, sheet by sheet in the workbook's order. */
  readonly issues: ImportIssue[];
}

/**
 * The Balances workbook, or its adjustment (decision 3; plan 4.2), sheet by sheet. A missing sheet
 * has no rows. Commit only with no issues; the server adds what needs the database (each lease and
 * owner exists, the advance's paid-through date as an amount, and an adjustment never going below
 * what has been paid or drawn).
 */
export function checkBalanceRows(sheets: BalanceSheetsInput, options: BalanceOptions): BalanceRows {
  const arrears = checkArrearsRows(sheets.arrears ?? [], options);
  const advances = checkAdvanceRows(sheets.advances ?? [], options);
  const deposits = checkDepositRows(sheets.deposits ?? [], options);
  const withholding = checkWithholdingRows(sheets.withholding ?? [], options);
  const ownerItems = checkOwnerItemRows(sheets.ownerItems ?? [], options);
  return {
    arrears: arrears.rows,
    advances: advances.rows,
    deposits: deposits.rows,
    withholding: withholding.rows,
    ownerItems: ownerItems.rows,
    issues: [
      ...arrears.issues,
      ...advances.issues,
      ...deposits.issues,
      ...withholding.issues,
      ...ownerItems.issues,
    ],
  };
}
