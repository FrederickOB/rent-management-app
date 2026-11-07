'use client';

import { STAFF_ROLES } from '@rent/contracts';
import { requiresPasswordAndTotp, type StaffRole } from '@rent/domain/policy';
import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CheckboxField, SelectField, TextField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { roleLabel } from '@/lib/format';

const ROLE_OPTIONS = STAFF_ROLES.map((role) => ({ value: role, label: roleLabel(role) }));

export interface InviteFormProps {
  readonly onInvited: (message: string) => void;
  readonly onCancel: () => void;
}

/**
 * Adds someone to the company (AD-03). Roles that sign in with a password get a set-password
 * email; the others (caretakers) sign in with a phone code, so they need a phone number.
 */
export function InviteForm({ onInvited, onCancel }: InviteFormProps) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<StaffRole>('property_manager');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [nominatedApprover, setNominatedApprover] = useState(false);
  const [whatsappConsent, setWhatsappConsent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Which sign-in a role uses comes from the policy module, the same rule the API applies.
  const byEmail = requiresPasswordAndTotp(role);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const added = await api().memberships.invite({
        name: name.trim(),
        role,
        nominatedApprover,
        whatsappConsent,
        ...(byEmail ? { email: email.trim() } : { phone: phone.trim() }),
      });
      onInvited(
        byEmail
          ? `Invitation sent. ${added.name} will get an email with a link to set a password, then sets up two-step sign-in.`
          : `${added.name} is added and signs in with a code sent to their phone.`,
      );
    } catch (failure) {
      setError(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" aria-label="Invite someone">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Full name"
          required
          minLength={2}
          maxLength={120}
          autoComplete="off"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <SelectField
          label="Role"
          value={role}
          options={ROLE_OPTIONS}
          onChange={(event) => {
            const next = STAFF_ROLES.find((r) => r === event.target.value);
            if (next) setRole(next);
          }}
        />
        {byEmail ? (
          <TextField
            label="Email address"
            type="email"
            required
            autoComplete="off"
            hint="They get a link to set their password."
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        ) : (
          <TextField
            label="Phone number"
            type="tel"
            required
            autoComplete="off"
            hint="They sign in with a code sent to this number, for example 024 123 4567 or +233 24 123 4567."
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />
        )}
      </div>
      <CheckboxField
        label="Nominated approver"
        hint="Can approve requests that need a second person, for example for a landlord who works alone."
        checked={nominatedApprover}
        onChange={(event) => setNominatedApprover(event.target.checked)}
      />
      <CheckboxField
        label="They agreed to emergency repair alerts on WhatsApp"
        hint="Tick only if they said yes. Emergency alerts also go by SMS to staff phones. They can change this from their own profile."
        checked={whatsappConsent}
        onChange={(event) => setWhatsappConsent(event.target.checked)}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={pending}>
          Send invitation
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
