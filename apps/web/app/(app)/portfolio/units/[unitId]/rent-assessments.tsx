'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { FileField } from '@/components/file-field';
import { useApp } from '@/components/app-context';
import { Empty, LoadFailed, Loading } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { TextField } from '@/components/ui/field';
import { api, keyedApi } from '@/lib/api';
import { openFetchedLink } from '@/lib/browser-files';
import { formatBusinessDate, todayIn } from '@/lib/business-dates';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { sendOnce, useIdempotencyKeeper } from '@/lib/idempotency';
import { NOTICE_UPLOAD, uploadNoticeFile } from '@/lib/notice-uploads';
import { assessmentBarText, assessmentProblems } from '@/lib/rent-assessments';
import { fileProblem } from '@/lib/upload';

type Assessments = Awaited<ReturnType<ReturnType<typeof api>['rentAssessments']['list']>>;

/**
 * Rent Officer assessments of the unit (decision 3; Act 220 s.23): no notice to quit may follow
 * within the bar after one. Records are never edited. The bar's rule is shown with its status, and
 * warned about while counsel has not verified it.
 */
export function RentAssessments({
  unitId,
  canRecord,
}: {
  readonly unitId: string;
  readonly canRecord: boolean;
}) {
  const { timeZone } = useApp();
  const [data, setData] = useState<Assessments | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api().rentAssessments.list({ unitId }));
      setProblem(null);
    } catch (failure) {
      setProblem(toProblem(failure).message);
    }
  }, [unitId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function open(assessmentId: string) {
    try {
      await openFetchedLink(
        async () => (await api().rentAssessments.download({ unitId, assessmentId })).url,
      );
    } catch (failure) {
      setProblem(toProblem(failure).message);
    }
  }

  const bar = data?.bar ? assessmentBarText(data.bar) : null;
  return (
    <Card data-testid="rent-assessments">
      <CardHeader
        title="Rent Officer assessments"
        description="No notice to quit may be issued within the bar after an assessment (Act 220 s.23)."
        actions={
          canRecord && !adding ? (
            <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
              Record an assessment
            </Button>
          ) : null
        }
      />
      <CardBody>
        {bar ? (
          <Alert tone={bar.warn ? 'warning' : 'info'} title="Notices to quit are barred">
            <span data-testid="assessment-bar">{bar.text}</span>
          </Alert>
        ) : null}
        {message ? <Alert tone="success">{message}</Alert> : null}
        {adding ? (
          <RecordAssessment
            unitId={unitId}
            today={todayIn(timeZone)}
            onSaved={async () => {
              setAdding(false);
              setMessage('Assessment recorded.');
              await load();
            }}
            onCancel={() => setAdding(false)}
          />
        ) : null}
        {problem ? <LoadFailed message={problem} onRetry={() => void load()} /> : null}
        {data === null && !problem ? <Loading what="assessments" /> : null}
        {data?.assessments.length === 0 ? <Empty>No assessment is recorded.</Empty> : null}
        {data?.assessments.length ? (
          <ul className="divide-y divide-slate-100 text-sm" aria-label="Assessments">
            {data.assessments.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center gap-3 py-2"
                data-testid="rent-assessment"
              >
                <span className="font-medium">{formatBusinessDate(a.assessedOn)}</span>
                <span>Reference {a.reference}</span>
                <span className="text-slate-600">
                  Recorded {a.recordedByName ? `by ${a.recordedByName}, ` : ''}
                  {formatTime(a.recordedAt, timeZone)}
                </span>
                {a.hasDocument ? (
                  <Button size="sm" variant="ghost" onClick={() => void open(a.id)}>
                    Open the document
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </CardBody>
    </Card>
  );
}

function RecordAssessment({
  unitId,
  today,
  onSaved,
  onCancel,
}: {
  readonly unitId: string;
  readonly today: string;
  readonly onSaved: () => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [assessedOn, setAssessedOn] = useState('');
  const [reference, setReference] = useState('');
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const keeper = useIdempotencyKeeper();
  const keyedFor = useRef<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProblem(null);
    const found = assessmentProblems({ assessedOn, reference }, today);
    const document = file.current?.files?.[0] ?? null;
    const wrong = document ? fileProblem(document, NOTICE_UPLOAD) : null;
    if (wrong) found.document = wrong;
    setErrors(found);
    if (Object.keys(found).length) return;
    setPending(true);
    try {
      const uploadId = document
        ? await uploadNoticeFile(document, 'rent_assessment', api().notices)
        : null;
      const content = JSON.stringify([assessedOn, reference.trim(), Boolean(uploadId)]);
      if (keyedFor.current !== content) {
        keeper.reset();
        keyedFor.current = content;
      }
      await sendOnce(keeper, (key) =>
        keyedApi(key).rentAssessments.record({
          unitId,
          assessedOn,
          reference: reference.trim(),
          uploadId,
        }),
      );
      await onSaved();
    } catch (failure) {
      setProblem(toProblem(failure).message);
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="Record an assessment"
      className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label="Date of the assessment"
          type="date"
          max={today}
          value={assessedOn}
          error={errors.assessedOn}
          onChange={(event) => setAssessedOn(event.target.value)}
        />
        <TextField
          label="Rent Officer’s reference"
          maxLength={120}
          value={reference}
          error={errors.reference}
          onChange={(event) => setReference(event.target.value)}
        />
      </div>
      <FileField
        ref={file}
        label="The assessment document (optional)"
        rule={NOTICE_UPLOAD}
        error={errors.document}
      />
      {problem ? <Alert tone="error">{problem}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={pending}>
          Record the assessment
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
