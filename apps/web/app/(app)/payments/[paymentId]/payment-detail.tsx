'use client';

import { REVERSAL_REASONS, type PaymentDetail } from '@rent/contracts';
import Link from 'next/link';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useApp } from '@/components/app-context';
import { PaymentStatusBadge } from '@/components/billing-badges';
import { EvidenceButton } from '@/components/evidence-button';
import { secondaryLink, textLink } from '@/components/link-styles';
import { Empty } from '@/components/load-state';
import { PageHeader } from '@/components/page-header';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { SelectField, TextAreaField } from '@/components/ui/field';
import { Table, Td, Th } from '@/components/ui/table';
import { api, keyedApi } from '@/lib/api';
import {
  ALLOCATION_SOURCE_LABELS,
  evidenceOfMethod,
  MONEY_LOCATION_LABELS,
  PAYMENT_METHOD_LABELS,
  RECEIPT_KIND_LABELS,
  RECEIVED_INTO_LABELS,
  REVERSAL_REASON_LABELS,
  type MoneyLocation,
  type ReversalReason,
} from '@/lib/billing-format';
import { openFetchedLink } from '@/lib/browser-files';
import { formatBusinessDate } from '@/lib/business-dates';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import {
  isKeyReused,
  moneyProblem,
  sendOnce,
  useIdempotencyKeeper,
  type IdempotencyKeeper,
} from '@/lib/idempotency';
import { useHoldWhileSending } from '@/lib/in-flight';
import { ownerAccountOf } from '@/lib/lease-pick';
import { waitingNote } from '@/lib/money-requests';
import { CORRECTION_REASON_MIN, reversalForm, type ReversalDraft } from '@/lib/payment-form';
import { formatMinor } from '@/lib/tenancy-format';
import { MatchForm } from '../match-form';

export interface PaymentPermissions {
  /** billing.manage: ask for a reversal, match an unmatched receipt. */
  readonly manage: boolean;
  readonly seeApprovals: boolean;
  readonly seeLease: boolean;
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-slate-600">{label}</dt>
      <dd className="wrap-break-word">{children}</dd>
    </div>
  );
}

/** A payment (plan 4.19): what it paid for, its receipts, and corrections. */
export function PaymentDetailView({
  initial,
  can,
}: {
  readonly initial: PaymentDetail;
  readonly can: PaymentPermissions;
}) {
  const { timeZone } = useApp();
  const [payment, setPayment] = useState(initial);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [reversing, setReversing] = useState(false);
  // One key for the reversal request while the page is open, even if its form is closed and
  // opened again after an attempt nobody heard back from.
  const reversalKeeper = useIdempotencyKeeper();
  // Money in an owner's own account can be matched only to that owner's leases (P23).
  const unmatchedOwner = ownerAccountOf(payment);

  async function refresh() {
    try {
      setPayment(await api().payments.get({ paymentId: payment.id }));
    } catch {
      // The notice says what happened; a reload shows the rest.
    }
  }

  async function openReceipt(receiptId: string) {
    setProblem(null);
    try {
      await openFetchedLink(async () => (await api().payments.receiptDocument({ receiptId })).url);
    } catch (failure) {
      setProblem(toProblem(failure).message);
    }
  }

  const title = `Payment of ${formatMinor(payment.amountMinor)}`;
  const cheque = [payment.chequeNumber, payment.chequeBank].filter(Boolean).join(', ');

  return (
    <>
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link href="/payments" className="underline underline-offset-2">
          Payments
        </Link>{' '}
        <span aria-hidden="true">›</span>{' '}
        <span className="font-mono">
          {payment.receiptNumber ?? formatBusinessDate(payment.receivedOn)}
        </span>
      </nav>
      <div className="space-y-2">
        <PageHeader
          title={title}
          description={
            payment.unitCode
              ? [payment.unitCode, payment.tenantName].filter(Boolean).join(' · ')
              : 'Not matched to a lease yet'
          }
        />
        <div className="flex flex-wrap items-center gap-2">
          <PaymentStatusBadge status={payment.status} />
          <Badge>{PAYMENT_METHOD_LABELS[payment.method]}</Badge>
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
      {problem ? <Alert tone="error">{problem}</Alert> : null}

      <Card data-testid="payment-summary">
        <CardHeader title="Summary" />
        <CardBody>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Fact label="Received on">{formatBusinessDate(payment.receivedOn)}</Fact>
            <Fact label="Amount">{formatMinor(payment.amountMinor)}</Fact>
            <Fact label="How it was paid">
              {PAYMENT_METHOD_LABELS[payment.method]}
              {cheque ? <p className="text-slate-700">Cheque {cheque}</p> : null}
            </Fact>
            <Fact label="Received into">{RECEIVED_INTO_LABELS[payment.receivedInto]}</Fact>
            <Fact label="Owner">
              {payment.ownerName ?? (
                <span className="text-slate-700">
                  None yet: it waits in the company’s book until it is matched
                </span>
              )}
            </Fact>
            {payment.payerName ? <Fact label="Paid by">{payment.payerName}</Fact> : null}
            {payment.collectorName ? (
              <Fact label="Collected by">{payment.collectorName}</Fact>
            ) : null}
            {payment.recordedByName ? (
              <Fact label="Recorded by">{payment.recordedByName}</Fact>
            ) : null}
            {payment.reference ? (
              <Fact label="Reference">
                <span className="font-mono">{payment.reference}</span>
              </Fact>
            ) : null}
            <Fact label="Credit left">
              <span data-testid="payment-credit">{formatMinor(payment.creditMinor)}</span>
              <p className="text-xs text-slate-600">Not yet used for any charge.</p>
            </Fact>
            {payment.paidUntilAfter ? (
              <Fact label="Paid until, after this payment">
                {formatBusinessDate(payment.paidUntilAfter)}
              </Fact>
            ) : null}
            {payment.proofDocumentId ? (
              <Fact
                label={evidenceOfMethod(payment.method) === 'transfer_proof' ? 'Proof' : 'Photo'}
              >
                <EvidenceButton
                  documentId={payment.proofDocumentId}
                  kind={evidenceOfMethod(payment.method)}
                />
              </Fact>
            ) : null}
            {payment.note ? <Fact label="Note">{payment.note}</Fact> : null}
            <Fact label="Recorded">{formatTime(payment.createdAt, timeZone)}</Fact>
          </dl>
          {payment.leaseId && can.seeLease ? (
            <Link href={`/leases/${payment.leaseId}`} className={textLink}>
              Open the lease
            </Link>
          ) : null}
        </CardBody>
      </Card>

      <Card data-testid="payment-allocations">
        <CardHeader
          title="What it paid for"
          description="Oldest debt first. A reversal or a credit note adds rows with a minus sign; nothing is changed."
        />
        <CardBody>
          {payment.allocations.length === 0 ? (
            <Empty>
              {payment.status === 'unmatched'
                ? 'Nothing yet: it pays for nothing until it is matched to a lease.'
                : 'Nothing yet: all of it is held as credit.'}
            </Empty>
          ) : (
            <Table caption="What the payment paid for">
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>Invoice</Th>
                  <Th>Line</Th>
                  <Th>From</Th>
                  <Th className="text-right">Amount</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {payment.allocations.map((a) => (
                  <tr key={a.id} data-testid="allocation">
                    <Td className="whitespace-nowrap">{formatBusinessDate(a.valueDate)}</Td>
                    <Td>
                      <Link
                        href={`/invoices/${a.invoiceId}`}
                        className="font-mono underline underline-offset-2"
                      >
                        {a.invoiceNumber}
                      </Link>
                    </Td>
                    <Td>{a.lineLabel}</Td>
                    <Td>{ALLOCATION_SOURCE_LABELS[a.source]}</Td>
                    <Td className="text-right tabular-nums">{formatMinor(a.amountMinor)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>

      <Card data-testid="payment-receipts">
        <CardHeader
          title="Receipts"
          description="Numbered in order with no gaps. A reversal keeps the receipt and adds a credit receipt."
        />
        <CardBody>
          {payment.receipts.length === 0 ? (
            <Empty>
              {payment.status === 'unmatched'
                ? 'No receipt yet: it is issued when the money is matched to a lease.'
                : 'No receipt yet.'}
            </Empty>
          ) : (
            <ul className="divide-y divide-slate-100">
              {payment.receipts.map((receipt) => (
                <li
                  key={receipt.id}
                  data-testid="receipt"
                  className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm"
                >
                  <span>
                    <span className="font-mono font-semibold">{receipt.number}</span> ·{' '}
                    {RECEIPT_KIND_LABELS[receipt.kind]} · {formatMinor(receipt.amountMinor)} ·{' '}
                    issued {formatTime(receipt.issuedAt, timeZone)}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void openReceipt(receipt.id)}
                  >
                    Open the PDF of {receipt.number}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {payment.status === 'unmatched' && can.manage ? (
        <Card data-testid="payment-match">
          <CardHeader
            title="Match to a lease"
            description="This money arrived before anyone knew which lease it pays for."
          />
          <CardBody>
            <MatchForm
              paymentId={payment.id}
              owner={unmatchedOwner}
              onMatched={(next, lease) => {
                setPayment(next);
                setNotice(
                  `Matched to ${lease.unitCode}. It has paid the lease’s oldest debt first.`,
                );
              }}
            />
          </CardBody>
        </Card>
      ) : null}

      {can.manage || payment.status === 'reversed' || payment.openApprovalId ? (
        <Card data-testid="payment-reversal">
          <CardHeader
            title="Reverse this payment"
            description="For a bounced cheque or a wrong entry. To move a payment to the right lease, reverse it and record it again."
          />
          <CardBody>
            {payment.status === 'reversed' ? (
              <Alert tone="info">
                This payment was reversed. Its receipt stays, and a credit receipt was issued.
              </Alert>
            ) : payment.openApprovalId ? (
              <Alert tone="info">
                A reversal is waiting for a second person to approve it.{' '}
                {can.seeApprovals ? (
                  <Link href="/approvals" className="font-medium underline underline-offset-2">
                    Open Approvals
                  </Link>
                ) : null}
              </Alert>
            ) : !can.manage ? null : payment.reversalOptions.length === 0 ? (
              <p className="text-sm text-slate-600">This payment cannot be reversed here.</p>
            ) : reversing ? (
              <ReversalForm
                payment={payment}
                keeper={reversalKeeper}
                onDone={async (text) => {
                  setReversing(false);
                  setNotice(text);
                  await refresh();
                }}
                onCancel={() => setReversing(false)}
              />
            ) : (
              <Button variant="secondary" onClick={() => setReversing(true)}>
                Ask to reverse
              </Button>
            )}
          </CardBody>
        </Card>
      ) : null}

      {payment.leaseId && can.seeLease ? (
        <Link href={`/leases/${payment.leaseId}`} className={secondaryLink}>
          Back to the lease
        </Link>
      ) : null}
    </>
  );
}

const EMPTY_REVERSAL: ReversalDraft = { reason: '', note: '', moneyNowIn: '' };

/**
 * A payment reversal (P21b): built from what the payment pays for now, not from its first entry.
 * It waits for a second person (decision 3); the request carries the page's Idempotency-Key.
 */
function ReversalForm({
  payment,
  keeper,
  onDone,
  onCancel,
}: {
  readonly payment: PaymentDetail;
  readonly keeper: IdempotencyKeeper;
  readonly onDone: (text: string) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const { timeZone } = useApp();
  const options = payment.reversalOptions;
  const [draft, setDraft] = useState<ReversalDraft>(
    options.length === 1 ? { ...EMPTY_REVERSAL, moneyNowIn: options[0]! } : EMPTY_REVERSAL,
  );
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // An earlier attempt reached the API with other details: offer a fresh start, never a retry.
  const [reused, setReused] = useState(false);
  const parsed = reversalForm(draft, payment.id, options);
  const errors = tried ? parsed.errors : {};
  useHoldWhileSending(pending);

  function startAgain() {
    keeper.reset();
    setDraft(
      options.length === 1 ? { ...EMPTY_REVERSAL, moneyNowIn: options[0]! } : EMPTY_REVERSAL,
    );
    setTried(false);
    setError(null);
    setReused(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    setReused(false);
    const input = parsed.input;
    if (!input) return;
    setPending(true);
    try {
      const { approval } = await sendOnce(keeper, (key) =>
        keyedApi(key).payments.requestReversal(input),
      );
      await onDone(`Asked to reverse this payment. ${waitingNote(approval, timeZone)}`);
    } catch (failure) {
      setError(moneyProblem(failure));
      setReused(isKeyReused(failure));
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="Ask to reverse the payment"
      className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4"
    >
      <p className="text-sm text-slate-700">
        Every line it paid becomes owed again, and its credit goes. The receipt stays, and a credit
        receipt is issued. A second person must approve it.
      </p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <SelectField
        label="Why"
        value={draft.reason}
        error={errors.reason}
        options={[
          { value: '', label: 'Choose a reason' },
          ...REVERSAL_REASONS.map((r) => ({ value: r, label: REVERSAL_REASON_LABELS[r] })),
        ]}
        onChange={(event) =>
          setDraft((d) => ({
            ...d,
            reason:
              REVERSAL_REASONS.find((r): r is ReversalReason => r === event.target.value) ?? '',
          }))
        }
      />
      <TextAreaField
        label="What happened"
        hint={`At least ${CORRECTION_REASON_MIN} characters. The second person reads it before deciding.`}
        rows={2}
        maxLength={500}
        value={draft.note}
        error={errors.note}
        onChange={(event) => setDraft((d) => ({ ...d, note: event.target.value }))}
        className="[&_textarea]:font-sans"
      />
      <SelectField
        label="Where is the money now?"
        hint="It is taken back from there."
        value={draft.moneyNowIn}
        error={errors.moneyNowIn}
        options={[
          ...(options.length === 1 ? [] : [{ value: '', label: 'Choose where it is' }]),
          ...options.map((o) => ({ value: o, label: MONEY_LOCATION_LABELS[o] })),
        ]}
        onChange={(event) =>
          setDraft((d) => ({
            ...d,
            moneyNowIn: options.find((o): o is MoneyLocation => o === event.target.value) ?? '',
          }))
        }
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="danger" pending={pending}>
          Ask for the reversal
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
