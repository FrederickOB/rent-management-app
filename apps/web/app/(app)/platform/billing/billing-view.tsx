'use client';

import type { PriceListView, SubscriptionTermsView } from '@rent/contracts';
import { addDays, DEFAULT_TIME_ZONE, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { PRICING_CATEGORIES, type PricingCategory } from '@rent/domain/messaging';
import type { SubscriptionTier } from '@rent/domain/settings';
import { useSearchParams } from 'next/navigation';
import { useCallback, useState, type FormEvent } from 'react';
import { Empty, LoadFailed, Loading } from '@/components/load-state';
import { Tabs } from '@/components/tabs';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { CheckboxField, SelectField, TextField } from '@/components/ui/field';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatBusinessDate, todayIn } from '@/lib/business-dates';
import { toProblem } from '@/lib/errors';
import { percentToBps } from '@/lib/fee-terms';
import { nonNegativeMinorOf } from '@/lib/owner-money';
import { amountMinorOf } from '@/lib/payment-form';
import { CONSOLE_SECTIONS, consoleTab } from '@/lib/platform-console';
import { bpsText } from '@/lib/reporting';
import {
  bandRows,
  discountLimitsText,
  discountText,
  minimumText,
  PLACEHOLDER_PRICE_TEXT,
  PRICING_CATEGORY_LABELS,
  rateText,
  subscriptionMessage,
  termsRows,
  tierLabel,
  TIERS,
  VERSION_STATE_LABELS,
  versionStates,
  vatStatusText,
  wholeNumberOf,
  type VersionState,
} from '@/lib/subscription';
import { formatMinor } from '@/lib/tenancy-format';
import { useLoad } from '@/lib/use-load';

const TABS = CONSOLE_SECTIONS.find((section) => section.href === '/platform/billing')!.tabs;

const problemText = (failure: unknown): string =>
  subscriptionMessage(failure) ?? toProblem(failure).message;

/** Prices and terms run on the platform's default time zone; the API refuses a past date. */
const today = () => todayIn(DEFAULT_TIME_ZONE);
const tomorrow = () => toIsoDate(addDays(parseBusinessDate(today()), 1));

const STATE_TONES: Record<VersionState, 'green' | 'blue' | 'neutral'> = {
  in_force: 'green',
  future: 'blue',
  replaced: 'neutral',
};

function VersionBadge({ state }: { readonly state: VersionState | undefined }) {
  if (!state) return null;
  return <Badge tone={STATE_TONES[state]}>{VERSION_STATE_LABELS[state]}</Badge>;
}

export function BillingView({
  can,
}: {
  readonly can: { readonly pricing: boolean; readonly discounts: boolean };
}) {
  const params = useSearchParams();
  const tabs = TABS.filter((tab) => (tab.key === 'codes' ? can.discounts : can.pricing));
  const [tab, setTab] = useState(consoleTab(tabs, params.get('tab'))?.key ?? 'prices');

  return (
    <Tabs label="Plans and billing" tabs={tabs} current={tab} onChange={setTab}>
      {tab === 'prices' ? <PriceLists /> : null}
      {tab === 'terms' ? <Terms /> : null}
      {tab === 'codes' ? <DiscountCodes /> : null}
      {tab === 'whatsapp-rates' ? <WhatsappRates /> : null}
    </Tabs>
  );
}

// Price lists (PB-03, decision 3) ---------------------------------------------------------------

function PriceLists() {
  const load = useCallback(() => api().platformAdmin.priceLists(), []);
  const { state, reload } = useLoad(load);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <AddPriceList
        onAdded={(added) => {
          setNotice(
            `${tierLabel(added.tier)}’s new prices start on ${formatBusinessDate(added.effectiveFrom)}.`,
          );
          reload();
        }}
      />
      {state.status === 'loading' ? <Loading what="price lists" /> : null}
      {state.status === 'error' ? (
        <LoadFailed message={state.problem.message} onRetry={reload} />
      ) : null}
      {state.status === 'ready' ? <PriceListTable lists={state.data} /> : null}
    </div>
  );
}

function PriceListTable({ lists }: { readonly lists: readonly PriceListView[] }) {
  const states = versionStates(lists, (row) => row.tier, today());
  if (lists.length === 0) return <Empty>No price list yet.</Empty>;
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {TIERS.map((tier) => (
        <Card key={tier} data-testid="price-list-tier">
          <CardHeader title={tierLabel(tier)} />
          <CardBody>
            <ul className="space-y-3 text-sm">
              {lists
                .filter((list) => list.tier === tier)
                .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))
                .map((list) => (
                  <li
                    key={list.id}
                    className="space-y-1 border-b border-slate-100 pb-3 last:border-0"
                    data-testid="price-list"
                  >
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">
                        From {formatBusinessDate(list.effectiveFrom)}
                      </span>
                      <VersionBadge state={states.get(list.id)} />
                    </p>
                    <ul className="text-slate-700">
                      {bandRows(list.ratesMinor).map((row) => (
                        <li key={row.band}>
                          {row.label}: {rateText(row.value)}
                        </li>
                      ))}
                      <li>{minimumText(list.minimumMinor)}</li>
                      <li>Paying a year ahead: {bpsText(list.annualDiscountBps)} off</li>
                    </ul>
                    {list.placeholder ? (
                      <p className="font-medium text-amber-900" data-testid="price-placeholder">
                        {PLACEHOLDER_PRICE_TEXT}
                      </p>
                    ) : null}
                  </li>
                ))}
            </ul>
          </CardBody>
        </Card>
      ))}
    </div>
  );
}

type PriceField = 'single_room' | 'self_contained' | 'commercial' | 'minimum' | 'discount' | 'from';

function AddPriceList({ onAdded }: { readonly onAdded: (added: PriceListView) => void }) {
  const [open, setOpen] = useState(false);
  const [tier, setTier] = useState<SubscriptionTier>('starter');
  const [draft, setDraft] = useState<Record<PriceField, string>>({
    single_room: '',
    self_contained: '',
    commercial: '',
    minimum: '',
    discount: '10',
    from: tomorrow(),
  });
  const [errors, setErrors] = useState<Partial<Record<PriceField, string>>>({});
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (field: PriceField) => (value: string) =>
    setDraft((current) => ({ ...current, [field]: value }));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProblem(null);
    const money = (field: PriceField) => nonNegativeMinorOf(draft[field]);
    const rates = {
      single_room: money('single_room'),
      self_contained: money('self_contained'),
      commercial: money('commercial'),
    };
    const minimum = money('minimum');
    const discount = draft.discount.trim() === '0' ? 0 : percentToBps(draft.discount);
    const next: Partial<Record<PriceField, string>> = {};
    for (const field of ['single_room', 'self_contained', 'commercial', 'minimum'] as const) {
      const parsed = field === 'minimum' ? minimum : rates[field];
      if (!draft[field].trim()) next[field] = 'Enter an amount in cedis; 0 is allowed.';
      else if (parsed.problem) next[field] = parsed.problem;
    }
    if (discount === null) next.discount = 'Enter a percentage from 0 to 100, such as 10.';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.from) || draft.from <= today())
      next.from = 'Choose a date from tomorrow on.';
    setErrors(next);
    if (Object.keys(next).length > 0 || discount === null) return;
    setPending(true);
    try {
      const added = await api().platformAdmin.addPriceList({
        tier,
        ratesMinor: {
          single_room: rates.single_room.value ?? 0,
          self_contained: rates.self_contained.value ?? 0,
          commercial: rates.commercial.value ?? 0,
        },
        minimumMinor: minimum.value ?? 0,
        annualDiscountBps: discount,
        effectiveFrom: draft.from,
      });
      setOpen(false);
      onAdded(added);
    } catch (failure) {
      setProblem(problemText(failure));
    } finally {
      setPending(false);
    }
  }

  if (!open)
    return (
      <div>
        <Button onClick={() => setOpen(true)}>Add new prices</Button>
      </div>
    );

  return (
    <Card>
      <CardHeader
        title="New prices for a plan"
        description="They apply to months from the date you choose; earlier months keep the prices they had."
      />
      <CardBody>
        <form
          aria-label="New prices for a plan"
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => void submit(event)}
        >
          <SelectField
            label="Plan"
            value={tier}
            options={TIERS.map((t) => ({ value: t, label: tierLabel(t) }))}
            onChange={(event) => setTier(event.target.value as SubscriptionTier)}
          />
          <TextField
            label="From"
            type="date"
            min={tomorrow()}
            value={draft.from}
            onChange={(event) => set('from')(event.target.value)}
            error={errors.from}
          />
          {bandRows({ single_room: 0, self_contained: 0, commercial: 0 }).map((row) => (
            <TextField
              key={row.band}
              label={`${row.label}: GH₵ a unit a month`}
              inputMode="decimal"
              value={draft[row.band]}
              onChange={(event) => set(row.band)(event.target.value)}
              error={errors[row.band]}
            />
          ))}
          <TextField
            label="Monthly minimum (GH₵)"
            inputMode="decimal"
            value={draft.minimum}
            onChange={(event) => set('minimum')(event.target.value)}
            error={errors.minimum}
          />
          <TextField
            label="Discount for paying a year ahead (%)"
            inputMode="decimal"
            value={draft.discount}
            onChange={(event) => set('discount')(event.target.value)}
            error={errors.discount}
          />
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button type="submit" pending={pending}>
              Add the prices
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
          {problem ? (
            <Alert tone="error" className="sm:col-span-2">
              {problem}
            </Alert>
          ) : null}
        </form>
      </CardBody>
    </Card>
  );
}

// Terms (decisions 2, 5, 10, 11 and 12) ------------------------------------------------------

function Terms() {
  const load = useCallback(
    () =>
      Promise.all([
        api().platformAdmin.terms(),
        api()
          .rules.list({})
          .then((rules) => rules.find((rule) => rule.key === 'vat.platform_subscription') ?? null),
      ]),
    [],
  );
  const { state, reload } = useLoad(load);
  const [notice, setNotice] = useState<string | null>(null);

  if (state.status === 'loading') return <Loading what="the terms" />;
  if (state.status === 'error')
    return <LoadFailed message={state.problem.message} onRetry={reload} />;
  const [terms, vatRule] = state.data;
  const vatVerified = vatRule?.verificationStatus === 'verified';
  const states = versionStates(terms, () => 'terms', today());
  const inForce = terms.find((t) => states.get(t.id) === 'in_force') ?? null;

  return (
    <div className="space-y-4">
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <Alert tone={vatVerified ? 'info' : 'warning'} title="VAT on subscription invoices">
        {vatStatusText({ charged: inForce?.vatRegistered ?? false, verified: vatVerified })}
      </Alert>
      <AddTerms
        current={inForce}
        vatVerified={vatVerified}
        onAdded={(added) => {
          setNotice(`The new terms apply from ${formatBusinessDate(added.effectiveFrom)}.`);
          reload();
        }}
      />
      {terms.length === 0 ? (
        <Empty>No terms yet.</Empty>
      ) : (
        <ul className="space-y-3">
          {[...terms]
            .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))
            .map((t) => (
              <li key={t.id}>
                <Card data-testid="terms-version">
                  <CardHeader
                    title={`From ${formatBusinessDate(t.effectiveFrom)}`}
                    actions={<VersionBadge state={states.get(t.id)} />}
                  />
                  <CardBody>
                    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                      {termsRows(t).map((row) => (
                        <div key={row.key}>
                          <dt className="text-slate-600">{row.label}</dt>
                          <dd className="text-slate-900">{row.value}</dd>
                        </div>
                      ))}
                    </dl>
                  </CardBody>
                </Card>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

function AddTerms({
  current,
  vatVerified,
  onAdded,
}: {
  readonly current: SubscriptionTermsView | null;
  readonly vatVerified: boolean;
  readonly onAdded: (added: SubscriptionTermsView) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => ({
    from: today(),
    trialDays: String(current?.trialDays ?? 30),
    graceDays: String(current?.graceDays ?? 14),
    dueDays: String(current?.dueDays ?? 7),
    retention: String(current?.retentionDaysAfterCancel ?? 90),
    readOnlyEnabled: current?.readOnlyEnabled ?? true,
    vatRegistered: current?.vatRegistered ?? false,
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProblem(null);
    const trial = wholeNumberOf(draft.trialDays, 0, 365);
    const grace = wholeNumberOf(draft.graceDays, 0, 90);
    const due = wholeNumberOf(draft.dueDays, 0, 60);
    const retention = wholeNumberOf(draft.retention, 0, 3650);
    const next: Record<string, string> = {};
    if (trial.problem) next.trialDays = trial.problem;
    if (grace.problem) next.graceDays = grace.problem;
    if (due.problem) next.dueDays = due.problem;
    if (retention.problem) next.retention = retention.problem;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.from) || draft.from < today())
      next.from = 'Choose today or a later date.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setPending(true);
    try {
      const added = await api().platformAdmin.addTerms({
        effectiveFrom: draft.from,
        trialDays: trial.value!,
        graceDays: grace.value!,
        readOnlyEnabled: draft.readOnlyEnabled,
        dueDays: due.value!,
        retentionDaysAfterCancel: retention.value!,
        vatRegistered: draft.vatRegistered,
      });
      setOpen(false);
      onAdded(added);
    } catch (failure) {
      setProblem(problemText(failure));
    } finally {
      setPending(false);
    }
  }

  if (!open)
    return (
      <div>
        <Button onClick={() => setOpen(true)}>Change the terms</Button>
      </div>
    );

  const text = (key: keyof typeof draft, label: string, hint?: string) => (
    <TextField
      label={label}
      hint={hint}
      inputMode="numeric"
      value={String(draft[key])}
      onChange={(event) => setDraft((d) => ({ ...d, [key]: event.target.value }))}
      error={errors[key]}
    />
  );

  return (
    <Card>
      <CardHeader
        title="New terms"
        description="Filled in from the terms in force; change what you need. They apply from the date you choose."
      />
      <CardBody>
        <form
          aria-label="New subscription terms"
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => void submit(event)}
        >
          <TextField
            label="From"
            type="date"
            min={today()}
            value={draft.from}
            onChange={(event) => setDraft((d) => ({ ...d, from: event.target.value }))}
            error={errors.from}
          />
          {text('trialDays', 'Free trial (days)')}
          {text('dueDays', 'Invoice due (days after it is issued)')}
          {text('graceDays', 'Days after the due date before read-only')}
          {text('retention', 'Read access after cancelling (days)')}
          <CheckboxField
            label="Read-only for unpaid invoices"
            hint="Staff can read but not change records after the grace period. Tenants are never affected."
            checked={draft.readOnlyEnabled}
            onChange={(event) => setDraft((d) => ({ ...d, readOnlyEnabled: event.target.checked }))}
            className="sm:col-span-2"
          />
          <CheckboxField
            label="The platform is VAT-registered: charge VAT on subscription invoices"
            hint={vatVerified ? undefined : vatStatusText({ charged: true, verified: false })}
            checked={draft.vatRegistered}
            onChange={(event) => setDraft((d) => ({ ...d, vatRegistered: event.target.checked }))}
            className="sm:col-span-2"
          />
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button type="submit" pending={pending}>
              Add the terms
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
          {problem ? (
            <Alert tone="error" className="sm:col-span-2">
              {problem}
            </Alert>
          ) : null}
        </form>
      </CardBody>
    </Card>
  );
}

// Discount codes (decision 8) ----------------------------------------------------------------

function DiscountCodes() {
  const load = useCallback(() => api().platformAdmin.discountCodes(), []);
  const { state, reload } = useLoad(load);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <AddDiscountCode
        onAdded={(code) => {
          setNotice(`Added ${code}.`);
          reload();
        }}
      />
      {state.status === 'loading' ? <Loading what="discount codes" /> : null}
      {state.status === 'error' ? (
        <LoadFailed message={state.problem.message} onRetry={reload} />
      ) : null}
      {state.status === 'ready' && state.data.length === 0 ? <Empty>No code yet.</Empty> : null}
      {state.status === 'ready' && state.data.length > 0 ? (
        <Table caption="Discount codes">
          <thead>
            <tr>
              <Th>Code</Th>
              <Th>Discount</Th>
              <Th>Limits</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {state.data.map((code) => (
              <tr key={code.id} data-testid="discount-code-row">
                <Td className="font-mono font-medium">{code.code}</Td>
                <Td>{discountText(code)}</Td>
                <Td>{discountLimitsText(code)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </div>
  );
}

function AddDiscountCode({ onAdded }: { readonly onAdded: (code: string) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({
    code: '',
    kind: 'percentage' as 'percentage' | 'fixed',
    amount: '',
    months: '3',
    expiresOn: '',
    maxUses: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProblem(null);
    const code = draft.code.trim().toUpperCase();
    const percent = draft.kind === 'percentage' ? percentToBps(draft.amount) : null;
    const fixed = draft.kind === 'fixed' ? amountMinorOf(draft.amount) : null;
    const months = wholeNumberOf(draft.months, 1, 36);
    const uses = draft.maxUses.trim() ? wholeNumberOf(draft.maxUses, 1, 1_000_000) : null;
    const next: Record<string, string> = {};
    if (!/^[A-Z0-9-]{2,40}$/.test(code))
      next.code = 'Use 2 to 40 capital letters, digits and dashes, such as PILOT-2026.';
    if (draft.kind === 'percentage' && percent === null)
      next.amount = 'Enter a percentage from 0.01 to 100, such as 10.';
    if (fixed?.problem) next.amount = fixed.problem;
    if (months.problem) next.months = months.problem;
    if (uses?.problem) next.maxUses = uses.problem;
    if (draft.expiresOn && draft.expiresOn < today())
      next.expiresOn = 'Choose today or a later date, or leave it blank.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setPending(true);
    try {
      const added = await api().platformAdmin.addDiscountCode({
        code,
        kind: draft.kind,
        ...(percent !== null ? { percentBps: percent } : {}),
        ...(fixed?.value ? { amountMinor: fixed.value } : {}),
        months: months.value!,
        ...(draft.expiresOn ? { expiresOn: draft.expiresOn } : {}),
        ...(uses?.value ? { maxUses: uses.value } : {}),
      });
      setOpen(false);
      setDraft((d) => ({ ...d, code: '', amount: '', expiresOn: '', maxUses: '' }));
      onAdded(added.code);
    } catch (failure) {
      setProblem(problemText(failure));
    } finally {
      setPending(false);
    }
  }

  if (!open)
    return (
      <div>
        <Button onClick={() => setOpen(true)}>Add a discount code</Button>
      </div>
    );

  return (
    <Card>
      <CardHeader
        title="New discount code"
        description="A landlord applies it on their subscription page, or you apply it on a company’s page. One code at a time; it shows as its own line on each invoice it covers."
      />
      <CardBody>
        <form
          aria-label="New discount code"
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => void submit(event)}
        >
          <TextField
            label="Code"
            value={draft.code}
            maxLength={40}
            autoCapitalize="characters"
            onChange={(event) => setDraft((d) => ({ ...d, code: event.target.value }))}
            error={errors.code}
          />
          <SelectField
            label="Kind"
            value={draft.kind}
            options={[
              { value: 'percentage', label: 'A percentage off' },
              { value: 'fixed', label: 'An amount off each month' },
            ]}
            onChange={(event) =>
              setDraft((d) => ({ ...d, kind: event.target.value as 'percentage' | 'fixed' }))
            }
          />
          <TextField
            label={draft.kind === 'percentage' ? 'Percentage off' : 'GH₵ off each month'}
            inputMode="decimal"
            value={draft.amount}
            onChange={(event) => setDraft((d) => ({ ...d, amount: event.target.value }))}
            error={errors.amount}
          />
          <TextField
            label="For how many months"
            inputMode="numeric"
            value={draft.months}
            onChange={(event) => setDraft((d) => ({ ...d, months: event.target.value }))}
            error={errors.months}
          />
          <TextField
            label="Expires on (optional)"
            type="date"
            value={draft.expiresOn}
            onChange={(event) => setDraft((d) => ({ ...d, expiresOn: event.target.value }))}
            error={errors.expiresOn}
          />
          <TextField
            label="Most uses (optional)"
            inputMode="numeric"
            value={draft.maxUses}
            onChange={(event) => setDraft((d) => ({ ...d, maxUses: event.target.value }))}
            error={errors.maxUses}
          />
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button type="submit" pending={pending}>
              Add the code
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
          {problem ? (
            <Alert tone="error" className="sm:col-span-2">
              {problem}
            </Alert>
          ) : null}
        </form>
      </CardBody>
    </Card>
  );
}

// WhatsApp rates (decision 15) -----------------------------------------------------------------

function WhatsappRates() {
  const load = useCallback(() => api().platformAdmin.whatsappRates(), []);
  const { state, reload } = useLoad(load);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<PricingCategory>('utility');
  const [rate, setRate] = useState('');
  const [from, setFrom] = useState(today());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProblem(null);
    const parsed = nonNegativeMinorOf(rate);
    const next: Record<string, string> = {};
    if (!rate.trim()) next.rate = 'Enter the rate in cedis; 0 is allowed.';
    else if (parsed.problem) next.rate = parsed.problem;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) next.from = 'Choose a date.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setPending(true);
    try {
      const added = await api().platformAdmin.addWhatsappRate({
        category,
        rateMinor: parsed.value ?? 0,
        effectiveFrom: from,
      });
      setOpen(false);
      setRate('');
      setNotice(
        `${PRICING_CATEGORY_LABELS[added.category]} messages are estimated at ${formatMinor(added.rateMinor)} each from ${formatBusinessDate(added.effectiveFrom)}.`,
      );
      reload();
    } catch (failure) {
      setProblem(problemText(failure));
    } finally {
      setPending(false);
    }
  }

  const states =
    state.status === 'ready' ? versionStates(state.data, (row) => row.category, today()) : null;

  return (
    <div className="space-y-4">
      <Alert tone="info">
        These rates estimate what WhatsApp messages cost, by Meta’s pricing category. They are
        labelled “estimated” wherever they are used, and never bill anyone.
      </Alert>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {open ? (
        <Card>
          <CardHeader title="New WhatsApp rate" />
          <CardBody>
            <form
              aria-label="New WhatsApp rate"
              className="grid gap-3 sm:grid-cols-3"
              onSubmit={(event) => void submit(event)}
            >
              <SelectField
                label="Pricing category"
                value={category}
                options={PRICING_CATEGORIES.map((c) => ({
                  value: c,
                  label: PRICING_CATEGORY_LABELS[c],
                }))}
                onChange={(event) => setCategory(event.target.value as PricingCategory)}
              />
              <TextField
                label="GH₵ a message"
                inputMode="decimal"
                value={rate}
                onChange={(event) => setRate(event.target.value)}
                error={errors.rate}
              />
              <TextField
                label="From"
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                error={errors.from}
              />
              <div className="flex flex-wrap gap-2 sm:col-span-3">
                <Button type="submit" pending={pending}>
                  Add the rate
                </Button>
                <Button variant="ghost" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
              </div>
              {problem ? (
                <Alert tone="error" className="sm:col-span-3">
                  {problem}
                </Alert>
              ) : null}
            </form>
          </CardBody>
        </Card>
      ) : (
        <div>
          <Button onClick={() => setOpen(true)}>Add a rate</Button>
        </div>
      )}
      {state.status === 'loading' ? <Loading what="WhatsApp rates" /> : null}
      {state.status === 'error' ? (
        <LoadFailed message={state.problem.message} onRetry={reload} />
      ) : null}
      {state.status === 'ready' && state.data.length === 0 ? <Empty>No rate yet.</Empty> : null}
      {state.status === 'ready' && state.data.length > 0 ? (
        <Table caption="WhatsApp rates by pricing category">
          <thead>
            <tr>
              <Th>Category</Th>
              <Th className="text-right">A message (estimated)</Th>
              <Th>From</Th>
              <Th>State</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {[...state.data]
              .sort((a, b) =>
                a.category === b.category
                  ? a.effectiveFrom < b.effectiveFrom
                    ? 1
                    : -1
                  : a.category < b.category
                    ? -1
                    : 1,
              )
              .map((row) => (
                <tr key={row.id}>
                  <Td>{PRICING_CATEGORY_LABELS[row.category]}</Td>
                  <Td className="text-right tabular-nums">{formatMinor(row.rateMinor)}</Td>
                  <Td>{formatBusinessDate(row.effectiveFrom)}</Td>
                  <Td>
                    <VersionBadge state={states?.get(row.id)} />
                  </Td>
                </tr>
              ))}
          </tbody>
        </Table>
      ) : null}
    </div>
  );
}
