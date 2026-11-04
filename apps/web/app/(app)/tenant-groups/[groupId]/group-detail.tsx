'use client';

import type { TenantGroup } from '@rent/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { ConfirmBox } from '@/components/confirm-box';
import { Empty, LoadFailed, Loading } from '@/components/load-state';
import { PageHeader } from '@/components/page-header';
import { TenantPicker } from '@/components/record-pickers';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { CheckboxField, TextField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import type { PickedTenant } from '@/lib/record-picks';
import { groupErrors, groupPatch, type GroupDraft } from '@/lib/tenant-groups';

type Member = Awaited<ReturnType<ReturnType<typeof api>['tenantGroups']['members']>>[number];

export function GroupDetail({ groupId }: { readonly groupId: string }) {
  const { timeZone } = useApp();
  const [group, setGroup] = useState<TenantGroup | null>(null);
  const [members, setMembers] = useState<readonly Member[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [found, list] = await Promise.all([
        api().tenantGroups.get({ groupId }),
        api().tenantGroups.members({ groupId }),
      ]);
      setMissing(false);
      setGroup(found);
      setMembers(list);
      setProblem(null);
    } catch (failure) {
      const found = toProblem(failure);
      if (found.status === 404 || found.status === 400) setMissing(true);
      else setProblem(found.message);
    }
  }, [groupId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function archive() {
    setBusy(true);
    try {
      setGroup(await api().tenantGroups.archive({ groupId }));
      setArchiving(false);
      setNotice('Archived. Broadcasts can no longer go to this group.');
    } catch (failure) {
      setProblem(toProblem(failure).message);
    } finally {
      setBusy(false);
    }
  }

  const breadcrumb = (
    <nav aria-label="Breadcrumb" className="text-sm">
      <Link href="/tenant-groups" className="underline underline-offset-2">
        Tenant groups
      </Link>{' '}
      <span aria-hidden="true">›</span> <span>{group?.name ?? 'Group'}</span>
    </nav>
  );

  if (missing) {
    return (
      <>
        {breadcrumb}
        <PageHeader title="Tenant group" />
        <Alert tone="info">This group does not exist, or it is not one you can see.</Alert>
      </>
    );
  }
  if (!group) {
    return (
      <>
        {breadcrumb}
        <PageHeader title="Tenant group" />
        {problem ? (
          <LoadFailed message={problem} onRetry={() => void load()} />
        ) : (
          <Loading what="the group" />
        )}
      </>
    );
  }

  const live = !group.archivedAt;
  return (
    <>
      {breadcrumb}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <PageHeader title={group.name} description={group.description ?? undefined} />
          {group.archivedAt ? (
            <Badge tone="dark">Archived {formatTime(group.archivedAt, timeZone)}</Badge>
          ) : null}
        </div>
        {live && !archiving ? (
          <Button variant="ghost" onClick={() => setArchiving(true)}>
            Archive the group
          </Button>
        ) : null}
      </div>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {problem ? <Alert tone="error">{problem}</Alert> : null}
      {archiving ? (
        <ConfirmBox
          label={`Confirm archiving ${group.name}`}
          confirmText="Archive group"
          pending={busy}
          onConfirm={() => void archive()}
          onCancel={() => setArchiving(false)}
        >
          Archive {group.name}? Broadcasts already sent to it keep their record.
        </ConfirmBox>
      ) : null}
      {live ? (
        <Rename
          group={group}
          onSaved={(next) => {
            setGroup(next);
            setNotice(`Saved ${next.name}.`);
          }}
        />
      ) : null}
      <Members
        group={group}
        members={members}
        canChange={live}
        onChanged={async (next, text) => {
          setGroup(next);
          setNotice(text);
          setMembers(await api().tenantGroups.members({ groupId }));
        }}
      />
    </>
  );
}

function Rename({
  group,
  onSaved,
}: {
  readonly group: TenantGroup;
  readonly onSaved: (group: TenantGroup) => void;
}) {
  const [draft, setDraft] = useState<GroupDraft>({
    name: group.name,
    description: group.description ?? '',
  });
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errors = tried ? groupErrors(draft) : {};

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    if (Object.keys(groupErrors(draft)).length) return;
    const patch = groupPatch(group, draft);
    if (Object.keys(patch).length === 0) return;
    setPending(true);
    try {
      onSaved(await api().tenantGroups.update({ groupId: group.id, ...patch }));
    } catch (failure) {
      setError(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader title="Name and description" />
      <CardBody>
        <form onSubmit={submit} noValidate aria-label="Rename the group" className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Name"
              maxLength={60}
              value={draft.name}
              error={errors.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
            <TextField
              label="Description (optional)"
              maxLength={300}
              value={draft.description}
              error={errors.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </div>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <Button type="submit" variant="secondary" pending={pending}>
            Save
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

function Members({
  group,
  members,
  canChange,
  onChanged,
}: {
  readonly group: TenantGroup;
  readonly members: readonly Member[] | null;
  readonly canChange: boolean;
  readonly onChanged: (group: TenantGroup, text: string) => Promise<void>;
}) {
  const [tenant, setTenant] = useState<PickedTenant | null>(null);
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [pending, setPending] = useState<'add' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!tenant) {
      setError('Choose a tenant to add.');
      return;
    }
    setPending('add');
    setError(null);
    try {
      const next = await api().tenantGroups.addMembers({
        groupId: group.id,
        tenantIds: [tenant.id],
      });
      setTenant(null);
      await onChanged(next, `Added ${tenant.displayName}.`);
    } catch (failure) {
      setError(toProblem(failure).message);
    } finally {
      setPending(null);
    }
  }

  async function remove() {
    if (picked.length === 0) return;
    setPending('remove');
    setError(null);
    try {
      const next = await api().tenantGroups.removeMembers({
        groupId: group.id,
        tenantIds: [...picked],
      });
      const count = picked.length;
      setPicked([]);
      await onChanged(next, count === 1 ? 'Removed 1 member.' : `Removed ${count} members.`);
    } catch (failure) {
      setError(toProblem(failure).message);
    } finally {
      setPending(null);
    }
  }

  return (
    <Card data-testid="group-members">
      <CardHeader
        title="Members"
        description="Tenants you can see. A broadcast to the group reaches only those with a current lease."
      />
      <CardBody>
        {canChange ? (
          <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-4">
            <TenantPicker value={tenant} onChange={setTenant} label="Tenant to add" />
            <Button size="sm" pending={pending === 'add'} onClick={() => void add()}>
              Add to the group
            </Button>
          </div>
        ) : null}
        {error ? <Alert tone="error">{error}</Alert> : null}
        {members === null ? <Loading what="members" /> : null}
        {members?.length === 0 ? <Empty>No members yet.</Empty> : null}
        {members?.length ? (
          <>
            <ul className="divide-y divide-slate-100" aria-label="Members">
              {members.map((member) => (
                <li
                  key={member.tenantId}
                  data-testid="member-row"
                  className="flex flex-wrap items-center gap-3 py-2 text-sm"
                >
                  {canChange ? (
                    <CheckboxField
                      label={member.name}
                      checked={picked.includes(member.tenantId)}
                      onChange={(event) =>
                        setPicked((current) =>
                          event.target.checked
                            ? [...current, member.tenantId]
                            : current.filter((id) => id !== member.tenantId),
                        )
                      }
                    />
                  ) : (
                    <span className="font-medium">{member.name}</span>
                  )}
                  <span className="font-mono text-xs text-slate-600">
                    {member.units.map((u) => u.unitCode).join(', ') || 'No current unit'}
                  </span>
                  <Link
                    href={`/tenants/${member.tenantId}`}
                    className="text-xs underline underline-offset-2"
                  >
                    Profile
                  </Link>
                </li>
              ))}
            </ul>
            {canChange ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={picked.length === 0}
                pending={pending === 'remove'}
                onClick={() => void remove()}
              >
                Remove the ticked members
              </Button>
            ) : null}
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}
