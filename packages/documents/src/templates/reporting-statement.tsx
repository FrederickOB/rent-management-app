import { AGE_BUCKETS, AGE_BUCKET_LABELS } from '@rent/domain/billing';
import {
  formatBusinessDate,
  formatInstant,
  instantFrom,
  isValidTimeZone,
} from '@rent/domain/dates';
import { GRA_PAYERS, type GraPayer } from '@rent/domain/ledger';
import { format, money } from '@rent/domain/money';
import {
  AGENT_CASH_IN,
  AGENT_CASH_OUT,
  COLLECTION_METHODS,
  STATEMENT_CHECKS,
  type AgentCashIn,
  type AgentCashOut,
  type CollectionMethod,
  type StatementCheckName,
} from '@rent/domain/reporting';
import type { ReactNode } from 'react';
import { z } from 'zod';
import { Letterhead } from './letterhead';
import { defineTemplate, type TemplateProps } from './registry';

/**
 * The monthly owner statement (M9: AC-04; decisions 5 to 7). A page per property, then a summary
 * with the agent's side, each with a cash section (money in and out in the month), an accrual
 * section (earned in the month, held and owed at its end) and occupancy. The figures are the
 * domain's `ownerStatementFigures`, frozen as issued; amounts are integer pesewas, formatted only
 * here. The month is a calendar month in the company's time zone; every time shown (issued, worked
 * out, each payment recorded) is in the owner's time zone, named (DO-04). Expenses without a
 * receipt say so (M8 F3).
 */
const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const instant = z.string().datetime();
const minor = z.int();
const count = z.int().min(0);
const zone = z.string().refine(isValidTimeZone, 'Unknown time zone');

const byKeys = <K extends readonly [string, ...string[]]>(keys: K) =>
  z.strictObject(
    Object.fromEntries(keys.map((k) => [k, minor])) as { [P in K[number]]: typeof minor },
  );

const pageSchema = z.strictObject({
  propertyId: uuid.nullable(),
  cash: z.strictObject({
    collectionsByMethod: byKeys(COLLECTION_METHODS),
    collectionsMinor: minor,
    expensesByCategory: z
      .array(z.strictObject({ category: z.string().min(1).max(60), amountMinor: minor }))
      .max(20),
    expensesMinor: minor,
    feesMinor: minor,
    rentTaxAccruedMinor: minor,
    rentTaxPaidMinor: minor,
  }),
  accrual: z.strictObject({
    rentEarnedMinor: minor,
    serviceChargeEarnedMinor: minor,
    earnedMinor: minor,
    unearnedRentMinor: minor,
    unearnedServiceChargeMinor: minor,
    creditMinor: minor,
    unearnedMinor: minor,
    depositsHeldMinor: minor,
    arrearsByBucket: byKeys(AGE_BUCKETS),
    arrearsMinor: minor,
  }),
  occupancy: z.strictObject({
    units: count,
    lettable: count,
    occupied: count,
    vacant: count,
    available: count,
    reserved: count,
    underRepair: count,
    notLettable: count,
    rate: z.strictObject({ numerator: count, denominator: count, bps: count.nullable() }),
  }),
});
type Page = z.infer<typeof pageSchema>;

const figuresSchema = z.strictObject({
  ownerId: uuid,
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  firstDay: isoDate,
  lastDay: isoDate,
  properties: z.array(pageSchema).max(2_000),
  summary: pageSchema,
  processingFeesMinor: minor,
  rentTaxPayable: z
    .strictObject({
      openingMinor: minor,
      accruedMinor: minor,
      paidMinor: minor,
      certifiedMinor: minor,
      closingMinor: minor,
    })
    .nullable(),
  agent: z
    .strictObject({
      openingMinor: minor,
      in: byKeys(AGENT_CASH_IN),
      out: byKeys(AGENT_CASH_OUT),
      inMinor: minor,
      outMinor: minor,
      closingMinor: minor,
      feesDueOpeningMinor: minor,
      feesChargedMinor: minor,
      feesTakenMinor: minor,
      feesSettledAtSourceMinor: minor,
      feesDueClosingMinor: minor,
      reserveMinor: minor,
      graPaidBy: z.enum(GRA_PAYERS).nullable(),
      rentTaxHeldBackMinor: minor,
      netRemittableMinor: minor,
      remittancesMadeMinor: minor,
    })
    .nullable(),
  checks: z
    .array(
      z.strictObject({
        name: z.enum(STATEMENT_CHECKS),
        scope: z.string().min(1).max(60),
        expectedMinor: minor,
        actualMinor: minor,
        passed: z.boolean(),
      }),
    )
    .max(5_000),
});

const ownerStatementSchema = z.strictObject({
  statementId: uuid,
  companyName: z.string().min(1).max(200),
  ownerName: z.string().min(1).max(200),
  ownerReference: z.string().min(1).max(40),
  /** The month is a calendar month here (decision 5). */
  companyTimeZone: zone,
  /** Times are shown here (DO-04). */
  ownerTimeZone: zone,
  generatedAt: instant,
  issuedAt: instant,
  issuedByName: z.string().min(1).max(200),
  propertyNames: z.array(z.strictObject({ id: uuid, name: z.string().min(1).max(200) })).max(2_000),
  figures: figuresSchema,
  payments: z
    .array(
      z.strictObject({
        propertyId: uuid,
        unitCode: z.string().max(60),
        kind: z.enum(['received', 'matched', 'reversed']),
        method: z.enum(COLLECTION_METHODS),
        receivedOn: isoDate,
        recordedAt: instant,
        amountMinor: minor,
      }),
    )
    .max(50_000),
  expenses: z
    .array(
      z.strictObject({
        id: uuid,
        propertyId: uuid,
        category: z.string().min(1).max(60),
        supplierName: z.string().min(1).max(120),
        expenseDate: isoDate,
        amountMinor: minor,
        noReceipt: z.boolean(),
      }),
    )
    .max(20_000),
  /**
   * M11 (P25; plan 4.2): the opening balances brought in at the company's cut-over and reported in
   * the month, shown in their own section on the first statement. Absent on every other.
   */
  opening: z
    .strictObject({
      cutOver: isoDate,
      arrearsMinor: minor,
      advancesMinor: minor,
      depositsMinor: minor,
      withholdingMinor: minor,
      agentCashMinor: minor,
      rentTaxOutstandingMinor: minor,
    })
    .optional(),
});
export type OwnerStatementDocumentData = z.infer<typeof ownerStatementSchema>;

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const monthName = (month: string) =>
  `${MONTHS[Number(month.slice(5, 7)) - 1] ?? month} ${month.slice(0, 4)}`;

const METHOD_LABELS: Record<CollectionMethod, string> = {
  momo: 'MoMo',
  card: 'Card',
  bank_transfer: 'Bank transfer',
  cash: 'Cash',
  cheque: 'Cheque',
  test: 'Test payments',
};

const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  repairs: 'Repairs and maintenance',
  rates: 'Property rates',
  insurance: 'Insurance',
  utilities: 'Utilities',
  cleaning: 'Cleaning',
  security: 'Security',
  legal: 'Legal',
  other: 'Other',
};
const categoryLabel = (category: string) => CATEGORY_LABELS[category] ?? category;

const IN_LABELS: Record<AgentCashIn, string> = {
  collections: 'Rent and charges collected',
  owner_funding: 'Money the owner sent for bills',
  other_in: 'Other money in',
};

const OUT_LABELS: Record<AgentCashOut, string> = {
  expenses_paid: 'Expenses paid',
  fees_taken: 'Management fees taken',
  rent_tax_paid: 'Rent tax paid to GRA',
  vat_paid: 'VAT paid to GRA',
  refunds_paid: 'Refunds paid to tenants',
  remittances: 'Paid to the owner',
  reversals: 'Payments reversed',
  other_out: 'Other money out',
};

const CHECK_LABELS: Record<StatementCheckName, string> = {
  agent_cash: 'Cash held by the agent: opening, plus money in, less money out, equals closing',
  fees_due: 'Fees due: opening, plus charged, less taken and settled, equals closing',
  rent_tax_receipts: 'Rent tax: the month’s total equals the tax on each receipt',
  rent_tax_payable:
    'Rent tax payable: opening, plus accrued, less paid and certified, equals closing',
};

const GRA_LABELS: Record<GraPayer, string> = { agency: 'The agency', owner: 'The owner' };

const KIND_LABELS = { received: 'Received', matched: 'Matched', reversed: 'Reversed' } as const;

const cedis = (amount: number) => format(money(amount));
const share = (bps: number | null) =>
  bps === null ? '—' : `${Math.trunc(bps / 100)}.${String(bps % 100).padStart(2, '0')}%`;

function Row({ label, amount, strong }: { label: string; amount: number; strong?: boolean }) {
  return (
    <tr>
      <td>{strong ? <strong>{label}</strong> : label}</td>
      <td className="amount">{strong ? <strong>{cedis(amount)}</strong> : cedis(amount)}</td>
    </tr>
  );
}

function Counted({ label, value }: { label: string; value: ReactNode }) {
  return (
    <tr>
      <td>{label}</td>
      <td className="amount">{value}</td>
    </tr>
  );
}

/** The three sections every page has: cash, accrual and occupancy. */
function Sections({ page }: { page: Page }) {
  const { cash, accrual, occupancy } = page;
  const methods = COLLECTION_METHODS.filter((m) => cash.collectionsByMethod[m] !== 0);
  return (
    <>
      <h3>Money in and out in the month</h3>
      <table className="lines">
        <tbody>
          {methods.map((m) => (
            <Row
              key={m}
              label={`Collected by ${METHOD_LABELS[m]}`}
              amount={cash.collectionsByMethod[m]}
            />
          ))}
          <Row label="Collected from tenants" amount={cash.collectionsMinor} strong />
          {cash.expensesByCategory.map((e) => (
            <Row key={e.category} label={categoryLabel(e.category)} amount={e.amountMinor} />
          ))}
          <Row label="Expenses" amount={cash.expensesMinor} strong />
          <Row label="Management fees" amount={cash.feesMinor} />
          <Row label="Rent tax on the month’s receipts" amount={cash.rentTaxAccruedMinor} />
          <Row label="Rent tax paid to GRA" amount={cash.rentTaxPaidMinor} />
        </tbody>
      </table>
      <h3>Earned in the month, and held and owed at its end</h3>
      <table className="lines">
        <tbody>
          <Row label="Rent earned" amount={accrual.rentEarnedMinor} />
          <Row label="Service charge earned" amount={accrual.serviceChargeEarnedMinor} />
          <Row label="Earned" amount={accrual.earnedMinor} strong />
          <Row
            label="Unearned rent (paid for months not started)"
            amount={accrual.unearnedRentMinor}
          />
          <Row
            label="Unearned service charge (paid for months not started)"
            amount={accrual.unearnedServiceChargeMinor}
          />
          <Row label="Paid ahead, not yet applied to a month" amount={accrual.creditMinor} />
          <Row label="Held for tenants" amount={accrual.unearnedMinor} strong />
          <Row label="Deposits held" amount={accrual.depositsHeldMinor} />
          {AGE_BUCKETS.map((b) => (
            <Row
              key={b}
              label={`Arrears, ${AGE_BUCKET_LABELS[b]} overdue`}
              amount={accrual.arrearsByBucket[b]}
            />
          ))}
          <Row label="Arrears" amount={accrual.arrearsMinor} strong />
        </tbody>
      </table>
      <h3>Units at the month’s end</h3>
      <table className="lines">
        <tbody>
          <Counted label="Units" value={occupancy.units} />
          <Counted label="Occupied" value={occupancy.occupied} />
          <Counted label="Vacant" value={occupancy.vacant} />
          <Counted label="Of which reserved" value={occupancy.reserved} />
          <Counted label="Of which under repair" value={occupancy.underRepair} />
          <Counted label="Not lettable" value={occupancy.notLettable} />
          <Counted label="Occupancy (occupied of lettable)" value={share(occupancy.rate.bps)} />
        </tbody>
      </table>
    </>
  );
}

function OwnerStatement({ data, branding }: TemplateProps<OwnerStatementDocumentData>) {
  const f = data.figures;
  const names = new Map(data.propertyNames.map((p) => [p.id, p.name]));
  const nameOf = (id: string | null) =>
    id === null ? 'The owner' : (names.get(id) ?? 'A former property');
  const when = (iso: string) => formatInstant(instantFrom(iso), data.ownerTimeZone);
  const a = f.agent;
  const t = f.rentTaxPayable;
  return (
    <Letterhead branding={branding}>
      <h1>Owner statement: {monthName(f.month)}</h1>
      <table className="summary">
        <tbody>
          <tr>
            <th scope="row">Owner</th>
            <td>
              {data.ownerName} ({data.ownerReference})
            </td>
          </tr>
          <tr>
            <th scope="row">Managed by</th>
            <td>{data.companyName}</td>
          </tr>
          <tr>
            <th scope="row">Period</th>
            <td>
              {formatBusinessDate(f.firstDay)} to {formatBusinessDate(f.lastDay)} (
              {data.companyTimeZone})
            </td>
          </tr>
          <tr>
            <th scope="row">Issued</th>
            <td>
              {when(data.issuedAt)}, by {data.issuedByName}
            </td>
          </tr>
          <tr>
            <th scope="row">Figures worked out</th>
            <td>{when(data.generatedAt)}</td>
          </tr>
          <tr>
            <th scope="row">Statement</th>
            <td className="reference">{data.statementId}</td>
          </tr>
        </tbody>
      </table>
      <p className="small">
        Every figure comes from the ledger for the month, by the date it is reported in. Anything
        recorded after this statement was issued is reported in a later month, so this statement
        never changes. Times are shown in {data.ownerTimeZone}.
      </p>

      {data.opening ? (
        <section>
          <h2>Opening balances brought in</h2>
          <p className="small">
            Balances at the cut-over, {formatBusinessDate(data.opening.cutOver)}, brought in from
            before the platform. They are opening balances, never income: no rent tax and no
            management fee is charged on them. Rent tax still owed is in the rent tax payable at the
            start of the month below.
          </p>
          <table className="lines">
            <tbody>
              <Row label="Arrears owed by tenants" amount={data.opening.arrearsMinor} />
              <Row label="Rent paid in advance" amount={data.opening.advancesMinor} />
              <Row label="Deposits held" amount={data.opening.depositsMinor} />
              <Row
                label="Withholding tax awaiting certificates"
                amount={data.opening.withholdingMinor}
              />
              <Row label="Cash held by the agent" amount={data.opening.agentCashMinor} />
              <Row
                label="Rent tax still owed to GRA"
                amount={data.opening.rentTaxOutstandingMinor}
              />
            </tbody>
          </table>
        </section>
      ) : null}

      {f.properties.map((page, index) => {
        const id = page.propertyId as string;
        const payments = data.payments.filter((p) => p.propertyId === id);
        const expenses = data.expenses.filter((e) => e.propertyId === id);
        return (
          <section key={id} style={index === 0 ? undefined : { breakBefore: 'page' }}>
            <h2>{nameOf(id)}</h2>
            <Sections page={page} />
            <h3>Payments in the month</h3>
            {payments.length === 0 ? (
              <p className="small">No payments.</p>
            ) : (
              <table className="lines">
                <thead>
                  <tr>
                    <th scope="col">Received</th>
                    <th scope="col">Unit</th>
                    <th scope="col">Method</th>
                    <th scope="col">Recorded</th>
                    <th scope="col">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p, i) => (
                    <tr key={`${p.kind}-${i}`}>
                      <td>
                        {formatBusinessDate(p.receivedOn)}
                        {p.kind === 'received' ? '' : ` (${KIND_LABELS[p.kind]})`}
                      </td>
                      <td>{p.unitCode}</td>
                      <td>{METHOD_LABELS[p.method]}</td>
                      <td className="small">{when(p.recordedAt)}</td>
                      <td className="amount">{cedis(p.amountMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <h3>Expenses in the month</h3>
            {expenses.length === 0 ? (
              <p className="small">No expenses.</p>
            ) : (
              <table className="lines">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Expense</th>
                    <th scope="col">Supplier</th>
                    <th scope="col">Receipt</th>
                    <th scope="col">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {expenses.map((e, i) => (
                    <tr key={`${e.id}-${i}`}>
                      <td>{formatBusinessDate(e.expenseDate)}</td>
                      <td>{categoryLabel(e.category)}</td>
                      <td>{e.supplierName}</td>
                      <td>{e.noReceipt ? <strong>No receipt</strong> : 'Receipt held'}</td>
                      <td className="amount">{cedis(e.amountMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        );
      })}

      <section style={{ breakBefore: 'page' }}>
        <h2>Summary: every property</h2>
        <Sections page={f.summary} />
        <table className="lines">
          <tbody>
            <Row label="Payment processing fees" amount={f.processingFeesMinor} />
          </tbody>
        </table>
        {t ? (
          <>
            <h3>Rent tax payable</h3>
            <table className="lines">
              <tbody>
                <Row label="At the start of the month" amount={t.openingMinor} />
                <Row label="Accrued on the month’s receipts" amount={t.accruedMinor} />
                <Row label="Paid to GRA" amount={t.paidMinor} />
                <Row label="Settled by withholding certificates" amount={t.certifiedMinor} />
                <Row label="At the end of the month" amount={t.closingMinor} strong />
              </tbody>
            </table>
          </>
        ) : null}
        {a ? (
          <>
            <h3>Held by the agent for the owner</h3>
            <table className="lines">
              <tbody>
                <Row label="At the start of the month" amount={a.openingMinor} />
                {AGENT_CASH_IN.filter((k) => a.in[k] !== 0).map((k) => (
                  <Row key={k} label={IN_LABELS[k]} amount={a.in[k]} />
                ))}
                {AGENT_CASH_OUT.filter((k) => a.out[k] !== 0).map((k) => (
                  <Row key={k} label={OUT_LABELS[k]} amount={0 - a.out[k]} />
                ))}
                <Row label="At the end of the month" amount={a.closingMinor} strong />
              </tbody>
            </table>
            <h3>Management fees due to the agent</h3>
            <table className="lines">
              <tbody>
                <Row label="At the start of the month" amount={a.feesDueOpeningMinor} />
                <Row label="Charged in the month" amount={a.feesChargedMinor} />
                <Row label="Taken by the agent" amount={0 - a.feesTakenMinor} />
                <Row label="Settled at source" amount={0 - a.feesSettledAtSourceMinor} />
                <Row label="At the end of the month" amount={a.feesDueClosingMinor} strong />
              </tbody>
            </table>
            <h3>What the agent can pay the owner</h3>
            <table className="lines">
              <tbody>
                <Counted
                  label="Who pays the rent tax to GRA"
                  value={a.graPaidBy ? GRA_LABELS[a.graPaidBy] : 'Not recorded'}
                />
                <Row label="Held by the agent at the end of the month" amount={a.closingMinor} />
                <Row label="Rent tax held back for GRA" amount={0 - a.rentTaxHeldBackMinor} />
                <Row label="Held back for other bills" amount={0 - a.reserveMinor} />
                <Row label="Fees due to the agent" amount={0 - a.feesDueClosingMinor} />
                <Row label="Net remittable" amount={a.netRemittableMinor} strong />
                <Row label="Paid to the owner in the month" amount={a.remittancesMadeMinor} />
              </tbody>
            </table>
          </>
        ) : null}
        <h3>Checks</h3>
        <table className="lines">
          <tbody>
            {f.checks.map((c) => (
              <tr key={`${c.name}-${c.scope}`}>
                <td>
                  {CHECK_LABELS[c.name]}
                  {names.has(c.scope) ? ` (${nameOf(c.scope)})` : ''}
                </td>
                <td className="amount">{c.passed ? 'Passed' : 'Failed'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </Letterhead>
  );
}

export const ownerStatementV1 = defineTemplate({
  key: 'reporting.owner-statement',
  version: 1,
  title: 'Owner statement',
  schema: ownerStatementSchema,
  Component: OwnerStatement,
});
