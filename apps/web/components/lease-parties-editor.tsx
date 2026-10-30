'use client';

import { SIGNER_ROLES, type SignerRole } from '@rent/domain/esign';
import { useId, useState } from 'react';
import {
  canAddTenant,
  contactChoices,
  contactParts,
  contactSigner,
  emptyParty,
  mustSign,
  NO_RECORDS,
  partyLink,
  signerContact,
  signerContactLine,
  signsAs,
  STAFF_SIGNER_ROLES,
  staffChoices,
  staffSigner,
  tenantSigner,
  TYPED_SIGNER_ROLES,
  usualContactPart,
  type PartyDraft,
  type PartyField,
  type PartyLink,
  type PartyProblems,
  type SignerRecords,
} from '@/lib/lease-form';
import { CONTACT_KIND_LABELS, signerRoleLabel, type TenantKind } from '@/lib/tenancy-format';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { CheckboxField, SelectField, TextField } from './ui/field';

const LINK_SOURCES: Record<Exclude<PartyLink, null>, string> = {
  tenant_record: 'From the tenant’s record',
  contact: 'From their contact record',
  staff: 'From their staff record',
};

const roleOptions = (roles: readonly SignerRole[]) =>
  roles.map((r) => ({ value: r, label: signerRoleLabel(r) }));

/** A contact signing as the tenant is someone else who lives there, signing with the tenant. */
const contactPartOptions = (roles: readonly SignerRole[]) =>
  roles.map((r) => ({
    value: r,
    label: signsAs([{ role: r }], 'tenant')
      ? 'Tenant: someone who lives there too'
      : signerRoleLabel(r),
  }));

/**
 * The people who sign a lease (plan 4.8): the tenant or a company's signatories, the landlord's
 * signer, a guarantor and the witness. On a paper lease, each one's signing date (decision 7).
 *
 * On a draft for e-signing, a signer linked to a record (the tenant, one of the tenant's contacts
 * or a member of staff) gets their link and codes at the phone and email on that record, which is
 * what the API uses when the lease is sent: those details are shown, not typed, and the part they
 * sign in is fixed. Only someone not on record is typed in.
 */
export function LeasePartiesEditor({
  parties,
  problems,
  onChange,
  paper = false,
  records = NO_RECORDS,
  tenant = null,
  witnessRequired = false,
}: {
  readonly parties: readonly PartyDraft[];
  readonly problems: PartyProblems;
  readonly onChange: (next: PartyDraft[]) => void;
  readonly paper?: boolean;
  /** For a draft: the records signers can be linked to; each part is null when it could not be read. */
  readonly records?: SignerRecords;
  /** The lease's tenant, who signs as the tenant from their record. */
  readonly tenant?: { readonly name: string; readonly kind: TenantKind } | null;
  /** The draft asks for a witness, so a witness always signs. */
  readonly witnessRequired?: boolean;
}) {
  const baseId = useId();
  const [role, setRole] = useState<SignerRole>('witness');
  const [contactId, setContactId] = useState('');
  /** Null: the usual part for the contact chosen. */
  const [contactRole, setContactRole] = useState<SignerRole | null>(null);
  const [staffId, setStaffId] = useState('');
  const [staffRole, setStaffRole] = useState<SignerRole>(() =>
    signsAs(parties, 'landlord') ? 'witness' : 'landlord',
  );
  const update = (key: string, patch: Partial<PartyDraft>) =>
    onChange(parties.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  const add = (party: PartyDraft | null) => {
    if (party) onChange([...parties, party]);
  };

  const tenantKind = records.tenant?.kind ?? tenant?.kind ?? null;
  const contacts = paper ? [] : contactChoices(records, parties);
  const staff = paper ? [] : staffChoices(records, parties);
  const chosenContact = contacts.find((c) => c.id === contactId) ?? contacts[0];
  const chosenContactRole = chosenContact
    ? (contactRole ?? usualContactPart(chosenContact, tenantKind))
    : null;
  const chosenStaff = staff.find((s) => s.personId === staffId) ?? staff[0];
  const tenantCanSign = !paper && canAddTenant(tenantKind, parties);
  const typedRoles = paper ? SIGNER_ROLES : TYPED_SIGNER_ROLES;

  return (
    <div className="space-y-4">
      {!paper ? (
        <div className="space-y-1 text-sm text-slate-600">
          <p>
            The tenant, their contacts and your staff get their link and codes at the phone and
            email on their record. To change where those go, change the record.
          </p>
          <p>
            Only one signer signs as the tenant from the tenant&rsquo;s record. Anyone else who
            lives there is added as one of the tenant&rsquo;s contacts, then from the contacts
            below, so their link and codes go to their own phone. Staff sign for the landlord or as
            a witness.
          </p>
        </div>
      ) : null}
      {parties.length === 0 ? (
        <p className="text-sm text-slate-600">Nobody yet. Add the people who sign.</p>
      ) : null}
      <ol className="space-y-4">
        {parties.map((party, index) => {
          const link = paper ? null : partyLink(party);
          const problem = problems[party.key];
          const errorId = `${baseId}-${party.key}-error`;
          const tie = (field: PartyField) =>
            problem?.field === field ? { describedBy: errorId, invalid: true } : {};
          const locked = !paper && mustSign(party, witnessRequired);
          const required = paper ? null : (
            <CheckboxField
              label="Must sign before the lease takes effect"
              hint={
                locked
                  ? 'Always: the tenant, a signatory, the landlord’s signer, and the witness when the lease asks for one.'
                  : undefined
              }
              checked={party.required || locked}
              disabled={locked}
              onChange={(event) => update(party.key, { required: event.target.checked })}
            />
          );
          return (
            <li
              key={party.key}
              data-testid="party-row"
              className="space-y-3 rounded-md border border-slate-200 p-3"
            >
              {link ? (
                <div
                  role="group"
                  aria-label={`Signer ${index + 1}`}
                  aria-describedby={problem ? errorId : undefined}
                  className="space-y-3"
                >
                  <p className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium text-slate-900">{party.name}</span>
                    <Badge>{signerRoleLabel(party.role)}</Badge>
                    <span className="text-slate-600">{LINK_SOURCES[link]}</span>
                  </p>
                  <p className="text-sm">
                    <span className="text-slate-600">Link and codes go to: </span>
                    <span data-testid="party-contact" className="break-words text-slate-900">
                      {signerContactLine(signerContact(party, records))}
                    </span>
                  </p>
                  {required}
                </div>
              ) : (
                <div
                  role="group"
                  aria-label={`Signer ${index + 1}`}
                  className="grid gap-3 sm:grid-cols-2"
                >
                  <SelectField
                    label="Signs as"
                    value={party.role}
                    options={roleOptions(typedRoles)}
                    {...tie('role')}
                    onChange={(event) => {
                      const next = typedRoles.find((r) => r === event.target.value);
                      if (next) update(party.key, { role: next });
                    }}
                  />
                  <TextField
                    label="Name"
                    maxLength={160}
                    value={party.name}
                    {...tie('name')}
                    onChange={(event) => update(party.key, { name: event.target.value })}
                  />
                  <TextField
                    label="Phone (optional)"
                    type="tel"
                    autoComplete="off"
                    value={party.phone}
                    {...tie('phone')}
                    onChange={(event) => update(party.key, { phone: event.target.value })}
                  />
                  <TextField
                    label="Email (optional)"
                    type="email"
                    autoComplete="off"
                    value={party.email}
                    {...tie('email')}
                    onChange={(event) => update(party.key, { email: event.target.value })}
                  />
                  {paper ? (
                    <TextField
                      label="Signed on (optional)"
                      hint="Blank: the date the lease was signed."
                      type="date"
                      value={party.paperSignedOn}
                      {...tie('paperSignedOn')}
                      onChange={(event) => update(party.key, { paperSignedOn: event.target.value })}
                    />
                  ) : (
                    required
                  )}
                </div>
              )}
              {problem ? (
                <p id={errorId} className="text-sm font-medium text-red-700">
                  {problem.message}
                </p>
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
          );
        })}
      </ol>
      <div className="space-y-3">
        {!paper ? (
          <p className="text-sm text-slate-600">
            Add the tenant, one of the tenant&rsquo;s contacts or one of your staff, and they sign
            with the details on their record. Anyone else is typed in.
          </p>
        ) : null}
        {tenantCanSign ? (
          <Button
            variant="secondary"
            onClick={() => add(tenantSigner(records, tenant?.name ?? ''))}
          >
            Add the tenant as a signer
          </Button>
        ) : null}
        {chosenContact && chosenContactRole ? (
          <div className="flex flex-wrap items-end gap-2">
            <SelectField
              label="Add from the tenant’s contacts"
              value={chosenContact.id}
              options={contacts.map((c) => ({
                value: c.id,
                label: `${c.name} (${CONTACT_KIND_LABELS[c.kind]})`,
              }))}
              onChange={(event) => {
                setContactId(event.target.value);
                setContactRole(null);
              }}
            />
            <SelectField
              label="The contact signs as"
              value={chosenContactRole}
              options={contactPartOptions(contactParts(tenantKind))}
              onChange={(event) => {
                const next = contactParts(tenantKind).find((r) => r === event.target.value);
                if (next) setContactRole(next);
              }}
            />
            <Button
              variant="secondary"
              onClick={() => {
                add(contactSigner(chosenContact, chosenContactRole, tenantKind));
                setContactRole(null);
              }}
            >
              Add the contact
            </Button>
          </div>
        ) : null}
        {chosenStaff ? (
          <div className="flex flex-wrap items-end gap-2">
            <SelectField
              label="Add from your staff"
              value={chosenStaff.personId}
              options={staff.map((s) => ({
                value: s.personId,
                label: `${s.name} (${s.roleLabel})`,
              }))}
              onChange={(event) => setStaffId(event.target.value)}
            />
            <SelectField
              label="The staff member signs as"
              value={staffRole}
              options={roleOptions(STAFF_SIGNER_ROLES)}
              onChange={(event) => {
                const next = STAFF_SIGNER_ROLES.find((r) => r === event.target.value);
                if (next) setStaffRole(next);
              }}
            />
            <Button variant="secondary" onClick={() => add(staffSigner(chosenStaff, staffRole))}>
              Add the staff member
            </Button>
          </div>
        ) : null}
        <div className="flex flex-wrap items-end gap-2">
          <SelectField
            label="Add someone who signs as"
            value={role}
            options={roleOptions(typedRoles)}
            onChange={(event) => {
              const next = typedRoles.find((r) => r === event.target.value);
              if (next) setRole(next);
            }}
          />
          <Button variant="secondary" onClick={() => onChange([...parties, emptyParty(role)])}>
            Add signer
          </Button>
        </div>
      </div>
    </div>
  );
}
