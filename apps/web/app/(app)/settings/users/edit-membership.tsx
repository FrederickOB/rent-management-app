'use client';

import { STAFF_ROLES, type MembershipRow } from '@rent/contracts';
import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CheckboxField, SelectField, TextAreaField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { roleLabel } from '@/lib/format';
import { changedFields } from '@/lib/patch';
import { buildScope, parseIds } from './scope';

type Role = MembershipRow['role'];

const ROLE_OPTIONS = STAFF_ROLES.map((role) => ({ value: role, label: roleLabel(role) }));
const ID_HINT = 'Each line must be an ID such as 019a3000-0000-7000-8000-000000000002.';

export interface EditMembershipProps {
  readonly row: MembershipRow;
  readonly onSaved: (message: string) => void;
  readonly onCancel: () => void;
}

/** Role, access scope and the nominated-approver flag. Every change is audited with before and after (AD-07). */
export function EditMembership({ row, onSaved, onCancel }: EditMembershipProps) {
  const [role, setRole] = useState<Role>(row.role);
  const [nominatedApprover, setNominatedApprover] = useState(row.nominatedApprover);
  const [owners, setOwners] = useState((row.scope.owners ?? []).join('\n'));
  const [properties, setProperties] = useState((row.scope.properties ?? []).join('\n'));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ owners?: string; properties?: string }>({});

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ownerIds = parseIds(owners);
    const propertyIds = parseIds(properties);
    setFieldErrors({
      ...(ownerIds ? {} : { owners: ID_HINT }),
      ...(propertyIds ? {} : { properties: ID_HINT }),
    });
    setError(null);
    if (!ownerIds || !propertyIds) return;

    const patch = changedFields(
      {
        role: row.role,
        nominatedApprover: row.nominatedApprover,
        scope: buildScope(row.scope.owners ?? [], row.scope.properties ?? []),
      },
      { role, nominatedApprover, scope: buildScope(ownerIds, propertyIds) },
    );
    if (Object.keys(patch).length === 0) {
      onCancel();
      return;
    }
    setPending(true);
    try {
      await api().memberships.update({ membershipId: row.membershipId, ...patch });
      onSaved(`Saved the changes for ${row.name}.`);
    } catch (failure) {
      setError(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-4 rounded-md border border-slate-200 bg-slate-50 p-4"
      aria-label={`Change ${row.name}`}
    >
      {error ? <Alert tone="error">{error}</Alert> : null}
      <SelectField
        label="Role"
        value={role}
        options={ROLE_OPTIONS}
        className="max-w-sm"
        onChange={(event) => {
          const next = STAFF_ROLES.find((r) => r === event.target.value);
          if (next) setRole(next);
        }}
      />
      <CheckboxField
        label="Nominated approver"
        hint="Can approve requests that need a second person."
        checked={nominatedApprover}
        onChange={(event) => setNominatedApprover(event.target.checked)}
      />
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-slate-800">Access</legend>
        <p className="text-sm text-slate-600">
          Leave both lists empty to give access to everything in this company. To limit access,
          paste one ID per line.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextAreaField
            label="Owners"
            rows={3}
            value={owners}
            error={fieldErrors.owners}
            onChange={(event) => setOwners(event.target.value)}
          />
          <TextAreaField
            label="Properties"
            rows={3}
            value={properties}
            error={fieldErrors.properties}
            onChange={(event) => setProperties(event.target.value)}
          />
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={pending}>
          Save changes
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
