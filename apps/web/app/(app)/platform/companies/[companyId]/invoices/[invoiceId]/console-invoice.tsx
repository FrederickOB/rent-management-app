'use client';

import Link from 'next/link';
import { useCallback, useRef, useState, type FormEvent } from 'react';
import { ConfirmBox } from '@/components/confirm-box';
import { LoadFailed, Loading } from '@/components/load-state';
import { PageHeader } from '@/components/page-header';
import { SubscriptionInvoiceCards } from '@/components/subscription-invoice';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { TextAreaField, TextField } from '@/components/ui/field';
import { api, keyedApi } from '@/lib/api';
import { formatBusinessDate } from '@/lib/business-dates';
import { isKeyReused, moneyProblem, sendOnce, useIdempotencyKeeper } from '@/lib/idempotency';
import { amountMinorOf } from '@/lib/payment-form';
import { monthLabel } from '@/lib/rent-tax';
import { creditableMinor, subscriptionMessage, vatStatusText } from '@/lib/subscription';
import { formatMinor } from '@/lib/tenancy-format';
import { useLoad } from '@/lib/use-load';

type Invoice = Awaited<ReturnType<ReturnType<typeof api>['platformAdmin']['invoice']>>;

export function ConsoleInvoice({
  companyId,
  invoiceId,
}: {
  readonly companyId: string;
  readonly invoiceId: string;
}) {
  const load = useCallback(async () => {
    const invoice = await api().platformAdmin.invoice({ companyId, invoiceId });
    const snapshot = await api().platformAdmin.snapshot({
      companyId,
      snapshotId: invoice.snapshotId,
    });
    return { invoice, snapshot };
  }, [companyId, invoiceId]);
  const { state, reload } = useLoad(load);
  const [notice, setNotice] = useState<string | null>(null);

  const back = (
    <p className="text-sm">
      <Link
        href={`/platform/companies/${companyId}?tab=invoices`}
        className="underline underline-offset-2"
      >
        The company’s invoices
      </Link>
    </p>
  );
  if (state.status === 'loading')
    return (
      <>
        {back}
        <Loading what="the invoice" />
      </>
    );
  if (state.status === 'error')
    return (
      <>
        {back}
        <LoadFailed message={state.problem.message} onRetry={reload} />
      </>
    );
  const { invoice, snapshot } = state.data;

  return (
    <>
      {back}
      <PageHeader
        title={`Invoice ${invoice.number}`}
        description={`${monthLabel(invoice.month)}. Issued ${formatBusinessDate(invoice.issuedOn)}, due ${formatBusinessDate(invoice.dueOn)}.`}
      />
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <SubscriptionInvoiceCards
        invoice={invoice}
        snapshot={snapshot}
        timeZone="UTC"
        vatNote={vatStatusText({ charged: true, verified: false })}
        invoiceDocument={() => api().platformAdmin.invoiceDocument({ companyId, invoiceId })}
        creditNoteDocument={(creditNoteId) => () =>
          api().platformAdmin.creditNoteDocument({ companyId, creditNoteId })
        }
      >
        {invoice.status !== 'void' && creditableMinor(invoice) > 0 ? (
          <CreditForm
            companyId={companyId}
            invoice={invoice}
            onCredited={(text) => {
              setNotice(text);
              reload();
            }}
          />
        ) : null}
      </SubscriptionInvoiceCards>
    </>
  );
}

/**
 * Crediting an invoice (founder answer Q2; review WEB-17): in full or in part, never more than
 * its total less earlier credits, with a reason, confirmed, under one Idempotency-Key.
 */
function CreditForm({
  companyId,
  invoice,
  onCredited,
}: {
  readonly companyId: string;
  readonly invoice: Invoice;
  readonly onCredited: (text: string) => void;
}) {
  const most = creditableMinor(invoice);
  const keeper = useIdempotencyKeeper();
  const keyedFor = useRef<string | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<{ amount?: string; reason?: string }>({});
  const [confirming, setConfirming] = useState<{ amountMinor: number; reason: string } | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProblem(null);
    const parsed = amountMinorOf(amount, {
      maxMinor: most,
      message: `At most ${formatMinor(most)}: the invoice’s total less the credit notes already on it.`,
    });
    const trimmed = reason.trim();
    const next = {
      amount: parsed.problem ?? undefined,
      reason:
        trimmed.length < 5
          ? 'Give a reason of at least 5 characters; it is kept with the credit note.'
          : undefined,
    };
    setErrors(next);
    if (next.amount || next.reason || parsed.value === null) return;
    setConfirming({ amountMinor: parsed.value, reason: trimmed });
  }

  async function credit() {
    if (!confirming) return;
    const input = { companyId, invoiceId: invoice.id, ...confirming };
    const content = JSON.stringify(input);
    if (keyedFor.current !== content) {
      keeper.reset();
      keyedFor.current = content;
    }
    setPending(true);
    try {
      const note = await sendOnce(keeper, (key) =>
        keyedApi(key).platformAdmin.creditInvoice(input),
      );
      keyedFor.current = null;
      setConfirming(null);
      setAmount('');
      setReason('');
      onCredited(
        `Credit note ${note.number} takes ${formatMinor(note.amountMinor)} off invoice ${invoice.number}.`,
      );
    } catch (failure) {
      setProblem(subscriptionMessage(failure) ?? moneyProblem(failure));
      if (isKeyReused(failure)) {
        keeper.reset();
        keyedFor.current = null;
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      aria-label="Credit this invoice"
      className="space-y-3 rounded-md border border-slate-200 p-3"
      onSubmit={review}
    >
      <p className="text-sm font-medium text-slate-900">Credit this invoice</p>
      <TextField
        label="Amount to credit (GH₵)"
        hint={`Up to ${formatMinor(most)}.`}
        inputMode="decimal"
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
        error={errors.amount}
        className="max-w-xs"
      />
      <TextAreaField
        label="Reason"
        rows={2}
        maxLength={500}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        error={errors.reason}
        className="[&_textarea]:font-sans"
      />
      {confirming ? (
        <ConfirmBox
          label={`Confirm the credit on invoice ${invoice.number}`}
          confirmText={`Yes, credit ${formatMinor(confirming.amountMinor)}`}
          pending={pending}
          onConfirm={() => void credit()}
          onCancel={() => setConfirming(null)}
        >
          A credit note for {formatMinor(confirming.amountMinor)} is issued on invoice{' '}
          {invoice.number} and cannot be undone. The company is told, and if the invoice is already
          paid the credited part becomes credit for its next invoice.
        </ConfirmBox>
      ) : (
        <Button type="submit" variant="secondary">
          Credit the invoice
        </Button>
      )}
      {problem ? <Alert tone="error">{problem}</Alert> : null}
    </form>
  );
}
