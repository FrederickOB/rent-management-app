'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import { useApp } from '@/components/app-context';
import { LoadFailed, Loading } from '@/components/load-state';
import { PageHeader } from '@/components/page-header';
import { SubscriptionInvoiceCards } from '@/components/subscription-invoice';
import { api } from '@/lib/api';
import { formatBusinessDate } from '@/lib/business-dates';
import { monthLabel } from '@/lib/rent-tax';
import { INVOICE_VAT_NOTE } from '@/lib/subscription';
import { useLoad } from '@/lib/use-load';

export function InvoiceView({ invoiceId }: { readonly invoiceId: string }) {
  const { timeZone } = useApp();
  const load = useCallback(async () => {
    const invoice = await api().subscription.invoice({ invoiceId });
    const snapshot = await api().subscription.snapshot({ snapshotId: invoice.snapshotId });
    return { invoice, snapshot };
  }, [invoiceId]);
  const { state, reload } = useLoad(load);

  const back = (
    <p className="text-sm">
      <Link href="/settings/subscription" className="underline underline-offset-2">
        Subscription
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
      <SubscriptionInvoiceCards
        invoice={invoice}
        snapshot={snapshot}
        timeZone={timeZone}
        vatNote={INVOICE_VAT_NOTE}
        invoiceDocument={() => api().subscription.invoiceDocument({ invoiceId: invoice.id })}
        creditNoteDocument={(creditNoteId) => () =>
          api().subscription.creditNoteDocument({ creditNoteId })
        }
      />
    </>
  );
}
