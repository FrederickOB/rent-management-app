'use client';

import type { InvoiceRow, LeaseBilling, PaymentRow } from '@rent/contracts';
import Link from 'next/link';
import { useCallback } from 'react';
import { InvoiceStatusBadge, PaymentStatusBadge } from '@/components/billing-badges';
import { secondaryLink, textLink } from '@/components/link-styles';
import { SendPayLink } from '@/components/send-pay-link';
import { Empty, Loading, LoadFailed } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import {
  INVOICE_KIND_LABELS,
  moneyFacts,
  NOT_BILLED_LABELS,
  PAYMENT_METHOD_LABELS,
  periodLabel,
} from '@/lib/billing-format';
import { formatBusinessDate } from '@/lib/business-dates';
import { payLinkState } from '@/lib/collection';
import { formatMinor } from '@/lib/tenancy-format';
import { useLoad } from '@/lib/use-load';

export interface MoneyPermissions {
  /** billing.view: the money card, invoices and payments. */
  readonly view: boolean;
  /** payment.record: cash and cheques. */
  readonly recordCash: boolean;
  /** payment.record_transfer: transfers straight into an account. */
  readonly recordTransfer: boolean;
  /** billing.manage: send the tenant a pay link (BC-04); the API checks consent and destination. */
  readonly sendPayLink: boolean;
}

const ROWS = 12;

/** Ways to record money for this lease, as the policy allows; the API checks again. */
function RecordLinks({
  leaseId,
  can,
}: {
  readonly leaseId: string;
  readonly can: MoneyPermissions;
}) {
  if (!can.recordCash && !can.recordTransfer) return null;
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Record a payment">
      {can.recordCash ? (
        <Link href={`/cash/new?leaseId=${leaseId}`} className={secondaryLink}>
          Record cash or cheque
        </Link>
      ) : null}
      {can.recordTransfer ? (
        <Link href={`/payments/transfer?leaseId=${leaseId}`} className={secondaryLink}>
          Record a transfer
        </Link>
      ) : null}
    </div>
  );
}

interface MoneyData {
  readonly billing: LeaseBilling;
  /**
   * Cash and cheques recorded for the lease and still waiting for a second person, or null when
   * that could not be checked (the figures are shown, with a warning that some may be missing).
   */
  readonly waiting: { readonly minor: number; readonly count: number } | null;
}

/**
 * The lease's money (AR-02, AR-03, BC-11; plan 4.19): what is due and overdue, paid-until with
 * partial cover, unearned rent, the deposit held, credit and the payment reference. The API
 * derives every figure from the ledger and its sub-ledgers; none is typed in or stored.
 */
export function LeaseMoney({
  leaseId,
  unitCode,
  can,
}: {
  readonly leaseId: string;
  readonly unitCode: string;
  readonly can: MoneyPermissions;
}) {
  const load = useCallback(async (): Promise<MoneyData> => {
    const [billing, waiting] = await Promise.all([
      api().invoices.leaseBilling({ leaseId }),
      // Cash posts only once approved (BC-05); until then it is not in the figures, so say so.
      api()
        .payments.cashRecords({ leaseId, status: 'awaiting_approval' })
        .then(
          (rows) => ({
            minor: rows.reduce((sum, r) => sum + r.amountMinor, 0),
            count: rows.length,
          }),
          () => null,
        ),
    ]);
    return { billing, waiting };
  }, [leaseId]);
  const { state, reload } = useLoad(load);

  return (
    <Card data-testid="lease-money">
      <CardHeader
        title="Money"
        description="Worked out from the ledger each time; nothing here is typed in."
        actions={
          state.status === 'ready' && state.data.billing.notBilledReason === null ? (
            <RecordLinks leaseId={leaseId} can={can} />
          ) : null
        }
      />
      <CardBody>
        {state.status === 'loading' ? <Loading what="the money summary" /> : null}
        {state.status === 'error' ? (
          <LoadFailed message={state.problem.message} onRetry={reload} />
        ) : null}
        {state.status === 'ready' ? (
          <MoneySummary data={state.data} unitCode={unitCode} canSendPayLink={can.sendPayLink} />
        ) : null}
      </CardBody>
    </Card>
  );
}

function MoneySummary({
  data,
  unitCode,
  canSendPayLink,
}: {
  readonly data: MoneyData;
  readonly unitCode: string;
  readonly canSendPayLink: boolean;
}) {
  const { billing } = data;
  return (
    <>
      {billing.notBilledReason ? (
        <Alert tone="info" title="Not billed">
          {NOT_BILLED_LABELS[billing.notBilledReason]}
        </Alert>
      ) : null}
      {data.waiting === null ? (
        <Alert tone="warning">
          We could not check for cash or cheques waiting for confirmation. Any that are waiting are
          not in these figures until a second person approves them.
        </Alert>
      ) : data.waiting.count > 0 ? (
        <Alert tone="info">
          {formatMinor(data.waiting.minor)} in cash or cheques is recorded and waiting for
          confirmation. It is not in these figures until a second person approves it.
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
        <p data-testid="money-reference">
          <span className="text-slate-600">Payment reference: </span>
          {billing.paymentReference ? (
            <span className="font-mono text-base font-semibold tracking-wider">
              {billing.paymentReference}
            </span>
          ) : (
            <span className="text-slate-600">issued when the lease is signed</span>
          )}
        </p>
        {billing.billingStartDate ? (
          <p className="text-slate-700">
            Billed from {formatBusinessDate(billing.billingStartDate)}
          </p>
        ) : null}
      </div>
      {billing.paymentReference ? (
        <p className="text-sm text-slate-600">
          Tenants quote it, with the unit code <span className="font-mono">{unitCode}</span>, when
          they pay by transfer.
        </p>
      ) : null}
      <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {moneyFacts(billing).map((fact) => (
          <div key={fact.key} className="min-w-0" data-testid={`money-${fact.key}`}>
            <dt className="text-slate-600">{fact.label}</dt>
            <dd className="text-lg font-semibold tabular-nums text-slate-900">{fact.value}</dd>
            {fact.detail ? (
              <dd className="text-sm font-medium text-slate-800" data-testid="money-partial">
                {fact.detail}
              </dd>
            ) : null}
            <dd className="text-xs text-slate-600">{fact.hint}</dd>
          </div>
        ))}
      </dl>
      {canSendPayLink && billing.payLink ? <PayLinkSection payLink={billing.payLink} /> : null}
      {billing.chargedAfterEnd.length > 0 ? (
        <ChargedAfterEnd lines={billing.chargedAfterEnd} />
      ) : null}
    </>
  );
}

/**
 * The pay link for the lease (BC-04; plan 4.2 and 4.3), as the API answers before anyone tries:
 * for the oldest invoice still to pay, since payments pay the oldest debt first and the pay page
 * shows everything due (deviation 3); or why it cannot go now.
 */
function PayLinkSection({ payLink }: { readonly payLink: NonNullable<LeaseBilling['payLink']> }) {
  const state = payLinkState(payLink);
  return (
    <div className="space-y-2 border-t border-slate-200 pt-4" data-testid="money-pay-link">
      <p className="text-sm font-medium text-slate-900">Pay link</p>
      {state.kind === 'send' ? (
        <>
          <p className="text-sm text-slate-700">
            Send the tenant a link to pay by mobile money or card, by SMS or email. It is for the
            oldest invoice still to pay, and the page shows everything due on the lease.
          </p>
          <SendPayLink invoiceId={state.invoiceId} detail="for this lease" />
        </>
      ) : (
        <Alert tone={state.tone} live={false}>
          <span data-testid="pay-link-unavailable">{state.text}</span>
        </Alert>
      )}
    </div>
  );
}

/**
 * Periods charged before a late move-out was recorded (P27): they stay owed, and only a credit
 * note that a second person approves takes them off, so the card lists them with their invoices.
 */
function ChargedAfterEnd({ lines }: { readonly lines: LeaseBilling['chargedAfterEnd'] }) {
  return (
    <div className="space-y-2" data-testid="money-charged-after-end">
      <Alert tone="warning" title="Charged after the lease ended">
        These periods were charged before the move-out was recorded, so they are still owed. If the
        tenant should not pay them, ask for a credit note on the invoice. A second person must
        approve it.
      </Alert>
      <Table caption="Charges for periods after the lease ended">
        <thead>
          <tr>
            <Th>Invoice</Th>
            <Th>For</Th>
            <Th className="text-right">Charged</Th>
            <Th className="text-right">Still to pay</Th>
            <Th className="text-right">Can be credited</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {lines.map((line) => (
            <tr key={line.lineId} data-testid="charged-after-end">
              <Td>
                <Link
                  href={`/invoices/${line.invoiceId}`}
                  className="font-mono font-medium underline underline-offset-2"
                >
                  {line.invoiceNumber}
                </Link>
              </Td>
              <Td>
                {line.label}
                <p className="text-xs whitespace-nowrap text-slate-600">
                  {periodLabel(line.periodStart, line.periodEnd)}
                </p>
              </Td>
              <Td className="text-right tabular-nums">{formatMinor(line.netMinor)}</Td>
              <Td className="text-right tabular-nums">{formatMinor(line.outstandingMinor)}</Td>
              <Td className="text-right tabular-nums">{formatMinor(line.creditableMinor)}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

/** The lease's invoices, newest as the API orders them (BC-01). */
export function LeaseInvoices({ leaseId }: { readonly leaseId: string }) {
  const load = useCallback(() => api().invoices.list({ leaseId, limit: 100 }), [leaseId]);
  const { state, reload } = useLoad(load);
  // Newest due date first: the lease page answers "what is owed now"; the list has the rest.
  const rows: readonly InvoiceRow[] =
    state.status === 'ready'
      ? [...state.data].sort((a, b) => (a.dueDate < b.dueDate ? 1 : a.dueDate > b.dueDate ? -1 : 0))
      : [];
  return (
    <Card data-testid="lease-invoices">
      <CardHeader
        title="Invoices"
        description="Issued ahead of each due date, one per billing cycle, and a deposit invoice at signing."
      />
      <CardBody>
        {state.status === 'loading' ? <Loading what="invoices" /> : null}
        {state.status === 'error' ? (
          <LoadFailed message={state.problem.message} onRetry={reload} />
        ) : null}
        {state.status === 'ready' && rows.length === 0 ? <Empty>No invoices yet.</Empty> : null}
        {rows.length ? (
          <>
            <Table caption="Invoices for this lease">
              <thead>
                <tr>
                  <Th>Invoice</Th>
                  <Th>For</Th>
                  <Th>Due</Th>
                  <Th className="text-right">Total</Th>
                  <Th className="text-right">Still to pay</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.slice(0, ROWS).map((row) => (
                  <tr key={row.id} data-testid="lease-invoice">
                    <Td>
                      <Link
                        href={`/invoices/${row.id}`}
                        className="font-mono font-medium underline underline-offset-2"
                      >
                        {row.number}
                      </Link>
                    </Td>
                    <Td>
                      {INVOICE_KIND_LABELS[row.kind]}
                      {periodLabel(row.periodFrom, row.periodTo) ? (
                        <p className="text-xs whitespace-nowrap text-slate-600">
                          {periodLabel(row.periodFrom, row.periodTo)}
                        </p>
                      ) : null}
                    </Td>
                    <Td className="whitespace-nowrap">{formatBusinessDate(row.dueDate)}</Td>
                    <Td className="text-right tabular-nums">{formatMinor(row.totalMinor)}</Td>
                    <Td className="text-right tabular-nums">{formatMinor(row.outstandingMinor)}</Td>
                    <Td>
                      <InvoiceStatusBadge status={row.status} overdue={row.overdue} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Link href={`/invoices?leaseId=${leaseId}`} className={textLink}>
              {rows.length > ROWS ? `See all ${rows.length} invoices` : 'Open in Invoices'}
            </Link>
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}

/** The lease's payments and their receipts (BC-07). */
export function LeasePayments({ leaseId }: { readonly leaseId: string }) {
  const load = useCallback(() => api().payments.list({ leaseId, limit: 100 }), [leaseId]);
  const { state, reload } = useLoad(load);
  const rows: readonly PaymentRow[] =
    state.status === 'ready'
      ? [...state.data].sort((a, b) =>
          a.receivedOn < b.receivedOn ? 1 : a.receivedOn > b.receivedOn ? -1 : 0,
        )
      : [];
  return (
    <Card data-testid="lease-payments">
      <CardHeader
        title="Payments"
        description="Each payment pays the oldest debt first; anything left over is held as credit."
      />
      <CardBody>
        {state.status === 'loading' ? <Loading what="payments" /> : null}
        {state.status === 'error' ? (
          <LoadFailed message={state.problem.message} onRetry={reload} />
        ) : null}
        {state.status === 'ready' && rows.length === 0 ? <Empty>No payments yet.</Empty> : null}
        {rows.length ? (
          <>
            <Table caption="Payments for this lease">
              <thead>
                <tr>
                  <Th>Received</Th>
                  <Th className="text-right">Amount</Th>
                  <Th>How</Th>
                  <Th>Receipt</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.slice(0, ROWS).map((row) => (
                  <tr key={row.id} data-testid="lease-payment">
                    <Td className="whitespace-nowrap">
                      <Link
                        href={`/payments/${row.id}`}
                        className="font-medium underline underline-offset-2"
                      >
                        {formatBusinessDate(row.receivedOn)}
                      </Link>
                    </Td>
                    <Td className="text-right tabular-nums">{formatMinor(row.amountMinor)}</Td>
                    <Td>{PAYMENT_METHOD_LABELS[row.method]}</Td>
                    <Td className="font-mono">{row.receiptNumber ?? '—'}</Td>
                    <Td>
                      <PaymentStatusBadge status={row.status} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {rows.length > ROWS ? (
              <Link href={`/payments?leaseId=${leaseId}`} className={textLink}>
                See all {rows.length} payments
              </Link>
            ) : null}
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}
