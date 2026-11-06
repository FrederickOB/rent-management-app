'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { FileField } from '@/components/file-field';
import { useApp } from '@/components/app-context';
import { Empty, LoadFailed, Loading } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { TextField } from '@/components/ui/field';
import { api, keyedApi } from '@/lib/api';
import { openFetchedLink } from '@/lib/browser-files';
import { formatBusinessDate, todayIn } from '@/lib/business-dates';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { sendOnce, useIdempotencyKeeper } from '@/lib/idempotency';
import { NOTICE_UPLOAD, UploadCache, uploadNoticeFile } from '@/lib/notice-uploads';
import { noticeRefusal } from '@/lib/notices';
import {
  ASSESSMENT_STATUS_LABELS,
  assessmentBarState,
  assessmentProblems,
  assessmentReasonProblem,
} from '@/lib/rent-assessments';
import { fileProblem } from '@/lib/upload';

type Assessments = Awaited<ReturnType<ReturnType<typeof api>['rentAssessments']['list']>>;
type Assessment = Assessments['assessments'][number];

const REUSED =
  'An earlier attempt with other details was already recorded. The list below is up to date: check it before recording again.';

/**
 * Rent Officer assessments of the unit (decision 3; Act 220 s.23): no notice to quit may follow
 * within the bar after one. Records are never edited: a mistake is corrected by a new record that
 * replaces it, or voided, each with a reason (C4); both stay listed. The bar's rule is shown with
 * its status, and warned about while counsel has not verified it, or when none is in force.
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

  const done = async (text: string) => {
    setAdding(false);
    setMessage(text);
    await load();
  };

  const bar = data ? assessmentBarState(data.bar, data.ruleMissing) : null;
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
          <Alert tone={bar.tone} title={bar.title}>
            <span data-testid="assessment-bar">{bar.text}</span>
          </Alert>
        ) : null}
        {message ? <Alert tone="success">{message}</Alert> : null}
        {adding ? (
          <AssessmentForm
            unitId={unitId}
            today={todayIn(timeZone)}
            replacing={null}
            onSaved={() => done('Assessment recorded.')}
            onCancel={() => setAdding(false)}
            onReload={() => void load()}
          />
        ) : null}
        {problem ? <LoadFailed message={problem} onRetry={() => void load()} /> : null}
        {data === null && !problem ? <Loading what="assessments" /> : null}
        {data?.assessments.length === 0 ? <Empty>No assessment is recorded.</Empty> : null}
        {data?.assessments.length ? (
          <ul className="divide-y divide-slate-100 text-sm" aria-label="Assessments">
            {data.assessments.map((a) => (
              <AssessmentItem
                key={a.id}
                unitId={unitId}
                assessment={a}
                canChange={canRecord && a.status === 'active'}
                onOpen={() => void open(a.id)}
                onDone={done}
                onReload={() => void load()}
              />
            ))}
          </ul>
        ) : null}
      </CardBody>
    </Card>
  );
}

function AssessmentItem({
  unitId,
  assessment: a,
  canChange,
  onOpen,
  onDone,
  onReload,
}: {
  readonly unitId: string;
  readonly assessment: Assessment;
  readonly canChange: boolean;
  readonly onOpen: () => void;
  readonly onDone: (text: string) => Promise<void>;
  readonly onReload: () => void;
}) {
  const { timeZone } = useApp();
  const [mode, setMode] = useState<'view' | 'correct' | 'void'>('view');
  return (
    <li className="space-y-2 py-3" data-testid="rent-assessment" data-status={a.status}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium">{formatBusinessDate(a.assessedOn)}</span>
        <span>Reference {a.reference}</span>
        <Badge tone={a.status === 'active' ? 'green' : 'dark'}>
          {ASSESSMENT_STATUS_LABELS[a.status]}
        </Badge>
        <span className="text-slate-600">
          Recorded {a.recordedByName ? `by ${a.recordedByName}, ` : ''}
          {formatTime(a.recordedAt, timeZone)}
        </span>
        {a.hasDocument ? (
          <Button size="sm" variant="ghost" onClick={onOpen}>
            Open the document
          </Button>
        ) : null}
      </div>
      {a.replacesId ? (
        <p className="text-slate-700">
          Corrects an earlier record{a.reason ? `: ${a.reason}` : '.'}
        </p>
      ) : null}
      {a.voided ? (
        <p className="text-slate-700">
          Voided {a.voided.byName ? `by ${a.voided.byName}, ` : ''}
          {formatTime(a.voided.at, timeZone)}: {a.voided.reason}
        </p>
      ) : null}
      {canChange && mode === 'view' ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => setMode('correct')}>
            Correct it
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMode('void')}>
            Void it
          </Button>
        </div>
      ) : null}
      {mode === 'correct' ? (
        <AssessmentForm
          unitId={unitId}
          today={todayIn(timeZone)}
          replacing={a}
          onSaved={() =>
            onDone('Corrected. The new record replaces the old one, which stays listed.')
          }
          onCancel={() => setMode('view')}
          onReload={onReload}
        />
      ) : null}
      {mode === 'void' ? (
        <VoidForm
          unitId={unitId}
          assessment={a}
          onSaved={() => onDone('Voided. It stays listed, and no longer bars a notice to quit.')}
          onCancel={() => setMode('view')}
          onReload={onReload}
        />
      ) : null}
    </li>
  );
}

/** A new assessment, or the correction of one (C4); both append-only and keyed (C5). */
function AssessmentForm({
  unitId,
  today,
  replacing,
  onSaved,
  onCancel,
  onReload,
}: {
  readonly unitId: string;
  readonly today: string;
  readonly replacing: Assessment | null;
  readonly onSaved: () => Promise<void>;
  readonly onCancel: () => void;
  readonly onReload: () => void;
}) {
  const [assessedOn, setAssessedOn] = useState(replacing?.assessedOn ?? '');
  const [reference, setReference] = useState(replacing?.reference ?? '');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const keeper = useIdempotencyKeeper();
  const keyedFor = useRef<string | null>(null);
  const [uploads] = useState(() => new UploadCache());

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProblem(null);
    const found = assessmentProblems({ assessedOn, reference }, today);
    if (replacing) {
      const wrong = assessmentReasonProblem(reason);
      if (wrong) found.reason = wrong;
    }
    const document = file.current?.files?.[0] ?? null;
    const wrongFile = document ? fileProblem(document, NOTICE_UPLOAD) : null;
    if (wrongFile) found.document = wrongFile;
    setErrors(found);
    if (Object.keys(found).length) return;
    setPending(true);
    try {
      // A retry reuses the upload of the same file (review item 4).
      const uploadId = document
        ? await uploads.upload(document, 'rent_assessment', (f, purpose) =>
            uploadNoticeFile(f, purpose, api().notices),
          )
        : null;
      const body = { unitId, assessedOn, reference: reference.trim(), uploadId };
      const content = JSON.stringify([replacing?.id ?? null, body, reason.trim()]);
      if (keyedFor.current !== content) {
        keeper.reset();
        keyedFor.current = content;
      }
      await sendOnce(keeper, (key) =>
        replacing
          ? keyedApi(key).rentAssessments.correct({
              ...body,
              assessmentId: replacing.id,
              reason: reason.trim(),
            })
          : keyedApi(key).rentAssessments.record(body),
      );
      await onSaved();
    } catch (failure) {
      if (noticeRefusal(failure) === 'key_reused') {
        keeper.reset();
        keyedFor.current = null;
        setProblem(REUSED);
        onReload();
      } else {
        setProblem(toProblem(failure).message);
      }
      setPending(false);
    }
  }

  const label = replacing ? 'Correct the assessment' : 'Record an assessment';
  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={label}
      className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4"
    >
      {replacing ? (
        <p className="text-sm text-slate-700">
          The correction is a new record that replaces this one. The old record stays listed.
        </p>
      ) : null}
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
      {replacing ? (
        <TextField
          label="Why it is corrected"
          maxLength={500}
          value={reason}
          error={errors.reason}
          onChange={(event) => setReason(event.target.value)}
        />
      ) : null}
      <FileField
        ref={file}
        label="The assessment document (optional)"
        rule={NOTICE_UPLOAD}
        error={errors.document}
      />
      {problem ? <Alert tone="error">{problem}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={pending}>
          {replacing ? 'Record the correction' : 'Record the assessment'}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function VoidForm({
  unitId,
  assessment,
  onSaved,
  onCancel,
  onReload,
}: {
  readonly unitId: string;
  readonly assessment: Assessment;
  readonly onSaved: () => Promise<void>;
  readonly onCancel: () => void;
  readonly onReload: () => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const keeper = useIdempotencyKeeper();
  const keyedFor = useRef<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const wrong = assessmentReasonProblem(reason);
    setError(wrong);
    if (wrong) return;
    setPending(true);
    try {
      const content = reason.trim();
      if (keyedFor.current !== content) {
        keeper.reset();
        keyedFor.current = content;
      }
      await sendOnce(keeper, (key) =>
        keyedApi(key).rentAssessments.void({
          unitId,
          assessmentId: assessment.id,
          reason: reason.trim(),
        }),
      );
      await onSaved();
    } catch (failure) {
      if (noticeRefusal(failure) === 'key_reused') {
        keeper.reset();
        keyedFor.current = null;
        setError(REUSED);
        onReload();
      } else {
        setError(toProblem(failure).message);
      }
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="Void the assessment"
      className="space-y-3 rounded-md border border-red-200 bg-red-50 p-3"
    >
      <p className="text-sm text-red-900">
        Void this assessment, recorded in error? It stays listed as voided and no longer bars a
        notice to quit.
      </p>
      <TextField
        label="Why it is voided"
        maxLength={500}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="danger" pending={pending}>
          Void it
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Keep it
        </Button>
      </div>
    </form>
  );
}
