import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addDays, addMonths, parseBusinessDate, toIsoDate } from '../dates';
import {
  advanceMatchKey,
  checkAdvanceRows,
  checkArrearsRows,
  checkBalanceRows,
  checkDepositRows,
  checkLeaseRows,
  checkOwnerItemRows,
  checkOwnerRows,
  checkTenantRows,
  checkWithholdingRows,
  companyTenantKey,
  leaseImportDifferences,
  leaseMatchKey,
  ownerFieldsAfterImport,
  tenantFieldsAfterImport,
  tenantPhoneKey,
  type BalanceOptions,
  type OnboardingSheetRows,
} from './rows';

const TODAY = '2026-11-10';
const CUT_OVER = '2026-11-01';
const BALANCES: BalanceOptions = { cutOverDate: CUT_OVER, mode: 'balances' };
const ADJUSTMENT: BalanceOptions = { cutOverDate: CUT_OVER, mode: 'adjustment' };

// Fictional numbers only (CLAUDE.md section 14).
const PHONE_A = '024 000 0001';
const PHONE_A_E164 = '+233240000001';
const PHONE_B = '0240000002';
const PHONE_B_E164 = '+233240000002';
const GHANA_CARD = 'GHA-000000001-1';
const COMPANY_TIN = 'C0000000001';

const sheet = (...rows: Record<string, unknown>[]): OnboardingSheetRows =>
  rows.map((values, i) => ({ row: i + 2, values }));
const columnsAt = (issues: readonly { row: number | null; column: string | null }[], row: number) =>
  issues.filter((i) => i.row === row).map((i) => i.column);

const owner = (values: Record<string, unknown> = {}) => ({
  reference: 'own-01',
  kind: 'individual',
  displayName: 'Ama Owusu',
  ...values,
});

const person = (values: Record<string, unknown> = {}) => ({
  kind: 'Individual',
  name: 'Kofi Asante',
  phone: PHONE_A,
  ...values,
});

const company = (values: Record<string, unknown> = {}) => ({
  kind: 'Company',
  name: 'Osu Traders Ltd',
  tin: COMPANY_TIN,
  ...values,
});

const lease = (values: Record<string, unknown> = {}) => ({
  unit: 'ACC-LEG-B1-04',
  tenantPhone: PHONE_A,
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  monthlyRent: '1,500.50',
  cycle: 'Annually',
  noticeDays: 90,
  signedOn: '2025-12-15',
  ...values,
});

const ref = { unit: 'acc-leg-b1-4', leaseStart: '2026-01-01' };
const LEASE_KEY = leaseMatchKey('ACC-LEG-B1-04', '2026-01-01');

describe('PR-08 register import: the Owners sheet (M11 decision 2, step 1)', () => {
  it('normalises a good owner row and matches it by reference', () => {
    const { rows, issues } = checkOwnerRows(
      sheet(
        owner({
          kind: 'Company',
          displayName: 'Owusu Holdings',
          legalName: 'Owusu Holdings Limited',
          phone: PHONE_A,
          email: 'Accounts@Example.com ',
          tin: 'c000 0000 001',
        }),
      ),
    );
    expect(issues).toEqual([]);
    expect(rows).toEqual([
      {
        row: 2,
        reference: 'OWN-01',
        kind: 'company',
        displayName: 'Owusu Holdings',
        legalName: 'Owusu Holdings Limited',
        phone: PHONE_A_E164,
        email: 'accounts@example.com',
        tin: 'C0000000001',
        matchKey: 'owner:OWN-01',
      },
    ]);
  });

  it('reports every problem by row and column, and a reference used twice', () => {
    const { rows, issues } = checkOwnerRows(
      sheet(
        owner({ reference: 'O', kind: 'Trust', displayName: 'A' }),
        owner({ phone: '12', email: 'not-an-email', tin: '!!' }),
        owner({ reference: 'OWN-02' }),
        owner({ reference: ' own-02 ' }),
      ),
    );
    expect(rows.map((r) => r.row)).toEqual([4]);
    expect(columnsAt(issues, 2)).toEqual(['Owner reference', 'Kind', 'Name']);
    expect(columnsAt(issues, 3)).toEqual(['Phone', 'Email', 'TIN']);
    expect(issues.find((i) => i.row === 5)?.message).toBe('Owner OWN-02 is already on row 4');
    expect(issues.every((i) => i.sheet === 'Owners')).toBe(true);
  });

  it('keeps what an existing owner has where a cell is left blank', () => {
    const [row] = checkOwnerRows(sheet(owner({ displayName: 'Ama Owusu-Ansah' }))).rows;
    const existing = {
      kind: 'individual' as const,
      displayName: 'Ama Owusu',
      legalName: 'Ama Serwaa Owusu',
      phone: PHONE_B_E164,
      email: 'ama@example.com',
    };
    expect(ownerFieldsAfterImport(existing, row!)).toEqual({
      ...existing,
      displayName: 'Ama Owusu-Ansah',
    });
  });

  it('refuses a sheet over the row limit as a whole', () => {
    const many = Array.from({ length: 1_001 }, (_, i) => owner({ reference: `OWN-${i}` }));
    const { issues } = checkOwnerRows(sheet(...many));
    expect(issues[0]).toEqual({
      sheet: 'Owners',
      row: null,
      column: null,
      message: 'At most 1000 rows',
    });
  });
});

describe('TL-01 onboarding: the Tenants sheet (M11 decision 2, step 2)', () => {
  it('reads an individual, matched by phone in E.164', () => {
    const { rows, issues } = checkTenantRows(
      sheet(
        person({
          whatsappPhone: 240000003,
          email: 'kofi@example.com',
          occupation: 'Teacher',
          idType: 'ghana card',
          idNumber: 'gha 000000001 1',
        }),
      ),
    );
    expect(issues).toEqual([]);
    expect(rows[0]).toMatchObject({
      kind: 'individual',
      displayName: 'Kofi Asante',
      phone: PHONE_A_E164,
      whatsappPhone: '+233240000003',
      occupation: 'Teacher',
      businessType: null,
      identity: { type: 'ghana_card', number: GHANA_CARD, country: 'GH' },
      matchKey: tenantPhoneKey(PHONE_A_E164),
      keys: [tenantPhoneKey(PHONE_A_E164)],
    });
  });

  it('reads a company tenant with no phone, matched by name and TIN', () => {
    const { rows, issues } = checkTenantRows(
      sheet(
        company({
          legalName: 'Osu Traders Limited',
          occupation: 'Retail',
          registrationNumber: 'CS000000001',
        }),
        company({ name: 'Tema Logistics', tin: 'C0000000002', phone: PHONE_B }),
      ),
    );
    expect(issues).toEqual([]);
    expect(rows[0]).toMatchObject({
      kind: 'company',
      legalName: 'Osu Traders Limited',
      occupation: null,
      businessType: 'Retail',
      registrationNumber: 'CS000000001',
      phone: null,
      matchKey: companyTenantKey('osu  traders LTD', COMPANY_TIN),
    });
    // With a phone, the phone comes first; the name and TIN still name it for the Leases sheet.
    expect(rows[1]!.keys).toEqual([
      tenantPhoneKey(PHONE_B_E164),
      companyTenantKey('Tema Logistics', 'C0000000002'),
    ]);
  });

  it('needs what a tenant is matched by, and keeps company details for companies', () => {
    const { rows, issues } = checkTenantRows(
      sheet(
        person({ phone: null }),
        company({ tin: null }),
        person({ legalName: 'Kofi Asante Esq', registrationNumber: 'CS1' }),
        person({ kind: 'Partnership', phone: PHONE_B }),
      ),
    );
    expect(rows).toEqual([]);
    expect(issues.find((i) => i.row === 2)).toMatchObject({
      column: 'Phone',
      message: 'Required: tenants are matched by their phone',
    });
    expect(issues.find((i) => i.row === 3)).toMatchObject({
      column: 'Phone',
      message: 'Give the phone or the TIN, so the tenant can be matched',
    });
    expect(columnsAt(issues, 4)).toEqual(['Legal name', 'Registration number']);
    expect(columnsAt(issues, 5)).toEqual(['Kind']);
  });

  it('checks ID numbers without ever repeating them', () => {
    const { rows, issues } = checkTenantRows(
      sheet(
        person({ idType: 'Ghana Card', idNumber: 'GHA-98765' }),
        person({ phone: PHONE_B, idNumber: 'A0000001' }),
        person({ phone: '0240000004', idType: 'Passport', idNumber: 'A0000001' }),
        person({ phone: '0240000005', idType: 'Passport', idNumber: 'a000 0001', idCountry: 'ng' }),
      ),
    );
    expect(columnsAt(issues, 2)).toEqual(['ID number']);
    expect(columnsAt(issues, 3)).toEqual(['ID type']);
    expect(columnsAt(issues, 4)).toEqual(['ID number']);
    expect(rows.map((r) => r.identity)).toEqual([
      { type: 'passport', number: 'A0000001', country: 'NG' },
    ]);
    for (const issue of issues) {
      expect(issue.message).not.toContain('98765');
      expect(issue.message).not.toContain('A0000001');
    }
  });

  it('finds the same tenant twice in a file, by phone or by name and TIN', () => {
    const { rows, issues } = checkTenantRows(
      sheet(
        person(),
        person({ name: 'K. Asante', phone: '+233 24 000 0001' }),
        company(),
        company({ name: ' OSU traders  ltd' }),
      ),
    );
    expect(rows.map((r) => r.row)).toEqual([2, 4]);
    expect(issues).toEqual([
      { sheet: 'Tenants', row: 3, column: 'Phone', message: 'This tenant is already on row 2' },
      { sheet: 'Tenants', row: 5, column: 'TIN', message: 'This tenant is already on row 4' },
    ]);
  });

  it('keeps what an existing tenant has where a cell is left blank', () => {
    const [row] = checkTenantRows(sheet(person({ occupation: 'Nurse' }))).rows;
    const existing = {
      displayName: 'Kofi',
      legalName: null,
      phone: PHONE_A_E164,
      whatsappPhone: '+233240000003',
      email: 'kofi@example.com',
      occupation: 'Teacher',
      businessType: null,
      registrationNumber: null,
    };
    expect(tenantFieldsAfterImport(existing, row!)).toEqual({
      ...existing,
      displayName: 'Kofi Asante',
      occupation: 'Nurse',
    });
  });
});

describe('CM-09 onboarding: consent per channel from the Tenants sheet', () => {
  it('records Yes as granted, No as withdrawn and blank as nothing', () => {
    const { rows, issues } = checkTenantRows(
      sheet(
        person({ email: 'kofi@example.com', consentWhatsapp: 'Yes', consentSms: 'no' }),
        person({ phone: PHONE_B, consentWhatsapp: true, consentEmail: false }),
      ),
    );
    expect(issues).toEqual([]);
    expect(rows.map((r) => r.consent)).toEqual([
      { whatsapp: true, sms: false, email: null },
      { whatsapp: true, sms: null, email: false },
    ]);
  });

  it('refuses consent on a channel the tenant has no address for, and an unclear answer', () => {
    const { rows, issues } = checkTenantRows(
      sheet(
        company({ consentWhatsapp: 'Yes', consentSms: 'Yes', consentEmail: 'Yes' }),
        person({ consentSms: 'maybe' }),
      ),
    );
    expect(rows).toEqual([]);
    expect(issues.map((i) => [i.row, i.column, i.message])).toEqual([
      [2, 'WhatsApp consent', 'WhatsApp consent needs a phone or a WhatsApp phone'],
      [2, 'SMS consent', 'SMS consent needs a phone'],
      [2, 'Email consent', 'Email consent needs an email'],
      [3, 'SMS consent', 'Use Yes or No, or leave it blank'],
    ]);
  });
});

describe('TL-06 onboarding: the Leases sheet (paper leases, M11 decision 2)', () => {
  it('reads a paper lease in pesewas, matched by unit and start date', () => {
    const tenants = checkTenantRows(sheet(person())).rows;
    const { rows, issues } = checkLeaseRows(
      sheet(lease({ unit: 'acc-leg-b1-4', deposit: 0, serviceCharge: 200, use: '' })),
      { today: TODAY, tenants },
    );
    expect(issues).toEqual([]);
    expect(rows).toEqual([
      {
        row: 2,
        unitCode: 'ACC-LEG-B1-04',
        tenant: { by: 'phone', phone: PHONE_A_E164 },
        tenantKey: tenantPhoneKey(PHONE_A_E164),
        tenantRow: 2,
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        monthlyRentMinor: 150_050,
        cycle: 'annual',
        depositMinor: null,
        serviceChargeMonthlyMinor: 20_000,
        use: null,
        noticeDays: 90,
        signedOn: '2025-12-15',
        matchKey: LEASE_KEY,
      },
    ]);
  });

  it('names a company tenant by name and TIN, found on the Tenants sheet or left to the server', () => {
    const tenants = checkTenantRows(sheet(company())).rows;
    const { rows, issues } = checkLeaseRows(
      sheet(
        lease({ tenantPhone: null, tenantName: 'osu traders ltd', tenantTin: COMPANY_TIN }),
        lease({ unit: 'ACC-OSU-B1-01', tenantPhone: PHONE_B, use: 'Commercial', deposit: 3000 }),
        lease({ unit: 'ACC-OSU-B1-02', tenantPhone: null, tenantName: 'Osu Traders Ltd' }),
        lease({ unit: 'ACC-OSU-B1-03', tenantPhone: null }),
      ),
      { today: TODAY, tenants },
    );
    expect(rows.map((r) => [r.tenantRow, r.use, r.depositMinor])).toEqual([
      [2, null, null],
      [null, 'commercial', 300_000],
    ]);
    expect(rows[0]!.tenant).toEqual({
      by: 'name_and_tin',
      name: 'osu traders ltd',
      tin: COMPANY_TIN,
    });
    expect(issues.map((i) => [i.row, i.column, i.message])).toEqual([
      [4, 'Tenant TIN', 'Give the TIN with the tenant’s name'],
      [5, 'Tenant phone', 'Give the tenant’s phone, or a company tenant’s name and TIN'],
    ]);
  });

  it('puts the lease-term rules on the cells they are about', () => {
    const { rows, issues } = checkLeaseRows(
      sheet(
        lease({ endDate: '2025-12-31' }),
        lease({ unit: 'ACC-LEG-B1-05', endDate: '2026-03-31' }),
        lease({ unit: 'ACC-LEG-B1-06', noticeDays: 'three months', cycle: 'weekly' }),
        lease({ unit: 'ACC-LEG-B1-07', signedOn: '2026-11-11', startDate: '1 Jan 2026' }),
        lease({ unit: 'ACC-LEG-B1-08', monthlyRent: 0, serviceCharge: '-5', deposit: '-1' }),
        lease({ unit: 'X-1' }),
      ),
      { today: TODAY },
    );
    expect(rows).toEqual([]);
    expect(issues.find((i) => i.row === 2)).toMatchObject({
      column: 'End date',
      message: 'The lease must end after it starts',
    });
    expect(issues.find((i) => i.row === 3)).toMatchObject({
      column: 'Rent cycle',
      message: 'The billing cycle is longer than the lease',
    });
    expect(columnsAt(issues, 4)).toEqual(['Rent cycle', 'Notice days']);
    expect(columnsAt(issues, 5)).toEqual(['Start date', 'Signed on']);
    expect(columnsAt(issues, 6)).toEqual(['Monthly rent', 'Deposit', 'Monthly service charge']);
    expect(issues.find((i) => i.row === 7)).toMatchObject({
      column: 'Unit',
      message: 'Use a unit code such as ACC-LEG-B1-04',
    });
  });

  it('never rounds an amount: more than two decimals is refused, not rounded', () => {
    const { rows, issues } = checkLeaseRows(
      sheet(
        lease({ monthlyRent: 1500.555 }),
        lease({ unit: 'ACC-LEG-B1-05', monthlyRent: 1500 * 1.1 }),
        lease({ unit: 'ACC-LEG-B1-06', monthlyRent: 'GH₵ 1,650.10' }),
      ),
      { today: TODAY },
    );
    expect(columnsAt(issues, 2)).toEqual(['Monthly rent']);
    expect(columnsAt(issues, 3)).toEqual(['Monthly rent']);
    expect(rows.map((r) => r.monthlyRentMinor)).toEqual([165_010]);
  });

  it('refuses a second lease on a unit for the same or an overlapping term', () => {
    const { rows, issues } = checkLeaseRows(
      sheet(
        lease(),
        lease({ tenantPhone: PHONE_B }),
        lease({ startDate: '2026-06-01', endDate: '2027-05-31', tenantPhone: PHONE_B }),
        lease({ startDate: '2027-01-01', endDate: '2027-12-31', tenantPhone: PHONE_B }),
      ),
      { today: TODAY },
    );
    expect(rows.map((r) => r.row)).toEqual([2]);
    expect(issues.map((i) => [i.row, i.message])).toEqual([
      [3, 'The lease of ACC-LEG-B1-04 from this date is already on row 2'],
      [
        4,
        'ACC-LEG-B1-04 already has a lease from 2026-01-01 to 2026-12-31 on row 2; a unit holds one lease at a time',
      ],
      [
        5,
        'ACC-LEG-B1-04 already has a lease from 2026-06-01 to 2027-05-31 on row 4; a unit holds one lease at a time',
      ],
    ]);
    // Back to back is not an overlap.
    const next = checkLeaseRows(
      sheet(lease(), lease({ startDate: '2027-01-01', endDate: '2027-12-31' })),
      { today: TODAY },
    );
    expect(next.issues).toEqual([]);
  });

  it('lists the terms a re-imported lease states differently from the one recorded', () => {
    const [row] = checkLeaseRows(sheet(lease()), { today: TODAY }).rows;
    const recorded = {
      endDate: '2026-12-31',
      monthlyRentMinor: 150_050,
      cycle: 'annual' as const,
      depositMinor: null,
      serviceChargeMonthlyMinor: null,
      use: 'residential' as const,
      noticeDays: 90,
      signedOn: '2025-12-15',
    };
    expect(leaseImportDifferences(recorded, row!)).toEqual([]);
    expect(
      leaseImportDifferences(
        { ...recorded, monthlyRentMinor: 150_000, use: 'commercial', noticeDays: 30 },
        row!,
      ),
    ).toEqual(['Monthly rent', 'Notice days']);
  });
});

describe('P25 onboarding: the Balances workbook (M11 decision 3)', () => {
  it('reads arrears per lease, period and kind, before the cut-over and due by it', () => {
    const { rows, issues } = checkArrearsRows(
      sheet(
        { ...ref, periodStart: '2026-10-01', kind: 'Rent', amount: '1500', dueDate: '2026-10-01' },
        {
          ...ref,
          periodStart: '2026-10-01',
          kind: 'service charge',
          amount: 200,
          dueDate: '2026-10-01',
        },
        { ...ref, periodStart: '2026-11-01', kind: 'Rent', amount: '1500', dueDate: '2026-11-01' },
        { ...ref, periodStart: '2025-12-01', kind: 'Rent', amount: '1500', dueDate: '2026-11-02' },
        { ...ref, periodStart: '2026-10-01', kind: 'Rent', amount: '-50', dueDate: '2026-10-01' },
        { ...ref, periodStart: '2026-10-01', kind: 'Rent', amount: '700', dueDate: '2026-10-01' },
      ),
      BALANCES,
    );
    expect(rows).toEqual([
      {
        row: 2,
        unitCode: 'ACC-LEG-B1-04',
        leaseStart: '2026-01-01',
        leaseKey: LEASE_KEY,
        periodStart: '2026-10-01',
        kind: 'rent',
        amountMinor: 150_000,
        dueDate: '2026-10-01',
        matchKey: `arrears:${LEASE_KEY}|2026-10-01|rent`,
      },
      expect.objectContaining({ row: 3, kind: 'service_charge', amountMinor: 20_000 }),
    ]);
    expect(issues.map((i) => [i.row, i.column, i.message])).toEqual([
      [
        4,
        'Period start',
        'Arrears are for rent periods that started before the cut-over (2026-11-01); later periods are billed on the platform',
      ],
      [5, 'Period start', 'The period starts before the lease'],
      [5, 'Due date', 'Arrears fall due on or before the cut-over (2026-11-01)'],
      [6, 'Amount', 'Amounts here are above zero; lower an amount with the adjustment workbook'],
      [7, 'Period start', 'Rent for this lease and period is already on row 2'],
    ]);
  });

  it('takes an advance as an amount or a paid-through date, exactly one', () => {
    const { rows, issues } = checkAdvanceRows(
      sheet(
        { ...ref, amount: '18,000' },
        { ...ref, unit: 'ACC-LEG-B1-05', paidThrough: '2027-04-30' },
        { ...ref, unit: 'ACC-LEG-B1-06', amount: 100, paidThrough: '2027-04-30' },
        { ...ref, unit: 'ACC-LEG-B1-07' },
        { ...ref, unit: 'ACC-LEG-B1-08', paidThrough: '2026-10-31' },
        { ...ref, amount: '1' },
      ),
      BALANCES,
    );
    expect(rows.map((r) => [r.row, r.amountMinor, r.paidThrough, r.matchKey])).toEqual([
      [2, 1_800_000, null, advanceMatchKey(LEASE_KEY)],
      [3, null, '2027-04-30', advanceMatchKey(leaseMatchKey('ACC-LEG-B1-05', '2026-01-01'))],
    ]);
    expect(issues.map((i) => [i.row, i.message])).toEqual([
      [4, 'Give the amount or the paid-through date, not both'],
      [5, 'Give the amount paid ahead or the date it is paid through'],
      [6, 'A lease paid through a date before the cut-over (2026-11-01) has nothing paid ahead'],
      [7, 'An advance for this lease is already on row 2'],
    ]);
  });

  it('reads deposits held and withholding still to be certified', () => {
    const deposits = checkDepositRows(
      sheet({ ...ref, amount: 3000 }, { ...ref, amount: 0 }, { ...ref, amount: 10 }),
      BALANCES,
    );
    expect(deposits.rows.map((r) => r.amountMinor)).toEqual([300_000]);
    expect(deposits.issues.map((i) => [i.row, i.message])).toEqual([
      [3, 'Enter an amount above zero, or leave it out'],
      [4, 'The deposit for this lease is already on row 2'],
    ]);
    const withholding = checkWithholdingRows(
      sheet(
        { ...ref, amount: '120.00', withheldOn: '2026-10-05', periodStart: '2026-10-01' },
        { ...ref, amount: '120', withheldOn: '2026-11-05', periodStart: '2026-11-01' },
        { ...ref, amount: '120', periodStart: '2026-12-01' },
        { ...ref, amount: '120', withheldOn: '2026-10-05', periodStart: '2026-10-01' },
      ),
      BALANCES,
    );
    expect(withholding.rows).toEqual([
      expect.objectContaining({
        amountMinor: 12_000,
        withheldOn: '2026-10-05',
        periodStart: '2026-10-01',
        matchKey: `withholding:${LEASE_KEY}|2026-10-01`,
      }),
    ]);
    expect(withholding.issues.map((i) => [i.row, i.column, i.message])).toEqual([
      [3, 'Withheld on', 'Tax was withheld on or before the cut-over (2026-11-01)'],
      [4, 'Withheld on', 'Required'],
      [5, 'Period start', 'Withholding for this lease and period is already on row 2'],
    ]);
  });

  it('reads owner items: agent-held cash, and rent tax outstanding with its due date', () => {
    const { rows, issues } = checkOwnerItemRows(
      sheet(
        { owner: 'own-01', agentCash: '2,500', rentTax: 960, rentTaxDueOn: '2026-11-30' },
        { owner: 'OWN-02', agentCash: 100 },
        { owner: 'OWN-03', rentTax: 120 },
        { owner: 'OWN-04', rentTaxDueOn: '2026-11-30' },
        { owner: 'OWN-01', agentCash: 1 },
      ),
      BALANCES,
    );
    expect(rows).toEqual([
      {
        row: 2,
        ownerReference: 'OWN-01',
        agentCashMinor: 250_000,
        rentTaxOutstandingMinor: 96_000,
        rentTaxDueOn: '2026-11-30',
        matchKey: 'owner-items:OWN-01',
      },
      expect.objectContaining({ row: 3, agentCashMinor: 10_000, rentTaxOutstandingMinor: null }),
    ]);
    expect(issues.map((i) => [i.row, i.column, i.message])).toEqual([
      [4, 'Rent tax due date', 'Required'],
      [5, 'Agent-held cash', 'Give the agent-held cash, the rent tax outstanding, or both'],
      [5, 'Rent tax due date', 'Leave the due date blank when no rent tax is outstanding'],
      [6, 'Owner reference', 'Owner OWN-01 is already on row 2'],
    ]);
  });

  it('checks the whole workbook sheet by sheet; a missing sheet has no rows', () => {
    const result = checkBalanceRows(
      {
        arrears: sheet({ ...ref, periodStart: '2026-10-01', kind: 'Rent', amount: 1 }),
        deposits: sheet({ ...ref, amount: 3000 }),
        ownerItems: sheet({ owner: 'OWN-01' }),
      },
      BALANCES,
    );
    expect(result.deposits).toHaveLength(1);
    expect(result.advances).toEqual([]);
    expect(result.withholding).toEqual([]);
    expect(result.issues.map((i) => [i.sheet, i.column])).toEqual([
      ['Arrears', 'Due date'],
      ['Owner items', 'Agent-held cash'],
    ]);
  });

  it('parses any amount in pesewas exactly, never through a float', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 9_000_000_000_000 }), (minor) => {
        const digits = String(minor).padStart(3, '0');
        const text = `${digits.slice(0, -2)}.${digits.slice(-2)}`;
        const grouped = `${BigInt(digits.slice(0, -2)).toLocaleString('en-GB')}.${digits.slice(-2)}`;
        const { rows } = checkDepositRows(
          sheet({ ...ref, amount: text }, { ...ref, unit: 'ACC-LEG-B1-05', amount: grouped }),
          BALANCES,
        );
        expect(rows.map((r) => r.amountMinor)).toEqual([minor, minor]);
      }),
    );
  });
});

describe('P25 onboarding: the adjustment workbook (signed changes, M11 decision 3)', () => {
  it('takes a minus sign as lowering, and refuses a change of zero', () => {
    const { rows, issues } = checkArrearsRows(
      sheet(
        { ...ref, periodStart: '2026-10-01', kind: 'Rent', amount: '-500' },
        { ...ref, periodStart: '2026-09-01', kind: 'Rent', amount: '300', dueDate: '2026-09-01' },
        { ...ref, periodStart: '2026-08-01', kind: 'Rent', amount: '300' },
        { ...ref, periodStart: '2026-07-01', kind: 'Rent', amount: '0' },
      ),
      ADJUSTMENT,
    );
    expect(rows.map((r) => [r.amountMinor, r.dueDate])).toEqual([
      [-50_000, null],
      [30_000, '2026-09-01'],
    ]);
    // Raising adds an opening item, which needs its due date; lowering credits the existing one.
    expect(issues.map((i) => [i.row, i.column, i.message])).toEqual([
      [4, 'Due date', 'Required'],
      [5, 'Amount', 'Enter a change other than zero; a minus sign lowers'],
    ]);
  });

  it('gives an advance’s change as an amount, and checks the other sheets’ signs', () => {
    const advances = checkAdvanceRows(
      sheet(
        { ...ref, amount: '-1,000' },
        { ...ref, unit: 'ACC-LEG-B1-05', paidThrough: '2027-01-31' },
      ),
      ADJUSTMENT,
    );
    expect(advances.rows.map((r) => r.amountMinor)).toEqual([-100_000]);
    expect(advances.issues.map((i) => [i.row, i.column, i.message])).toEqual([
      [3, 'Paid through', 'In an adjustment, give the change as an amount'],
    ]);
    const balances = checkBalanceRows(
      {
        deposits: sheet({ ...ref, amount: '-3000' }),
        withholding: sheet(
          { ...ref, amount: '-120', periodStart: '2026-10-01' },
          { ...ref, amount: '120', periodStart: '2026-09-01' },
        ),
        ownerItems: sheet(
          { owner: 'OWN-01', agentCash: '-100', rentTax: '-20' },
          { owner: 'OWN-02', rentTax: '20' },
        ),
      },
      ADJUSTMENT,
    );
    expect(balances.deposits.map((r) => r.amountMinor)).toEqual([-300_000]);
    expect(balances.withholding.map((r) => [r.amountMinor, r.withheldOn])).toEqual([
      [-12_000, null],
    ]);
    expect(balances.ownerItems.map((r) => [r.agentCashMinor, r.rentTaxOutstandingMinor])).toEqual([
      [-10_000, -2_000],
    ]);
    expect(balances.issues.map((i) => [i.sheet, i.row, i.column])).toEqual([
      ['Withholding', 3, 'Withheld on'],
      ['Owner items', 3, 'Rent tax due date'],
    ]);
  });
});

describe('PR-08 onboarding: importing the same file again finds the same records', () => {
  const tenantRow = fc.record({
    kind: fc.constantFrom('Individual', 'individual', 'COMPANY', 'Company'),
    name: fc.constantFrom('Kofi Asante', 'Osu Traders Ltd', 'Abena Mensah'),
    phone: fc.integer({ min: 1, max: 9_999_999 }).map((n) => `024${String(n).padStart(7, '0')}`),
    tin: fc.constantFrom(COMPANY_TIN, 'C0000000002', null),
  });

  it('gives every row the same key each time, whatever the case and spacing of codes and names', () => {
    fc.assert(
      fc.property(fc.array(tenantRow, { maxLength: 20 }), (rows) => {
        const first = checkTenantRows(sheet(...rows));
        const again = checkTenantRows(sheet(...rows));
        expect(again).toEqual(first);
        const respaced = checkTenantRows(
          sheet(
            ...rows.map((r) => ({ ...r, name: ` ${r.name.toUpperCase()} `, phone: ` ${r.phone}` })),
          ),
        );
        expect(respaced.rows.map((r) => r.keys)).toEqual(first.rows.map((r) => r.keys));
      }),
    );
  });

  it('names a lease in the Balances workbook by the same key as its Leases row', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('acc-leg-b1-4', 'ACC-LEG-B1-04', ' Acc-Leg-B1-004 '),
        fc.integer({ min: 0, max: 300 }),
        (unit, offset) => {
          const first = addDays(parseBusinessDate('2025-01-01'), offset);
          const start = toIsoDate(first);
          const end = toIsoDate(addDays(addMonths(first, 12), -1));
          const [leaseRow] = checkLeaseRows(
            sheet(lease({ unit, startDate: start, endDate: end, cycle: 'Monthly' })),
            { today: TODAY },
          ).rows;
          const [deposit] = checkDepositRows(
            sheet({ unit, leaseStart: start, amount: 1 }),
            BALANCES,
          ).rows;
          expect(deposit!.leaseKey).toBe(leaseRow!.matchKey);
        },
      ),
    );
  });
});
