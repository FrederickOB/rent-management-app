'use client';

import type { TenantGroup } from '@rent/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Empty, Loading } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { CheckboxField, TextField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { groupErrors, type GroupDraft } from '@/lib/tenant-groups';

/** The list of groups, archived ones on request, and a form for a new one. */
export function GroupsView() {
  const [showArchived, setShowArchived] = useState(false);
  const [groups, setGroups] = useState<readonly TenantGroup[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setGroups(await api().tenantGroups.list(showArchived ? { archived: 'true' } : {}));
      setProblem(null);
    } catch (failure) {
      setProblem(toProblem(failure).message);
    }
  }, [showArchived]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <NewGroup
        onCreated={async (group) => {
          setNotice(`Made the group ${group.name}. Add its members next.`);
          await load();
        }}
      />
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <Card>
        <CardHeader title="Groups" />
        <CardBody>
          <CheckboxField
            label="Show only archived groups"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />
          {problem ? <Alert tone="error">{problem}</Alert> : null}
          {groups === null && !problem ? <Loading what="groups" /> : null}
          {groups?.length === 0 ? <Empty>No group yet.</Empty> : null}
          {groups?.length ? (
            <ul className="divide-y divide-slate-100" aria-label="Tenant groups">
              {groups.map((group) => (
                <li key={group.id} data-testid="group-row" className="space-y-1 py-3 text-sm">
                  <p className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/tenant-groups/${group.id}`}
                      className="text-base font-semibold underline underline-offset-2"
                    >
                      {group.name}
                    </Link>
                    <Badge>
                      {group.memberCount === 1 ? '1 member' : `${group.memberCount} members`}
                    </Badge>
                    {group.archivedAt ? <Badge tone="dark">Archived</Badge> : null}
                  </p>
                  {group.description ? <p className="text-slate-700">{group.description}</p> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </CardBody>
      </Card>
    </>
  );
}

function NewGroup({ onCreated }: { readonly onCreated: (group: TenantGroup) => Promise<void> }) {
  const [draft, setDraft] = useState<GroupDraft>({ name: '', description: '' });
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errors = tried ? groupErrors(draft) : {};

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    if (Object.keys(groupErrors(draft)).length) return;
    setPending(true);
    try {
      const group = await api().tenantGroups.create({
        name: draft.name.trim(),
        description: draft.description.trim() || null,
      });
      setDraft({ name: '', description: '' });
      setTried(false);
      await onCreated(group);
    } catch (failure) {
      setError(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader title="New group" />
      <CardBody>
        <form onSubmit={submit} noValidate aria-label="New group" className="space-y-4">
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
          <Button type="submit" pending={pending}>
            Make the group
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
