'use client';

import type { ConversationDetail, ConversationSummary } from '@rent/contracts';
import { CHANNEL_LABELS } from '@rent/domain/messaging';
import { DEFAULT_INBOX_TAGS } from '@rent/domain/settings';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useApp } from '@/components/app-context';
import { TenantPicker } from '@/components/record-pickers';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { CheckboxField, SelectField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { tagChoices } from '@/lib/inbox';
import { CONTACT_KIND_LABELS } from '@/lib/tenancy-format';
import type { PickedTenant } from '@/lib/record-picks';

type Assignee = Awaited<ReturnType<ReturnType<typeof api>['inbox']['assignees']>>[number];

/**
 * The side panel (CM-06): who has the conversation, its tags, resolving and reopening, and for
 * an unknown sender, linking them to a tenant (CM-02). Each control shows only when the API's
 * `can` says the person may use it; the API checks again.
 */
export function ConversationActions({
  detail,
  onChanged,
}: {
  readonly detail: ConversationDetail;
  readonly onChanged: (summary: ConversationSummary) => void;
}) {
  const triage = detail.state === 'triage';
  return (
    <>
      {triage && detail.can.triage ? <LinkTriage detail={detail} onChanged={onChanged} /> : null}
      {!triage ? <Assignment detail={detail} onChanged={onChanged} /> : null}
      {!triage ? <Tags detail={detail} onChanged={onChanged} /> : null}
      {!triage && detail.can.resolve ? (
        <ResolveOrReopen detail={detail} onChanged={onChanged} />
      ) : null}
    </>
  );
}

function Assignment({
  detail,
  onChanged,
}: {
  readonly detail: ConversationDetail;
  readonly onChanged: (summary: ConversationSummary) => void;
}) {
  const [people, setPeople] = useState<readonly Assignee[] | null>(null);
  const [choice, setChoice] = useState(detail.assignee?.personId ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // A resolved conversation is reopened first; the API refuses to assign it (review W5).
  const resolved = detail.state === 'resolved';
  const canAssign = detail.can.assign && !resolved;

  useEffect(() => {
    setChoice(detail.assignee?.personId ?? '');
  }, [detail.assignee?.personId]);

  useEffect(() => {
    if (!canAssign) return undefined;
    let current = true;
    api()
      .inbox.assignees({ conversationId: detail.id })
      .then(
        (list) => {
          if (current) setPeople(list);
        },
        (failure: unknown) => {
          if (current) setError(toProblem(failure).message);
        },
      );
    return () => {
      current = false;
    };
  }, [canAssign, detail.id]);

  async function save() {
    setPending(true);
    setError(null);
    setDone(null);
    try {
      const summary = await api().inbox.assign({
        conversationId: detail.id,
        personId: choice || null,
      });
      setDone(summary.assignee ? `Assigned to ${summary.assignee.name}.` : 'Unassigned.');
      onChanged(summary);
    } catch (failure) {
      setError(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card data-testid="assignment">
      <CardHeader title="Assigned to" level={3} />
      <CardBody>
        {!canAssign ? (
          <>
            <p className="text-sm text-slate-800">{detail.assignee?.name ?? 'Nobody yet'}</p>
            {resolved && detail.can.assign ? (
              <p className="text-sm text-slate-600">Reopen it to assign someone.</p>
            ) : null}
          </>
        ) : (
          <>
            <SelectField
              label="Staff member"
              hint="Only people who look after this tenant’s property are listed."
              value={choice}
              disabled={people === null}
              options={[
                { value: '', label: 'Nobody (unassigned)' },
                ...(detail.assignee &&
                !people?.some((p) => p.personId === detail.assignee?.personId)
                  ? [{ value: detail.assignee.personId, label: detail.assignee.name }]
                  : []),
                ...(people ?? []).map((p) => ({ value: p.personId, label: p.name })),
              ]}
              onChange={(event) => setChoice(event.target.value)}
            />
            <Button
              size="sm"
              pending={pending}
              disabled={choice === (detail.assignee?.personId ?? '')}
              onClick={() => void save()}
            >
              {choice ? 'Assign' : 'Unassign'}
            </Button>
          </>
        )}
        {error ? <Alert tone="error">{error}</Alert> : null}
        {done ? <Alert tone="success">{done}</Alert> : null}
      </CardBody>
    </Card>
  );
}

function Tags({
  detail,
  onChanged,
}: {
  readonly detail: ConversationDetail;
  readonly onChanged: (summary: ConversationSummary) => void;
}) {
  const { company } = useApp();
  const list = company?.settings.inboxTags ?? DEFAULT_INBOX_TAGS;
  const { offered, kept, retired } = tagChoices(list, detail.tags);
  const [picked, setPicked] = useState<readonly string[]>(kept);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canTag = detail.can.tag;
  const savedKey = [...detail.tags].sort().join(',');
  const keptKey = [...kept].sort().join(',');

  // Tags taken off the company's list are not offered again: the API takes only listed ones, so
  // saving drops them, and the panel says so (review note: a removed tag blocked saving).
  useEffect(() => {
    setPicked(keptKey ? keptKey.split(',') : []);
  }, [keptKey]);

  const changed = [...picked].sort().join(',') !== savedKey;

  async function save() {
    setPending(true);
    setError(null);
    try {
      onChanged(await api().inbox.setTags({ conversationId: detail.id, tags: [...picked] }));
    } catch (failure) {
      setError(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card data-testid="tags">
      <CardHeader title="Tags" level={3} />
      <CardBody>
        {!canTag ? (
          detail.tags.length ? (
            <div className="flex flex-wrap gap-1">
              {detail.tags.map((tag) => (
                <Badge key={tag}>{tag}</Badge>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-600">No tags.</p>
          )
        ) : (
          <fieldset className="space-y-2">
            <legend className="sr-only">Tags for this conversation</legend>
            {offered.map((tag) => (
              <CheckboxField
                key={tag}
                label={tag}
                checked={picked.includes(tag)}
                onChange={(event) =>
                  setPicked((current) =>
                    event.target.checked ? [...current, tag] : current.filter((t) => t !== tag),
                  )
                }
              />
            ))}
            {retired.length ? (
              <p className="text-sm text-slate-600" data-testid="retired-tags">
                No longer in your company’s tag list: {retired.join(', ')}. Saving removes{' '}
                {retired.length === 1 ? 'it' : 'them'}.
              </p>
            ) : null}
            <Button
              size="sm"
              variant="secondary"
              pending={pending}
              disabled={!changed}
              onClick={() => void save()}
            >
              Save tags
            </Button>
          </fieldset>
        )}
        {error ? <Alert tone="error">{error}</Alert> : null}
      </CardBody>
    </Card>
  );
}

function ResolveOrReopen({
  detail,
  onChanged,
}: {
  readonly detail: ConversationDetail;
  readonly onChanged: (summary: ConversationSummary) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolved = detail.state === 'resolved';

  async function act() {
    setPending(true);
    setError(null);
    try {
      onChanged(
        resolved
          ? await api().inbox.reopen({ conversationId: detail.id })
          : await api().inbox.resolve({ conversationId: detail.id }),
      );
    } catch (failure) {
      setError(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card data-testid="resolve">
      <CardBody>
        <p className="text-sm text-slate-700">
          {resolved
            ? 'Resolved. The tenant’s next message reopens it.'
            : 'Resolve it when nothing more is owed. The tenant’s next message reopens it.'}
        </p>
        <Button size="sm" variant="secondary" pending={pending} onClick={() => void act()}>
          {resolved ? 'Reopen' : 'Mark resolved'}
        </Button>
        {error ? <Alert tone="error">{error}</Alert> : null}
      </CardBody>
    </Card>
  );
}

type Contact = { readonly id: string; readonly label: string };

/** Links an unknown sender to a tenant or one of their contacts (CM-02); recorded and audited. */
function LinkTriage({
  detail,
  onChanged,
}: {
  readonly detail: ConversationDetail;
  readonly onChanged: (summary: ConversationSummary) => void;
}) {
  const router = useRouter();
  const [tenant, setTenant] = useState<PickedTenant | null>(null);
  const [contacts, setContacts] = useState<readonly Contact[]>([]);
  const [contactId, setContactId] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const address = detail.triage
    ? `${detail.triage.addressMasked} on ${CHANNEL_LABELS[detail.triage.channel]}`
    : 'this sender';

  useEffect(() => {
    setContactId('');
    setContacts([]);
    if (!tenant) return undefined;
    let current = true;
    api()
      .tenants.get({ tenantId: tenant.id })
      .then(
        (found) => {
          if (!current || found.access !== 'full') return;
          setContacts(
            found.contacts
              .filter((c) => !c.archived)
              .map((c) => ({ id: c.id, label: `${c.name} (${CONTACT_KIND_LABELS[c.kind]})` })),
          );
        },
        () => undefined,
      );
    return () => {
      current = false;
    };
  }, [tenant]);

  async function link() {
    if (!tenant) {
      setError('Choose the tenant this sender is.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const summary = await api().inbox.linkTriage({
        conversationId: detail.id,
        tenantId: tenant.id,
        contactId: contactId || null,
      });
      if (summary.id === detail.id) {
        // The triage conversation itself became the tenant's: nothing to navigate to.
        setPending(false);
        onChanged(summary);
      } else {
        router.push(`/inbox/${summary.id}`);
      }
    } catch (failure) {
      setError(toProblem(failure).message);
      setPending(false);
    }
  }

  return (
    <Card data-testid="link-triage">
      <CardHeader
        title="Who is this?"
        level={3}
        description={`Link ${address} to a tenant. Their messages join the tenant’s conversation, and later messages follow. This is recorded.`}
      />
      <CardBody>
        <TenantPicker value={tenant} onChange={setTenant} label="Tenant" />
        {contacts.length ? (
          <SelectField
            label="Written by"
            value={contactId}
            options={[
              { value: '', label: 'The tenant themselves' },
              ...contacts.map((c) => ({ value: c.id, label: c.label })),
            ]}
            onChange={(event) => setContactId(event.target.value)}
          />
        ) : null}
        <Button size="sm" pending={pending} onClick={() => void link()}>
          Link to this tenant
        </Button>
        {error ? <Alert tone="error">{error}</Alert> : null}
      </CardBody>
    </Card>
  );
}
