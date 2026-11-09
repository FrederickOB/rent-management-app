'use client';

import { DEFAULT_TIME_ZONE, isValidTimeZone } from '@rent/domain/dates';
import type { SubscriptionTier } from '@rent/domain/settings';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useRef, useState, type FormEvent } from 'react';
import { Empty, LoadFailed, Loading } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { SubscriptionStatusBadge } from '@/components/subscription-badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { SelectField, TextField } from '@/components/ui/field';
import { Table, Td, Th } from '@/components/ui/table';
import { api, keyedApi } from '@/lib/api';
import { formatBusinessDate } from '@/lib/business-dates';
import { toProblem } from '@/lib/errors';
import { isKeyReused, sendOnce, useIdempotencyKeeper } from '@/lib/idempotency';
import { companyKindLabel } from '@/lib/format';
import { subscriptionMessage, tierLabel, TIERS, wholeNumberOf } from '@/lib/subscription';
import { formatMinor } from '@/lib/tenancy-format';
import { useLoad } from '@/lib/use-load';
import { BillingSwitch } from '../billing/billing-switch';

export function CompaniesView({ canCreate }: { readonly canCreate: boolean }) {
  const load = useCallback(() => api().platformAdmin.companies(), []);
  const { state, reload } = useLoad(load);

  return (
    <>
      <BillingSwitch canTurnOn={false} />
      {canCreate ? <CreateCompany /> : null}
      <Card>
        <CardHeader title="Subscribers" />
        <CardBody>
          {state.status === 'loading' ? <Loading what="companies" /> : null}
          {state.status === 'error' ? (
            <LoadFailed message={state.problem.message} onRetry={reload} />
          ) : null}
          {state.status === 'ready' && state.data.length === 0 ? (
            <Empty>No company yet.</Empty>
          ) : null}
          {state.status === 'ready' && state.data.length > 0 ? (
            <Table caption="Subscriber companies">
              <thead>
                <tr>
                  <Th>Company</Th>
                  <Th>Kind</Th>
                  <Th>Plan</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Billable units</Th>
                  <Th className="text-right">Last invoice</Th>
                  <Th className="text-right">Owed</Th>
                  <Th>Support</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {state.data.map((row) => (
                  <tr key={row.company.id} data-testid="platform-company-row">
                    <Td className="font-medium">
                      <Link
                        href={`/platform/companies/${row.company.id}`}
                        className="underline underline-offset-2"
                      >
                        {row.company.name}
                      </Link>
                    </Td>
                    <Td>{companyKindLabel(row.kind)}</Td>
                    <Td>{tierLabel(row.tier)}</Td>
                    <Td>
                      <SubscriptionStatusBadge status={row.status} />
                      {row.status === 'trialing' && row.trialEndsOn ? (
                        <span className="block text-xs text-slate-600">
                          until {formatBusinessDate(row.trialEndsOn)}
                        </span>
                      ) : null}
                      {row.access === 'read_only' ? (
                        <span className="block text-xs font-medium text-red-800">
                          Read-only for staff
                        </span>
                      ) : null}
                    </Td>
                    <Td className="text-right tabular-nums">{row.billableUnits}</Td>
                    <Td className="text-right tabular-nums">
                      {formatMinor(row.monthlyRevenueMinor)}
                    </Td>
                    <Td className="text-right tabular-nums">{formatMinor(row.arrearsMinor)}</Td>
                    <Td>
                      {row.supportGrantActive ? <Badge tone="amber">Access granted</Badge> : '—'}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : null}
        </CardBody>
      </Card>
    </>
  );
}

interface Draft {
  kind: 'agency' | 'landlord';
  name: string;
  legalName: string;
  timeZone: string;
  tier: SubscriptionTier;
  trialDays: string;
  adminName: string;
  adminEmail: string;
}

type Field = keyof Draft;

const EMPTY: Draft = {
  kind: 'landlord',
  name: '',
  legalName: '',
  timeZone: DEFAULT_TIME_ZONE,
  tier: 'starter',
  trialDays: '',
  adminName: '',
  adminEmail: '',
};

/** Onboarding (decision 14): no self sign-up in the MVP; a platform admin creates the company. */
function CreateCompany() {
  const router = useRouter();
  const keeper = useIdempotencyKeeper();
  const keyedFor = useRef<string | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (field: Field) => (value: string) =>
    setDraft((current) => ({ ...current, [field]: value }));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProblem(null);
    const trial = draft.trialDays.trim() ? wholeNumberOf(draft.trialDays, 0, 365) : null;
    const next: Partial<Record<Field, string>> = {
      ...(draft.name.trim().length < 2 ? { name: 'Enter the company’s name.' } : {}),
      ...(isValidTimeZone(draft.timeZone.trim())
        ? {}
        : { timeZone: 'Enter a time zone such as Africa/Accra.' }),
      ...(trial?.problem ? { trialDays: trial.problem } : {}),
      ...(draft.adminName.trim().length < 2 ? { adminName: 'Enter the first admin’s name.' } : {}),
      ...(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.adminEmail.trim())
        ? {}
        : { adminEmail: 'Enter an email address such as ama@example.com.' }),
    };
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setPending(true);
    try {
      const input = {
        kind: draft.kind,
        name: draft.name.trim(),
        ...(draft.legalName.trim() ? { legalName: draft.legalName.trim() } : {}),
        timeZone: draft.timeZone.trim(),
        tier: draft.tier,
        ...(trial?.value !== null && trial?.value !== undefined ? { trialDays: trial.value } : {}),
        adminName: draft.adminName.trim(),
        adminEmail: draft.adminEmail.trim(),
      };
      const content = JSON.stringify(input);
      if (keyedFor.current !== content) {
        keeper.reset();
        keyedFor.current = content;
      }
      // BE-20: one onboarding per form, however often it is sent.
      const created = await sendOnce(keeper, (key) =>
        keyedApi(key).platformAdmin.createCompany(input),
      );
      router.push(`/platform/companies/${created.company.id}?created=1`);
    } catch (failure) {
      setProblem(subscriptionMessage(failure) ?? toProblem(failure).message);
      if (isKeyReused(failure)) {
        keeper.reset();
        keyedFor.current = null;
      }
      setPending(false);
    }
  }

  if (!open)
    return (
      <div>
        <Button onClick={() => setOpen(true)}>Onboard a company</Button>
      </div>
    );

  return (
    <Card>
      <CardHeader
        title="Onboard a company"
        description="It starts on a free trial; the first admin gets an email to set a password and two-step sign-in."
      />
      <CardBody>
        <form
          aria-label="Onboard a company"
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => void submit(event)}
        >
          <SelectField
            label="Kind"
            value={draft.kind}
            options={[
              { value: 'landlord', label: 'Landlord' },
              { value: 'agency', label: 'Agency' },
            ]}
            onChange={(event) => set('kind')(event.target.value)}
          />
          <TextField
            label="Name"
            value={draft.name}
            maxLength={200}
            onChange={(event) => set('name')(event.target.value)}
            error={errors.name}
          />
          <TextField
            label="Legal name (optional)"
            value={draft.legalName}
            maxLength={200}
            onChange={(event) => set('legalName')(event.target.value)}
          />
          <TextField
            label="Time zone"
            value={draft.timeZone}
            maxLength={60}
            onChange={(event) => set('timeZone')(event.target.value)}
            error={errors.timeZone}
          />
          <SelectField
            label="Plan"
            value={draft.tier}
            options={TIERS.map((tier) => ({ value: tier, label: tierLabel(tier) }))}
            onChange={(event) => set('tier')(event.target.value)}
          />
          <TextField
            label="Free trial in days (optional)"
            hint="Blank uses the trial length in the terms."
            inputMode="numeric"
            value={draft.trialDays}
            onChange={(event) => set('trialDays')(event.target.value)}
            error={errors.trialDays}
          />
          <TextField
            label="First admin’s name"
            value={draft.adminName}
            maxLength={200}
            onChange={(event) => set('adminName')(event.target.value)}
            error={errors.adminName}
          />
          <TextField
            label="First admin’s email"
            type="email"
            value={draft.adminEmail}
            onChange={(event) => set('adminEmail')(event.target.value)}
            error={errors.adminEmail}
          />
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button type="submit" pending={pending}>
              Create the company
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
