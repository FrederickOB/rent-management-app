'use client';

import { DEFAULT_TIME_ZONE } from '@rent/domain/dates';
import { useCallback, useState, type FormEvent } from 'react';
import { Empty, LoadFailed, Loading } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { SelectField, TextAreaField, TextField } from '@/components/ui/field';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatBusinessDate, todayIn } from '@/lib/business-dates';
import { cn } from '@/lib/cn';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import {
  RULE_STATE_LABELS,
  ruleValueOf,
  ruleValueText,
  subscriptionMessage,
  VERIFICATION_LABELS,
} from '@/lib/subscription';
import { useLoad } from '@/lib/use-load';

type Status = keyof typeof VERIFICATION_LABELS;
const STATUS_TONES = { verified: 'green', from_prd: 'blue', unverified: 'amber' } as const;
const STATE_TONES = { in_force: 'green', superseded: 'neutral', future: 'blue' } as const;

export function RulesView({ canAdd }: { readonly canAdd: boolean }) {
  const load = useCallback(() => api().rules.history({}), []);
  const { state, reload } = useLoad(load);
  const [filter, setFilter] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const rows =
    state.status === 'ready'
      ? state.data.filter((row) => row.key.includes(filter.trim().toLowerCase()))
      : [];

  return (
    <>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {canAdd ? (
        <AddRule
          onAdded={(text) => {
            setNotice(text);
            reload();
          }}
        />
      ) : null}
      <TextField
        label="Find a key"
        hint="For example rent_tax or vat."
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        className="max-w-sm"
      />
      {state.status === 'loading' ? <Loading what="the rules" /> : null}
      {state.status === 'error' ? (
        <LoadFailed message={state.problem.message} onRetry={reload} />
      ) : null}
      {state.status === 'ready' && rows.length === 0 ? <Empty>No rule matches.</Empty> : null}
      {rows.length > 0 ? (
        <Card>
          <CardBody>
            <Table caption="Rules, newest first">
              <thead>
                <tr>
                  <Th>Key</Th>
                  <Th>Value</Th>
                  <Th>In force</Th>
                  <Th>Status</Th>
                  <Th>Source</Th>
                  <Th>Added</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    data-testid="rule-row"
                    data-status={row.verificationStatus}
                    className={cn(row.verificationStatus === 'unverified' && 'bg-amber-50')}
                  >
                    <Td className="font-mono text-xs break-all">
                      {row.country} {row.key}
                    </Td>
                    <Td className="font-mono text-xs break-all">{ruleValueText(row.value)}</Td>
                    <Td>
                      <span className="block">
                        {formatBusinessDate(row.effectiveFrom)}
                        {row.effectiveTo ? ` to ${formatBusinessDate(row.effectiveTo)}` : ' on'}
                      </span>
                      <Badge tone={STATE_TONES[row.state]}>{RULE_STATE_LABELS[row.state]}</Badge>
                    </Td>
                    <Td>
                      <Badge tone={STATUS_TONES[row.verificationStatus]}>
                        {VERIFICATION_LABELS[row.verificationStatus]}
                      </Badge>
                      {row.verifiedBy ? (
                        <span className="block text-xs text-slate-600">by {row.verifiedBy}</span>
                      ) : null}
                    </Td>
                    <Td className="text-xs">
                      {row.source}
                      {row.notes ? <span className="block text-slate-600">{row.notes}</span> : null}
                    </Td>
                    <Td className="text-xs">
                      {row.createdBy}, {formatTime(row.createdAt, 'UTC')}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardBody>
        </Card>
      ) : null}
    </>
  );
}

function AddRule({ onAdded }: { readonly onAdded: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({
    key: '',
    value: '',
    from: todayIn(DEFAULT_TIME_ZONE),
    to: '',
    source: '',
    status: 'unverified' as Status,
    verifiedBy: '',
    notes: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (field: keyof typeof draft) => (value: string) =>
    setDraft((d) => ({ ...d, [field]: value }));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProblem(null);
    const value = ruleValueOf(draft.value);
    const key = draft.key.trim();
    const next: Record<string, string> = {};
    if (!/^[a-z0-9_]+(\.[a-z0-9_*]+)+$/.test(key))
      next.key = 'A dotted key such as vat.platform_subscription.';
    if (value.problem) next.value = value.problem;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.from)) next.from = 'Choose a date.';
    if (draft.to && draft.to < draft.from) next.to = 'The end comes after the start.';
    if (draft.source.trim().length < 3) next.source = 'Say where the value comes from.';
    if (draft.status === 'verified' && !draft.verifiedBy.trim())
      next.verifiedBy = 'Say who verified it.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setPending(true);
    try {
      const added = await api().rules.add({
        country: 'GH',
        key,
        value: value.value,
        effectiveFrom: draft.from,
        ...(draft.to ? { effectiveTo: draft.to } : {}),
        source: draft.source.trim(),
        verificationStatus: draft.status,
        ...(draft.verifiedBy.trim() ? { verifiedBy: draft.verifiedBy.trim() } : {}),
        ...(draft.notes.trim() ? { notes: draft.notes.trim() } : {}),
      });
      setOpen(false);
      onAdded(
        `Added ${added.key} from ${formatBusinessDate(added.effectiveFrom)}, ${VERIFICATION_LABELS[added.verificationStatus].toLowerCase()}.`,
      );
    } catch (failure) {
      setProblem(subscriptionMessage(failure) ?? toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  if (!open)
    return (
      <div>
        <Button onClick={() => setOpen(true)}>Add a rule</Button>
      </div>
    );

  return (
    <Card>
      <CardHeader
        title="New rule"
        description="Never invent a legal, tax or regulatory value: if it is not confirmed, add it as unverified with its source, and staff see a warning where it is used."
      />
      <CardBody>
        <form
          aria-label="New rule"
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => void submit(event)}
        >
          <TextField
            label="Key"
            value={draft.key}
            onChange={(event) => set('key')(event.target.value)}
            error={errors.key}
          />
          <TextAreaField
            label="Value (JSON)"
            hint='A number such as 800, true or false, "text" in quotes, or an object.'
            rows={2}
            value={draft.value}
            onChange={(event) => set('value')(event.target.value)}
            error={errors.value}
          />
          <TextField
            label="From"
            type="date"
            value={draft.from}
            onChange={(event) => set('from')(event.target.value)}
            error={errors.from}
          />
          <TextField
            label="Until (optional)"
            type="date"
            value={draft.to}
            onChange={(event) => set('to')(event.target.value)}
            error={errors.to}
          />
          <TextField
            label="Source"
            value={draft.source}
            maxLength={500}
            onChange={(event) => set('source')(event.target.value)}
            error={errors.source}
          />
          <SelectField
            label="Status"
            value={draft.status}
            options={(Object.keys(VERIFICATION_LABELS) as Status[]).map((value) => ({
              value,
              label: VERIFICATION_LABELS[value],
            }))}
            onChange={(event) => set('status')(event.target.value)}
          />
          <TextField
            label="Verified by (optional unless verified)"
            value={draft.verifiedBy}
            maxLength={200}
            onChange={(event) => set('verifiedBy')(event.target.value)}
            error={errors.verifiedBy}
          />
          <TextField
            label="Notes (optional)"
            value={draft.notes}
            maxLength={1000}
            onChange={(event) => set('notes')(event.target.value)}
          />
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button type="submit" pending={pending}>
              Add the rule
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
