'use client';

import type { CompanyProfile } from '@rent/contracts';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { SelectField, TextField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { formatIntegerList, parseInteger, parseIntegerList } from '@/lib/integers';

type Settings = CompanyProfile['settings'];
type Policy = Settings['advanceRentPolicy'];

const POLICIES: readonly { value: Policy; label: string; detail: string }[] = [
  {
    value: 'off',
    label: 'Off',
    detail: 'Advance rent is recorded without any check against the limit.',
  },
  {
    value: 'warn',
    label: 'Warn',
    detail:
      'A residential advance over the limit is recorded, flagged on the lease and listed in compliance reports. It is never described as compliant.',
  },
  {
    value: 'block',
    label: 'Block',
    detail: 'A residential advance over the limit cannot be recorded.',
  },
];

interface Values {
  rentReminderOffsetsDays: string;
  noticeReminderOffsetsHours: string;
  renewalReminderDays: string;
  advanceRentPolicy: Policy;
  approvalExpiryDays: string;
  approvalCoolingOffHours: string;
}

type Errors = Partial<Record<keyof Values, string>>;

const toValues = (s: Settings): Values => ({
  rentReminderOffsetsDays: formatIntegerList(s.rentReminderOffsetsDays),
  noticeReminderOffsetsHours: formatIntegerList(s.noticeReminderOffsetsHours),
  renewalReminderDays: formatIntegerList(s.renewalReminderDays),
  advanceRentPolicy: s.advanceRentPolicy,
  approvalExpiryDays: String(s.approvalExpiryDays),
  approvalCoolingOffHours: String(s.approvalCoolingOffHours),
});

// The bounds the API applies (packages/domain/settings), checked here for quicker feedback.
function list(text: string, errors: Errors, key: keyof Values): number[] {
  const values = parseIntegerList(text);
  if (!values || values.length > 12)
    errors[key] = 'Enter 1 to 12 whole numbers, separated by commas.';
  return values ?? [];
}

function whole(text: string, min: number, max: number, errors: Errors, key: keyof Values): number {
  const value = parseInteger(text);
  if (value === null || value < min || value > max)
    errors[key] = `Enter a whole number from ${min} to ${max}.`;
  return value ?? 0;
}

function parse(values: Values): { settings: Settings; errors: Errors } {
  const errors: Errors = {};
  const settings: Settings = {
    rentReminderOffsetsDays: list(
      values.rentReminderOffsetsDays,
      errors,
      'rentReminderOffsetsDays',
    ),
    noticeReminderOffsetsHours: list(
      values.noticeReminderOffsetsHours,
      errors,
      'noticeReminderOffsetsHours',
    ),
    renewalReminderDays: list(values.renewalReminderDays, errors, 'renewalReminderDays'),
    advanceRentPolicy: values.advanceRentPolicy,
    approvalExpiryDays: whole(values.approvalExpiryDays, 1, 90, errors, 'approvalExpiryDays'),
    approvalCoolingOffHours: whole(
      values.approvalCoolingOffHours,
      24,
      24 * 7,
      errors,
      'approvalCoolingOffHours',
    ),
  };
  return { settings, errors };
}

/** Company settings: product choices with the PRD's defaults, not law (CLAUDE.md section 7). */
export function SettingsForm({
  company,
  canEdit,
}: {
  readonly company: CompanyProfile;
  readonly canEdit: boolean;
}) {
  const router = useRouter();
  const [values, setValues] = useState<Values>(() => toValues(company.settings));
  const [errors, setErrors] = useState<Errors>({});
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const set = <K extends keyof Values>(key: K, value: Values[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const { settings, errors: found } = parse(values);
    setErrors(found);
    setProblem(null);
    setSaved(false);
    if (Object.keys(found).length > 0) return;
    setPending(true);
    try {
      const updated = await api().company.updateSettings(settings);
      setValues(toValues(updated.settings));
      setSaved(true);
      router.refresh();
    } catch (failure) {
      setProblem(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  const policy = POLICIES.find((p) => p.value === values.advanceRentPolicy);

  return (
    <Card>
      <CardHeader
        title="Reminders and approvals"
        description="Product settings for this company. Each one starts with the platform's recommended default."
      />
      <CardBody>
        <form onSubmit={submit} className="space-y-4" noValidate>
          {problem ? <Alert tone="error">{problem}</Alert> : null}
          {saved ? <Alert tone="success">Settings saved.</Alert> : null}
          <fieldset disabled={!canEdit} className="space-y-4">
            <legend className="sr-only">Reminders and approvals</legend>
            <TextField
              label="Rent reminders (days from the due date)"
              hint="When tenants are reminded about rent. Negative numbers are days before the due date, 0 is the due date and positive numbers are days after it. Default: -7, 0, 3, 7, 14."
              value={values.rentReminderOffsetsDays}
              error={errors.rentReminderOffsetsDays}
              onChange={(event) => set('rentReminderOffsetsDays', event.target.value)}
            />
            <TextField
              label="Notice reminders (hours after issue)"
              hint="When a tenant who has not opened a notice is reminded about it. Default: 24, 72, 120, 168 (one to seven days)."
              value={values.noticeReminderOffsetsHours}
              error={errors.noticeReminderOffsetsHours}
              onChange={(event) => set('noticeReminderOffsetsHours', event.target.value)}
            />
            <TextField
              label="Renewal reminders (days before the lease ends)"
              hint="When you are reminded that a lease is coming to an end. Default: 90, 60, 30."
              value={values.renewalReminderDays}
              error={errors.renewalReminderDays}
              onChange={(event) => set('renewalReminderDays', event.target.value)}
            />
            <SelectField
              label="Advance rent over the limit"
              hint={`${policy?.detail ?? ''} The limit itself is set in the platform's legal rules, not here.`}
              value={values.advanceRentPolicy}
              options={POLICIES.map((p) => ({ value: p.value, label: p.label }))}
              onChange={(event) => {
                const next = POLICIES.find((p) => p.value === event.target.value);
                if (next) set('advanceRentPolicy', next.value);
              }}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="Approval requests expire after (days)"
                hint="A request nobody answers closes after this many days. 1 to 90."
                inputMode="numeric"
                value={values.approvalExpiryDays}
                error={errors.approvalExpiryDays}
                onChange={(event) => set('approvalExpiryDays', event.target.value)}
              />
              <TextField
                label="Cooling-off before self-confirmation (hours)"
                hint="A landlord who works alone can confirm their own request after this wait. At least 24 hours."
                inputMode="numeric"
                value={values.approvalCoolingOffHours}
                error={errors.approvalCoolingOffHours}
                onChange={(event) => set('approvalCoolingOffHours', event.target.value)}
              />
            </div>
          </fieldset>
          {canEdit ? (
            <Button type="submit" pending={pending}>
              Save settings
            </Button>
          ) : null}
        </form>
      </CardBody>
    </Card>
  );
}
