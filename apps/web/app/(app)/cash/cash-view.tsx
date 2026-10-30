'use client';

import { CASH_RECORD_STATUSES } from '@rent/contracts';
import Link from 'next/link';
import { useCallback, useState } from 'react';
import { useApp } from '@/components/app-context';
import { CashRecordStatusBadge } from '@/components/billing-badges';
import { Empty, Loading, LoadFailed } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { SelectField } from '@/components/ui/field';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import {
  CASH_RECORD_STATUS_LABELS,
  PAYMENT_METHOD_LABELS,
  type CashRecordStatus,
} from '@/lib/billing-format';
import { formatBusinessDate } from '@/lib/business-dates';
import { formatTime } from '@/lib/format';
import { bankable } from '@/lib/payment-form';
import { formatMinor } from '@/lib/tenancy-format';
import { useLoad } from '@/lib/use-load';

export interface CashPermissions {
  /** cash.bank: bank one's own cash. */
  readonly bank: boolean;
  /** cash.bank_others: bank anyone's. */
  readonly bankOthers: boolean;
  /** billing.view: open the payment a cash record became. */
  readonly seePayments: boolean;
}

const SAVED: Record<string, string> = {
  banking:
    'Banking recorded. The cash stays in the collector’s hands until a second person approves it.',
};

/** Undeposited cash per collector and owner, and the cash records behind it (BC-05, P07). */
export function CashView({
  can,
  saved,
}: {
  readonly can: CashPermissions;
  readonly saved: string | null;
}) {
  return (
    <>
      {saved && SAVED[saved] ? <Alert tone="success">{SAVED[saved]}</Alert> : null}
      <Holdings can={can} />
      <CashRecords can={can} />
    </>
  );
}

function Holdings({ can }: { readonly can: CashPermissions }) {
  const { me } = useApp();
  const load = useCallback(() => api().payments.collectorsCash(), []);
  const { state, reload } = useLoad(load);
  const rows = state.status === 'ready' ? state.data : [];
  const total = rows.reduce((sum, r) => sum + r.heldMinor, 0);
  return (
    <Card data-testid="cash-on-hand">
      <CardHeader
        title="Held, not yet banked"
        description="From the ledger: approved cash and cheques, less what has been banked."
      />
      <CardBody>
        {state.status === 'loading' ? <Loading what="cash on hand" /> : null}
        {state.status === 'error' ? (
          <LoadFailed message={state.problem.message} onRetry={reload} />
        ) : null}
        {state.status === 'ready' && rows.length === 0 ? (
          <Empty>No cash or cheques are waiting to be banked.</Empty>
        ) : null}
        {rows.length ? (
          <Table caption="Cash on hand by collector and owner">
            <thead>
              <tr>
                <Th>Collector</Th>
                <Th>Owner</Th>
                <Th className="text-right">Held</Th>
                <Th className="text-right">Banking waiting for approval</Th>
                <Th>Held since</Th>
                {can.bank ? <Th>Banking</Th> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => {
                const mine = row.collectorPersonId === me.personId;
                const canBank = can.bank && (mine || can.bankOthers) && bankable(row) > 0;
                return (
                  <tr key={`${row.collectorPersonId}:${row.ownerId}`} data-testid="cash-holding">
                    <Td>{mine ? `${row.collectorName} (you)` : row.collectorName}</Td>
                    <Td>{row.ownerName}</Td>
                    <Td className="text-right font-semibold tabular-nums" data-testid="cash-held">
                      {formatMinor(row.heldMinor)}
                    </Td>
                    <Td className="text-right tabular-nums">
                      {formatMinor(row.bankingPendingMinor)}
                    </Td>
                    <Td className="whitespace-nowrap">
                      {row.oldestUnbankedOn ? formatBusinessDate(row.oldestUnbankedOn) : '—'}
                    </Td>
                    {can.bank ? (
                      <Td>
                        {canBank ? (
                          <Link
                            href={`/cash/banking?collector=${row.collectorPersonId}&owner=${row.ownerId}`}
                            className="font-medium whitespace-nowrap underline underline-offset-2"
                          >
                            Record banking
                          </Link>
                        ) : null}
                      </Td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
            {rows.length > 1 ? (
              <tfoot>
                <tr className="border-t border-slate-300">
                  <Th scope="row" colSpan={2}>
                    Total
                  </Th>
                  <Td className="text-right font-semibold tabular-nums">{formatMinor(total)}</Td>
                  <Td colSpan={can.bank ? 3 : 2} />
                </tr>
              </tfoot>
            ) : null}
          </Table>
        ) : null}
      </CardBody>
    </Card>
  );
}

const statusOf = (value: string): CashRecordStatus | undefined =>
  CASH_RECORD_STATUSES.find((s) => s === value);

function CashRecords({ can }: { readonly can: CashPermissions }) {
  const { timeZone } = useApp();
  const [status, setStatus] = useState('');
  const load = useCallback(() => {
    const chosen = statusOf(status);
    return api().payments.cashRecords({ ...(chosen ? { status: chosen } : {}), limit: 100 });
  }, [status]);
  const { state, reload } = useLoad(load);
  const rows = state.status === 'ready' ? state.data : [];
  return (
    <Card data-testid="cash-records">
      <CardHeader
        title="Cash and cheques recorded"
        description="Nothing posts until a second person approves it. A landlord who works alone confirms it after the waiting time."
      />
      <CardBody>
        <SelectField
          label="Show"
          value={status}
          options={[
            { value: '', label: 'Everything' },
            ...CASH_RECORD_STATUSES.map((s) => ({ value: s, label: CASH_RECORD_STATUS_LABELS[s] })),
          ]}
          onChange={(event) => setStatus(event.target.value)}
          className="max-w-sm"
        />
        {state.status === 'loading' ? <Loading what="cash records" /> : null}
        {state.status === 'error' ? (
          <LoadFailed message={state.problem.message} onRetry={reload} />
        ) : null}
        {state.status === 'ready' && rows.length === 0 ? (
          <Empty>Nothing recorded yet.</Empty>
        ) : null}
        {rows.length ? (
          <Table caption="Cash and cheques recorded">
            <thead>
              <tr>
                <Th>Received</Th>
                <Th className="text-right">Amount</Th>
                <Th>How</Th>
                <Th>Unit</Th>
                <Th>Paid by</Th>
                <Th>Held by</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr key={row.id} data-testid="cash-record">
                  <Td className="whitespace-nowrap">
                    {formatBusinessDate(row.receivedOn)}
                    <p className="text-xs text-slate-600">
                      Recorded {formatTime(row.createdAt, timeZone)}
                    </p>
                  </Td>
                  <Td className="text-right tabular-nums">{formatMinor(row.amountMinor)}</Td>
                  <Td>
                    {PAYMENT_METHOD_LABELS[row.method]}
                    {row.chequeNumber ? (
                      <p className="text-xs text-slate-600">
                        No. {row.chequeNumber}
                        {row.chequeBank ? `, ${row.chequeBank}` : ''}
                      </p>
                    ) : null}
                  </Td>
                  <Td className="font-mono">{row.unitCode}</Td>
                  <Td>{row.payerName}</Td>
                  <Td>{row.collectorName}</Td>
                  <Td>
                    <CashRecordStatusBadge status={row.status} />
                    {row.paymentId && can.seePayments ? (
                      <p className="mt-1 text-xs">
                        <Link
                          href={`/payments/${row.paymentId}`}
                          className="underline underline-offset-2"
                        >
                          Open the payment
                        </Link>
                      </p>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : null}
      </CardBody>
    </Card>
  );
}
