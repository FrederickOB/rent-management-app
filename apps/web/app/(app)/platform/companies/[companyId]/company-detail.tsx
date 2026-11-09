'use client';

import type { SubscriptionTier } from '@rent/domain/settings';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Empty, LoadFailed, Loading } from '@/components/load-state';
import { PageHeader } from '@/components/page-header';
import { ReasonForm } from '@/components/reason-form';
import { SubscriptionStatusBadge } from '@/components/subscription-badges';
import { Tabs } from '@/components/tabs';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { SelectField, TextField } from '@/components/ui/field';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatBusinessDate } from '@/lib/business-dates';
import { toProblem } from '@/lib/errors';
import { companyKindLabel, formatTime, humanise } from '@/lib/format';
import { COMPANY_DETAIL_TABS, consoleTab } from '@/lib/platform-console';
import { monthLabel } from '@/lib/rent-tax';
import {
  ESTIMATED,
  grantStateText,
  invoiceStateText,
  subscriptionMessage,
  tierLabel,
  TIERS,
  totalUnits,
  WHATSAPP_COST_NOTE,
  wholeNumberOf,
} from '@/lib/subscription';
import { formatMinor } from '@/lib/tenancy-format';

type Detail = Awaited<ReturnType<ReturnType<typeof api>['platformAdmin']['company']>>;

const UTC = 'UTC';
const time = (iso: string) => formatTime(iso, UTC);

/** Re-thrown with plain words, so the reason form shows them. */
async function plainly<T>(send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (failure) {
    throw new Error(subscriptionMessage(failure) ?? toProblem(failure).message, {
      cause: failure,
    });
  }
}

export function CompanyDetail({
  companyId,
  can,
}: {
  readonly companyId: string;
  readonly can: { readonly manage: boolean; readonly discount: boolean; readonly support: boolean };
}) {
  const params = useSearchParams();
  const [tab, setTab] = useState(consoleTab(COMPANY_DETAIL_TABS, params.get('tab'))!.key);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(
    params.get('created') ? 'Created. Its first admin has been invited by email.' : null,
  );

  const load = useCallback(async () => {
    try {
      setDetail(await api().platformAdmin.company({ companyId }));
      setProblem(null);
    } catch (failure) {
      setProblem(toProblem(failure).message);
    }
  }, [companyId]);

  useEffect(() => {
    void load();
  }, [load]);

  const back = (
    <p className="text-sm">
      <Link href="/platform/companies" className="underline underline-offset-2">
        Companies
      </Link>
    </p>
  );
  if (problem && !detail)
    return (
      <>
        {back}
        <LoadFailed message={problem} onRetry={() => void load()} />
      </>
    );
  if (!detail)
    return (
      <>
        {back}
        <Loading what="the company" />
      </>
    );

  const updated = (next: Detail, text: string) => {
    setDetail(next);
    setNotice(text);
  };

  return (
    <>
      {back}
      <div className="space-y-2">
        <PageHeader title={detail.company.name} />
        <p className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
          <span>{companyKindLabel(detail.kind)}</span>
          <span aria-hidden="true">·</span>
          <span data-testid="platform-company-tier">{tierLabel(detail.tier)}</span>
          <SubscriptionStatusBadge status={detail.status} />
          {detail.access === 'read_only' ? <Badge tone="red">Read-only for staff</Badge> : null}
        </p>
      </div>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <Tabs
        label="Parts of the company’s record"
        tabs={COMPANY_DETAIL_TABS}
        current={tab}
        onChange={setTab}
      >
        {tab === 'subscription' ? (
          <SubscriptionTab detail={detail} can={can} onUpdated={updated} />
        ) : null}
        {tab === 'invoices' ? <InvoicesTab detail={detail} /> : null}
        {tab === 'usage' ? <UsageTab detail={detail} /> : null}
        {tab === 'support' ? <SupportTab detail={detail} canUse={can.support} /> : null}
      </Tabs>
    </>
  );
}

function SubscriptionTab({
  detail,
  can,
  onUpdated,
}: {
  readonly detail: Detail;
  readonly can: { readonly manage: boolean; readonly discount: boolean };
  readonly onUpdated: (next: Detail, text: string) => void;
}) {
  const s = detail.subscription;
  const [action, setAction] = useState<'tier' | 'trial' | null>(null);
  const [tier, setTier] = useState<SubscriptionTier>(detail.tier);
  const [days, setDays] = useState('14');
  const [daysError, setDaysError] = useState<string | null>(null);

  const facts: { label: string; value: string }[] = [
    { label: 'Plan', value: tierLabel(s.tier) },
    ...(s.trialEndsOn
      ? [{ label: 'Free trial ends', value: formatBusinessDate(s.trialEndsOn) }]
      : []),
    ...(s.pendingTier
      ? [
          {
            label: 'Moving to',
            value: `${tierLabel(s.pendingTier.tier)} on ${formatBusinessDate(s.pendingTier.from)}`,
          },
        ]
      : []),
    ...(s.cancelsOn ? [{ label: 'Ends on', value: formatBusinessDate(s.cancelsOn) }] : []),
    ...(s.arrears
      ? [
          {
            label: 'Past due',
            value: `${formatMinor(s.arrears.pastDueMinor)}, the oldest due ${formatBusinessDate(s.arrears.oldestDueOn)}`,
          },
        ]
      : []),
    ...(s.readOnlyFrom && detail.access !== 'read_only'
      ? [{ label: 'Read-only from', value: formatBusinessDate(s.readOnlyFrom) }]
      : []),
    { label: 'Prepaid credit', value: formatMinor(s.annual?.creditMinor ?? s.creditMinor) },
    ...(s.discount
      ? [
          {
            label: `Discount ${s.discount.code}`,
            value: `${s.discount.description}; ${s.discount.monthsLeft} months left`,
          },
        ]
      : []),
    {
      label: `Estimate for ${monthLabel(s.estimate.month)}`,
      value: `${formatMinor(s.estimate.totalMinor)} for ${totalUnits(s.estimate.billableUnits)} billable units`,
    },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Subscription" />
        <CardBody className="space-y-3">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {facts.map((fact) => (
              <div key={fact.label}>
                <dt className="text-slate-600">{fact.label}</dt>
                <dd className="text-slate-900">{fact.value}</dd>
              </div>
            ))}
          </dl>
          {can.manage ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => setAction('tier')}>
                Set the plan
              </Button>
              {detail.status === 'trialing' ? (
                <Button variant="secondary" size="sm" onClick={() => setAction('trial')}>
                  Extend the trial
                </Button>
              ) : null}
            </div>
          ) : null}
          {action === 'tier' ? (
            <div className="space-y-3">
              <SelectField
                label="Plan"
                value={tier}
                options={TIERS.map((t) => ({ value: t, label: tierLabel(t) }))}
                onChange={(event) => setTier(event.target.value as SubscriptionTier)}
                className="max-w-xs"
              />
              <ReasonForm
                label="Set the company’s plan"
                intro="Takes effect at once, for example for a pilot. The reason is kept in the company’s audit log."
                minLength={5}
                submitText={`Set ${tierLabel(tier)}`}
                onSubmit={async (reason) => {
                  const next = await plainly(() =>
                    api().platformAdmin.setTier({ companyId: detail.company.id, tier, reason }),
                  );
                  setAction(null);
                  onUpdated(next, `${next.company.name} is now on ${tierLabel(next.tier)}.`);
                }}
                onCancel={() => setAction(null)}
              />
            </div>
          ) : null}
          {action === 'trial' ? (
            <div className="space-y-3">
              <TextField
                label="Days to add"
                inputMode="numeric"
                value={days}
                onChange={(event) => setDays(event.target.value)}
                error={daysError}
                className="max-w-48"
              />
              <ReasonForm
                label="Extend the free trial"
                minLength={5}
                submitText="Extend the trial"
                onSubmit={async (reason) => {
                  const parsed = wholeNumberOf(days, 1, 365);
                  setDaysError(parsed.problem);
                  if (parsed.value === null) throw new Error(parsed.problem ?? 'Enter the days.');
                  const count = parsed.value;
                  const next = await plainly(() =>
                    api().platformAdmin.extendTrial({
                      companyId: detail.company.id,
                      days: count,
                      reason,
                    }),
                  );
                  setAction(null);
                  onUpdated(
                    next,
                    next.trialEndsOn
                      ? `The free trial now ends on ${formatBusinessDate(next.trialEndsOn)}.`
                      : 'The free trial is extended.',
                  );
                }}
                onCancel={() => setAction(null)}
              />
            </div>
          ) : null}
          {can.discount ? <CompanyCode detail={detail} onUpdated={onUpdated} /> : null}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="History" description="Every change to the subscription, newest first." />
        <CardBody>
          {detail.events.length === 0 ? (
            <Empty>Nothing yet.</Empty>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm" data-testid="platform-company-events">
              {detail.events.map((event, index) => (
                <li key={`${event.at}-${index}`} className="py-2">
                  <p className="font-medium text-slate-900">{humanise(event.kind)}</p>
                  <p className="text-slate-700">{event.detail}</p>
                  <p className="text-xs text-slate-600">{time(event.at)}</p>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function CompanyCode({
  detail,
  onUpdated,
}: {
  readonly detail: Detail;
  readonly onUpdated: (next: Detail, text: string) => void;
}) {
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = code.trim().toUpperCase();
    if (trimmed.length < 2) {
      setProblem('Enter the discount code.');
      return;
    }
    setPending(true);
    setProblem(null);
    try {
      const next = await api().platformAdmin.applyCode({
        companyId: detail.company.id,
        code: trimmed,
      });
      setCode('');
      onUpdated(next, `Applied ${trimmed} to ${next.company.name}.`);
    } catch (failure) {
      setProblem(subscriptionMessage(failure) ?? toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      aria-label="Apply a discount code to the company"
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => void submit(event)}
    >
      <TextField
        label="Discount code"
        value={code}
        maxLength={40}
        onChange={(event) => setCode(event.target.value)}
        error={problem}
        className="min-w-48"
      />
      <Button type="submit" variant="secondary" pending={pending}>
        Apply the code
      </Button>
    </form>
  );
}

function InvoicesTab({ detail }: { readonly detail: Detail }) {
  return (
    <Card>
      <CardHeader title="Invoices" />
      <CardBody>
        {detail.invoices.length === 0 ? (
          <Empty>No invoice yet.</Empty>
        ) : (
          <Table caption="The company’s subscription invoices">
            <thead>
              <tr>
                <Th>Invoice</Th>
                <Th>Month</Th>
                <Th>Due</Th>
                <Th className="text-right">Total</Th>
                <Th>State</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {detail.invoices.map((invoice) => (
                <tr key={invoice.id}>
                  <Td className="font-medium">{invoice.number}</Td>
                  <Td>{monthLabel(invoice.month)}</Td>
                  <Td>{formatBusinessDate(invoice.dueOn)}</Td>
                  <Td className="text-right tabular-nums">{formatMinor(invoice.totalMinor)}</Td>
                  <Td>{invoiceStateText(invoice)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </CardBody>
    </Card>
  );
}

function UsageTab({ detail }: { readonly detail: Detail }) {
  return (
    <Card>
      <CardHeader title="Usage" description={WHATSAPP_COST_NOTE} />
      <CardBody>
        {detail.usage.length === 0 ? (
          <Empty>No usage recorded yet.</Empty>
        ) : (
          <UsageTable rows={detail.usage} caption="The company’s usage by month" byMonth />
        )}
      </CardBody>
    </Card>
  );
}

type UsageRow = Detail['usage'][number];

/** Usage and messaging costs (decision 15): shared by a company's page and Messaging costs. */
export function UsageTable({
  rows,
  caption,
  byMonth = false,
}: {
  readonly rows: readonly UsageRow[];
  readonly caption: string;
  readonly byMonth?: boolean;
}) {
  return (
    <Table caption={caption}>
      <thead>
        <tr>
          <Th>{byMonth ? 'Month' : 'Company'}</Th>
          <Th className="text-right">Units</Th>
          <Th className="text-right">Billable</Th>
          <Th className="text-right">Invoiced</Th>
          <Th className="text-right">Paid</Th>
          <Th className="text-right">Owed</Th>
          <Th className="text-right">SMS</Th>
          <Th className="text-right">WhatsApp</Th>
          <Th className="text-right">Email</Th>
          <Th className="text-right">App</Th>
          <Th className="text-right">SMS cost</Th>
          <Th className="text-right">WhatsApp cost ({ESTIMATED.toLowerCase()})</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((row) => (
          <tr key={`${row.company.id}-${row.month}`} data-testid="usage-row">
            <Td className="font-medium">{byMonth ? monthLabel(row.month) : row.company.name}</Td>
            <Td className="text-right tabular-nums">{row.units}</Td>
            <Td className="text-right tabular-nums">{totalUnits(row.billableUnits)}</Td>
            <Td className="text-right tabular-nums">{formatMinor(row.invoicedMinor)}</Td>
            <Td className="text-right tabular-nums">{formatMinor(row.paidMinor)}</Td>
            <Td className="text-right tabular-nums">{formatMinor(row.arrearsMinor)}</Td>
            <Td className="text-right tabular-nums">{row.messages.sms}</Td>
            <Td className="text-right tabular-nums">{row.messages.whatsapp}</Td>
            <Td className="text-right tabular-nums">{row.messages.email}</Td>
            <Td className="text-right tabular-nums">{row.messages.push}</Td>
            <Td className="text-right tabular-nums">{formatMinor(row.smsCostMinor)}</Td>
            <Td className="text-right tabular-nums">
              {formatMinor(row.whatsappCostEstimatedMinor)}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function SupportTab({ detail, canUse }: { readonly detail: Detail; readonly canUse: boolean }) {
  const active = detail.supportGrants.some((grant) => grant.active);
  return (
    <Card>
      <CardHeader
        title="Support access"
        description="Only the company’s admin grants it; while it lasts, support reads the company and changes nothing."
      />
      <CardBody className="space-y-3">
        {active && canUse ? (
          <Link
            href={`/platform/support/${detail.company.id}`}
            className="inline-block font-medium underline underline-offset-2"
          >
            Open the company read-only
          </Link>
        ) : null}
        {detail.supportGrants.length === 0 ? (
          <Empty>The company has never granted support access.</Empty>
        ) : (
          <GrantList grants={detail.supportGrants} />
        )}
      </CardBody>
    </Card>
  );
}

type GrantRow = Detail['supportGrants'][number];

/** Grants and the requests made under each (AD-10): shared with Support access. */
export function GrantList({ grants }: { readonly grants: readonly GrantRow[] }) {
  return (
    <ul className="space-y-3">
      {grants.map((grant) => {
        const state = grantStateText(
          {
            expiresAt: grant.until,
            revokedAt: grant.revokedAt,
            revokedByName: grant.revokedByName,
          },
          grant.active ? grant.from : grant.until,
          time,
        );
        return (
          <li
            key={grant.id}
            className="space-y-1 rounded-md border border-slate-200 p-3 text-sm"
            data-testid="platform-support-grant"
          >
            <p className="flex flex-wrap items-center gap-2">
              <Badge tone={grant.active ? 'amber' : 'neutral'}>
                {grant.active ? 'Active' : 'Ended'}
              </Badge>
              <span className="text-slate-900">{grant.reason}</span>
            </p>
            <p className="text-slate-700">
              Granted by {grant.grantedBy.name} {time(grant.from)}. {state.text}
            </p>
            {grant.sessions.length === 0 ? (
              <p className="text-slate-600">Nothing opened under it.</p>
            ) : (
              <Table caption="Requests made under this access">
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th>Who</Th>
                    <Th>What</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {grant.sessions.map((session, index) => (
                    <tr key={`${session.at}-${index}`}>
                      <Td>{time(session.at)}</Td>
                      <Td>{session.adminName}</Td>
                      <Td className="break-all">
                        {session.route}
                        {session.record ? ` (${session.record})` : ''}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </li>
        );
      })}
    </ul>
  );
}
