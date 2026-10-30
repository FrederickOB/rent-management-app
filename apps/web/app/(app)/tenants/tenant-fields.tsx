'use client';

import type { MessageChannel } from '@rent/domain/messaging';
import { ID_TYPES } from '@rent/domain/tenancy';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Alert } from '@/components/ui/alert';
import { CheckboxField, SelectField, TextAreaField, TextField } from '@/components/ui/field';
import {
  CONTACT_KIND_LABELS,
  ID_TYPE_LABELS,
  type ContactKind,
  type IdType,
} from '@/lib/tenancy-format';
import {
  CONSENT_VERSION,
  consentWording,
  DUPLICATE_MATCH_LABELS,
  type ConsentDraft,
  type ContactDraft,
  type TenantDraft,
  type TenantErrors,
} from '@/lib/tenant-form';

export interface DuplicateTenant {
  readonly tenantId: string;
  readonly displayName: string;
  readonly matchedOn: keyof typeof DUPLICATE_MATCH_LABELS;
}

/**
 * Tenants who share a phone, ID number or TIN with the one being saved (plan 4.3): a warning with
 * a link to each, never a block.
 */
export function DuplicateTenants({
  duplicates,
  children,
}: {
  readonly duplicates: readonly DuplicateTenant[];
  /** What to do about it, such as "Add as a new tenant anyway". */
  readonly children?: ReactNode;
}) {
  return (
    <Alert tone="warning" title="This may be a tenant you already have">
      <ul className="list-disc space-y-1 pl-5">
        {duplicates.map((d) => (
          <li key={`${d.tenantId}-${d.matchedOn}`}>
            <Link
              href={`/tenants/${d.tenantId}`}
              className="font-medium underline underline-offset-2"
            >
              {d.displayName}
            </Link>{' '}
            has {DUPLICATE_MATCH_LABELS[d.matchedOn]}.
          </li>
        ))}
      </ul>
      {children}
    </Alert>
  );
}

/**
 * Reminders when a phone or email with consent on record is changed (CM-09): the consent stays
 * with the channel, so staff check the person agreed at the new number or address.
 */
export function ConsentChangeNotes({ notes }: { readonly notes: readonly string[] }) {
  if (notes.length === 0) return null;
  return (
    <Alert tone="info" title="Consent on record">
      <ul className="list-disc space-y-1 pl-5">
        {notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </Alert>
  );
}

/**
 * A tenant's details (TL-01, TL-02, TL-04). People get an occupation and an ID number; companies
 * get their registration details and TIN. When editing, ID numbers and TINs start blank: blank
 * keeps what is stored, which is shown masked.
 */
export function TenantDetailsFields({
  draft,
  errors,
  onChange,
  stored,
}: {
  readonly draft: TenantDraft;
  readonly errors: TenantErrors;
  readonly onChange: (next: TenantDraft) => void;
  /** The masked numbers on file, when editing. */
  readonly stored?: { readonly idMasked: string | null; readonly tinMasked: string | null };
}) {
  const set = <K extends keyof TenantDraft>(key: K, value: TenantDraft[K]) =>
    onChange({ ...draft, [key]: value });
  const company = draft.kind === 'company';
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <TextField
        label={company ? 'Company name' : 'Full name'}
        hint={company ? 'As it should appear on lists.' : 'As on their ID, if they have one.'}
        maxLength={160}
        value={draft.displayName}
        error={errors.displayName}
        onChange={(event) => set('displayName', event.target.value)}
      />
      {company ? (
        <TextField
          label="Registered name (optional)"
          maxLength={200}
          value={draft.legalName}
          error={errors.legalName}
          onChange={(event) => set('legalName', event.target.value)}
        />
      ) : (
        <TextField
          label="Occupation (optional)"
          maxLength={120}
          value={draft.occupation}
          error={errors.occupation}
          onChange={(event) => set('occupation', event.target.value)}
        />
      )}
      <TextField
        label={company ? 'Phone (optional)' : 'Phone'}
        hint="Such as 024 412 3456. It is how a tenant signs in to the app."
        type="tel"
        autoComplete="off"
        value={draft.phone}
        error={errors.phone}
        onChange={(event) => set('phone', event.target.value)}
      />
      <TextField
        label="WhatsApp number (optional)"
        hint="Only if it differs from the phone."
        type="tel"
        autoComplete="off"
        value={draft.whatsappPhone}
        error={errors.whatsappPhone}
        onChange={(event) => set('whatsappPhone', event.target.value)}
      />
      <TextField
        label="Email (optional)"
        type="email"
        autoComplete="off"
        value={draft.email}
        error={errors.email}
        onChange={(event) => set('email', event.target.value)}
      />
      {company ? (
        <>
          <TextField
            label="Business type (optional)"
            hint="Such as pharmacy or law firm."
            maxLength={120}
            value={draft.businessType}
            error={errors.businessType}
            onChange={(event) => set('businessType', event.target.value)}
          />
          <TextField
            label="Registration number (optional)"
            maxLength={40}
            autoComplete="off"
            value={draft.registrationNumber}
            error={errors.registrationNumber}
            onChange={(event) => set('registrationNumber', event.target.value)}
          />
          <TextField
            label={stored?.tinMasked ? `TIN (on file: ${stored.tinMasked})` : 'TIN (optional)'}
            hint={
              stored?.tinMasked
                ? 'Leave blank to keep the TIN on file. It is stored encrypted and shown masked.'
                : 'Stored encrypted and shown masked.'
            }
            autoComplete="off"
            spellCheck={false}
            maxLength={20}
            value={draft.tin}
            error={errors.tin}
            onChange={(event) => set('tin', event.target.value.toUpperCase())}
          />
        </>
      ) : (
        <>
          <SelectField
            label="ID type (optional)"
            value={draft.idType}
            options={[
              { value: '', label: 'No ID number' },
              ...ID_TYPES.map((t) => ({ value: t, label: ID_TYPE_LABELS[t] })),
            ]}
            onChange={(event) =>
              set('idType', ID_TYPES.find((t): t is IdType => t === event.target.value) ?? '')
            }
          />
          {draft.idType ? (
            <TextField
              label={
                stored?.idMasked
                  ? `${ID_TYPE_LABELS[draft.idType]} number (on file: ${stored.idMasked})`
                  : `${ID_TYPE_LABELS[draft.idType]} number`
              }
              hint={
                draft.idType === 'ghana_card'
                  ? 'Such as GHA-123456789-0. Stored encrypted and shown masked; never photograph the card.'
                  : 'Stored encrypted and shown masked. A passport is recorded, not verified.'
              }
              autoComplete="off"
              spellCheck={false}
              maxLength={32}
              value={draft.idNumber}
              error={errors.idNumber}
              onChange={(event) => set('idNumber', event.target.value.toUpperCase())}
            />
          ) : null}
          {draft.idType === 'passport' ? (
            <TextField
              label="Issuing country"
              hint="Two letters, such as NG or GB."
              autoComplete="off"
              maxLength={2}
              value={draft.idCountry}
              error={errors.idCountry}
              onChange={(event) => set('idCountry', event.target.value.toUpperCase())}
            />
          ) : null}
        </>
      )}
      <TextAreaField
        className="sm:col-span-2 [&_textarea]:font-sans"
        label="Notes (optional)"
        rows={2}
        maxLength={2000}
        value={draft.notes}
        error={errors.notes}
        onChange={(event) => set('notes', event.target.value)}
      />
    </div>
  );
}

/**
 * Consent per channel (CM-09; decision 2). Staff record what the person agreed to, in the words
 * that are stored with it, by version.
 */
export function ConsentFields({
  consent,
  onChange,
  who,
}: {
  readonly consent: ConsentDraft;
  readonly onChange: (next: ConsentDraft) => void;
  /** Whose consent: "the tenant", "this contact". */
  readonly who: string;
}) {
  const channels: readonly MessageChannel[] = ['sms', 'email'];
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-slate-800">
        Messages {who} agreed to receive
      </legend>
      {channels.map((channel) => (
        <CheckboxField
          key={channel}
          label={channel === 'sms' ? 'By SMS' : 'By email'}
          hint={`${consentWording(channel)} (${CONSENT_VERSION})`}
          checked={consent[channel]}
          onChange={(event) => onChange({ ...consent, [channel]: event.target.checked })}
        />
      ))}
      <p className="text-sm text-slate-600">
        Without consent on any channel, signing links are handed over in person instead.
      </p>
    </fieldset>
  );
}

/** One contact (TL-03, TL-04): a guarantor, next of kin, employer, signatory or finance contact. */
export function ContactFields({
  contact,
  errors,
  kinds,
  onChange,
  withConsent = true,
}: {
  readonly contact: ContactDraft;
  readonly errors: Partial<Record<keyof ContactDraft, string>> | undefined;
  readonly kinds: readonly ContactKind[];
  readonly onChange: (next: ContactDraft) => void;
  readonly withConsent?: boolean;
}) {
  const set = <K extends keyof ContactDraft>(key: K, value: ContactDraft[K]) =>
    onChange({ ...contact, [key]: value });
  const professional = ['employer', 'signatory', 'finance'].includes(contact.kind);
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label="Kind of contact"
          value={contact.kind}
          options={kinds.map((k) => ({ value: k, label: CONTACT_KIND_LABELS[k] }))}
          onChange={(event) => {
            const kind = kinds.find((k) => k === event.target.value);
            if (kind) set('kind', kind);
          }}
        />
        <TextField
          label="Name"
          maxLength={160}
          value={contact.name}
          error={errors?.name}
          onChange={(event) => set('name', event.target.value)}
        />
        <TextField
          label="Phone (optional)"
          type="tel"
          autoComplete="off"
          value={contact.phone}
          error={errors?.phone}
          onChange={(event) => set('phone', event.target.value)}
        />
        <TextField
          label="Email (optional)"
          type="email"
          autoComplete="off"
          value={contact.email}
          error={errors?.email}
          onChange={(event) => set('email', event.target.value)}
        />
        {professional ? (
          <>
            <TextField
              label="Organisation (optional)"
              maxLength={160}
              value={contact.organisation}
              onChange={(event) => set('organisation', event.target.value)}
            />
            <TextField
              label="Position (optional)"
              maxLength={120}
              value={contact.position}
              onChange={(event) => set('position', event.target.value)}
            />
          </>
        ) : (
          <TextField
            label="Relationship (optional)"
            hint="Such as aunt or employer."
            maxLength={80}
            value={contact.relationship}
            onChange={(event) => set('relationship', event.target.value)}
          />
        )}
      </div>
      {withConsent ? (
        <ConsentFields
          who="this contact"
          consent={contact.consent}
          onChange={(consent) => set('consent', consent)}
        />
      ) : null}
    </div>
  );
}
