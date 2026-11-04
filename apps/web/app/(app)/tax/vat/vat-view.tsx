'use client';

import type { ApiClient } from '@rent/contracts/client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '@/components/app-context';
import { secondaryLink } from '@/components/link-styles';
import { Empty, Loading } from '@/components/load-state';
import { RulesWarning } from '@/components/rules-warning';
import { TaxFileButton } from '@/components/tax-file-button';
import { Alert } from '@/components/ui/alert';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { SelectField, TextField } from '@/components/ui/field';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatBusinessDate, todayIn } from '@/lib/business-dates';
import { toProblem } from '@/lib/errors';
import { monthLabel, monthOf, monthPeriod, previousMonth } from '@/lib/rent-tax';
import { useRequestGate } from '@/lib/request-gate';
import { formatMinor } from '@/lib/tenancy-format';
import { byTaxPoint } from '@/lib/vat-returns';

type VatReport = Awaited<ReturnType<ApiClient['vat']['report']>>;

/** The VAT and levies report (P33) for one owner and month. Every figure is the API's. */
export function VatView({
  owners,
  initialOwnerId,
  initialMonth,
  canPay,
}: {
  readonly owners: readonly { readonly id: string; readonly label: string }[];
  readonly initialOwnerId: string | null;
  readonly initialMonth: string | null;
  readonly canPay: boolean;
}) {
  const { timeZone } = useApp();
  const today = todayIn(timeZone);
  const [ownerId, setOwnerId] = useState(
    initialOwnerId ?? (owners.length === 1 ? owners[0]!.id : ''),
  );
  const [month, setMonth] = useState(initialMonth ?? previousMonth(today));
  const [report, setReport] = useState<VatReport | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const gate = useRequestGate();
  const valid = monthPeriod(month) !== null;

  const load = useCallback(async () => {
    const current = gate.begin();
    setReport(null);
    setProblem(null);
    if (!ownerId || !valid) return;
    try {
      const result = await api().vat.report({ ownerId, month });
      if (current()) setReport(result);
    } catch (failure) {
      if (current()) setProblem(toProblem(failure).message);
    }
  }, [gate, ownerId, month, valid]);

  useEffect(() => {
    void load();
    return gate.cancel;
  }, [gate, load]);

  return (
    <Card data-testid="vat-report">
      <CardHeader
        title="VAT and levies by month"
        description="Charged at the tax point and owed to GRA with the month’s return. Rates come from rules a tax adviser is still to confirm (OQ-20)."
        actions={
          canPay && ownerId ? (
            <Link
              href={`/tax/vat/payments/new?ownerId=${ownerId}&month=${month}`}
              className={secondaryLink}
            >
              Record a VAT payment
            </Link>
          ) : null
        }
      />
      <CardBody>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label="Owner"
            value={ownerId}
            options={[
              {
                value: '',
                label: owners.length ? 'Choose the owner' : 'No owner is registered for VAT',
              },
              ...owners.map((o) => ({ value: o.id, label: o.label })),
            ]}
            onChange={(event) => setOwnerId(event.target.value)}
          />
          <TextField
            label="Month"
            type="month"
            hint="Year and month, such as 2026-10."
            max={monthOf(today)}
            value={month}
            error={month && !valid ? 'Choose a month' : null}
            onChange={(event) => setMonth(event.target.value)}
          />
        </div>
        {!ownerId ? <Empty>Choose an owner registered for VAT.</Empty> : null}
        {problem ? <Alert tone="error">{problem}</Alert> : null}
        {ownerId && valid && !report && !problem ? <Loading what="the VAT report" /> : null}
        {report ? <VatBody report={report} /> : null}
      </CardBody>
    </Card>
  );
}

function VatBody({ report }: { readonly report: VatReport }) {
  const rows = byTaxPoint(report.invoices);
  const owner = report.ownerName;
  return (
    <div className="space-y-4">
      <RulesWarning rules={[]} apiWarnings={report.warnings} />
      <p className="text-sm font-medium text-slate-900">
        {owner}, {monthLabel(report.month)}
      </p>
      {rows.length === 0 ? (
        <Empty>No VAT was charged in {monthLabel(report.month)}.</Empty>
      ) : (
        <Table caption={`VAT and levies for ${owner}, ${monthLabel(report.month)}`}>
          <thead>
            <tr>
              <Th>Tax point</Th>
              <Th>Invoice</Th>
              <Th className="text-right">VAT</Th>
              <Th className="text-right">NHIL</Th>
              <Th className="text-right">GETFund</Th>
              <Th className="text-right">Credit notes</Th>
              <Th className="text-right">Total</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => (
              <tr key={`${row.taxPoint}-${row.invoiceId}`} data-testid="vat-row">
                <Td className="whitespace-nowrap">{formatBusinessDate(row.taxPoint)}</Td>
                <Td>
                  <Link
                    href={`/invoices/${row.invoiceId}`}
                    className="font-mono underline underline-offset-2"
                  >
                    {row.invoiceNumber}
                  </Link>
                  <p className="text-xs text-slate-600">
                    {row.unitCode} · {row.tenantName}
                  </p>
                </Td>
                <Td className="text-right tabular-nums">{formatMinor(row.vatMinor)}</Td>
                <Td className="text-right tabular-nums">{formatMinor(row.nhilMinor)}</Td>
                <Td className="text-right tabular-nums">{formatMinor(row.getfundMinor)}</Td>
                <Td className="text-right tabular-nums">
                  {row.adjustmentsMinor ? formatMinor(row.adjustmentsMinor) : '—'}
                </Td>
                <Td className="text-right font-medium tabular-nums">
                  {formatMinor(row.totalMinor)}
                </Td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-300" data-testid="vat-totals">
              <Th scope="row" colSpan={2}>
                Total for the month
              </Th>
              <Td className="text-right font-semibold tabular-nums">
                {formatMinor(report.totals.vatMinor)}
              </Td>
              <Td className="text-right font-semibold tabular-nums">
                {formatMinor(report.totals.nhilMinor)}
              </Td>
              <Td className="text-right font-semibold tabular-nums">
                {formatMinor(report.totals.getfundMinor)}
              </Td>
              <Td className="text-right font-semibold tabular-nums">
                {formatMinor(report.totals.adjustmentsMinor)}
              </Td>
              <Td className="text-right font-semibold tabular-nums">
                {formatMinor(report.totals.totalMinor)}
              </Td>
            </tr>
          </tfoot>
        </Table>
      )}
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
        <div data-testid="vat-total">
          <dt className="text-slate-600">VAT and levies charged</dt>
          <dd className="text-lg font-semibold tabular-nums">
            {formatMinor(report.totals.totalMinor)}
          </dd>
        </div>
        <div data-testid="vat-paid">
          <dt className="text-slate-600">Paid to GRA for this month</dt>
          <dd className="text-lg font-semibold tabular-nums">
            {formatMinor(report.totals.paidMinor)}
          </dd>
        </div>
        <div data-testid="vat-outstanding">
          <dt className="text-slate-600">Still to pay GRA</dt>
          <dd className="text-lg font-semibold tabular-nums">
            {formatMinor(report.totals.outstandingMinor)}
          </dd>
        </div>
      </dl>
      <div className="space-y-2" data-testid="vat-payments">
        <h3 className="text-sm font-semibold text-slate-900">VAT paid to GRA for this month</h3>
        {report.payments.length === 0 ? (
          <Empty>None recorded.</Empty>
        ) : (
          <ul className="divide-y divide-slate-100">
            {report.payments.map((payment) => (
              <li
                key={payment.id}
                data-testid="vat-payment"
                className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm"
              >
                <span>
                  <span className="font-medium">{formatMinor(payment.amountMinor)}</span> paid{' '}
                  {formatBusinessDate(payment.paidOn)}, GRA receipt{' '}
                  <span className="font-mono">{payment.graReceiptNumber}</span>
                </span>
                <TaxFileButton
                  documentId={payment.receiptDocumentId}
                  label={`Open GRA receipt ${payment.graReceiptNumber}`}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
