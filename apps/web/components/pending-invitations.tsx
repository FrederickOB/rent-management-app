'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { roleLabel } from '@/lib/format';
import { invitationMessage } from '@/lib/invitations';
import { useLoad } from '@/lib/use-load';
import { Alert } from './ui/alert';
import { Button } from './ui/button';
import { Card, CardBody, CardHeader } from './ui/card';

/**
 * Invitations waiting for the signed-in person (M11 founder D2), with Accept and Decline. Shown
 * after sign-in; nothing when none waits. Accepting adds the company to this person's list.
 */
export function PendingInvitations() {
  const router = useRouter();
  const load = useCallback(() => api().me.invitations(), []);
  const { state, reload } = useLoad(load);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function act(membershipId: string, companyName: string, accept: boolean) {
    setPending(membershipId);
    setProblem(null);
    setNotice(null);
    try {
      if (accept) await api().me.acceptInvitation({ membershipId });
      else await api().me.declineInvitation({ membershipId });
      setNotice(
        accept
          ? `You have joined ${companyName}. Switch to it from the header.`
          : `You declined the invitation from ${companyName}.`,
      );
      reload();
      // The header's company list and the session's memberships come from the layout.
      router.refresh();
    } catch (failure) {
      setProblem(invitationMessage(failure) ?? toProblem(failure).message);
    } finally {
      setPending(null);
    }
  }

  if (state.status !== 'ready' || (state.data.length === 0 && !notice && !problem)) return null;
  return (
    <Card data-testid="pending-invitations">
      <CardHeader
        title="Invitations waiting for you"
        description="A company has asked you to join it. Accept to work in it, or decline."
      />
      <CardBody className="space-y-3">
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        {problem ? <Alert tone="error">{problem}</Alert> : null}
        <ul className="divide-y divide-slate-100 text-sm">
          {state.data.map((invitation) => (
            <li
              key={invitation.membershipId}
              className="flex flex-wrap items-center justify-between gap-3 py-2"
              data-testid="pending-invitation"
            >
              <span>
                <span className="font-medium text-slate-900">{invitation.companyName}</span>, as{' '}
                {roleLabel(invitation.role)}
              </span>
              <span className="flex gap-2">
                <Button
                  size="sm"
                  pending={pending === invitation.membershipId}
                  onClick={() => void act(invitation.membershipId, invitation.companyName, true)}
                >
                  Accept
                  <span className="sr-only"> the invitation from {invitation.companyName}</span>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending === invitation.membershipId}
                  onClick={() => void act(invitation.membershipId, invitation.companyName, false)}
                >
                  Decline
                  <span className="sr-only"> the invitation from {invitation.companyName}</span>
                </Button>
              </span>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
