'use client';

import type { ContactRow, MessagingConsent, TenantDetailView } from '@rent/contracts';
import type { ApiClient } from '@rent/contracts/client';
import type { ConsentChannel } from '@rent/domain/messaging';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ConfirmBox } from '@/components/confirm-box';
import { primaryLink, secondaryLink } from '@/components/link-styles';
import { PageHeader } from '@/components/page-header';
import { LeaseStatusBadge } from '@/components/tenancy-badges';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { CheckboxField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { channelsFor, consentChannelName } from '@/lib/messaging-consent';
import { TENANT_KIND_LABELS, termLabel } from '@/lib/tenancy-format';
import {
  consentResetNotes,
  hasErrors,
  tenantDraftOf,
  tenantErrors,
  tenantPatch,
  type TenantDraft,
} from '@/lib/tenant-form';
import {
  ConsentChangeNotes,
  DuplicateTenants,
  TenantDetailsFields,
  type DuplicateTenant,
} from '../tenant-fields';
import { ConsentCard } from './consent-card';
import { ContactsCard } from './contacts-card';
import { IdentityCard } from './identity-card';
import { TimelineCard } from './timeline-card';

type Notice = { readonly tone: 'success' | 'error'; readonly text: string } | null;
type LimitedTenant = Extract<
  Awaited<ReturnType<ApiClient['tenants']['get']>>,
  { access: 'limited' }
>;

export interface TenantPermissions {
  readonly manage: boolean;
  readonly verify: boolean;
  readonly reveal: boolean;
  readonly lease: boolean;
  /** M6: the tenant's messages join the timeline, with a link to the conversation (CM-05). */
  readonly messages?: boolean;
  /** M6: may write to the tenant (messaging.reply), starting the conversation if need be. */
  readonly write?: boolean;
}

/** What a caretaker sees (plan 4.14): the name, the phone and the units, nothing else. */
export function TenantLimited({ tenant }: { readonly tenant: LimitedTenant }) {
  return (
    <>
      <Breadcrumb name={tenant.displayName} />
      <PageHeader title={tenant.displayName} />
      <Card data-testid="tenant-limited">
        <CardBody>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Item label="Phone" value={tenant.phone} />
            <Item label="Units" value={tenant.units.join(', ') || null} />
          </dl>
          <p className="text-sm text-slate-600">
            You see a tenant&rsquo;s name, phone and units. Ask a manager for anything else.
          </p>
        </CardBody>
      </Card>
    </>
  );
}

function Breadcrumb({ name }: { readonly name: string }) {
  return (
    <nav aria-label="Breadcrumb" className="text-sm">
      <Link href="/tenants" className="underline underline-offset-2">
        Tenants
      </Link>{' '}
      <span aria-hidden="true">›</span> <span>{name}</span>
    </nav>
  );
}

function Item({ label, value }: { readonly label: string; readonly value: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-slate-600">{label}</dt>
      <dd className="break-words">
        {value ?? <span className="text-slate-500">Not recorded</span>}
      </dd>
    </div>
  );
}

/** The full profile (TL-01 to TL-04; plan 4.16). */
export function TenantProfile({
  initial,
  created,
  can,
}: {
  readonly initial: TenantDetailView;
  readonly created: boolean;
  readonly can: TenantPermissions;
}) {
  const router = useRouter();
  const [tenant, setTenant] = useState(initial);
  const [notice, setNotice] = useState<Notice>(
    created ? { tone: 'success', text: `Added ${initial.displayName}.` } : null,
  );
  const [editing, setEditing] = useState(false);
  const [duplicates, setDuplicates] = useState<readonly DuplicateTenant[]>([]);
  const [archiving, setArchiving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [timelineVersion, setTimelineVersion] = useState(0);
  // Consent on every channel (CM-09): null while loading, false when only the M3 record could be
  // read (an API without the M6 route), so the card still shows SMS and email.
  // Consent on every channel (CM-09), null while it loads. A failed read shows its error and a
  // retry; it never falls back to the M3 rows, which know only SMS and email (review W8).
  const [messaging, setMessaging] = useState<MessagingConsent | null>(null);
  const [consentProblem, setConsentProblem] = useState<string | null>(null);
  const live = !tenant.archived;
  const tenantId = tenant.id;

  const loadConsent = useCallback(async () => {
    try {
      setMessaging(await api().messagingConsent.get({ tenantId }));
      setConsentProblem(null);
    } catch (failure) {
      setConsentProblem(toProblem(failure).message);
    }
  }, [tenantId]);

  useEffect(() => {
    void loadConsent();
  }, [loadConsent, timelineVersion]);

  /** One person's channels; null while loading or when the read failed. */
  const channelsOf = (contact: ContactRow | null) =>
    messaging ? (channelsFor(messaging, contact?.id ?? null) ?? []) : null;

  async function recordConsent(
    contact: ContactRow | null,
    channel: ConsentChannel,
    action: 'grant' | 'withdraw',
  ) {
    setMessaging(
      await api().messagingConsent.record({
        tenantId,
        contactId: contact?.id ?? null,
        channel,
        action,
      }),
    );
    const who = contact?.name ?? tenant.displayName;
    const name = consentChannelName(channel);
    await refresh(
      action === 'grant'
        ? `Recorded ${name} consent for ${who}.`
        : `Recorded that ${who} withdrew ${name} consent.`,
    );
  }
  const company = tenant.kind === 'company';
  // A number shown after a reveal belongs to the number it was asked for (TL-02): the identity
  // card starts afresh, hiding it, when the number on file changes or the edit form opens.
  const revealScope = [
    editing ? 'editing' : 'viewing',
    tenant.identity.type ?? '',
    tenant.identity.masked ?? '',
    tenant.tinMasked ?? '',
  ].join('|');

  async function refresh(text?: string) {
    try {
      const next = await api().tenants.get({ tenantId: tenant.id });
      if (next.access === 'full') setTenant(next);
      if (text) setNotice({ tone: 'success', text });
    } catch (failure) {
      setNotice({ tone: 'error', text: toProblem(failure).message });
    }
    setTimelineVersion((v) => v + 1);
  }

  async function archive() {
    setBusy(true);
    try {
      await api().tenants.archive({ tenantId: tenant.id });
      setArchiving(false);
      await refresh(`Archived ${tenant.displayName}.`);
      router.refresh();
    } catch (failure) {
      setNotice({ tone: 'error', text: toProblem(failure).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Breadcrumb name={tenant.displayName} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <PageHeader
            title={tenant.displayName}
            description={
              company
                ? [TENANT_KIND_LABELS.company, tenant.businessType].filter(Boolean).join(' · ')
                : (tenant.occupation ?? undefined)
            }
          />
          <div className="flex flex-wrap gap-2">
            {company ? <Badge>{TENANT_KIND_LABELS.company}</Badge> : null}
            {tenant.archived ? <Badge tone="dark">Archived</Badge> : null}
            {tenant.units.map((code) => (
              <Badge key={code} tone="blue">
                {code}
              </Badge>
            ))}
          </div>
        </div>
        {live ? (
          <div className="flex flex-wrap gap-2">
            {can.lease ? (
              <>
                <Link href={`/leases/new?tenantId=${tenant.id}`} className={primaryLink}>
                  Start a lease
                </Link>
                <Link href={`/leases/paper?tenantId=${tenant.id}`} className={secondaryLink}>
                  Record a paper lease
                </Link>
              </>
            ) : null}
            {can.manage && !editing ? (
              <>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setDuplicates([]);
                    setEditing(true);
                  }}
                >
                  Edit details
                </Button>
                <Button
                  variant="ghost"
                  aria-expanded={archiving}
                  onClick={() => setArchiving((a) => !a)}
                >
                  Archive
                </Button>
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
      {duplicates.length ? <DuplicateTenants duplicates={duplicates} /> : null}
      {archiving ? (
        <ConfirmBox
          label={`Confirm archiving ${tenant.displayName}`}
          confirmText="Archive tenant"
          pending={busy}
          onConfirm={() => void archive()}
          onCancel={() => setArchiving(false)}
        >
          Archive {tenant.displayName}? A tenant who still holds a lease cannot be archived. The
          record and its history stay.
        </ConfirmBox>
      ) : null}

      {editing ? (
        <EditDetails
          tenant={tenant}
          onSaved={(next, found) => {
            setTenant(next);
            setEditing(false);
            setNotice({
              tone: 'success',
              text: found.length
                ? `Saved ${next.displayName}. Check below that you do not have them twice.`
                : `Saved ${next.displayName}.`,
            });
            setDuplicates(found);
            setTimelineVersion((v) => v + 1);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <Card data-testid="tenant-details">
          <CardHeader title="Details" />
          <CardBody>
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              {company ? <Item label="Registered name" value={tenant.legalName} /> : null}
              <Item label="Phone" value={tenant.phone} />
              <Item label="WhatsApp" value={tenant.whatsappPhone} />
              <Item label="Email" value={tenant.email} />
              {company ? (
                <>
                  <Item label="Business type" value={tenant.businessType} />
                  <Item label="Registration number" value={tenant.registrationNumber} />
                </>
              ) : (
                <Item label="Occupation" value={tenant.occupation} />
              )}
              <Item label="Notes" value={tenant.notes} />
            </dl>
          </CardBody>
        </Card>
      )}

      <IdentityCard
        key={revealScope}
        tenant={tenant}
        can={can}
        onChanged={(text) => refresh(text)}
      />
      <ConsentCard
        channels={channelsOf(null)}
        problem={consentProblem}
        onRetry={() => void loadConsent()}
        canManage={can.manage && live}
        onRecord={(channel, action) => recordConsent(null, channel, action)}
      />
      <ContactsCard
        tenant={tenant}
        canManage={can.manage && live}
        onChanged={(text) => refresh(text)}
        consentOf={(contact) => channelsOf(contact)}
        consentProblem={consentProblem}
        onRecordConsent={recordConsent}
      />

      <Card>
        <CardHeader title="Tenancies" description="Every lease with this tenant, newest first." />
        <CardBody>
          {tenant.leases.length === 0 ? (
            <p className="text-sm text-slate-600">No lease yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm" aria-label="Tenancies">
              {tenant.leases.map((lease) => (
                <li
                  key={lease.id}
                  data-testid="tenancy-row"
                  className="flex flex-wrap items-center justify-between gap-2 py-3"
                >
                  <Link
                    href={`/leases/${lease.id}`}
                    className="font-medium underline underline-offset-2"
                  >
                    <span className="font-mono">{lease.unitCode}</span>{' '}
                    {termLabel(lease.startDate, lease.endDate)}
                  </Link>
                  <LeaseStatusBadge status={lease.status} />
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <TimelineCard
        tenantId={tenant.id}
        version={timelineVersion}
        withMessages={Boolean(can.messages)}
        canWrite={Boolean(can.write) && live}
      />
    </>
  );
}

function EditDetails({
  tenant,
  onSaved,
  onCancel,
}: {
  readonly tenant: TenantDetailView;
  readonly onSaved: (next: TenantDetailView, duplicates: readonly DuplicateTenant[]) => void;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState<TenantDraft>(() => tenantDraftOf(tenant));
  const [removeId, setRemoveId] = useState(false);
  const [removeTin, setRemoveTin] = useState(false);
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errors = tried ? tenantErrors(draft) : {};
  const consentNotes = consentResetNotes(tenant, draft, 'the tenant');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    if (hasErrors(tenantErrors(draft))) return;
    const patch = tenantPatch(tenant, draft, { removeId, removeTin });
    if (Object.keys(patch).length === 0) {
      onCancel();
      return;
    }
    setPending(true);
    try {
      const saved = await api().tenants.update({ tenantId: tenant.id, ...patch });
      onSaved(
        saved.tenant,
        saved.duplicates.filter((d) => d.tenantId !== tenant.id),
      );
    } catch (failure) {
      setError(toProblem(failure).message);
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title={`Edit ${tenant.displayName}`}
        description="Contacts and consent are changed below, each on its own."
      />
      <CardBody>
        <form onSubmit={submit} noValidate aria-label="Edit details" className="space-y-4">
          {error ? <Alert tone="error">{error}</Alert> : null}
          <TenantDetailsFields
            draft={draft}
            errors={errors}
            onChange={setDraft}
            stored={{ idMasked: tenant.identity.masked, tinMasked: tenant.tinMasked }}
          />
          <ConsentChangeNotes notes={consentNotes} />
          {tenant.kind === 'individual' && tenant.identity.masked ? (
            <CheckboxField
              label="Remove the ID number on file"
              hint="Removing it also cancels a check in progress."
              checked={removeId}
              onChange={(event) => setRemoveId(event.target.checked)}
            />
          ) : null}
          {tenant.kind === 'company' && tenant.tinMasked ? (
            <CheckboxField
              label="Remove the TIN on file"
              checked={removeTin}
              onChange={(event) => setRemoveTin(event.target.checked)}
            />
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" pending={pending}>
              Save details
            </Button>
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
