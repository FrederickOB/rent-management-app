'use client';

import type { ContactRow, TenantDetailView } from '@rent/contracts';
import { useState, type FormEvent } from 'react';
import { ConfirmBox } from '@/components/confirm-box';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { CheckboxField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { CONTACT_KIND_LABELS, CONTACT_KINDS_FOR } from '@/lib/tenancy-format';
import {
  consentChangeNotes,
  contactCreateInput,
  contactDraftOf,
  contactPatch,
  contactProblems,
  emptyContact,
  type ContactDraft,
} from '@/lib/tenant-form';
import { ConsentChangeNotes, ContactFields } from '../tenant-fields';
import { ConsentRows } from './consent-card';

/**
 * Contacts (TL-03, TL-04): a guarantor, next of kin and employer reference for a person; the
 * authorised signatories and the finance contact for a company. Archived, never deleted.
 */
export function ContactsCard({
  tenant,
  canManage,
  onChanged,
}: {
  readonly tenant: TenantDetailView;
  readonly canManage: boolean;
  readonly onChanged: (text: string) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const archived = tenant.contacts.filter((c) => c.archived).length;
  const shown = tenant.contacts.filter((c) => showArchived || !c.archived);

  return (
    <Card data-testid="contacts">
      <CardHeader
        title="Contacts"
        description={
          tenant.kind === 'company'
            ? 'Authorised signatories sign leases for the company.'
            : 'A guarantor signs the lease with the tenant.'
        }
        actions={
          canManage && !adding ? (
            <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
              Add a contact
            </Button>
          ) : null
        }
      />
      <CardBody>
        {adding ? (
          <AddContact
            tenant={tenant}
            onSaved={async (text) => {
              setAdding(false);
              await onChanged(text);
            }}
            onCancel={() => setAdding(false)}
          />
        ) : null}
        {archived ? (
          <CheckboxField
            label="Show archived contacts"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />
        ) : null}
        {shown.length === 0 ? <p className="text-sm text-slate-600">No contacts.</p> : null}
        <ul className="divide-y divide-slate-100">
          {shown.map((contact) => (
            <ContactItem
              key={contact.id}
              tenant={tenant}
              contact={contact}
              canManage={canManage && !contact.archived}
              onChanged={onChanged}
            />
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

function ContactItem({
  tenant,
  contact,
  canManage,
  onChanged,
}: {
  readonly tenant: TenantDetailView;
  readonly contact: ContactRow;
  readonly canManage: boolean;
  readonly onChanged: (text: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'archive'>('view');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const details = [contact.relationship, contact.organisation, contact.position]
    .filter(Boolean)
    .join(' · ');

  async function archive() {
    setBusy(true);
    setError(null);
    try {
      await api().tenants.archiveContact({ tenantId: tenant.id, contactId: contact.id });
      setMode('view');
      await onChanged(`Archived ${contact.name}.`);
    } catch (failure) {
      setError(toProblem(failure).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li data-testid="contact-row" className="space-y-3 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <span className="text-base font-semibold text-slate-900">{contact.name}</span>
            <Badge>{CONTACT_KIND_LABELS[contact.kind]}</Badge>
            {contact.archived ? <Badge tone="dark">Archived</Badge> : null}
          </p>
          {details ? <p className="text-slate-700">{details}</p> : null}
          <p className="break-words text-slate-700">
            {[contact.phone, contact.email].filter(Boolean).join(' · ') || 'No phone or email'}
          </p>
        </div>
        {canManage && mode === 'view' ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              aria-label={`Edit ${contact.name}`}
              onClick={() => setMode('edit')}
            >
              Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Archive ${contact.name}`}
              onClick={() => setMode('archive')}
            >
              Archive
            </Button>
          </div>
        ) : null}
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {mode === 'archive' ? (
        <ConfirmBox
          label={`Confirm archiving ${contact.name}`}
          confirmText="Archive contact"
          pending={busy}
          onConfirm={() => void archive()}
          onCancel={() => setMode('view')}
        >
          Archive {contact.name}? The contact and their history stay on record.
        </ConfirmBox>
      ) : null}
      {mode === 'edit' ? (
        <EditContact
          tenant={tenant}
          contact={contact}
          onSaved={async (text) => {
            setMode('view');
            await onChanged(text);
          }}
          onCancel={() => setMode('view')}
        />
      ) : null}
      {!contact.archived ? (
        <ConsentRows
          consent={contact.consent}
          addresses={{ sms: contact.phone, email: contact.email }}
          canManage={canManage}
          who={contact.name}
          onRecord={async (channel, action) => {
            await api().tenants.recordConsent({
              tenantId: tenant.id,
              contactId: contact.id,
              channel,
              action,
            });
            await onChanged(
              action === 'grant'
                ? `Recorded ${channel === 'sms' ? 'SMS' : 'email'} consent for ${contact.name}.`
                : `Recorded that ${contact.name} withdrew ${channel === 'sms' ? 'SMS' : 'email'} consent.`,
            );
          }}
        />
      ) : null}
    </li>
  );
}

function EditContact({
  tenant,
  contact,
  onSaved,
  onCancel,
}: {
  readonly tenant: TenantDetailView;
  readonly contact: ContactRow;
  readonly onSaved: (text: string) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState<ContactDraft>(() => contactDraftOf(contact));
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Consent is recorded on its own below the contact, so it is not checked here.
  const problems = contactProblems({ ...draft, consent: { sms: false, email: false } });
  const consentNotes = consentChangeNotes(contact, draft, contact.name);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    if (Object.keys(problems).length) return;
    const patch = contactPatch(contact, draft);
    if (Object.keys(patch).length === 0) {
      onCancel();
      return;
    }
    setPending(true);
    try {
      await api().tenants.updateContact({ tenantId: tenant.id, contactId: contact.id, ...patch });
      await onSaved(`Saved ${draft.name.trim()}.`);
    } catch (failure) {
      setError(toProblem(failure).message);
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={`Edit ${contact.name}`}
      className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4"
    >
      {error ? <Alert tone="error">{error}</Alert> : null}
      <ContactFields
        contact={draft}
        errors={tried ? problems : undefined}
        kinds={[contact.kind]}
        onChange={setDraft}
        withConsent={false}
      />
      <ConsentChangeNotes notes={consentNotes} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={pending}>
          Save contact
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function AddContact({
  tenant,
  onSaved,
  onCancel,
}: {
  readonly tenant: TenantDetailView;
  readonly onSaved: (text: string) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const kinds = CONTACT_KINDS_FOR[tenant.kind];
  const [draft, setDraft] = useState<ContactDraft>(() => emptyContact(kinds[0]!));
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problems = contactProblems(draft);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    if (Object.keys(problems).length) return;
    setPending(true);
    try {
      const saved = await api().tenants.addContact({
        tenantId: tenant.id,
        ...contactCreateInput(draft),
      });
      await onSaved(`Added ${saved.name} as ${CONTACT_KIND_LABELS[saved.kind].toLowerCase()}.`);
    } catch (failure) {
      setError(toProblem(failure).message);
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="Add a contact"
      className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4"
    >
      {error ? <Alert tone="error">{error}</Alert> : null}
      <ContactFields
        contact={draft}
        errors={tried ? problems : undefined}
        kinds={kinds}
        onChange={setDraft}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={pending}>
          Add contact
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
