'use client';

import type { TaskView } from '@rent/contracts';
import { TASK_KIND_LABELS, TASK_KINDS, type TaskKind, type TaskStatus } from '@rent/domain/tasks';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { Empty, LoadFailed, Loading } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { Field, SelectField, controlClass } from '@/components/ui/field';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { useRequestGate } from '@/lib/request-gate';
import { TASK_STATUS_LABELS, taskOverdue } from '@/lib/tasks';

type Which = 'mine' | 'all';

export function TasksView() {
  const { timeZone } = useApp();
  const [which, setWhich] = useState<Which>('mine');
  const [status, setStatus] = useState<TaskStatus | ''>('open');
  const [kind, setKind] = useState<TaskKind | ''>('');
  const [tasks, setTasks] = useState<readonly TaskView[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const gate = useRequestGate();

  const load = useCallback(async () => {
    const current = gate.begin();
    try {
      const list = await api().tasks.list({
        ...(which === 'mine' ? { mine: 'true' } : {}),
        ...(status ? { status } : {}),
        ...(kind ? { kind } : {}),
      });
      if (!current()) return;
      setTasks(list);
      setProblem(null);
    } catch (failure) {
      if (current()) setProblem(toProblem(failure).message);
    }
  }, [gate, which, status, kind]);

  useEffect(() => {
    setTasks(null);
    void load();
    return gate.cancel;
  }, [gate, load]);

  const now = new Date();
  return (
    <>
      <div role="group" aria-label="Whose tasks" className="flex flex-wrap gap-2">
        {(['mine', 'all'] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={which === option}
            onClick={() => setWhich(option)}
            className={cn(
              'min-h-11 rounded-md px-4 py-2 text-sm font-medium',
              which === option
                ? 'bg-brand text-brand-contrast'
                : 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-100',
            )}
          >
            {option === 'mine' ? 'Mine' : 'Everyone’s I can see'}
          </button>
        ))}
      </div>
      <Card>
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-2 lg:max-w-xl">
            <SelectField
              label="Status"
              value={status}
              options={[
                { value: '', label: 'Any status' },
                { value: 'open', label: TASK_STATUS_LABELS.open },
                { value: 'done', label: TASK_STATUS_LABELS.done },
                { value: 'cancelled', label: TASK_STATUS_LABELS.cancelled },
              ]}
              onChange={(event) => setStatus(event.target.value as TaskStatus | '')}
            />
            <SelectField
              label="Kind"
              value={kind}
              options={[
                { value: '', label: 'Any kind' },
                ...TASK_KINDS.map((k) => ({ value: k, label: TASK_KIND_LABELS[k] })),
              ]}
              onChange={(event) => setKind(event.target.value as TaskKind | '')}
            />
          </div>
          {message ? <Alert tone="success">{message}</Alert> : null}
          {problem ? <LoadFailed message={problem} onRetry={() => void load()} /> : null}
          {tasks === null && !problem ? <Loading what="tasks" /> : null}
          {tasks?.length === 0 ? <Empty>No task here.</Empty> : null}
          {tasks?.length ? (
            <ul className="divide-y divide-slate-100" aria-label="Tasks">
              {tasks.map((task) => (
                <TaskItem
                  key={task.id}
                  task={task}
                  overdue={taskOverdue(task, now)}
                  timeZone={timeZone}
                  onChanged={(next, text) => {
                    setTasks((current) =>
                      (current ?? []).map((t) => (t.id === next.id ? next : t)),
                    );
                    setMessage(text);
                  }}
                />
              ))}
            </ul>
          ) : null}
        </CardBody>
      </Card>
    </>
  );
}

type Acting = 'complete' | 'note' | 'cancel';

const ACTING_TEXT: Record<
  Acting,
  { button: string; done: string; noteLabel: string; required: boolean }
> = {
  complete: {
    button: 'Mark done',
    done: 'Marked done.',
    noteLabel: 'Note (optional): what was done',
    required: false,
  },
  note: { button: 'Save the note', done: 'Note saved.', noteLabel: 'Note', required: true },
  cancel: {
    button: 'Cancel the task',
    done: 'Task cancelled.',
    noteLabel: 'Why it is no longer needed',
    required: true,
  },
};

function TaskItem({
  task,
  overdue,
  timeZone,
  onChanged,
}: {
  readonly task: TaskView;
  readonly overdue: boolean;
  readonly timeZone: string;
  readonly onChanged: (next: TaskView, text: string) => void;
}) {
  const [acting, setActing] = useState<Acting | null>(null);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = task.status === 'open';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!acting) return;
    const text = note.trim();
    if (ACTING_TEXT[acting].required && text.length < 2) {
      setError('Add a note of at least 2 characters.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const call = api().tasks;
      const next =
        acting === 'complete'
          ? await call.complete({ taskId: task.id, note: text || null })
          : acting === 'note'
            ? await call.note({ taskId: task.id, note: text })
            : await call.cancel({ taskId: task.id, note: text });
      onChanged(next, ACTING_TEXT[acting].done);
      setActing(null);
      setNote('');
    } catch (failure) {
      setError(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <li className="space-y-2 py-4 text-sm" data-testid="task-row">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-base font-semibold text-slate-900">{task.title}</span>
        <span data-testid="task-status">
          <Badge
            tone={open ? (overdue ? 'red' : 'amber') : task.status === 'done' ? 'green' : 'dark'}
          >
            {open && overdue ? 'Overdue' : TASK_STATUS_LABELS[task.status]}
          </Badge>
        </span>
        <Badge>{task.kindLabel}</Badge>
      </div>
      <p className="text-slate-700">
        {task.property.name}
        {task.unitCode ? <span className="ml-1 font-mono text-xs">{task.unitCode}</span> : null}
        {task.tenantName ? ` · ${task.tenantName}` : ''}
      </p>
      <p className="text-slate-600">
        Due {formatTime(task.dueAt, timeZone)} · {task.assignee?.name ?? 'Nobody assigned'}
        {task.notice ? (
          <>
            {' · '}
            <Link href={`/notices/${task.notice.id}`} className="underline underline-offset-2">
              {task.notice.number ?? task.notice.typeLabel}
            </Link>
          </>
        ) : null}
      </p>
      {task.note ? <p className="whitespace-pre-wrap text-slate-800">Note: {task.note}</p> : null}
      {task.completedAt ? (
        <p className="text-slate-600">
          Done {task.completedByName ? `by ${task.completedByName}, ` : ''}
          {formatTime(task.completedAt, timeZone)}
        </p>
      ) : null}
      {task.cancelledAt ? (
        <p className="text-slate-600">Cancelled {formatTime(task.cancelledAt, timeZone)}</p>
      ) : null}
      {open && task.mayComplete && !acting ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setActing('complete')}>
            Mark done
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setActing('note')}>
            Add a note
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setActing('cancel')}>
            Cancel the task
          </Button>
        </div>
      ) : null}
      {acting ? (
        <form
          onSubmit={submit}
          noValidate
          aria-label={`${ACTING_TEXT[acting].button}: ${task.title}`}
          className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3"
        >
          <Field label={ACTING_TEXT[acting].noteLabel}>
            {(control) => (
              <textarea
                {...control}
                rows={2}
                maxLength={2000}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                className={controlClass}
              />
            )}
          </Field>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" pending={pending}>
              {ACTING_TEXT[acting].button}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setActing(null)}>
              Back
            </Button>
          </div>
        </form>
      ) : null}
    </li>
  );
}
