'use client';

import type { InvoiceDetail, InvoiceLineView } from '@rent/contracts';
import Link from 'next/link';
import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useApp } from '@/components/app-context';
import { InvoiceStatusBadge } from '@/components/billing-badges';
import { textLink } from '@/components/link-styles';
import { Empty } from '@/components/load-state';
import { PageHeader } from '@/components/page-header';
import { SendPayLink } from '@/components/send-pay-link';
import { Alert } from '@/components/ui/alert';
import { Badge, type BadgeTone } from '@/components/ui/badge';
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
import { payLinkOffered } from '@/lib/collection';
import { formatBusinessDate } from '@/lib/business-dates';
import { toProblem } from '@/lib/errors';
import { isKeyReused, moneyProblem, sendOnce, useKeepers } from '@/lib/idempotency';
import { useHoldWhileSending } from '@/lib/in-flight';
import { amountInput } from '@/lib/lease-form';
import {
  correctionMax,
  correctionsOffered,
  groupLines,
  lineName,
  otherInvoiceWarnings,
  vatWarning,
  type CorrectionKind,
} from '@/lib/invoice-view';
import { formatTime } from '@/lib/format';
import { waitingNote } from '@/lib/money-requests';
import {
  REMINDER_STATE_LABELS,
  reminderRows,
  reminderWhen,
  type ReminderState,
} from '@/lib/receipt-delivery';
import { correctionForm, CORRECTION_REASON_MIN } from '@/lib/payment-form';
import { formatMinor } from '@/lib/tenancy-format';

export interface InvoicePermissions {
  /** billing.manage: ask for credit notes and write-offs; a second person approves. */
  readonly correct: boolean;
  readonly seeApprovals: boolean;
  readonly seeLease: boolean;
  /** billing.manage: send the tenant a pay link (BC-04); the API checks consent and destination. */
  readonly sendPayLink: boolean;
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
  const [open, setOpen] = useState<{
    kind: CorrectionKind;
    line: InvoiceLineView;
    base: InvoiceLineView | null;
  } | null>(null);
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
          {can.sendPayLink && payLinkOffered(invoice) ? (
            <div className="space-y-1 border-t border-slate-200 pt-4">
              <p className="text-sm text-slate-700">
                The tenant gets a link to pay by mobile money or card, on the first channel they
                have agreed to: app notification, WhatsApp, SMS or email. The page shows everything
                due on the lease, oldest first.
              </p>
              <SendPayLink invoiceId={invoice.id} detail={`for invoice ${invoice.number}`} />
            </div>
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
                    base={null}
                    can={can.correct}
                    onAsk={(kind) => setOpen({ kind, line, base: null })}
                  />
                  {taxes.map((tax) => (
                    <LineRow
                      key={tax.id}
                      line={tax}
                      base={line}
                      can={can.correct}
                      onAsk={(kind) => setOpen({ kind, line: tax, base: line })}
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
              name={lineName(open.line, open.base)}
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

      {invoice.reminders && invoice.status !== 'voided' ? (
        <InvoiceReminders invoice={invoice} reminders={invoice.reminders} />
      ) : null}

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

const REMINDER_TONES: Record<ReminderState, BadgeTone> = {
  sent: 'green',
  skipped: 'amber',
  upcoming: 'blue',
  stopped: 'dark',
};

/**
 * The invoice's rent reminders (BC-09; plan 4.7): each step of the company's ladder, sent or
 * skipped as the API recorded it, or still to come. Each goes once, at 08:00 in the company's
 * time zone, with the pay link, only on channels the tenant agreed to; the first carries the
 * invoice itself. They stop once nothing is left to pay.
 */
function InvoiceReminders({
  invoice,
  reminders,
}: {
  readonly invoice: InvoiceDetail;
  readonly reminders: NonNullable<InvoiceDetail['reminders']>;
}) {
  const { company, timeZone } = useApp();
  const settled =
    invoice.outstandingMinor <= 0 || invoice.status === 'paid' || invoice.status === 'written_off';
  const rows = reminderRows({
    dueDate: invoice.dueDate,
    // Without the company's settings, only what was recorded is shown.
    offsetsDays: company?.settings.rentReminderOffsetsDays ?? [],
    steps: reminders,
    settled,
  });
  return (
    <Card data-testid="invoice-reminders">
      <CardHeader
        title="Reminders"
        description="Each step of the company’s reminder ladder goes once, with the pay link, on channels the tenant agreed to. They stop as soon as the invoice is paid."
      />
      <CardBody>
        {rows.length === 0 ? (
          <Empty>No reminders are set for this company.</Empty>
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map((row) => (
              <li
                key={row.offsetDays}
                data-testid="invoice-reminder"
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
              >
                <span>
                  {reminderWhen(row)}
                  {row.recordedAt ? (
                    <span className="block text-xs text-slate-600">
                      Recorded {formatTime(row.recordedAt, timeZone)}
                    </span>
                  ) : null}
                </span>
                <Badge tone={REMINDER_TONES[row.state]}>{REMINDER_STATE_LABELS[row.state]}</Badge>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function LineRow({
  line,
  base,
  can,
  onAsk,
}: {
  readonly line: InvoiceLineView;
  /** The line a VAT or levy line is charged on; null for any other line. */
  readonly base: InvoiceLineView | null;
  readonly can: boolean;
  readonly onAsk: (kind: CorrectionKind) => void;
}) {
  const tax = base !== null;
  const offered = correctionsOffered(line);
  const period = periodLabel(line.periodStart, line.periodEnd);
  const unverified = line.rule !== null && line.rule.verificationStatus !== 'verified';
  // Each button names its line for people using a screen reader (WCAG 2.4.6).
  const name = lineName(line, base);
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
            {offered.includes('credit_note') ? (
              <Button size="sm" variant="secondary" onClick={() => onAsk('credit_note')}>
                Ask for a credit note<span className="sr-only"> on {name}</span>
              </Button>
            ) : null}
            {offered.includes('write_off') ? (
              <Button size="sm" variant="secondary" onClick={() => onAsk('write_off')}>
                Ask to write off<span className="sr-only"> {name}</span>
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
  name,
  keeperName,
  keepers,
  onDone,
  onCancel,
}: {
  readonly kind: CorrectionKind;
  readonly line: InvoiceLineView;
  /** The line as people read it (`lineName`). */
  readonly name: string;
  readonly keeperName: string;
  readonly keepers: ReturnType<typeof useKeepers>;
  readonly onDone: (text: string) => void;
  readonly onCancel: () => void;
}) {
  const { timeZone } = useApp();
  // The API's own figure for what this correction may take off (P27, P24).
  const max = correctionMax(line, kind);
  const [amount, setAmount] = useState(amountInput(max));
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // An earlier attempt reached the API with other details: offer a fresh start, never a retry.
  const [reused, setReused] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const words = KIND_WORDS[kind];
  const parsed = correctionForm(kind, { amount, reason }, max);
  const errors = tried ? parsed.errors : {};
  useHoldWhileSending(pending);

  // Opening the form takes the focus to it, so keyboard and screen-reader users land in it.
  useEffect(() => {
    form.current?.querySelector<HTMLElement>('input, textarea')?.focus();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    setReused(false);
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
      setReused(isKeyReused(failure));
      setPending(false);
    }
  }

  function startAgain() {
    keepers(keeperName).reset();
    setAmount(amountInput(max));
    setReason('');
    setTried(false);
    setError(null);
    setReused(false);
  }

  return (
    <form
      ref={form}
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
        {reused ? (
          <Button variant="secondary" onClick={startAgain}>
            Start again
          </Button>
        ) : null}
        <Button variant="ghost" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
