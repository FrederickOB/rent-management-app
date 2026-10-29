'use client';

import type { CompanyProfile } from '@rent/contracts';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { TextField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { isHexColour, textOn } from '@/lib/colour';
import { toProblem } from '@/lib/errors';
import { ColourField } from './colour-field';

interface Values {
  displayName: string;
  senderName: string;
  primaryColour: string;
  accentColour: string;
}

type Errors = Partial<Record<keyof Values, string>>;

function check(values: Values): Errors {
  const errors: Errors = {};
  const name = values.displayName.trim();
  if (name.length < 2 || name.length > 80) errors.displayName = 'Use 2 to 80 characters.';
  const sender = values.senderName.trim();
  if (sender.length < 2 || sender.length > 40) errors.senderName = 'Use 2 to 40 characters.';
  if (!isHexColour(values.primaryColour))
    errors.primaryColour = 'Use a hex colour such as #0F766E.';
  if (!isHexColour(values.accentColour)) errors.accentColour = 'Use a hex colour such as #F59E0B.';
  return errors;
}

/** Company profile and branding (AD-01). Saving refreshes the shell, which shows the new look. */
export function BrandingForm({
  company,
  canEdit,
}: {
  readonly company: CompanyProfile;
  readonly canEdit: boolean;
}) {
  const router = useRouter();
  const [values, setValues] = useState<Values>({
    displayName: company.displayName,
    senderName: company.branding.senderName,
    primaryColour: company.branding.primaryColour,
    accentColour: company.branding.accentColour,
  });
  const [errors, setErrors] = useState<Errors>({});
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const set = (key: keyof Values) => (value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found = check(values);
    setErrors(found);
    setProblem(null);
    setSaved(false);
    if (Object.keys(found).length > 0) return;
    setPending(true);
    try {
      await api().company.updateBranding({
        displayName: values.displayName.trim(),
        senderName: values.senderName.trim(),
        primaryColour: values.primaryColour.toUpperCase(),
        accentColour: values.accentColour.toUpperCase(),
      });
      setSaved(true);
      router.refresh();
    } catch (failure) {
      setProblem(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  const previewPrimary = isHexColour(values.primaryColour)
    ? values.primaryColour
    : company.branding.primaryColour;

  return (
    <Card>
      <CardHeader
        title="Profile and branding"
        description="Shown at the top of every page, on documents and in emails. The sender name is how messages and documents are signed."
      />
      <CardBody>
        <form onSubmit={submit} className="space-y-4" noValidate>
          {problem ? <Alert tone="error">{problem}</Alert> : null}
          {saved ? <Alert tone="success">Branding saved.</Alert> : null}
          <fieldset disabled={!canEdit} className="grid gap-4 sm:grid-cols-2">
            <legend className="sr-only">Profile and branding</legend>
            <TextField
              label="Display name"
              maxLength={80}
              value={values.displayName}
              error={errors.displayName}
              onChange={(event) => set('displayName')(event.target.value)}
            />
            <TextField
              label="Sender name"
              maxLength={40}
              hint="Up to 40 characters."
              value={values.senderName}
              error={errors.senderName}
              onChange={(event) => set('senderName')(event.target.value)}
            />
            <ColourField
              label="Primary colour"
              hint="The header and main buttons."
              value={values.primaryColour}
              error={errors.primaryColour}
              disabled={!canEdit}
              onChange={set('primaryColour')}
            />
            <ColourField
              label="Accent colour"
              hint="Highlights, such as the badge shown without a logo."
              value={values.accentColour}
              error={errors.accentColour}
              disabled={!canEdit}
              onChange={set('accentColour')}
            />
          </fieldset>
          <div className="space-y-1">
            <p className="text-sm font-medium text-slate-800">Preview</p>
            <div
              className="rounded-md px-4 py-3 text-sm font-semibold"
              style={{ backgroundColor: previewPrimary, color: textOn(previewPrimary) }}
            >
              {values.displayName.trim() || company.displayName}
            </div>
          </div>
          <p className="text-sm text-slate-600">
            Legal name: {company.legalName}. Time zone: {company.timeZone}. Currency:{' '}
            {company.currency}.
          </p>
          {canEdit ? (
            <Button type="submit" pending={pending}>
              Save branding
            </Button>
          ) : null}
        </form>
      </CardBody>
    </Card>
  );
}
