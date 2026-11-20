'use client';

import { STAFF_ROLES, type MembershipRow } from '@rent/contracts';
import type { CompanyKind } from '@rent/domain/policy';
import { useState, type FormEvent } from 'react';
import { MultiSelect, type MultiSelectOption } from '@/components/multi-select';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CheckboxField, SelectField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { membershipSavedText } from '@/lib/membership-approval';
import { roleLabel } from '@/lib/format';
import { changedFields } from '@/lib/patch';
import {
  buildScope,
  scopePickersFor,
  scopeProblems,
  scopeRefusal,
  scopeToSave,
  type PickerNeed,
} from './scope';

type Role = MembershipRow['role'];

const ROLE_OPTIONS = STAFF_ROLES.map((role) => ({ value: role, label: roleLabel(role) }));

/** Owners and properties to choose from; null when this session may not list them. */
export interface ScopeOptions {
  readonly owners: readonly MultiSelectOption[] | null;
  readonly properties: readonly MultiSelectOption[] | null;
}

export interface EditMembershipProps {
  readonly row: MembershipRow;
  readonly companyKind: CompanyKind;
  readonly scopeOptions: ScopeOptions;
  readonly onSaved: (message: string, approvals: boolean) => void;
  readonly onCancel: () => void;
}

const HINTS: Record<'owners' | 'properties', Record<Exclude<PickerNeed, 'hidden'>, string>> = {
  owners: {
    required:
      'They see the properties of the owners chosen here, and nothing else. Choose at least one.',
    optional: 'Limit them to these owners’ properties.',
  },
  properties: {
    required: 'They see only the properties chosen here. Choose at least one.',
    optional: 'Limit them to these properties (added to any owners above).',
  },
};

/** Role, access scope and the nominated-approver flag. Every change is audited with before and after (AD-07). */
export function EditMembership({
  row,
  companyKind,
  scopeOptions,
  onSaved,
  onCancel,
}: EditMembershipProps) {
  const [role, setRole] = useState<Role>(row.role);
  const [nominatedApprover, setNominatedApprover] = useState(row.nominatedApprover);
  // M8 (decision 5): recorded as a consent of its own, not with the role.
  const [whatsappConsent, setWhatsappConsent] = useState(row.whatsappConsent ?? false);
  const [owners, setOwners] = useState<string[]>([...(row.scope.owners ?? [])]);
  const [properties, setProperties] = useState<string[]>([...(row.scope.properties ?? [])]);
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A list the API refused (AD-02): its message shows next to that list until something changes.
  const [refused, setRefused] = useState<{ list: 'owners' | 'properties'; message: string } | null>(
    null,
  );

  // Which lists the chosen role uses comes from the policy module (AD-02), not from this form.
  const pickers = scopePickersFor(role, companyKind);
  const problems = scopeProblems(pickers, owners, properties);
  const optionalOnly = pickers.owners !== 'required' && pickers.properties !== 'required';
  const listError = (list: 'owners' | 'properties') =>
    (tried ? problems[list] : undefined) ?? (refused?.list === list ? refused.message : undefined);
  const changed =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setRefused(null);
    };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    setRefused(null);
    if (problems.owners || problems.properties) return;

    const patch = changedFields(
      {
        role: row.role,
        nominatedApprover: row.nominatedApprover,
        scope: buildScope(row.scope.owners ?? [], row.scope.properties ?? []),
      },
      { role, nominatedApprover, scope: scopeToSave(pickers, owners, properties) },
    );
    const consentChanged = whatsappConsent !== (row.whatsappConsent ?? false);
    if (Object.keys(patch).length === 0 && !consentChanged) {
      onCancel();
      return;
    }
    setPending(true);
    try {
      const updated =
        Object.keys(patch).length > 0
          ? await api().memberships.update({ membershipId: row.membershipId, ...patch })
          : null;
      if (consentChanged)
        await api().memberships.whatsappConsent({
          membershipId: row.membershipId,
          granted: whatsappConsent,
        });
      // Founder D1: a promotion or a nomination may wait for a second person.
      const saved = membershipSavedText({
        name: row.name,
        approvalRequestId: updated?.approvalRequestId,
        kind: 'change',
      });
      onSaved(saved.text, saved.approvals);
    } catch (failure) {
      // The API checks the scope against the role the person will have; place its answer where
      // it can be acted on.
      const problem = toProblem(failure);
      const place = scopeRefusal(problem.code);
      if ((place === 'owners' || place === 'properties') && pickers[place] !== 'hidden')
        setRefused({ list: place, message: problem.message });
      else if (place === 'unknown')
        setError(
          `${problem.message.replace(/\.$/, '')}. Untick anything marked “Not in the list”, then save again.`,
        );
      else setError(problem.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
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
          if (next) changed(setRole)(next);
        }}
      />
      <CheckboxField
        label="Nominated approver"
        hint="Can approve requests that need a second person."
        checked={nominatedApprover}
        onChange={(event) => setNominatedApprover(event.target.checked)}
      />
      <CheckboxField
        label="Agreed to emergency repair alerts on WhatsApp"
        hint="Only with their say-so; each change is kept as a consent record. SMS alerts go to staff phones anyway."
        checked={whatsappConsent}
        onChange={(event) => setWhatsappConsent(event.target.checked)}
      />
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-slate-800">Access</legend>
        <p className="text-sm text-slate-600">
          {optionalOnly
            ? 'Leave both lists empty to give access to everything in this company.'
            : `As ${roleLabel(role).toLowerCase()}, they see only what is chosen here.`}
        </p>
        <div className="grid gap-4 lg:grid-cols-2">
          {pickers.owners !== 'hidden' ? (
            <MultiSelect
              legend={pickers.owners === 'required' ? 'Owners' : 'Owners (optional)'}
              hint={HINTS.owners[pickers.owners]}
              options={scopeOptions.owners ?? []}
              emptyText={
                scopeOptions.owners ? 'There are no owners yet.' : 'You cannot list owners here.'
              }
              value={owners}
              error={listError('owners')}
              onChange={changed(setOwners)}
            />
          ) : null}
          {pickers.properties !== 'hidden' ? (
            <MultiSelect
              legend={pickers.properties === 'required' ? 'Properties' : 'Properties (optional)'}
              hint={HINTS.properties[pickers.properties]}
              options={scopeOptions.properties ?? []}
              emptyText={
                scopeOptions.properties
                  ? 'There are no properties yet.'
                  : 'You cannot list properties here.'
              }
              value={properties}
              error={listError('properties')}
              onChange={changed(setProperties)}
            />
          ) : null}
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
