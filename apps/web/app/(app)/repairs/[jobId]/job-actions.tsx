'use client';

import type { MaintenanceJobDetail } from '@rent/contracts';
import type { MaintenanceAttachmentStage, MediaKind } from '@rent/domain/maintenance';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useApp } from '@/components/app-context';
import { anyRefused, MediaPicker, usableFiles, type PickedFile } from '@/components/media';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { SelectField, TextAreaField, TextField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { errorCode, toProblem } from '@/lib/errors';
import { useHoldWhileSending } from '@/lib/in-flight';
import {
  categoryOf,
  CATEGORY_OPTIONS,
  completeProblems,
  isStaleStep,
  MAINTENANCE_FIELD_OF_CODE,
  maintenanceMessage,
  noteProblem,
  priorityOf,
  PRIORITY_OPTIONS,
  reasonProblem,
  responseProblems,
  STAGE_LABELS,
  startProblems,
  triageProblems,
} from '@/lib/maintenance';
import { MediaRefused, MediaUploads } from '@/lib/media-upload';
import { instantOfLocal, localNow } from '@/lib/notices';
import { StorageUploadError } from '@/lib/upload';
import { useAssignees } from '@/lib/use-assignees';

type Step =
  | 'triage'
  | 'priority'
  | 'assign'
  | 'unassign'
  | 'visit'
  | 'start'
  | 'complete'
  | 'response'
  | 'close'
  | 'cancel'
  | 'media'
  | 'note';

const STEP_BUTTONS: readonly {
  step: Step;
  action: keyof MaintenanceJobDetail['actions'];
  text: string;
}[] = [
  { step: 'triage', action: 'triage', text: 'Triage' },
  { step: 'assign', action: 'assign', text: 'Assign' },
  { step: 'start', action: 'start', text: 'Start the work' },
  { step: 'complete', action: 'complete', text: 'Mark the work done' },
  { step: 'response', action: 'recordResponse', text: 'Record the tenant’s answer' },
  { step: 'close', action: 'close', text: 'Close the job' },
  { step: 'visit', action: 'planVisit', text: 'Plan a visit' },
  { step: 'priority', action: 'changePriority', text: 'Change the priority' },
  { step: 'unassign', action: 'unassign', text: 'Take it back' },
  { step: 'media', action: 'addMedia', text: 'Add photos or recordings' },
  { step: 'note', action: 'addNote', text: 'Add a note' },
  { step: 'cancel', action: 'cancel', text: 'Cancel the job' },
];

/** The step the job is waiting for, offered first. */
const MAIN_STEP: Partial<Record<MaintenanceJobDetail['status'], Step>> = {
  reported: 'triage',
  triaged: 'assign',
  assigned: 'start',
  in_progress: 'complete',
  work_done: 'response',
};

/** Where a job waits for staff to close it, closing is the step offered first. */
const mainStep = (job: MaintenanceJobDetail): Step | undefined =>
  job.status === 'work_done' && job.actions.close ? 'close' : MAIN_STEP[job.status];

const PHOTOS: readonly MediaKind[] = ['image'];
const ANY_MEDIA: readonly MediaKind[] = ['image', 'video', 'audio'];

type Changed = (next: MaintenanceJobDetail, text: string) => void;

interface StepProps {
  readonly job: MaintenanceJobDetail;
  readonly onDone: Changed;
  readonly onStale: (text: string) => Promise<void>;
  readonly onCancel: () => void;
}

/** The steps the reader may take now: each one the API's `actions` allow, and nothing else. */
export function JobActions({
  job,
  can,
  onChanged,
  onStale,
}: {
  readonly job: MaintenanceJobDetail;
  readonly can: { readonly listStaff: boolean; readonly listArtisans: boolean };
  readonly onChanged: Changed;
  readonly onStale: (text: string) => Promise<void>;
}) {
  const [open, setOpen] = useState<Step | null>(null);
  const main = mainStep(job);
  const buttons = STEP_BUTTONS.filter((b) => job.actions[b.action]);
  const props: StepProps = {
    job,
    onDone: (next, text) => {
      setOpen(null);
      onChanged(next, text);
    },
    onStale: async (text) => {
      setOpen(null);
      await onStale(text);
    },
    onCancel: () => setOpen(null),
  };

  return (
    <Card data-testid="job-actions">
      <CardHeader title="What happens next" />
      <CardBody>
        {open === null ? (
          <div className="flex flex-wrap gap-2">
            {buttons.map((b) => (
              <Button
                key={b.step}
                variant={b.step === main ? 'primary' : b.step === 'cancel' ? 'ghost' : 'secondary'}
                onClick={() => setOpen(b.step)}
              >
                {b.text}
              </Button>
            ))}
          </div>
        ) : null}
        {open === 'triage' ? <TriageForm {...props} /> : null}
        {open === 'priority' ? <PriorityForm {...props} /> : null}
        {open === 'assign' ? <AssignForm {...props} can={can} /> : null}
        {open === 'unassign' ? (
          <ReasonStep
            {...props}
            label="Take the job back"
            intro="It goes back to Triaged. An artisan’s job sheet stops working."
            submit="Take it back"
            send={(reason) => api().maintenance.unassign({ jobId: job.id, reason })}
            done="Took the job back."
          />
        ) : null}
        {open === 'cancel' ? (
          <ReasonStep
            {...props}
            label="Cancel the job"
            intro="For a duplicate, or a repair that is not needed. It is kept, marked cancelled."
            submit="Cancel the job"
            danger
            send={(reason) => api().maintenance.cancel({ jobId: job.id, reason })}
            done="Cancelled the job."
          />
        ) : null}
        {open === 'visit' ? <VisitForm {...props} /> : null}
        {open === 'start' ? <StartForm {...props} /> : null}
        {open === 'complete' ? <CompleteForm {...props} /> : null}
        {open === 'response' ? <ResponseForm {...props} /> : null}
        {open === 'close' ? <CloseForm {...props} /> : null}
        {open === 'media' ? <MediaForm {...props} /> : null}
        {open === 'note' ? <NoteForm {...props} /> : null}
      </CardBody>
    </Card>
  );
}

/**
 * Sends a step and sorts out the answer: the new job; a refusal because the job moved on (the
 * page reloads); a refusal that names a field; or a message.
 */
function useStep(props: StepProps) {
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<string, string>>>({});
  useHoldWhileSending(pending);

  async function run(
    send: () => Promise<MaintenanceJobDetail>,
    done: string,
    onMediaRefused?: () => void,
  ): Promise<void> {
    setPending(true);
    setError(null);
    setFieldErrors({});
    try {
      const next = await send();
      setStatus(null);
      props.onDone(next, done);
    } catch (failure) {
      setStatus(null);
      if (isStaleStep(failure)) {
        await props.onStale(maintenanceMessage(failure) ?? toProblem(failure).message);
        return;
      }
      if (failure instanceof MediaRefused || failure instanceof StorageUploadError) {
        setError(failure.message);
        return;
      }
      const code = errorCode(failure);
      if (code.startsWith('MEDIA_')) onMediaRefused?.();
      const message = maintenanceMessage(failure) ?? toProblem(failure).message;
      const field = MAINTENANCE_FIELD_OF_CODE[code];
      if (field) setFieldErrors({ [field]: message });
      else setError(message);
    } finally {
      setPending(false);
    }
  }

  return { pending, status, setStatus, error, fieldErrors, run };
}

function StepForm({
  label,
  children,
  error,
  status,
  pending,
  submit,
  danger,
  onCancel,
  onSubmit,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly error: string | null;
  readonly status?: string | null;
  readonly pending: boolean;
  readonly submit: string;
  readonly danger?: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form
      onSubmit={onSubmit}
      noValidate
      aria-label={label}
      className="space-y-4 rounded-md border border-slate-200 bg-slate-50 p-4"
    >
      <p className="text-sm font-semibold text-slate-900">{label}</p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {children}
      {status ? (
        <p role="status" className="text-sm text-slate-700">
          {status}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant={danger ? 'danger' : 'primary'} pending={pending}>
          {submit}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function TriageForm(props: StepProps) {
  const { job } = props;
  const [priority, setPriority] = useState<string>(
    job.priority ?? (job.emergencyFlag ? 'emergency' : ''),
  );
  const [category, setCategory] = useState<string>(job.category ?? '');
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const step = useStep(props);
  const problems = triageProblems({ priority, category });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    const p = priorityOf(priority);
    const c = categoryOf(category);
    if (!p || !c || note.trim().length > 2000) return;
    void step.run(
      () =>
        api().maintenance.triage({
          jobId: job.id,
          priority: p,
          category: c,
          note: note.trim() || null,
        }),
      p === 'emergency'
        ? 'Triaged as an emergency. The property’s managers and caretakers are alerted at once.'
        : 'Triaged. The target times now run from the report.',
    );
  }

  return (
    <StepForm
      label="Triage the job"
      error={step.error}
      pending={step.pending}
      submit="Save the triage"
      onCancel={props.onCancel}
      onSubmit={submit}
    >
      {job.emergencyFlag ? (
        <Alert tone="warning" live={false}>
          The tenant said this is an emergency. Lowering the priority is kept in the record.
        </Alert>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label="Priority"
          value={priority}
          error={tried ? problems.priority : undefined}
          hint="An emergency alerts the managers and caretakers on WhatsApp and by SMS at once."
          options={[{ value: '', label: 'Choose the priority' }, ...PRIORITY_OPTIONS]}
          onChange={(event) => setPriority(event.target.value)}
        />
        <SelectField
          label="Category"
          value={category}
          error={tried ? problems.category : undefined}
          options={[{ value: '', label: 'Choose the category' }, ...CATEGORY_OPTIONS]}
          onChange={(event) => setCategory(event.target.value)}
        />
      </div>
      <TextAreaField
        label="Note (optional)"
        rows={2}
        maxLength={2000}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        className="[&_textarea]:font-sans"
      />
    </StepForm>
  );
}

function PriorityForm(props: StepProps) {
  const { job } = props;
  const [priority, setPriority] = useState<string>(job.priority ?? '');
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const step = useStep(props);
  const reasonError = reasonProblem(reason);
  const p = priorityOf(priority);
  const same = p !== null && p === job.priority;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    if (!p || same || reasonError) return;
    void step.run(
      () => api().maintenance.changePriority({ jobId: job.id, priority: p, reason: reason.trim() }),
      p === 'emergency'
        ? 'Raised to an emergency. The property’s managers and caretakers are alerted at once.'
        : 'Changed the priority.',
    );
  }

  return (
    <StepForm
      label="Change the priority"
      error={step.error}
      pending={step.pending}
      submit="Change the priority"
      onCancel={props.onCancel}
      onSubmit={submit}
    >
      <SelectField
        label="New priority"
        value={priority}
        error={
          tried && (!p || same)
            ? same
              ? 'Choose a different priority'
              : 'Choose the priority'
            : undefined
        }
        options={[{ value: '', label: 'Choose the priority' }, ...PRIORITY_OPTIONS]}
        onChange={(event) => setPriority(event.target.value)}
        className="max-w-sm"
      />
      <TextAreaField
        label="Reason"
        hint="Kept in the record with who changed it and when."
        rows={2}
        maxLength={500}
        value={reason}
        error={tried ? (reasonError ?? step.fieldErrors.reason) : step.fieldErrors.reason}
        onChange={(event) => setReason(event.target.value)}
        className="[&_textarea]:font-sans"
      />
    </StepForm>
  );
}

function AssignForm(
  props: StepProps & {
    readonly can: { readonly listStaff: boolean; readonly listArtisans: boolean };
  },
) {
  const { job } = props;
  const { timeZone } = useApp();
  const options = useAssignees(props.can);
  const [assignee, setAssignee] = useState('');
  const [due, setDue] = useState('');
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const step = useStep(props);
  const chosen = options.find((o) => o.value === assignee) ?? null;
  const dueAt = due ? instantOfLocal(due, timeZone) : null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    if (!chosen || (due && !dueAt) || note.trim().length > 2000) return;
    const id = chosen.value.slice(chosen.value.indexOf(':') + 1);
    void step.run(
      () =>
        api().maintenance.assign({
          jobId: job.id,
          assignee:
            chosen.kind === 'staff'
              ? { kind: 'staff', personId: id }
              : { kind: 'artisan', artisanId: id },
          dueAt,
          note: note.trim() || null,
        }),
      chosen.kind === 'staff'
        ? `Assigned to ${chosen.label}. It is on their Tasks list.`
        : `Assigned to ${chosen.label}. Their job sheet link is on its way by WhatsApp or SMS.`,
    );
  }

  return (
    <StepForm
      label="Assign the job"
      error={step.error}
      pending={step.pending}
      submit="Assign"
      onCancel={props.onCancel}
      onSubmit={submit}
    >
      <p className="text-sm text-slate-700">
        Staff get a task. An artisan gets a job sheet by WhatsApp or SMS, showing the unit, the
        description, the photos and the property contact’s phone, never the tenant’s.
      </p>
      <SelectField
        label="Assign to"
        value={assignee}
        error={tried && !chosen ? 'Choose who does the work' : undefined}
        options={[
          {
            value: '',
            label: options.length ? 'Choose a person or an artisan' : 'Nobody to choose yet',
          },
          ...options.map((o) => ({ value: o.value, label: o.label })),
        ]}
        onChange={(event) => setAssignee(event.target.value)}
      />
      <TextField
        label={`Due (optional, ${timeZone})`}
        type="datetime-local"
        min={localNow(timeZone)}
        value={due}
        error={tried && due && !dueAt ? 'Choose a date and time' : undefined}
        onChange={(event) => setDue(event.target.value)}
        className="max-w-xs"
      />
      <TextAreaField
        label="Note for them (optional)"
        rows={2}
        maxLength={2000}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        className="[&_textarea]:font-sans"
      />
    </StepForm>
  );
}

function ReasonStep(
  props: StepProps & {
    readonly label: string;
    readonly intro: string;
    readonly submit: string;
    readonly danger?: boolean;
    readonly send: (reason: string) => Promise<MaintenanceJobDetail>;
    readonly done: string;
  },
) {
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const step = useStep(props);
  const problem = reasonProblem(reason);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    if (problem) return;
    void step.run(() => props.send(reason.trim()), props.done);
  }

  return (
    <StepForm
      label={props.label}
      error={step.error}
      pending={step.pending}
      submit={props.submit}
      danger={props.danger}
      onCancel={props.onCancel}
      onSubmit={submit}
    >
      <p className="text-sm text-slate-700">{props.intro}</p>
      <TextAreaField
        label="Reason"
        hint="Kept in the record."
        rows={2}
        maxLength={500}
        value={reason}
        error={tried ? (problem ?? step.fieldErrors.reason) : step.fieldErrors.reason}
        onChange={(event) => setReason(event.target.value)}
        className="[&_textarea]:font-sans"
      />
    </StepForm>
  );
}

function VisitForm(props: StepProps) {
  const { job } = props;
  const { timeZone } = useApp();
  const [at, setAt] = useState('');
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const step = useStep(props);
  const visitAt = at ? instantOfLocal(at, timeZone) : null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    if (!visitAt || note.trim().length > 500) return;
    void step.run(
      () => api().maintenance.planVisit({ jobId: job.id, visitAt, note: note.trim() || null }),
      'Planned the visit. The tenant is told on their channel.',
    );
  }

  return (
    <StepForm
      label="Plan a visit"
      error={step.error}
      pending={step.pending}
      submit="Plan the visit"
      onCancel={props.onCancel}
      onSubmit={submit}
    >
      <TextField
        label={`When (${timeZone})`}
        type="datetime-local"
        min={localNow(timeZone)}
        value={at}
        error={tried && !visitAt ? 'Choose the date and time of the visit' : undefined}
        onChange={(event) => setAt(event.target.value)}
        className="max-w-xs"
      />
      <TextAreaField
        label="Note for the tenant (optional)"
        rows={2}
        maxLength={500}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        className="[&_textarea]:font-sans"
      />
    </StepForm>
  );
}

function useJobUploads(kinds: readonly MediaKind[]) {
  const [uploads] = useState(
    () => new MediaUploads(kinds, (input) => api().maintenance.createUpload(input)),
  );
  return uploads;
}

function StartForm(props: StepProps) {
  const { job } = props;
  const uploads = useJobUploads(PHOTOS);
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const step = useStep(props);
  const usable = usableFiles(files);
  const problems = startProblems({ photoCount: usable.length, reason });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    if (anyRefused(files) || problems.photos || problems.reason) return;
    void step.run(
      async () => {
        let uploadIds: string[] = [];
        if (usable.length > 0) {
          step.setStatus('Uploading the photos…');
          uploadIds = await uploads.idsFor(usable, (done) =>
            step.setStatus(`Uploading the photos… ${done} of ${usable.length}`),
          );
        }
        step.setStatus('Recording the start…');
        return api().maintenance.start({
          jobId: job.id,
          uploadIds,
          beforePhotoReason: usable.length > 0 ? null : reason.trim(),
        });
      },
      'Recorded that the work has started.',
      () => uploads.forget(usable),
    );
  }

  return (
    <StepForm
      label="Start the work"
      error={step.error}
      status={step.status}
      pending={step.pending}
      submit="Record the start"
      onCancel={props.onCancel}
      onSubmit={submit}
    >
      <MediaPicker
        label="Before photos"
        kinds={PHOTOS}
        files={files}
        onChange={setFiles}
        disabled={step.pending}
        capture
        note="Add a photo of the problem before work starts, or say below why there is none."
        error={tried ? (problems.photos ?? step.fieldErrors.photos) : step.fieldErrors.photos}
      />
      <TextAreaField
        label="No before photo, because (only without a photo)"
        hint="For example: emergency, no time. Kept in the record."
        rows={2}
        maxLength={500}
        value={reason}
        disabled={usable.length > 0}
        error={tried ? (problems.reason ?? step.fieldErrors.reason) : step.fieldErrors.reason}
        onChange={(event) => setReason(event.target.value)}
        className="[&_textarea]:font-sans"
      />
    </StepForm>
  );
}

/**
 * Marking the work done (MI-06, ★): an after photo and a completion note are both required, said
 * before the form is sent; the API and the database refuse it without them too.
 */
function CompleteForm(props: StepProps) {
  const { job } = props;
  const uploads = useJobUploads(PHOTOS);
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const step = useStep(props);
  const usable = usableFiles(files);
  const problems = completeProblems({ photoCount: usable.length, note });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    if (anyRefused(files) || problems.photos || problems.note) return;
    void step.run(
      async () => {
        step.setStatus('Uploading the photos…');
        const uploadIds = await uploads.idsFor(usable, (done) =>
          step.setStatus(`Uploading the photos… ${done} of ${usable.length}`),
        );
        step.setStatus('Recording the work as done…');
        return api().maintenance.complete({
          jobId: job.id,
          uploadIds,
          completionNote: note.trim(),
        });
      },
      'Marked the work done. The tenant is asked to confirm it, or say what is still wrong.',
      () => uploads.forget(usable),
    );
  }

  return (
    <StepForm
      label="Mark the work done"
      error={step.error}
      status={step.status}
      pending={step.pending}
      submit="Mark the work done"
      onCancel={props.onCancel}
      onSubmit={submit}
    >
      <Alert tone="info" live={false} title="Both are required">
        At least one photo of the finished work, and a note of what was done. The job cannot be
        marked done without them.
      </Alert>
      <MediaPicker
        label="After photos (required)"
        kinds={PHOTOS}
        files={files}
        onChange={setFiles}
        disabled={step.pending}
        capture
        error={tried ? (problems.photos ?? step.fieldErrors.photos) : step.fieldErrors.photos}
      />
      <TextAreaField
        label="Completion note (required)"
        hint="What was done, and anything the tenant or the owner should know."
        rows={3}
        maxLength={2000}
        value={note}
        error={tried ? (problems.note ?? step.fieldErrors.note) : step.fieldErrors.note}
        onChange={(event) => setNote(event.target.value)}
        className="[&_textarea]:font-sans"
      />
    </StepForm>
  );
}

function ResponseForm(props: StepProps) {
  const { job } = props;
  const [response, setResponse] = useState<'confirmed' | 'disputed' | ''>('');
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const step = useStep(props);
  const problems = responseProblems({ response, reason });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    if (!response || problems.response || problems.reason) return;
    void step.run(
      () =>
        api().maintenance.recordResponse({
          jobId: job.id,
          response,
          reason: response === 'disputed' ? reason.trim() : null,
        }),
      response === 'confirmed'
        ? 'Recorded the tenant’s confirmation. The job is closed.'
        : 'Recorded the dispute. The job is back in progress.',
    );
  }

  return (
    <StepForm
      label="Record the tenant’s answer"
      error={step.error}
      pending={step.pending}
      submit="Record the answer"
      onCancel={props.onCancel}
      onSubmit={submit}
    >
      <p className="text-sm text-slate-700">
        For a tenant who answered in person or by phone. Answers in the app, on WhatsApp or by SMS
        are recorded by themselves.
      </p>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-slate-800">What the tenant said</legend>
        {(
          [
            ['confirmed', 'The work is done (the job closes)'],
            ['disputed', 'Something is still wrong (it goes back to In progress)'],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="flex min-h-11 items-center gap-3 text-sm">
            <input
              type="radio"
              name="tenant-response"
              value={value}
              checked={response === value}
              onChange={() => setResponse(value)}
              className="size-5"
            />
            {label}
          </label>
        ))}
        {tried && problems.response ? (
          <p className="text-sm font-medium text-red-700">{problems.response}</p>
        ) : null}
      </fieldset>
      {response === 'disputed' ? (
        <TextAreaField
          label="What is still wrong"
          rows={2}
          maxLength={1000}
          value={reason}
          error={tried ? problems.reason : undefined}
          onChange={(event) => setReason(event.target.value)}
          className="[&_textarea]:font-sans"
        />
      ) : null}
    </StepForm>
  );
}

/**
 * A job with no tenant to confirm it (a common area, an empty unit) is closed by staff once the
 * work is done; a tenant's job closes on their answer or after the auto-close days.
 */
function CloseForm(props: StepProps) {
  const { job } = props;
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const step = useStep(props);
  const tooLong = note.trim().length > 1000;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    if (tooLong) return;
    void step.run(
      () => api().maintenance.close({ jobId: job.id, note: note.trim() || null }),
      'Closed the job. Any artisan’s job sheet link has stopped working.',
    );
  }

  return (
    <StepForm
      label="Close the job"
      error={step.error}
      pending={step.pending}
      submit="Close the job"
      onCancel={props.onCancel}
      onSubmit={submit}
    >
      <p className="text-sm text-slate-700">
        There is no tenant to confirm the work, so close it once you have checked it.
      </p>
      <TextAreaField
        label="Note (optional)"
        rows={2}
        maxLength={1000}
        value={note}
        error={tried && tooLong ? 'Use at most 1,000 characters' : undefined}
        onChange={(event) => setNote(event.target.value)}
        className="[&_textarea]:font-sans"
      />
    </StepForm>
  );
}

function MediaForm(props: StepProps) {
  const { job } = props;
  const uploads = useJobUploads(ANY_MEDIA);
  const [stage, setStage] = useState<MaintenanceAttachmentStage>('other');
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [tried, setTried] = useState(false);
  const step = useStep(props);
  const usable = usableFiles(files);
  const problem = usable.length === 0 ? 'Choose at least one file' : null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    if (problem || anyRefused(files) || usable.length > 10) return;
    void step.run(
      async () => {
        step.setStatus('Uploading…');
        const uploadIds = await uploads.idsFor(usable, (done) =>
          step.setStatus(`Uploading… ${done} of ${usable.length}`),
        );
        step.setStatus('Adding them to the job…');
        return api().maintenance.addMedia({ jobId: job.id, stage, uploadIds });
      },
      usable.length === 1 ? 'Added the file.' : `Added ${usable.length} files.`,
      () => uploads.forget(usable),
    );
  }

  return (
    <StepForm
      label="Add photos, videos or voice notes"
      error={step.error}
      status={step.status}
      pending={step.pending}
      submit="Add them"
      onCancel={props.onCancel}
      onSubmit={submit}
    >
      <SelectField
        label="Taken"
        value={stage}
        options={(['before', 'after', 'other'] as const).map((s) => ({
          value: s,
          label: STAGE_LABELS[s],
        }))}
        onChange={(event) => {
          const value = event.target.value;
          if (value === 'before' || value === 'after' || value === 'other') setStage(value);
        }}
        className="max-w-xs"
      />
      <MediaPicker
        label="Files"
        kinds={ANY_MEDIA}
        files={files}
        onChange={setFiles}
        disabled={step.pending}
        error={tried ? problem : undefined}
      />
    </StepForm>
  );
}

function NoteForm(props: StepProps) {
  const { job } = props;
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const step = useStep(props);
  const problem = noteProblem(note);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    if (problem) return;
    void step.run(
      () => api().maintenance.addNote({ jobId: job.id, note: note.trim() }),
      'Added the note.',
    );
  }

  return (
    <StepForm
      label="Add a note"
      error={step.error}
      pending={step.pending}
      submit="Add the note"
      onCancel={props.onCancel}
      onSubmit={submit}
    >
      <TextAreaField
        label="Note"
        hint="Staff see it on the timeline; the tenant does not."
        rows={3}
        maxLength={2000}
        value={note}
        error={tried ? problem : undefined}
        onChange={(event) => setNote(event.target.value)}
        className="[&_textarea]:font-sans"
      />
    </StepForm>
  );
}
