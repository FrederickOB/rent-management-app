'use client';

import { useCallback, useState } from 'react';
import { ConfirmBox } from '@/components/confirm-box';
import { Empty, LoadFailed, Loading } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { SelectField, TextAreaField } from '@/components/ui/field';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import {
  ageText,
  heartbeatText,
  mayRunAgain,
  opsReasonProblem,
  QUEUE_LEVEL_LABELS,
  QUEUE_LEVEL_TONES,
  thresholdsText,
  WEBHOOK_STATUS_LABELS,
} from '@/lib/ops';
import { useLoad } from '@/lib/use-load';

const time = (iso: string) => formatTime(iso, 'UTC');

/**
 * The worker's heartbeat and each queue's oldest job (M11 decision 9): a queue whose oldest job
 * passes its threshold is a warning, then critical (payments 5 and 15 minutes; others 30 and 120).
 */
export function QueuesPanel() {
  const load = useCallback(
    () => Promise.all([api().platformOps.heartbeat(), api().platformOps.queues()]),
    [],
  );
  const { state, reload } = useLoad(load);
  if (state.status === 'loading') return <Loading what="the queues" />;
  if (state.status === 'error')
    return <LoadFailed message={state.problem.message} onRetry={reload} />;
  const [beat, queues] = state.data;
  return (
    <Card data-testid="ops-queues">
      <CardHeader
        title="Worker and queues"
        actions={
          <Button size="sm" variant="secondary" onClick={reload}>
            Check again
          </Button>
        }
      />
      <CardBody className="space-y-3">
        <Alert
          tone={beat.healthy ? 'success' : 'error'}
          title={beat.healthy ? 'Worker running' : 'Worker not reporting'}
        >
          <span data-testid="ops-heartbeat">
            {heartbeatText(beat)}
            {beat.lastBeatAt ? ` Last beat ${time(beat.lastBeatAt)}.` : ''}
          </span>
        </Alert>
        {queues.length === 0 ? (
          <Empty>No queues reported.</Empty>
        ) : (
          <Table caption="Queues with their oldest waiting job">
            <thead>
              <tr>
                <Th>Queue</Th>
                <Th className="text-right">Waiting</Th>
                <Th className="text-right">Running</Th>
                <Th className="text-right">Oldest waiting</Th>
                <Th>State</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {queues.map((queue) => (
                <tr key={queue.name} data-testid="ops-queue">
                  <Td className="font-mono text-xs">{queue.name}</Td>
                  <Td className="text-right tabular-nums">{queue.queued}</Td>
                  <Td className="text-right tabular-nums">{queue.active}</Td>
                  <Td className="text-right tabular-nums">
                    {ageText(queue.oldestAgeSeconds)}
                    <span className="block text-xs text-slate-600">
                      {thresholdsText(queue.warnAfterSeconds, queue.criticalAfterSeconds)}
                    </span>
                  </Td>
                  <Td>
                    <Badge tone={QUEUE_LEVEL_TONES[queue.level]}>
                      {QUEUE_LEVEL_LABELS[queue.level]}
                    </Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * Failed and dead-lettered webhooks, replayed through the normal idempotent path with a reason
 * (decision 9; audited in the platform's chain). Replaying twice changes nothing.
 */
export function WebhooksPanel({ canReplay }: { readonly canReplay: boolean }) {
  const [status, setStatus] = useState<'' | 'failed' | 'dead_lettered'>('');
  const load = useCallback(() => api().platformOps.webhooks(status ? { status } : {}), [status]);
  const { state, reload } = useLoad(load);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <Card data-testid="ops-webhooks">
      <CardHeader
        title="Webhooks that were not processed"
        description="Each is stored as it arrived. Replaying it runs the normal path again: the provider is asked to verify, and nothing already recorded is recorded twice."
      />
      <CardBody className="space-y-3">
        <SelectField
          label="Show"
          value={status}
          options={[
            { value: '', label: 'Failed and dead-lettered' },
            { value: 'failed', label: 'Failed only' },
            { value: 'dead_lettered', label: 'Dead-lettered only' },
          ]}
          onChange={(event) => setStatus(event.target.value as typeof status)}
          className="max-w-xs"
        />
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        {state.status === 'loading' ? <Loading what="the webhooks" /> : null}
        {state.status === 'error' ? (
          <LoadFailed message={state.problem.message} onRetry={reload} />
        ) : null}
        {state.status === 'ready' && state.data.length === 0 ? (
          <Empty>Every webhook was processed.</Empty>
        ) : null}
        {state.status === 'ready' && state.data.length > 0 ? (
          <ul className="space-y-3">
            {state.data.map((hook) => (
              <li
                key={hook.id}
                className="space-y-1 rounded-md border border-slate-200 p-3 text-sm"
                data-testid="ops-webhook"
                data-webhook-id={hook.id}
              >
                <p className="flex flex-wrap items-center gap-2">
                  <Badge tone={hook.status === 'dead_lettered' ? 'red' : 'amber'}>
                    {WEBHOOK_STATUS_LABELS[hook.status]}
                  </Badge>
                  <span className="font-medium">{hook.provider}</span>
                  <span className="font-mono text-xs">{hook.eventType ?? 'unknown event'}</span>
                  <span className="font-mono text-xs text-slate-600">{hook.eventId}</span>
                </p>
                <p className="text-slate-700">
                  Received {time(hook.receivedAt)}.
                  {hook.lastError ? ` Last error: ${hook.lastError}` : ''}
                </p>
                {hook.replayCount > 0 ? (
                  <p className="text-slate-600">
                    Replayed {hook.replayCount} {hook.replayCount === 1 ? 'time' : 'times'}
                    {hook.lastReplayedAt ? `, last ${time(hook.lastReplayedAt)}` : ''}
                    {hook.lastReplayedByName ? ` by ${hook.lastReplayedByName}` : ''}.
                  </p>
                ) : null}
                {canReplay ? (
                  <ReasonAction
                    what={`webhook ${hook.eventId}`}
                    button="Replay"
                    confirmText="Yes, replay it"
                    explain="It is processed again through the normal path. If it was already recorded, nothing changes."
                    run={async (reason) => {
                      const next = await api().platformOps.replayWebhook({
                        webhookId: hook.id,
                        reason,
                      });
                      setNotice(
                        `Replayed ${next.eventId}: now ${WEBHOOK_STATUS_LABELS[next.status].toLowerCase()}.`,
                      );
                      reload();
                    }}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </CardBody>
    </Card>
  );
}

/** Dead-lettered jobs, run again with a reason (decision 9). Every job is idempotent. */
export function JobsPanel({ canRetry }: { readonly canRetry: boolean }) {
  const load = useCallback(() => api().platformOps.jobs({}), []);
  const { state, reload } = useLoad(load);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <Card data-testid="ops-jobs">
      <CardHeader
        title="Jobs that failed for good"
        description="Each ran out of retries and went to the dead-letter queue. Every job is idempotent, so running it again never doubles its work."
      />
      <CardBody className="space-y-3">
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        {state.status === 'loading' ? <Loading what="the jobs" /> : null}
        {state.status === 'error' ? (
          <LoadFailed message={state.problem.message} onRetry={reload} />
        ) : null}
        {state.status === 'ready' && state.data.length === 0 ? (
          <Empty>No dead-lettered job.</Empty>
        ) : null}
        {state.status === 'ready' && state.data.length > 0 ? (
          <ul className="space-y-3">
            {state.data.map((job) => (
              <li
                key={job.id}
                className="space-y-1 rounded-md border border-slate-200 p-3 text-sm"
                data-testid="ops-job"
                data-job-id={job.id}
              >
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs font-medium">{job.name}</span>
                  <span className="text-slate-600">
                    {job.attempts} {job.attempts === 1 ? 'attempt' : 'attempts'}
                  </span>
                </p>
                <p className="text-slate-700">
                  {job.failedAt ? `Failed ${time(job.failedAt)}.` : 'Failed.'}
                  {job.lastError ? ` Last error: ${job.lastError}` : ''}
                  {job.retriedAt ? ` Run again ${time(job.retriedAt)}.` : ''}
                </p>
                {canRetry && mayRunAgain(job) ? (
                  <ReasonAction
                    what={`job ${job.name}`}
                    button="Run again"
                    confirmText="Yes, run it again"
                    explain="It goes back on its queue and runs as it would have."
                    run={async (reason) => {
                      await api().platformOps.retryJob({ jobId: job.id, reason });
                      setNotice(`${job.name} is back on its queue.`);
                      reload();
                    }}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </CardBody>
    </Card>
  );
}

/** A replay or retry: a reason (kept in the audit chain), then a confirmation. */
function ReasonAction({
  what,
  button,
  confirmText,
  explain,
  run,
}: {
  readonly what: string;
  readonly button: string;
  readonly confirmText: string;
  readonly explain: string;
  readonly run: (reason: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);

  if (!open)
    return (
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        {button}
      </Button>
    );

  async function confirm() {
    setPending(true);
    setError(null);
    try {
      await run(reason.trim());
      setOpen(false);
      setConfirming(false);
      setReason('');
    } catch (failure) {
      setConfirming(false);
      setError(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      <TextAreaField
        label={`Why ${button.toLowerCase()} ${what}`}
        hint="Kept in the platform’s audit log."
        rows={2}
        maxLength={500}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        error={error}
        className="[&_textarea]:font-sans"
      />
      {confirming ? (
        <ConfirmBox
          label={`Confirm: ${button.toLowerCase()} ${what}`}
          confirmText={confirmText}
          pending={pending}
          onConfirm={() => void confirm()}
          onCancel={() => setConfirming(false)}
        >
          {explain}
        </ConfirmBox>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => {
              const problem = opsReasonProblem(reason);
              setError(problem);
              if (!problem) setConfirming(true);
            }}
          >
            {button}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
