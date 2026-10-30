'use client';

import type { InvoiceDetail, InvoiceLineView } from '@rent/contracts';
import Link from 'next/link';
import { Fragment, useState, type FormEvent, type ReactNode } from 'react';
import { useApp } from '@/components/app-context';
import { InvoiceStatusBadge } from '@/components/billing-badges';
import { textLink } from '@/components/link-styles';
import { Empty } from '@/components/load-state';
import { PageHeader } from '@/components/page-header';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { TextAreaField, TextField } from '@/components/ui/field';
import { Table, Td, Th } from '@/components/ui/table';
import { api, keyedApi } from '@/lib/api';
import {
  ALLOCATION_SOURCE_LABELS,
  INVOICE_KIND_LABELS,
  lineKindLabel,
  periodLabel,
  rateLabel,
} from '@/lib/billing-format';
import { openFetchedLink } from '@/lib/browser-files';
import { formatBusinessDate } from '@/lib/business-dates';
import { toProblem } from '@/lib/errors';
import { moneyProblem, sendOnce, useKeepers } from '@/lib/idempotency';
import { amountInput } from '@/lib/lease-form';
import { groupLines, lineCorrections, otherInvoiceWarnings, vatWarning } from '@/lib/invoice-view';
import { waitingNote } from '@/lib/money-requests';
import { correctionForm, CORRECTION_REASON_MIN, type CorrectionKind } from '@/lib/payment-form';
import { formatMinor } from '@/lib/tenancy-format';

export interface InvoicePermissions {
  /** billing.manage: ask for credit notes and write-offs; a second person approves. */
  readonly correct: boolean;
  readonly seeApprovals: boolean;
  readonly seeLease: boolean;
}

const KIND_WORDS: Record<
  CorrectionKind,
  { title: string; submit: string; asked: (amount: string, line: string) => string }
> = {
  credit_note: {
    title: 'Ask for a credit note',
    submit: 'Ask for the credit note',
    asked: (amount, line) => `Asked for a credit note of ${amount} on ${line}.`,
  },
  write_off: {
    title: 'Ask to write off',
    submit: 'Ask for the write-off',
    asked: (amount, line) => `Asked to write off ${amount} on ${line}.`,
  },
};

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-slate-600">{label}</dt>
      <dd className="wrap-break-word">{children}</dd>
    </div>
  );
}

/** A tax line's name: `VAT at 15%`, charged on its base line's net amount (P32). */
function taxName(line: InvoiceLineView): string {
  return `${lineKindLabel(line.kind)}${line.rateBps !== null ? ` at ${rateLabel(line.rateBps)}` : ''}`;
}

/** An invoice (BC-01, CT-04; plan 4.19). Every balance on it is derived by the API. */
export function InvoiceDetailView({
  initial,
  can,
}: {
  readonly initial: InvoiceDetail;
  readonly can: InvoicePermissions;
}) {
  const invoice = initial;
  const [notice, setNotice] = useState<string | null>(null);
  const [pdfProblem, setPdfProblem] = useState<string | null>(null);
  const [open, setOpen] = useState<{ kind: CorrectionKind; line: InvoiceLineView } | null>(null);
  const keepers = useKeepers();
  const warning = vatWarning(invoice);
  const others = otherInvoiceWarnings(invoice.warnings, warning);
  const groups = groupLines(invoice.lines);

  async function openPdf() {
    setPdfProblem(null);
    try {
      await openFetchedLink(
        async () => (await api().invoices.document({ invoiceId: invoice.id })).url,
      );
    } catch (failure) {
      setPdfProblem(toProblem(failure).message);
    }
  }

  return (
    <>
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link href="/invoices" className="underline underline-offset-2">
          Invoices
        </Link>{' '}
        <span aria-hidden="true">›</span> <span className="font-mono">{invoice.number}</span>
      </nav>
      <div className="space-y-2">
        <PageHeader
          title={`Invoice ${invoice.number}`}
          description={`${invoice.unitCode} · ${invoice.tenantName}`}
        />
        <div className="flex flex-wrap items-center gap-2">
          <InvoiceStatusBadge status={invoice.status} overdue={invoice.overdue} />
          <Badge>{INVOICE_KIND_LABELS[invoice.kind]}</Badge>
          {invoice.hasVat ? <Badge>With VAT</Badge> : null}
        </div>
      </div>

      {notice ? (
        <Alert tone="success">
          {notice}{' '}
          {can.seeApprovals ? (
            <Link href="/approvals" className="font-medium underline underline-offset-2">
              Open Approvals
            </Link>
          ) : null}
        </Alert>
      ) : null}
      {warning ? (
        <Alert tone="warning" title="VAT rates not verified">
          {warning}
        </Alert>
      ) : null}
      {others.map((text) => (
        <Alert key={text} tone="warning">
          {text}
        </Alert>
      ))}
      {invoice.notes.map((text) => (
        <Alert key={text} tone="info">
          {text}
        </Alert>
      ))}

      <Card data-testid="invoice-summary">
        <CardHeader
          title="Summary"
          actions={
            <Button variant="secondary" onClick={() => void openPdf()}>
              Open the PDF
            </Button>
          }
        />
        <CardBody>
          {pdfProblem ? (
            <Alert tone="error">
              {pdfProblem}
              {invoice.documentId
                ? null
                : ' The PDF is made a minute or so after the invoice is issued.'}
            </Alert>
          ) : null}
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Fact label="Billed to">
              {invoice.billedTo.name}
              {invoice.billedTo.tin ? (
                <p className="text-slate-700">TIN {invoice.billedTo.tin}</p>
              ) : null}
            </Fact>
            <Fact label="From">
              {invoice.billedFrom.name}
              {invoice.billedFrom.tin ? (
                <p className="text-slate-700">TIN {invoice.billedFrom.tin}</p>
              ) : null}
            </Fact>
            <Fact label="Unit">
              <span className="font-mono">{invoice.unitCode}</span> · {invoice.propertyName}
            </Fact>
            <Fact label="Owner">{invoice.ownerName}</Fact>
            <Fact label="Issued">{formatBusinessDate(invoice.issueDate)}</Fact>
            <Fact label="Due">{formatBusinessDate(invoice.dueDate)}</Fact>
            {periodLabel(invoice.periodFrom, invoice.periodTo) ? (
              <Fact label="For">{periodLabel(invoice.periodFrom, invoice.periodTo)}</Fact>
            ) : null}
            <Fact label="Payment reference">
              <span className="font-mono font-semibold tracking-wider">
                {invoice.paymentReference}
              </span>
            </Fact>
            <Fact label="Total">{formatMinor(invoice.totalMinor)}</Fact>
            <Fact label="Paid">{formatMinor(invoice.settledMinor)}</Fact>
            <Fact label="Still to pay">
              <span className="font-semibold" data-testid="invoice-outstanding">
                {formatMinor(invoice.outstandingMinor)}
              </span>
            </Fact>
          </dl>
          {can.seeLease ? (
            <Link href={`/leases/${invoice.leaseId}`} className={textLink}>
              Open the lease
            </Link>
          ) : null}
        </CardBody>
      </Card>

      <Card data-testid="invoice-lines">
        <CardHeader
          title="Lines"
          description={
            invoice.hasVat
              ? 'VAT and levies sit under the line they are charged on, each at its rate of that line’s amount after credit notes.'
              : 'Rent and service charge become income as each monthly period starts.'
          }
        />
        <CardBody>
          <Table caption="Invoice lines">
            <thead>
              <tr>
                <Th>Line</Th>
                <Th>Due</Th>
                <Th className="text-right">Amount</Th>
                <Th className="text-right">Credited</Th>
                <Th className="text-right">Paid</Th>
                <Th className="text-right">Written off</Th>
                <Th className="text-right">Still to pay</Th>
                {can.correct ? <Th>Corrections</Th> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {groups.map(({ line, taxes }) => (
                <Fragment key={line.id}>
                  <LineRow
                    line={line}
                    tax={false}
                    can={can.correct}
                    onAsk={(kind) => setOpen({ kind, line })}
                  />
                  {taxes.map((tax) => (
                    <LineRow
                      key={tax.id}
                      line={tax}
                      tax
                      can={can.correct}
                      onAsk={(kind) => setOpen({ kind, line: tax })}
                    />
                  ))}
                </Fragment>
              ))}
            </tbody>
          </Table>
          {open ? (
            <CorrectionForm
              key={`${open.kind}:${open.line.id}`}
              kind={open.kind}
              line={open.line}
              keeperName={`${open.kind}:${open.line.id}`}
              keepers={keepers}
              onDone={(text) => {
                setOpen(null);
                setNotice(text);
              }}
              onCancel={() => setOpen(null)}
            />
          ) : null}
        </CardBody>
      </Card>

      <Card data-testid="invoice-allocations">
        <CardHeader
          title="What paid it"
          description="Payments settle the oldest debt first. A correction adds a new row; nothing is changed."
        />
        <CardBody>
          {invoice.allocations.length === 0 ? (
            <Empty>Nothing has been allocated to this invoice yet.</Empty>
          ) : (
            <Table caption="Allocations">
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>From</Th>
                  <Th>Line</Th>
                  <Th className="text-right">Amount</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {invoice.allocations.map((a) => (
                  <tr key={a.id} data-testid="allocation">
                    <Td className="whitespace-nowrap">
                      {formatBusinessDate(a.valueDate)}
                      {a.accountingDate !== a.valueDate ? (
                        <p className="text-xs text-slate-600">
                          Reported on {formatBusinessDate(a.accountingDate)}
                        </p>
                      ) : null}
                    </Td>
                    <Td>
                      {ALLOCATION_SOURCE_LABELS[a.source]}
                      {a.paymentId ? (
                        <>
                          {' '}
                          <Link
                            href={`/payments/${a.paymentId}`}
                            className="font-mono underline underline-offset-2"
                          >
                            {a.receiptNumber ?? 'Open the payment'}
                          </Link>
                        </>
                      ) : null}
                    </Td>
                    <Td>{a.lineLabel}</Td>
                    <Td className="text-right tabular-nums">{formatMinor(a.amountMinor)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>
    </>
  );
}

function LineRow({
  line,
  tax,
  can,
  onAsk,
}: {
  readonly line: InvoiceLineView;
  readonly tax: boolean;
  readonly can: boolean;
  readonly onAsk: (kind: CorrectionKind) => void;
}) {
  const moves = lineCorrections(line);
  const period = periodLabel(line.periodStart, line.periodEnd);
  const unverified = line.rule !== null && line.rule.verificationStatus !== 'verified';
  return (
    <tr
      data-testid={tax ? 'invoice-tax-line' : 'invoice-line'}
      className={tax ? 'bg-slate-50' : undefined}
    >
      <Td className={tax ? 'pl-8' : undefined}>
        {tax ? (
          <>
            <span aria-hidden="true">↳ </span>
            {taxName(line)}
            {unverified ? (
              <span className="ml-2">
                <Badge tone="amber">Rate not verified</Badge>
              </span>
            ) : null}
          </>
        ) : (
          <>
            <span className="font-medium">{line.label || lineKindLabel(line.kind)}</span>
            {period ? <p className="text-xs whitespace-nowrap text-slate-600">{period}</p> : null}
            {line.kind === 'rent' || line.kind === 'service_charge' ? (
              <p className="text-xs text-slate-600">
                {line.accrued ? 'Income: its period has started' : 'Not started yet'}
              </p>
            ) : null}
          </>
        )}
      </Td>
      <Td className="whitespace-nowrap">{formatBusinessDate(line.dueDate)}</Td>
      <Td className="text-right tabular-nums">{formatMinor(line.amountMinor)}</Td>
      <Td className="text-right tabular-nums">{formatMinor(line.creditedMinor)}</Td>
      <Td className="text-right tabular-nums">{formatMinor(line.settledMinor)}</Td>
      <Td className="text-right tabular-nums">{formatMinor(line.writtenOffMinor)}</Td>
      <Td className="text-right font-medium tabular-nums">{formatMinor(line.outstandingMinor)}</Td>
      {can ? (
        <Td>
          <div className="flex flex-wrap gap-1">
            {moves.creditableMinor > 0 ? (
              <Button size="sm" variant="secondary" onClick={() => onAsk('credit_note')}>
                Ask for a credit note
              </Button>
            ) : null}
            {moves.writableOffMinor > 0 ? (
              <Button size="sm" variant="secondary" onClick={() => onAsk('write_off')}>
                Ask to write off
              </Button>
            ) : null}
          </div>
        </Td>
      ) : null}
    </tr>
  );
}

/**
 * A credit note (P27) or a write-off (P24) on one line. It opens an approval: nothing changes
 * until a second person approves it (decision 3). The request carries an Idempotency-Key, kept
 * for the line while the page is open, so a retry never asks twice.
 */
function CorrectionForm({
  kind,
  line,
  keeperName,
  keepers,
  onDone,
  onCancel,
}: {
  readonly kind: CorrectionKind;
  readonly line: InvoiceLineView;
  readonly keeperName: string;
  readonly keepers: ReturnType<typeof useKeepers>;
  readonly onDone: (text: string) => void;
  readonly onCancel: () => void;
}) {
  const { timeZone } = useApp();
  const moves = lineCorrections(line);
  const max = kind === 'credit_note' ? moves.creditableMinor : moves.writableOffMinor;
  const [amount, setAmount] = useState(amountInput(max));
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const words = KIND_WORDS[kind];
  const parsed = correctionForm(kind, { amount, reason }, max);
  const errors = tried ? parsed.errors : {};
  const name = line.baseLineId ? taxName(line) : line.label || lineKindLabel(line.kind);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    if (!parsed.input) return;
    const input = { lineId: line.id, ...parsed.input };
    setPending(true);
    try {
      const { approval } = await sendOnce(keepers(keeperName), (key) =>
        kind === 'credit_note'
          ? keyedApi(key).invoices.creditNote(input)
          : keyedApi(key).invoices.writeOff(input),
      );
      onDone(
        `${words.asked(formatMinor(input.amountMinor), name)} ${waitingNote(approval, timeZone)}`,
      );
    } catch (failure) {
      setError(moneyProblem(failure));
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={words.title}
      className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4"
    >
      <p className="text-sm font-medium text-slate-900">
        {words.title}: {name}
      </p>
      <p className="text-sm text-slate-700">
        {kind === 'credit_note'
          ? `It can take off up to ${formatMinor(max)}. Money already paid on the line goes back to the tenant’s credit. A second person must approve it.`
          : `Up to ${formatMinor(max)} is still owed. A write-off records that it will not be paid, as an expense. A second person must approve it.`}
      </p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <TextField
        label="Amount (GH₵)"
        inputMode="decimal"
        autoComplete="off"
        value={amount}
        error={errors.amount}
        onChange={(event) => setAmount(event.target.value)}
        className="max-w-xs"
      />
      <TextAreaField
        label="Reason"
        hint={`At least ${CORRECTION_REASON_MIN} characters. The second person reads it before deciding.`}
        rows={2}
        maxLength={500}
        value={reason}
        error={errors.reason}
        onChange={(event) => setReason(event.target.value)}
        className="[&_textarea]:font-sans"
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={pending}>
          {words.submit}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
