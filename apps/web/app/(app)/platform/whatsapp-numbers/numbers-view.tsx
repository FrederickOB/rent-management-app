'use client';

import type { CompanyPlan, WhatsAppNumber } from '@rent/contracts';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { ConfirmBox } from '@/components/confirm-box';
import { Empty, Loading } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { SelectField, TextField } from '@/components/ui/field';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import {
  EMPTY_NUMBER,
  numberErrors,
  numberInput,
  type NumberDraft,
} from '@/lib/platform-messaging';

export function NumbersView() {
  const { timeZone } = useApp();
  const [numbers, setNumbers] = useState<readonly WhatsAppNumber[] | null>(null);
  const [companies, setCompanies] = useState<readonly CompanyPlan[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retiring, setRetiring] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, plans] = await Promise.all([
        api().platformMessaging.whatsappNumbers(),
        api()
          .platformMessaging.companyPlans()
          .catch(() => []),
      ]);
      setNumbers(list);
      setCompanies(plans);
      setProblem(null);
    } catch (failure) {
      setProblem(toProblem(failure).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function retire(number: WhatsAppNumber) {
    setBusy(true);
    try {
      await api().platformMessaging.retireWhatsappNumber({ numberId: number.id });
      setRetiring(null);
      setNotice(`Retired ${number.displayPhone}.`);
      await load();
    } catch (failure) {
      setProblem(toProblem(failure).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <RegisterNumber
        companies={companies}
        onSaved={async (number) => {
          setNotice(`Registered ${number.displayPhone}.`);
          await load();
        }}
      />
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <Card>
        <CardHeader title="Numbers" />
        <CardBody>
          {problem ? <Alert tone="error">{problem}</Alert> : null}
          {numbers === null && !problem ? <Loading what="numbers" /> : null}
          {numbers?.length === 0 ? <Empty>No number is registered yet.</Empty> : null}
          {numbers?.length ? (
            <Table caption="WhatsApp numbers">
              <thead>
                <tr>
                  <Th>Number</Th>
                  <Th>For</Th>
                  <Th>Meta IDs</Th>
                  <Th>Status</Th>
                  <Th>
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {numbers.map((number) => (
                  <tr key={number.id} data-testid="number-row">
                    <Td>
                      <p className="font-medium">{number.displayPhone}</p>
                      <p className="text-xs text-slate-600">{number.displayName}</p>
                    </Td>
                    <Td>
                      {number.kind === 'shared'
                        ? 'Shared by every company without its own'
                        : (number.company?.name ?? 'A company')}
                    </Td>
                    <Td className="font-mono text-xs">
                      <p>Phone {number.phoneNumberId}</p>
                      <p>Account {number.wabaId}</p>
                    </Td>
                    <Td>
                      <Badge tone={number.status === 'active' ? 'green' : 'dark'}>
                        {number.status === 'active' ? 'Active' : 'Retired'}
                      </Badge>
                      <p className="text-xs text-slate-600">
                        Added {formatTime(number.createdAt, timeZone)}
                      </p>
                    </Td>
                    <Td>
                      {number.status === 'active' && retiring !== number.id ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Retire ${number.displayPhone}`}
                          onClick={() => setRetiring(number.id)}
                        >
                          Retire
                        </Button>
                      ) : null}
                      {retiring === number.id ? (
                        <ConfirmBox
                          label={`Confirm retiring ${number.displayPhone}`}
                          confirmText="Retire number"
                          pending={busy}
                          onConfirm={() => void retire(number)}
                          onCancel={() => setRetiring(null)}
                        >
                          Stop sending from {number.displayPhone}?
                        </ConfirmBox>
                      ) : null}
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

function RegisterNumber({
  companies,
  onSaved,
}: {
  readonly companies: readonly CompanyPlan[];
  readonly onSaved: (number: WhatsAppNumber) => Promise<void>;
}) {
  const [draft, setDraft] = useState<NumberDraft>(EMPTY_NUMBER);
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errors = tried ? numberErrors(draft) : {};
  const set = <K extends keyof NumberDraft>(key: K, value: NumberDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    if (Object.keys(numberErrors(draft)).length) return;
    setPending(true);
    try {
      const number = await api().platformMessaging.registerWhatsappNumber(numberInput(draft));
      setDraft(EMPTY_NUMBER);
      setTried(false);
      await onSaved(number);
    } catch (failure) {
      setError(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Register a number"
        description="From the number’s page in Meta’s WhatsApp Manager. The company’s WhatsApp account must be shared with the platform’s business first."
      />
      <CardBody>
        <form onSubmit={submit} noValidate aria-label="Register a number" className="space-y-4">
          <SelectField
            label="Kind"
            value={draft.kind}
            options={[
              { value: 'company', label: 'A company’s own number' },
              { value: 'shared', label: 'The shared platform number' },
            ]}
            onChange={(event) => set('kind', event.target.value as NumberDraft['kind'])}
          />
          {draft.kind === 'company' ? (
            <SelectField
              label="Company"
              value={draft.companyId}
              error={errors.companyId}
              options={[
                { value: '', label: 'Choose a company' },
                ...companies.map((c) => ({ value: c.companyId, label: c.displayName })),
              ]}
              onChange={(event) => set('companyId', event.target.value)}
            />
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Number"
              hint="International form, such as +233302000000."
              value={draft.displayPhone}
              error={errors.displayPhone}
              onChange={(event) => set('displayPhone', event.target.value)}
            />
            <TextField
              label="Name tenants see"
              value={draft.displayName}
              error={errors.displayName}
              onChange={(event) => set('displayName', event.target.value)}
            />
            <TextField
              label="Phone number ID"
              inputMode="numeric"
              value={draft.phoneNumberId}
              error={errors.phoneNumberId}
              onChange={(event) => set('phoneNumberId', event.target.value)}
            />
            <TextField
              label="WhatsApp Business Account ID"
              inputMode="numeric"
              value={draft.wabaId}
              error={errors.wabaId}
              onChange={(event) => set('wabaId', event.target.value)}
            />
          </div>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <Button type="submit" pending={pending}>
            Register the number
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
