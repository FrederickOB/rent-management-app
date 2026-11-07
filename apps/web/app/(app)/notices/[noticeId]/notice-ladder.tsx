'use client';

import type { NoticeDetail } from '@rent/contracts';
import { useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { TextField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { LADDER_STEP_LABELS, ladderControls, noticeChannelName } from '@/lib/notices';

type Control = 'pause' | 'resume' | 'cancel';

const CONTROL_TEXT: Record<Control, { button: string; done: string; hint: string }> = {
  pause: {
    button: 'Pause the reminders',
    done: 'Reminders paused.',
    hint: 'Nothing more goes to the tenant until you resume. The notice stays in force.',
  },
  resume: {
    button: 'Resume the reminders',
    done: 'Reminders resumed.',
    hint: 'Steps that fell due while paused go when they next can, the latest only.',
  },
  cancel: {
    button: 'Cancel the reminders',
    done: 'Reminders cancelled for good.',
    hint: 'No more reminders, in-person steps or escalation. The notice stays in force.',
  },
};

/**
 * The reminder ladder (LN-05): its steps with when each falls due and when it will go (held for
 * the sending window, decision 11), and pausing, resuming or cancelling it with a reason. These
 * are flags on the notice, never a change to what it says.
 */
export function LadderCard({
  notice,
  onChanged,
}: {
  readonly notice: NoticeDetail;
  readonly onChanged: (next: NoticeDetail, text?: string) => void;
}) {
  const { timeZone } = useApp();
  const [control, setControl] = useState<Control | null>(null);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { ladder } = notice;
  const offered = notice.actions.controlLadder ? ladderControls(ladder) : [];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!control) return;
    if (reason.trim().length < 3) {
      setProblem('Give a reason of at least 3 characters.');
      return;
    }
    setPending(true);
    setProblem(null);
    try {
      const next = await api().notices.ladder({
        noticeId: notice.id,
        action: control,
        reason: reason.trim(),
      });
      onChanged(next, CONTROL_TEXT[control].done);
      setControl(null);
      setReason('');
    } catch (failure) {
      setProblem(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card data-testid="notice-ladder">
      <CardHeader
        title="Reminders and escalation"
        description="The notice is in force whether or not it is signed; the reminders only help it reach the tenant."
      />
      <CardBody>
        {ladder.paused || ladder.cancelled ? (
          <Alert tone={ladder.cancelled ? 'info' : 'warning'}>
            {ladder.cancelled ? 'Cancelled' : 'Paused'}
            {ladder.changedByName ? ` by ${ladder.changedByName}` : ''}
            {ladder.changedAt ? `, ${formatTime(ladder.changedAt, timeZone)}` : ''}
            {ladder.reason ? `: ${ladder.reason}` : '.'}
          </Alert>
        ) : null}
        {ladder.steps.length === 0 ? (
          <p className="text-sm text-slate-600">This notice has no reminders.</p>
        ) : (
          <ol className="space-y-2 text-sm" aria-label="Ladder steps">
            {ladder.steps.map((step) => (
              <li
                key={step.key}
                data-testid="ladder-step"
                className="flex flex-wrap items-center gap-2"
              >
                <span className="font-medium">{LADDER_STEP_LABELS[step.action]}</span>
                {step.channels.length ? (
                  <span className="text-slate-600">
                    by {step.channels.map(noticeChannelName).join(', ')}
                  </span>
                ) : null}
                {step.statesRemainsInForce ? <Badge>Says the notice remains in force</Badge> : null}
                <span className="text-slate-600">
                  {step.dueAt
                    ? `due ${formatTime(step.dueAt, timeZone)}`
                    : `${step.afterHours} h after issue`}
                  {step.runsAt && step.runsAt !== step.dueAt
                    ? `, goes ${formatTime(step.runsAt, timeZone)} (sending window)`
                    : ''}
                </span>
              </li>
            ))}
          </ol>
        )}
        {offered.length && !control ? (
          <div className="flex flex-wrap gap-2">
            {offered.map((c) => (
              <Button
                key={c}
                size="sm"
                variant={c === 'cancel' ? 'ghost' : 'secondary'}
                onClick={() => {
                  setControl(c);
                  setProblem(null);
                }}
              >
                {CONTROL_TEXT[c].button}
              </Button>
            ))}
          </div>
        ) : null}
        {control ? (
          <form
            onSubmit={submit}
            noValidate
            aria-label={CONTROL_TEXT[control].button}
            className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3"
          >
            <p className="text-sm text-slate-700">{CONTROL_TEXT[control].hint}</p>
            <TextField
              label="Reason"
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" pending={pending}>
                {CONTROL_TEXT[control].button}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setControl(null)}>
                Keep it as it is
              </Button>
            </div>
          </form>
        ) : null}
        {problem ? <Alert tone="error">{problem}</Alert> : null}
      </CardBody>
    </Card>
  );
}
