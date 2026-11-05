'use client';

import type { NoticeDetail } from '@rent/contracts';
import {
  NOTICE_OUTCOME_LABELS,
  STAFF_NOTICE_OUTCOMES,
  type NoticeOutcome,
} from '@rent/domain/notices';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, SelectField, controlClass } from '@/components/ui/field';
import { api, keyedApi } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { sendOnce, useIdempotencyKeeper } from '@/lib/idempotency';

type StaffOutcome = Exclude<NoticeOutcome, 'superseded'>;

/**
 * Closing with an outcome and a note (decision 12), and correcting (plan 4.8). Closing records
 * what happened; nothing ends the lease or touches the unit (Act 220 s.17 and s.27). A correction
 * is a new draft that references this notice; issuing it closes this one as superseded.
 */
export function CloseAndCorrect({
  notice,
  onChanged,
}: {
  readonly notice: NoticeDetail;
  readonly onChanged: (next: NoticeDetail, text?: string) => void;
}) {
  const router = useRouter();
  const [closing, setClosing] = useState(false);
  const [outcome, setOutcome] = useState<StaffOutcome | ''>('');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState<'close' | 'correct' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // C5: starting a correction is an append-only create, keyed so a retry makes one draft.
  const keeper = useIdempotencyKeeper();
  if (!notice.actions.close && !notice.actions.correct) return null;

  async function close(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProblem(null);
    if (!outcome) {
      setProblem('Choose the outcome.');
      return;
    }
    if (note.trim().length < 3) {
      setProblem('Add a note of at least 3 characters: what happened.');
      return;
    }
    setPending('close');
    try {
      const next = await api().notices.close({ noticeId: notice.id, outcome, note: note.trim() });
      setClosing(false);
      onChanged(next, `Closed: ${NOTICE_OUTCOME_LABELS[outcome]}.`);
    } catch (failure) {
      setProblem(toProblem(failure).message);
    } finally {
      setPending(null);
    }
  }

  async function correct() {
    setPending('correct');
    setProblem(null);
    try {
      const draft = await sendOnce(keeper, (key) =>
        keyedApi(key).notices.correct({ noticeId: notice.id }),
      );
      router.push(`/notices/${draft.id}/edit`);
    } catch (failure) {
      setProblem(toProblem(failure).message);
      setPending(null);
    }
  }

  return (
    <Card data-testid="notice-close-correct">
      <CardHeader
        title="Close or correct"
        description="An issued notice is never edited. To change what it says, correct it with a new notice."
      />
      <CardBody>
        <div className="flex flex-wrap gap-2">
          {notice.actions.correct ? (
            <Button
              variant="secondary"
              pending={pending === 'correct'}
              disabled={pending !== null}
              onClick={() => void correct()}
            >
              Correct with a new notice
            </Button>
          ) : null}
          {notice.actions.close && !closing ? (
            <Button
              variant="secondary"
              disabled={pending !== null}
              onClick={() => setClosing(true)}
            >
              Close the notice
            </Button>
          ) : null}
        </div>
        {closing ? (
          <form
            onSubmit={close}
            noValidate
            aria-label="Close the notice"
            className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3"
          >
            <SelectField
              label="Outcome"
              value={outcome}
              options={[
                { value: '', label: 'Choose the outcome' },
                ...STAFF_NOTICE_OUTCOMES.map((o) => ({
                  value: o,
                  label: NOTICE_OUTCOME_LABELS[o],
                })),
              ]}
              onChange={(event) => setOutcome(event.target.value as StaffOutcome | '')}
            />
            <Field label="Note">
              {(control) => (
                <textarea
                  {...control}
                  rows={3}
                  maxLength={2000}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  className={controlClass}
                />
              )}
            </Field>
            {notice.type === 'notice_to_quit' ? (
              <p className="text-sm text-slate-700">
                Closing records the outcome only. It does not end the lease or the tenancy:
                possession needs a court or Rent Control order (Act 220 s.17).
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" pending={pending === 'close'}>
                Close with this outcome
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setClosing(false)}>
                Keep it open
              </Button>
            </div>
          </form>
        ) : null}
        {problem ? <Alert tone="error">{problem}</Alert> : null}
      </CardBody>
    </Card>
  );
}
