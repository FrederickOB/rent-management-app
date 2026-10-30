'use client';

import type { OwnerRow, PropertyRowView } from '@rent/contracts';
import { OWNER_KINDS } from '@rent/domain/portfolio';
import Link from 'next/link';
import { useId, useState, type FormEvent } from 'react';
import { ConfirmBox } from '@/components/confirm-box';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import {
  CheckboxField,
  controlClass,
  Field,
  SelectField,
  TextAreaField,
  TextField,
} from '@/components/ui/field';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import {
  countryLabel,
  ownerCreateInput,
  ownerDraftOf,
  ownerErrors,
  ownerPatch,
  timeZoneSuggestions,
  type OwnerDraft,
} from '@/lib/owner-form';
import type { LinkedUser } from '@/lib/owner-users';
import { countsSummary, locationLabel, OWNER_KIND_LABELS } from '@/lib/register-format';

type Notice = { readonly tone: 'success' | 'error'; readonly text: string } | null;

/**
 * Owners (AD-02): list, add, edit and archive, with the properties each one owns and the people
 * whose access runs through them.
 */
export function OwnersManager({
  initialRows,
  canManage,
  linkedUsers,
}: {
  readonly initialRows: readonly OwnerRow[];
  /** From the policy (owner.manage); the API refuses anything else regardless. */
  readonly canManage: boolean;
  /** People linked to each owner, by owner id; null when this session may not list people. */
  readonly linkedUsers: Readonly<Record<string, readonly LinkedUser[]>> | null;
}) {
  const [rows, setRows] = useState<readonly OwnerRow[]>(initialRows);
  const [showArchived, setShowArchived] = useState(false);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  async function refresh(text: string) {
    setNotice({ tone: 'success', text });
    try {
      setRows(await api().owners.list({ includeArchived: 'true' }));
    } catch (failure) {
      setNotice({ tone: 'error', text: toProblem(failure).message });
    }
  }

  const shown = rows.filter((r) => showArchived || !r.archived);
  const archivedCount = rows.filter((r) => r.archived).length;

  return (
    <>
      {canManage && adding ? (
        <Card>
          <CardHeader
            title="Add an owner"
            description="Leave the reference empty to get the next one, such as OWN-03."
          />
          <CardBody>
            <OwnerForm
              submitText="Add owner"
              onSubmit={async (draft) => {
                const created = await api().owners.create(ownerCreateInput(draft));
                setAdding(false);
                await refresh(`Added ${created.displayName} as ${created.reference}.`);
              }}
              onCancel={() => setAdding(false)}
            />
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Owners"
          description={`${shown.length} ${shown.length === 1 ? 'owner' : 'owners'}${archivedCount && !showArchived ? `, and ${archivedCount} archived` : ''}.`}
          actions={
            canManage && !adding ? (
              <Button
                onClick={() => {
                  setAdding(true);
                  setNotice(null);
                }}
              >
                Add an owner
              </Button>
            ) : null
          }
        />
        <CardBody>
          {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
          {archivedCount ? (
            <CheckboxField
              label="Show archived owners"
              checked={showArchived}
              onChange={(event) => setShowArchived(event.target.checked)}
            />
          ) : null}
          {shown.length === 0 ? (
            <p className="text-sm text-slate-600">No owners yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {shown.map((owner) => (
                <OwnerItem
                  key={owner.id}
                  owner={owner}
                  canManage={canManage}
                  linkedUsers={linkedUsers ? (linkedUsers[owner.id] ?? []) : null}
                  onChanged={refresh}
                />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </>
  );
}

function OwnerItem({
  owner,
  canManage,
  linkedUsers,
  onChanged,
}: {
  readonly owner: OwnerRow;
  readonly canManage: boolean;
  readonly linkedUsers: readonly LinkedUser[] | null;
  readonly onChanged: (text: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'archive'>('view');
  const [properties, setProperties] = useState<readonly PropertyRowView[] | 'loading' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const contact = [owner.phone, owner.email].filter(Boolean).join(' · ');
  const country = countryLabel(owner.residenceCountry);

  async function toggleProperties() {
    if (properties !== null) {
      setProperties(null);
      return;
    }
    setProperties('loading');
    setError(null);
    try {
      setProperties((await api().register.listProperties({ ownerId: owner.id })).rows);
    } catch (failure) {
      setProperties(null);
      setError(toProblem(failure).message);
    }
  }

  async function archive() {
    setBusy(true);
    setError(null);
    try {
      await api().owners.archive({ ownerId: owner.id });
      setMode('view');
      await onChanged(`Archived ${owner.displayName}.`);
    } catch (failure) {
      setError(toProblem(failure).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li data-testid="owner-row" className="space-y-3 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <span className="text-base font-semibold text-slate-900">{owner.displayName}</span>
            <span className="font-mono text-slate-700">{owner.reference}</span>
            <Badge>{OWNER_KIND_LABELS[owner.kind]}</Badge>
            {owner.archived ? <Badge tone="dark">Archived</Badge> : null}
          </p>
          {owner.legalName && owner.legalName !== owner.displayName ? (
            <p className="text-slate-700">Legal name: {owner.legalName}</p>
          ) : null}
          <p className="break-words text-slate-700">{contact || 'No phone or email recorded'}</p>
          <p className="text-slate-700">
            {country ? `Lives in ${country}` : 'Country not recorded'} · Time zone {owner.timeZone}
          </p>
          {owner.notes ? <p className="break-words text-slate-600">{owner.notes}</p> : null}
          {linkedUsers ? (
            <div data-testid="linked-users" className="text-slate-700">
              {linkedUsers.length === 0 ? (
                <p>No users linked</p>
              ) : (
                <>
                  <p className="font-medium text-slate-800">Users linked to this owner</p>
                  <ul
                    className="list-disc pl-5"
                    aria-label={`Users linked to ${owner.displayName}`}
                  >
                    {linkedUsers.map((user) => (
                      <li key={user.membershipId}>
                        {user.name}{' '}
                        <span className="text-slate-600">
                          ({user.invited ? `${user.role}, invited` : user.role})
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            aria-expanded={properties !== null}
            aria-label={`Properties of ${owner.displayName}`}
            onClick={() => void toggleProperties()}
          >
            Properties
          </Button>
          {canManage && !owner.archived && mode === 'view' ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                aria-label={`Edit ${owner.displayName}`}
                onClick={() => {
                  setError(null);
                  setMode('edit');
                }}
              >
                Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Archive ${owner.displayName}`}
                onClick={() => {
                  setError(null);
                  setMode('archive');
                }}
              >
                Archive
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {mode === 'archive' ? (
        <ConfirmBox
          label={`Confirm archiving ${owner.displayName}`}
          confirmText="Archive owner"
          pending={busy}
          onConfirm={() => void archive()}
          onCancel={() => setMode('view')}
        >
          Archive {owner.displayName}? An owner who still owns properties cannot be archived; move
          or archive those first.
        </ConfirmBox>
      ) : null}
      {mode === 'edit' ? (
        <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
          <OwnerForm
            initial={owner}
            submitText="Save owner"
            onSubmit={async (draft) => {
              const patch = ownerPatch(owner, draft);
              if (Object.keys(patch).length)
                await api().owners.update({ ownerId: owner.id, ...patch });
              setMode('view');
              await onChanged(`Saved ${draft.displayName.trim()}.`);
            }}
            onCancel={() => setMode('view')}
          />
        </div>
      ) : null}
      {properties === 'loading' ? (
        <p role="status" className="text-sm text-slate-600">
          Loading properties…
        </p>
      ) : null}
      {Array.isArray(properties) ? (
        properties.length === 0 ? (
          <p className="text-sm text-slate-600">No properties.</p>
        ) : (
          <ul
            className="space-y-1 rounded-md border border-slate-200 p-3 text-sm"
            aria-label={`Properties of ${owner.displayName}`}
          >
            {properties.map((p) => (
              <li key={p.id} className="flex flex-wrap items-baseline justify-between gap-2">
                <Link
                  href={`/portfolio/properties/${p.id}`}
                  className="font-medium underline underline-offset-2"
                >
                  <span className="font-mono">{p.code}</span> {p.name}
                </Link>
                <span className="text-slate-600">
                  {locationLabel(p)} · {countsSummary(p.counts)}
                </span>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </li>
  );
}

function OwnerForm({
  initial,
  submitText,
  onSubmit,
  onCancel,
}: {
  readonly initial?: OwnerRow;
  readonly submitText: string;
  /** Throws to show the API's message. */
  readonly onSubmit: (draft: OwnerDraft) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const zonesId = useId();
  const [draft, setDraft] = useState<OwnerDraft>(() => ownerDraftOf(initial));
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zones] = useState<readonly string[]>(() => timeZoneSuggestions());
  const errors = tried ? ownerErrors(draft) : {};
  const set = <K extends keyof OwnerDraft>(key: K, value: OwnerDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    if (Object.keys(ownerErrors(draft)).length) return;
    setPending(true);
    try {
      await onSubmit(draft);
    } catch (failure) {
      setError(toProblem(failure).message);
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate aria-label={submitText} className="space-y-4">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label="Kind"
          value={draft.kind}
          options={OWNER_KINDS.map((k) => ({ value: k, label: OWNER_KIND_LABELS[k] }))}
          onChange={(event) => {
            const kind = OWNER_KINDS.find((k) => k === event.target.value);
            if (kind) set('kind', kind);
          }}
        />
        <TextField
          label="Reference"
          hint="Short, for lists and imports, such as OWN-03."
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          maxLength={20}
          value={draft.reference}
          error={errors.reference}
          onChange={(event) => set('reference', event.target.value.toUpperCase())}
        />
        <TextField
          label="Name"
          hint="As it should appear on lists and statements."
          maxLength={120}
          value={draft.displayName}
          error={errors.displayName}
          onChange={(event) => set('displayName', event.target.value)}
        />
        <TextField
          label="Legal name (optional)"
          maxLength={160}
          value={draft.legalName}
          error={errors.legalName}
          onChange={(event) => set('legalName', event.target.value)}
        />
        <TextField
          label="Phone (optional)"
          type="tel"
          autoComplete="off"
          maxLength={20}
          value={draft.phone}
          error={errors.phone}
          onChange={(event) => set('phone', event.target.value)}
        />
        <TextField
          label="Email (optional)"
          type="email"
          autoComplete="off"
          value={draft.email}
          error={errors.email}
          onChange={(event) => set('email', event.target.value)}
        />
        <TextField
          label="Country of residence (optional)"
          hint="The two-letter code, such as GH or GB."
          autoCapitalize="characters"
          autoComplete="off"
          maxLength={2}
          value={draft.residenceCountry}
          error={errors.residenceCountry}
          onChange={(event) => set('residenceCountry', event.target.value.toUpperCase())}
        />
        <Field
          label="Time zone"
          hint="Where the owner lives; times for them use it."
          error={errors.timeZone}
        >
          {(control) => (
            <>
              <input
                {...control}
                list={zonesId}
                autoComplete="off"
                spellCheck={false}
                maxLength={64}
                value={draft.timeZone}
                onChange={(event) => set('timeZone', event.target.value)}
                className={controlClass}
              />
              <datalist id={zonesId}>
                {zones.map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
            </>
          )}
        </Field>
      </div>
      <TextAreaField
        label="Notes (optional)"
        rows={3}
        maxLength={1000}
        value={draft.notes}
        error={errors.notes}
        onChange={(event) => set('notes', event.target.value)}
        className="[&_textarea]:font-sans"
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={pending}>
          {submitText}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
