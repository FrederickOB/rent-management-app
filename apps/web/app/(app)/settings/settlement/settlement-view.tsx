'use client';

import type { SettlementAccountView } from '@rent/contracts';
import Link from 'next/link';
import { useCallback, useState } from 'react';
import { useApp } from '@/components/app-context';
import { Empty, Loading, LoadFailed } from '@/components/load-state';
import { ReasonForm } from '@/components/reason-form';
import { Alert } from '@/components/ui/alert';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { api, keyedApi } from '@/lib/api';
import { formatTime } from '@/lib/format';
import { moneyProblem, sendOnce, useKeepers } from '@/lib/idempotency';
import { waitingNote } from '@/lib/money-requests';
import { CORRECTION_REASON_MIN } from '@/lib/payment-form';
import {
  holderLabel,
  mayRetire,
  nameCheck,
  SETTLEMENT_STATUS_LABELS,
  settlementStatusNote,
  sortAccounts,
  openRequestOf,
  REVEAL_REASON,
  type AgreementRow,
} from '@/lib/settlement';
import { useLoad } from '@/lib/use-load';
import { AccountRequestForm } from './account-form';
import { AgreementsCard } from './agreements-card';

type CompanyKind = 'landlord' | 'agency' | 'platform';

export interface SettlementPermissions {
  /** settlement_account.change: ask to add or retire an account, and set where rent goes. */
  readonly change: boolean;
  /** settlement_account.reveal: show a full account number, with a reason (audited). */
  readonly reveal: boolean;
  readonly seeApprovals: boolean;
}

const STATUS_TONES: Record<SettlementAccountView['status'], BadgeTone> = {
  awaiting_approval: 'blue',
  cooling_off: 'amber',
  active: 'green',
  rejected: 'red',
  retired: 'dark',
};

interface Loaded {
  readonly accounts: readonly SettlementAccountView[];
  /** Each agency owner's choice (decision 6); empty for a landlord, who uses their own account. */
  readonly agreements: readonly AgreementRow[];
}

/** Settlement accounts and, in an agency, where each owner's rent goes (ADR-008, decision 6). */
export function SettlementView({
  companyKind,
  owners,
  can,
}: {
  readonly companyKind: CompanyKind;
  readonly owners: readonly { readonly id: string; readonly label: string }[];
  readonly can: SettlementPermissions;
}) {
  const agency = companyKind === 'agency';
  const load = useCallback(async (): Promise<Loaded> => {
    const [accounts, agreements] = await Promise.all([
      api().settlement.list(),
      agency ? api().settlement.agreements() : Promise.resolve([]),
    ]);
    return { accounts, agreements };
  }, [agency]);
  const { state, reload } = useLoad(load);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const done = (text: string) => {
    setNotice(text);
    setAdding(false);
    reload();
  };

  return (
    <>
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
      <Card data-testid="settlement-accounts">
        <CardHeader
          title="Bank accounts"
          description="Only the last four digits are shown. Mobile money wallets cannot take rent yet: tenants still pay by mobile money, and it settles to a bank account."
          actions={
            can.change && !adding ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setNotice(null);
                  setAdding(true);
                }}
              >
                Add a bank account
              </Button>
            ) : null
          }
        />
        <CardBody>
          {adding ? (
            <AccountRequestForm
              companyKind={companyKind}
              owners={owners}
              onDone={done}
              onCancel={() => setAdding(false)}
            />
          ) : null}
          {state.status === 'loading' ? <Loading what="settlement accounts" /> : null}
          {state.status === 'error' ? (
            <LoadFailed message={state.problem.message} onRetry={reload} />
          ) : null}
          {state.status === 'ready' && state.data.accounts.length === 0 ? (
            <Empty>
              No bank account yet. Until one is approved and its 24 hours have passed, tenants
              cannot be sent pay links.
            </Empty>
          ) : null}
          {state.status === 'ready' && state.data.accounts.length ? (
            <ul className="divide-y divide-slate-100">
              {sortAccounts(state.data.accounts).map((account) => (
                <AccountItem
                  key={account.id}
                  account={account}
                  companyKind={companyKind}
                  can={can}
                  onRequested={done}
                />
              ))}
            </ul>
          ) : null}
        </CardBody>
      </Card>
      {agency && state.status === 'ready' ? (
        <AgreementsCard
          agreements={state.data.agreements}
          accounts={state.data.accounts}
          canChange={can.change}
          seeApprovals={can.seeApprovals}
          onChanged={(text) => {
            setNotice(text);
            reload();
          }}
        />
      ) : null}
    </>
  );
}

function AccountItem({
  account,
  companyKind,
  can,
  onRequested,
}: {
  readonly account: SettlementAccountView;
  readonly companyKind: CompanyKind;
  readonly can: SettlementPermissions;
  readonly onRequested: (text: string) => void;
}) {
  const { timeZone } = useApp();
  const [retiring, setRetiring] = useState(false);
  // The full number, once revealed with a reason (CLAUDE.md section 10); never kept elsewhere.
  const [revealing, setRevealing] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const request = openRequestOf(account);
  // One key per account while the page is open: asking again after a dropped answer reuses it.
  const keepers = useKeepers();
  const note = settlementStatusNote(account, timeZone);
  const check = nameCheck(account);
  const open = account.status === 'awaiting_approval' || account.status === 'cooling_off';
  return (
    <li data-testid="settlement-account" className="space-y-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1 text-sm">
          <p className="text-base font-semibold">
            {account.bankName}{' '}
            <span className="font-mono font-normal" data-testid="settlement-number">
              {account.numberMasked}
            </span>
          </p>
          <p className="text-slate-700">
            {holderLabel(account, companyKind)}
            {account.branch ? ` · ${account.branch} branch` : ''}
          </p>
          <p>
            In the name of <span className="font-medium">{account.accountName}</span>
          </p>
          {/* The provider's name check (ADR-008), shown to whoever approves. */}
          {check.kind === 'matches' ? (
            <p className="text-slate-700" data-testid="settlement-name-check">
              {check.text}
            </p>
          ) : open ? (
            <Alert tone="warning" live={false}>
              <span data-testid="settlement-name-check">{check.text}</span>
            </Alert>
          ) : null}
          <p className="text-xs text-slate-600">
            Asked for {formatTime(account.createdAt, timeZone)}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <Badge tone={STATUS_TONES[account.status]}>
            {SETTLEMENT_STATUS_LABELS[account.status]}
          </Badge>
          {account.status === 'active' && !account.providerReady ? (
            <Badge tone="amber">Not with the provider yet</Badge>
          ) : null}
        </div>
      </div>
      {note ? (
        <p className="text-sm text-slate-700" data-testid="settlement-note">
          {note}
        </p>
      ) : null}
      {request ? (
        <p className="text-sm text-slate-800" data-testid="settlement-open-request">
          {request.text}{' '}
          {can.seeApprovals ? (
            <Link href="/approvals" className="font-medium underline underline-offset-2">
              Open Approvals
            </Link>
          ) : null}
        </p>
      ) : null}
      {shown ? (
        <div
          data-testid="settlement-revealed"
          className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
        >
          <p>
            Account number: <strong className="font-mono text-base">{shown}</strong>
          </p>
          <p>
            Who saw it, when and why is in the audit log; the number itself is not. Hide it when you
            are done.
          </p>
          <Button size="sm" variant="secondary" onClick={() => setShown(null)}>
            Hide the number
          </Button>
        </div>
      ) : null}
      {revealing ? (
        <ReasonForm
          label={`Show the full number of ${account.bankName} ${account.numberMasked}`}
          intro="Say why you need to see the full account number. Who saw it, when and why is kept in the audit log."
          minLength={REVEAL_REASON.min}
          maxLength={REVEAL_REASON.max}
          submitText="Show the number"
          onSubmit={async (reason) => {
            const { accountNumber } = await api().settlement.reveal({
              accountId: account.id,
              reason,
            });
            setShown(accountNumber);
            setRevealing(false);
          }}
          onCancel={() => setRevealing(false)}
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
        {can.reveal && !shown && !revealing ? (
          <Button size="sm" variant="secondary" onClick={() => setRevealing(true)}>
            Show the full number
            <span className="sr-only"> of {account.bankName}</span>
          </Button>
        ) : null}
        {can.change && mayRetire(account) && !retiring ? (
          <Button size="sm" variant="secondary" onClick={() => setRetiring(true)}>
            Ask to stop using it
            <span className="sr-only">
              {' '}
              ({account.bankName} {account.numberMasked})
            </span>
          </Button>
        ) : null}
      </div>
      {retiring ? (
        <ReasonForm
          label={`Stop using ${account.bankName} ${account.numberMasked}`}
          intro="Rent stops settling into this account once a second person approves. Make sure another account is in use first, or pay links for its leases stop working."
          minLength={CORRECTION_REASON_MIN}
          submitText="Ask to stop using it"
          danger
          onSubmit={async (reason) => {
            const { approval } = await sendOnce(keepers(`retire:${account.id}`), (key) =>
              keyedApi(key).settlement.retire({ accountId: account.id, reason }),
            ).catch((failure: unknown) => {
              // Said in terms of whether asking again is safe (M4a plan 4.15).
              throw new Error(moneyProblem(failure));
            });
            setRetiring(false);
            onRequested(
              `Asked to stop using ${account.bankName} ${account.numberMasked}. ${waitingNote(approval, timeZone)}`,
            );
          }}
          onCancel={() => setRetiring(false)}
        />
      ) : null}
    </li>
  );
}
