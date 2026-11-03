'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import { useApp } from '@/components/app-context';
import { Empty, Loading, LoadFailed } from '@/components/load-state';
import { RuleList } from '@/components/rule-list';
import { RulesWarning } from '@/components/rules-warning';
import { DueBadge, RentTaxStatusBadge } from '@/components/tax-badges';
import { Alert } from '@/components/ui/alert';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Table, Td, Th } from '@/components/ui/table';
import { paymentAdvanceLabel } from '@/lib/advance-compliance';
import { api } from '@/lib/api';
import { rateLabel } from '@/lib/billing-format';
import { formatBusinessDate, todayIn } from '@/lib/business-dates';
import { isOwed, TAX_ITEM_KIND_LABELS } from '@/lib/rent-tax';
import { formatMinor } from '@/lib/tenancy-format';
import { useLoad } from '@/lib/use-load';

/**
 * A payment's rent tax (TX-01, TX-02; P17) and its months paid ahead (AR-05): the base the receipt
 * was taxed on, the rate for the lease's use, the tax, its due date and where it stands, with any
 * correction since. Every figure is the API's; the rules it used warn while unverified.
 */
export function PaymentTax({ paymentId }: { readonly paymentId: string }) {
  const { timeZone } = useApp();
  const today = todayIn(timeZone);
  const load = useCallback(async () => {
    const [items, advance] = await Promise.all([
      api().rentTax.items({ paymentId }),
      // AR-05: the months this payment paid ahead, as recorded when it arrived.
      api()
        .advanceRent.payment({ paymentId })
        .catch(() => null),
    ]);
    return { items, advance };
  }, [paymentId]);
  const { state, reload } = useLoad(load);
  const recorded = state.status === 'ready' ? state.data.advance : null;
  const advance = recorded ? paymentAdvanceLabel(recorded, recorded.rule) : null;
  return (
    <Card data-testid="payment-tax">
      <CardHeader
        title="Rent tax"
        description="Worked out on the rent this receipt newly covers, advances included, and due to GRA 30 days after the money arrived."
      />
      <CardBody>
        {state.status === 'loading' ? <Loading what="rent tax" /> : null}
        {state.status === 'error' ? (
          <LoadFailed message={state.problem.message} onRetry={reload} />
        ) : null}
        {state.status === 'ready' ? (
          <>
            <RulesWarning rules={state.data.items.flatMap((item) => item.rules)} />
            {state.data.items.length === 0 ? (
              <Empty>
                No rent tax on this payment: it paid no rent, or the owner is taxed on income as a
                letting business.
              </Empty>
            ) : (
              <Table caption="Rent tax on this payment">
                <thead>
                  <tr>
                    <Th>What</Th>
                    <Th className="text-right">Taxed on</Th>
                    <Th className="text-right">Rate</Th>
                    <Th className="text-right">Tax</Th>
                    <Th>Due</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {state.data.items.map((item) => (
                    <tr key={item.id} data-testid="payment-tax-item">
                      <Td>
                        {TAX_ITEM_KIND_LABELS[item.kind]}
                        <p className="text-xs text-slate-600">
                          {formatBusinessDate(item.valueDate)}
                        </p>
                      </Td>
                      <Td className="text-right tabular-nums">{formatMinor(item.baseMinor)}</Td>
                      <Td className="text-right tabular-nums">{rateLabel(item.rateBps)}</Td>
                      <Td className="text-right tabular-nums" data-testid="payment-tax-amount">
                        {formatMinor(item.taxMinor)}
                      </Td>
                      <Td className="min-w-48">
                        {isOwed(item.status) ? (
                          <DueBadge item={item} today={today} />
                        ) : (
                          <RentTaxStatusBadge status={item.status} />
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            <RuleList rules={state.data.items.flatMap((item) => item.rules)} />
            {state.data.items[0] ? (
              <Link
                href={`/tax/rent?ownerId=${state.data.items[0].ownerId}`}
                className="text-sm font-medium underline underline-offset-2"
              >
                Open the owner’s rent tax
              </Link>
            ) : null}
          </>
        ) : null}
        {advance ? (
          <div className="space-y-2 border-t border-slate-200 pt-4" data-testid="payment-advance">
            <p className="text-sm text-slate-800">{advance.text}</p>
            {advance.flag ? (
              <Alert tone="warning" live={false}>
                {advance.flag}
              </Alert>
            ) : null}
            {recorded?.rule ? <RuleList rules={[recorded.rule]} label="The limit’s rule" /> : null}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
