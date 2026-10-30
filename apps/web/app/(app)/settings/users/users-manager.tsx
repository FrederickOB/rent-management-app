'use client';

import type { MembershipRow } from '@rent/contracts';
import type { CompanyKind } from '@rent/domain/policy';
import Link from 'next/link';
import { Fragment, useMemo, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { formatDate, roleLabel } from '@/lib/format';
import { EditMembership, type ScopeOptions } from './edit-membership';
import { InviteForm } from './invite-form';
import { scopeSummary, type ScopeNames } from './scope';

const STATUS_LABELS: Record<MembershipRow['status'], string> = {
  invited: 'Invited',
  active: 'Active',
  revoked: 'Removed',
};

export interface UsersManagerProps {
  readonly initialRows: readonly MembershipRow[];
  /** From the policy (membership.manage); the API refuses anything else regardless. */
  readonly canManage: boolean;
  readonly canSearchAudit: boolean;
  readonly selfPersonId: string;
  readonly timeZone: string;
  readonly companyKind: CompanyKind;
  /** Owners and properties for the access pickers (AD-02), when this session may list them. */
  readonly scopeOptions: ScopeOptions;
}

type Notice = { readonly tone: 'success' | 'error'; readonly text: string } | null;

/** Memberships (AD-03): list, invite, change role, scope and approver flag, and remove. */
export function UsersManager({
  initialRows,
  canManage,
  canSearchAudit,
  selfPersonId,
  timeZone,
  companyKind,
  scopeOptions,
}: UsersManagerProps) {
  const [rows, setRows] = useState<readonly MembershipRow[]>(initialRows);
  const [notice, setNotice] = useState<Notice>(null);
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const names = useMemo<ScopeNames>(
    () => ({
      owners: new Map((scopeOptions.owners ?? []).map((o) => [o.value, o.label])),
      properties: new Map((scopeOptions.properties ?? []).map((p) => [p.value, p.label])),
    }),
    [scopeOptions],
  );

  async function refresh(message: string) {
    setNotice({ tone: 'success', text: message });
    try {
      setRows(await api().memberships.list());
    } catch (failure) {
      setNotice({ tone: 'error', text: toProblem(failure).message });
    }
  }

  async function remove(row: MembershipRow) {
    setBusy(true);
    try {
      await api().memberships.revoke({ membershipId: row.membershipId });
      setRemoving(null);
      await refresh(`${row.name} no longer has access to this company.`);
    } catch (failure) {
      setNotice({ tone: 'error', text: toProblem(failure).message });
    } finally {
      setBusy(false);
    }
  }

  const showActions = canManage || canSearchAudit;
  const columns = showActions ? 6 : 5;

  return (
    <>
      {canManage && inviting ? (
        <Card>
          <CardHeader
            title="Invite someone"
            description="Staff get an email to set a password. Caretakers sign in with a code sent to their phone."
          />
          <CardBody>
            <InviteForm
              onInvited={(message) => {
                setInviting(false);
                void refresh(message);
              }}
              onCancel={() => setInviting(false)}
            />
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="People"
          description="Everyone with access to this company, including people who have not accepted their invitation yet."
          actions={
            canManage && !inviting ? (
              <Button
                onClick={() => {
                  setInviting(true);
                  setNotice(null);
                }}
              >
                Invite someone
              </Button>
            ) : null
          }
        />
        <CardBody>
          {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
          <Table caption="People in this company">
            <thead>
              <tr>
                <Th>Person</Th>
                <Th>Role</Th>
                <Th>Status</Th>
                <Th>Access</Th>
                <Th>Added</Th>
                {showActions ? (
                  <Th>
                    <span className="sr-only">Actions</span>
                  </Th>
                ) : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => {
                const self = row.personId === selfPersonId;
                const open = row.status !== 'revoked';
                return (
                  <Fragment key={row.membershipId}>
                    <tr
                      data-testid="membership-row"
                      className={open ? undefined : 'text-slate-500'}
                    >
                      <Td>
                        <p className="font-medium">
                          {row.name}
                          {self ? <span className="font-normal text-slate-600"> (you)</span> : null}
                        </p>
                        <p className="text-slate-600">
                          {row.email ?? row.phoneMasked ?? 'No contact details'}
                        </p>
                      </Td>
                      <Td>
                        <p>{roleLabel(row.role)}</p>
                        {row.nominatedApprover ? (
                          <p className="text-slate-600">Nominated approver</p>
                        ) : null}
                      </Td>
                      <Td>{STATUS_LABELS[row.status]}</Td>
                      <Td>{scopeSummary(row.scope, names)}</Td>
                      <Td className="whitespace-nowrap">{formatDate(row.createdAt, timeZone)}</Td>
                      {showActions ? (
                        <Td>
                          <div className="flex justify-end gap-2 whitespace-nowrap">
                            {canManage && open && !self ? (
                              <>
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  aria-label={`Change ${row.name}`}
                                  aria-expanded={editing === row.membershipId}
                                  onClick={() => {
                                    setEditing(
                                      editing === row.membershipId ? null : row.membershipId,
                                    );
                                    setRemoving(null);
                                    setNotice(null);
                                  }}
                                >
                                  Change
                                </Button>
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  aria-label={`Remove ${row.name}`}
                                  aria-expanded={removing === row.membershipId}
                                  onClick={() => {
                                    setRemoving(
                                      removing === row.membershipId ? null : row.membershipId,
                                    );
                                    setEditing(null);
                                    setNotice(null);
                                  }}
                                >
                                  Remove
                                </Button>
                              </>
                            ) : null}
                            {canSearchAudit ? (
                              <Link
                                href={`/audit?recordType=membership&recordId=${encodeURIComponent(row.membershipId)}`}
                                className="inline-flex min-h-9 items-center px-2 text-sm font-medium underline underline-offset-2"
                                aria-label={`History of ${row.name}'s access`}
                              >
                                History
                              </Link>
                            ) : null}
                          </div>
                        </Td>
                      ) : null}
                    </tr>
                    {canManage && removing === row.membershipId ? (
                      <tr>
                        <td colSpan={columns} className="px-3 pb-4">
                          <div
                            role="group"
                            aria-label={`Confirm removing ${row.name}`}
                            className="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 p-4"
                          >
                            <p className="text-sm text-red-900">
                              Remove {row.name} from this company? They lose access at once. Their
                              history stays in the audit log.
                            </p>
                            <div className="flex gap-2">
                              <Button
                                variant="danger"
                                size="sm"
                                pending={busy}
                                onClick={() => void remove(row)}
                              >
                                Remove access
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => setRemoving(null)}>
                                Keep
                              </Button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                    {canManage && editing === row.membershipId ? (
                      <tr>
                        <td colSpan={columns} className="px-3 pb-4">
                          <EditMembership
                            row={row}
                            companyKind={companyKind}
                            scopeOptions={scopeOptions}
                            onSaved={(message) => {
                              setEditing(null);
                              void refresh(message);
                            }}
                            onCancel={() => setEditing(null)}
                          />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </Table>
        </CardBody>
      </Card>
    </>
  );
}
