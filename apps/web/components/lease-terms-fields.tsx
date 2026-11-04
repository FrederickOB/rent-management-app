'use client';

import { BREAK_PARTIES, type LeaseUse } from '@rent/domain/tenancy';
import { useId } from 'react';
import {
  endAfterMonths,
  newKey,
  type BreakDraft,
  type TermsDraft,
  type TermsErrors,
} from '@/lib/lease-form';
import { BREAK_PARTY_LABELS, CYCLE_OPTIONS } from '@/lib/tenancy-format';
import { Button } from './ui/button';
import { CheckboxField, SelectField, TextField } from './ui/field';

const TERM_LENGTHS: readonly { months: number; label: string }[] = [
  { months: 6, label: '6 months' },
  { months: 12, label: '1 year' },
  { months: 24, label: '2 years' },
];

/**
 * The terms of a lease (TL-06; plan 4.6): dates, rent and cycle, the initial advance, deposit and
 * service charge, rent changes, a break clause and the contractual notice. Amounts are typed in
 * cedis; the form sends pesewas.
 */
export function LeaseTermsFields({
  draft,
  errors,
  onChange,
  useHint,
}: {
  readonly draft: TermsDraft;
  readonly errors: TermsErrors;
  readonly onChange: (next: TermsDraft) => void;
  /** What "from the unit" means for this unit, such as "residential". */
  readonly useHint?: string;
}) {
  const set = <K extends keyof TermsDraft>(key: K, value: TermsDraft[K]) =>
    onChange({ ...draft, [key]: value });
  const setBreak = (patch: Partial<BreakDraft>) =>
    draft.breakClause && onChange({ ...draft, breakClause: { ...draft.breakClause, ...patch } });
  // The rent-change and break-clause problems are shown once for their group, and each of the
  // group's inputs points to it, so assistive technology reads it with the field.
  const baseId = useId();
  const stepsErrorId = `${baseId}-steps-error`;
  const breakErrorId = `${baseId}-break-error`;
  const stepsTie = errors.steps ? { describedBy: stepsErrorId, invalid: true } : {};
  const breakTie = errors.breakClause ? { describedBy: breakErrorId, invalid: true } : {};

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="First day of the lease"
          type="date"
          value={draft.startDate}
          error={errors.startDate}
          onChange={(event) => set('startDate', event.target.value)}
        />
        <TextField
          label="Last day of the lease"
          type="date"
          value={draft.endDate}
          error={errors.endDate}
          onChange={(event) => set('endDate', event.target.value)}
        />
      </div>
      {draft.startDate ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-slate-600">Set the end for a term of</span>
          {TERM_LENGTHS.map((length) => (
            <Button
              key={length.months}
              size="sm"
              variant="secondary"
              onClick={() => set('endDate', endAfterMonths(draft.startDate, length.months))}
            >
              {length.label}
            </Button>
          ))}
        </div>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Monthly rent (GH₵)"
          hint="Rent periods are monthly from the first day, whatever the billing cycle."
          inputMode="decimal"
          autoComplete="off"
          value={draft.monthlyRent}
          error={errors.monthlyRent}
          onChange={(event) => set('monthlyRent', event.target.value)}
        />
        <SelectField
          label="Billing cycle"
          value={draft.cycle}
          error={errors.cycle}
          options={CYCLE_OPTIONS}
          onChange={(event) => {
            const cycle = CYCLE_OPTIONS.find((c) => c.value === event.target.value)?.value;
            if (cycle) set('cycle', cycle);
          }}
        />
        <TextField
          label="Initial advance in months (optional)"
          hint="How many months the first invoice covers, such as 12. Blank: one billing cycle."
          inputMode="numeric"
          value={draft.initialAdvanceMonths}
          error={errors.initialAdvanceMonths}
          onChange={(event) =>
            set('initialAdvanceMonths', event.target.value.replace(/\D/g, '').slice(0, 3))
          }
        />
        <TextField
          label="Security deposit (GH₵, optional)"
          hint="Held as a deposit, never as rent."
          inputMode="decimal"
          autoComplete="off"
          value={draft.deposit}
          error={errors.deposit}
          onChange={(event) => set('deposit', event.target.value)}
        />
        <TextField
          label="Service charge a month (GH₵, optional)"
          inputMode="decimal"
          autoComplete="off"
          value={draft.serviceCharge}
          error={errors.serviceCharge}
          onChange={(event) => set('serviceCharge', event.target.value)}
        />
        <TextField
          label="Notice period (days)"
          hint="The notice the lease itself asks for."
          inputMode="numeric"
          value={draft.noticeDays}
          error={errors.noticeDays}
          onChange={(event) => set('noticeDays', event.target.value.replace(/\D/g, '').slice(0, 4))}
        />
        <SelectField
          label="Use"
          value={draft.use}
          error={errors.use}
          options={[
            { value: '', label: useHint ? `From the unit (${useHint})` : 'From the unit' },
            { value: 'residential', label: 'Residential' },
            { value: 'commercial', label: 'Commercial' },
          ]}
          onChange={(event) => {
            const value = event.target.value;
            set(
              'use',
              value === 'residential' || value === 'commercial' ? (value as LeaseUse) : '',
            );
          }}
        />
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-slate-800">Rent changes (optional)</legend>
        <p className="text-sm text-slate-600">
          Each change starts on the first day of a rent period, after the start of the lease.
        </p>
        {errors.steps ? (
          <p id={stepsErrorId} className="text-sm font-medium text-red-700">
            {errors.steps}
          </p>
        ) : null}
        {draft.steps.map((step, index) => (
          <div
            key={step.key}
            role="group"
            aria-label={`Rent change ${index + 1}`}
            className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]"
          >
            <TextField
              label="From"
              type="date"
              value={step.effectiveFrom}
              {...stepsTie}
              onChange={(event) =>
                set(
                  'steps',
                  draft.steps.map((s) =>
                    s.key === step.key ? { ...s, effectiveFrom: event.target.value } : s,
                  ),
                )
              }
            />
            <TextField
              label="New monthly rent (GH₵)"
              inputMode="decimal"
              value={step.monthlyRent}
              {...stepsTie}
              onChange={(event) =>
                set(
                  'steps',
                  draft.steps.map((s) =>
                    s.key === step.key ? { ...s, monthlyRent: event.target.value } : s,
                  ),
                )
              }
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                set(
                  'steps',
                  draft.steps.filter((s) => s.key !== step.key),
                )
              }
            >
              Remove
            </Button>
          </div>
        ))}
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            set('steps', [
              ...draft.steps,
              { key: newKey('step'), effectiveFrom: '', monthlyRent: '' },
            ])
          }
        >
          Add a rent change
        </Button>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-slate-800">Break clause</legend>
        <CheckboxField
          label="The lease has a break clause"
          checked={draft.breakClause !== null}
          onChange={(event) =>
            set(
              'breakClause',
              event.target.checked
                ? { fromDate: '', party: 'either', noticeDays: '30', creditUnusedDays: false }
                : null,
            )
          }
        />
        {errors.breakClause ? (
          <p id={breakErrorId} className="text-sm font-medium text-red-700">
            {errors.breakClause}
          </p>
        ) : null}
        {draft.breakClause ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <TextField
              label="Can break from"
              type="date"
              value={draft.breakClause.fromDate}
              {...breakTie}
              onChange={(event) => setBreak({ fromDate: event.target.value })}
            />
            <SelectField
              label="Who may break"
              value={draft.breakClause.party}
              options={BREAK_PARTIES.map((p) => ({ value: p, label: BREAK_PARTY_LABELS[p] }))}
              {...breakTie}
              onChange={(event) => {
                const party = BREAK_PARTIES.find((p) => p === event.target.value);
                if (party) setBreak({ party });
              }}
            />
            <TextField
              label="Break notice (days)"
              inputMode="numeric"
              value={draft.breakClause.noticeDays}
              {...breakTie}
              onChange={(event) =>
                setBreak({ noticeDays: event.target.value.replace(/\D/g, '').slice(0, 4) })
              }
            />
            <CheckboxField
              className="sm:col-span-3"
              label="Credit the unused days of the month on an early exit"
              checked={draft.breakClause.creditUnusedDays}
              onChange={(event) => setBreak({ creditUnusedDays: event.target.checked })}
            />
          </div>
        ) : null}
      </fieldset>
    </div>
  );
}
