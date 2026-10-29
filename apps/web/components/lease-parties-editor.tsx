'use client';

import { SIGNER_ROLES, type SignerRole } from '@rent/domain/esign';
import { useState } from 'react';
import { emptyParty, type PartyDraft, type PartyErrors } from '@/lib/lease-form';
import { signerRoleLabel } from '@/lib/tenancy-format';
import { Button } from './ui/button';
import { CheckboxField, SelectField, TextField } from './ui/field';

/**
 * The people who sign a lease (plan 4.8): the tenant or a company's signatories, the landlord's
 * signatory, a guarantor and the witness. On a paper lease, each one's signing date (decision 7).
 */
export function LeasePartiesEditor({
  parties,
  errors,
  onChange,
  paper = false,
}: {
  readonly parties: readonly PartyDraft[];
  readonly errors: PartyErrors;
  readonly onChange: (next: PartyDraft[]) => void;
  readonly paper?: boolean;
}) {
  const [role, setRole] = useState<SignerRole>('witness');
  const update = (key: string, patch: Partial<PartyDraft>) =>
    onChange(parties.map((p) => (p.key === key ? { ...p, ...patch } : p)));

  return (
    <div className="space-y-4">
      {parties.length === 0 ? (
        <p className="text-sm text-slate-600">Nobody yet. Add the people who sign.</p>
      ) : null}
      <ol className="space-y-4">
        {parties.map((party, index) => (
          <li
            key={party.key}
            data-testid="party-row"
            className="space-y-3 rounded-md border border-slate-200 p-3"
          >
            <div
              role="group"
              aria-label={`Signer ${index + 1}`}
              className="grid gap-3 sm:grid-cols-2"
            >
              <SelectField
                label="Signs as"
                value={party.role}
                options={SIGNER_ROLES.map((r) => ({ value: r, label: signerRoleLabel(r) }))}
                onChange={(event) => {
                  const next = SIGNER_ROLES.find((r) => r === event.target.value);
                  if (next) update(party.key, { role: next });
                }}
              />
              <TextField
                label="Name"
                maxLength={160}
                value={party.name}
                onChange={(event) => update(party.key, { name: event.target.value })}
              />
              <TextField
                label="Phone (optional)"
                type="tel"
                autoComplete="off"
                value={party.phone}
                onChange={(event) => update(party.key, { phone: event.target.value })}
              />
              <TextField
                label="Email (optional)"
                type="email"
                autoComplete="off"
                value={party.email}
                onChange={(event) => update(party.key, { email: event.target.value })}
              />
              {paper ? (
                <TextField
                  label="Signed on (optional)"
                  hint="Blank: the date the lease was signed."
                  type="date"
                  value={party.paperSignedOn}
                  onChange={(event) => update(party.key, { paperSignedOn: event.target.value })}
                />
              ) : (
                <CheckboxField
                  label="Must sign before the lease takes effect"
                  checked={party.required}
                  onChange={(event) => update(party.key, { required: event.target.checked })}
                />
              )}
            </div>
            {errors[party.key] ? (
              <p className="text-sm font-medium text-red-700">{errors[party.key]}</p>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Remove signer ${index + 1}`}
              onClick={() => onChange(parties.filter((p) => p.key !== party.key))}
            >
              Remove
            </Button>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-end gap-2">
        <SelectField
          label="Add someone who signs as"
          value={role}
          options={SIGNER_ROLES.map((r) => ({ value: r, label: signerRoleLabel(r) }))}
          onChange={(event) => {
            const next = SIGNER_ROLES.find((r) => r === event.target.value);
            if (next) setRole(next);
          }}
        />
        <Button variant="secondary" onClick={() => onChange([...parties, emptyParty(role)])}>
          Add signer
        </Button>
      </div>
    </div>
  );
}
