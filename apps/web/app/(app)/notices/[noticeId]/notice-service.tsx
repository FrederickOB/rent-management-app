'use client';

import type { NoticeDetail } from '@rent/contracts';
import { SERVICE_METHOD_LABELS, SERVICE_METHODS, type ServiceMethod } from '@rent/domain/notices';
import { useRef, useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { FileField } from '@/components/file-field';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { CheckboxField, Field, SelectField, TextField, controlClass } from '@/components/ui/field';
import { api, keyedApi } from '@/lib/api';
import { openFetchedLink } from '@/lib/browser-files';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { sendOnce, useIdempotencyKeeper } from '@/lib/idempotency';
import { NOTICE_UPLOAD, UploadCache, uploadNoticeFile } from '@/lib/notice-uploads';
import { instantOfLocal, localNow, noticeRefusal } from '@/lib/notices';
import { fileProblem } from '@/lib/upload';

/**
 * Physical service (LN-05; plan 4.7; decision 10): how, when and by whom the notice was served,
 * with a witness, a photo of the posted notice and a sworn affidavit. A record is never edited; a
 * correction is a new record that names the one it corrects.
 */
export function ServiceCard({
  notice,
  personId,
  onChanged,
  onReload,
}: {
  readonly notice: NoticeDetail;
  readonly personId: string;
  readonly onChanged: (next: NoticeDetail, text?: string) => void;
  /** Fetch the notice again, so the records shown are the API's. */
  readonly onReload: () => void;
}) {
  const { timeZone } = useApp();
  const [recording, setRecording] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function open(which: 'service_photo' | 'affidavit', recordId: string) {
    setProblem(null);
    try {
      await openFetchedLink(
        async () => (await api().notices.download({ noticeId: notice.id, which, recordId })).url,
      );
    } catch (failure) {
      setProblem(toProblem(failure).message);
    }
  }

  const recipientName = (id: string | null) =>
    id ? (notice.recipients.find((r) => r.id === id)?.name ?? 'A recipient') : 'The premises';

  return (
    <Card data-testid="notice-service">
      <CardHeader
        title="Physical service"
        description={
          notice.type === 'notice_to_quit'
            ? 'Every notice to quit is also posted on the premises, whether or not the tenant signs (OQ-10).'
            : 'Recorded when the notice is served by hand, by post or on the premises.'
        }
        actions={
          notice.actions.recordService && !recording ? (
            <Button size="sm" variant="secondary" onClick={() => setRecording(true)}>
              Record service
            </Button>
          ) : null
        }
      />
      <CardBody>
        {recording ? (
          <ServiceForm
            notice={notice}
            personId={personId}
            onSaved={(next) => {
              setRecording(false);
              onChanged(next, 'Service recorded.');
            }}
            onCancel={() => setRecording(false)}
            onReload={onReload}
          />
        ) : null}
        {notice.serviceRecords.length === 0 ? (
          <p className="text-sm text-slate-600">No physical service is recorded yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm" aria-label="Service records">
            {notice.serviceRecords.map((record) => (
              <li key={record.id} className="space-y-1 py-3" data-testid="service-record">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{record.methodLabel}</span>
                  <span>
                    <time dateTime={record.servedAt}>{formatTime(record.servedAt, timeZone)}</time>
                  </span>
                  {record.correctedByRecordId ? <Badge tone="dark">Corrected</Badge> : null}
                  {record.correctsRecordId ? <Badge tone="blue">A correction</Badge> : null}
                </p>
                <p className="text-slate-700">
                  {recipientName(record.recipientId)} · served by {record.servedByName}
                  {record.witnessName ? ` · witnessed by ${record.witnessName}` : ''}
                </p>
                {record.notes ? (
                  <p className="whitespace-pre-wrap text-slate-700">{record.notes}</p>
                ) : null}
                <p className="text-xs text-slate-600">
                  Recorded {record.recordedByName ? `by ${record.recordedByName}, ` : ''}
                  {formatTime(record.recordedAt, timeZone)}
                </p>
                <div className="flex flex-wrap gap-2">
                  {record.hasPhoto ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void open('service_photo', record.id)}
                    >
                      Open the photo
                    </Button>
                  ) : null}
                  {record.hasAffidavit ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void open('affidavit', record.id)}
                    >
                      Open the affidavit
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        {problem ? <Alert tone="error">{problem}</Alert> : null}
      </CardBody>
    </Card>
  );
}

function ServiceForm({
  notice,
  personId,
  onSaved,
  onCancel,
  onReload,
}: {
  readonly notice: NoticeDetail;
  readonly personId: string;
  readonly onSaved: (next: NoticeDetail) => void;
  readonly onCancel: () => void;
  readonly onReload: () => void;
}) {
  const { timeZone } = useApp();
  const [method, setMethod] = useState<ServiceMethod>(
    notice.type === 'notice_to_quit' ? 'posted_on_premises' : 'handed_to_tenant',
  );
  // To the second, so a notice served moments after it was issued is not dated before its issue.
  const [servedAt, setServedAt] = useState(() => localNow(timeZone, new Date(), 'second'));
  const [byMe, setByMe] = useState(true);
  const [servedByName, setServedByName] = useState('');
  const [witness, setWitness] = useState('');
  const [recipientId, setRecipientId] = useState('');
  const [notes, setNotes] = useState('');
  const [corrects, setCorrects] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const photo = useRef<HTMLInputElement>(null);
  const affidavit = useRef<HTMLInputElement>(null);
  const keeper = useIdempotencyKeeper();
  const keyedFor = useRef<string | null>(null);
  const [uploads] = useState(() => new UploadCache());
  const correctable = notice.serviceRecords.filter((r) => !r.correctedByRecordId);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const at = instantOfLocal(servedAt, timeZone);
    if (!at) {
      setError('Give the date and time it was served.');
      return;
    }
    if (!byMe && servedByName.trim().length < 2) {
      setError('Say who served it.');
      return;
    }
    const files = [
      { input: photo.current?.files?.[0] ?? null, purpose: 'service_photo' as const },
      { input: affidavit.current?.files?.[0] ?? null, purpose: 'affidavit' as const },
    ];
    for (const { input } of files) {
      const wrong = input ? fileProblem(input, NOTICE_UPLOAD) : null;
      if (wrong) {
        setError(wrong);
        return;
      }
    }
    setPending(true);
    try {
      // A retry reuses the upload of the same file (review item 4).
      const [photoUploadId, affidavitUploadId] = await Promise.all(
        files.map(({ input, purpose }) =>
          input
            ? uploads.upload(input, purpose, (file, p) => uploadNoticeFile(file, p, api().notices))
            : Promise.resolve(null),
        ),
      );
      const body = {
        noticeId: notice.id,
        method,
        servedAt: at,
        ...(byMe ? { servedByPersonId: personId } : { servedByName: servedByName.trim() }),
        witnessName: witness.trim() || null,
        recipientId: recipientId || null,
        notes: notes.trim() || null,
        photoUploadId,
        affidavitUploadId,
        correctsRecordId: corrects || null,
      };
      // A changed record is a new submission with a new key (M6 lesson).
      const content = JSON.stringify(body);
      if (keyedFor.current !== content) {
        keeper.reset();
        keyedFor.current = content;
      }
      onSaved(await sendOnce(keeper, (key) => keyedApi(key).notices.recordService(body)));
    } catch (failure) {
      if (noticeRefusal(failure) === 'key_reused') {
        keeper.reset();
        keyedFor.current = null;
        setError(
          'An earlier attempt with other details was already recorded. The list above is up to date: check it before recording again.',
        );
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
      aria-label="Record service"
      className="space-y-4 rounded-md border border-slate-200 bg-slate-50 p-4"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label="How it was served"
          value={method}
          options={SERVICE_METHODS.map((m) => ({ value: m, label: SERVICE_METHOD_LABELS[m] }))}
          onChange={(event) => setMethod(event.target.value as ServiceMethod)}
        />
        <TextField
          label="When"
          type="datetime-local"
          step={1}
          hint={`Company time (${timeZone}).`}
          value={servedAt}
          onChange={(event) => setServedAt(event.target.value)}
        />
        <SelectField
          label="Served on"
          value={recipientId}
          options={[
            { value: '', label: 'The premises as a whole' },
            ...notice.recipients.map((r) => ({ value: r.id, label: r.name })),
          ]}
          onChange={(event) => setRecipientId(event.target.value)}
        />
        <TextField
          label="Witness (optional)"
          maxLength={120}
          value={witness}
          onChange={(event) => setWitness(event.target.value)}
        />
      </div>
      <CheckboxField
        label="I served it myself"
        checked={byMe}
        onChange={(event) => setByMe(event.target.checked)}
      />
      {!byMe ? (
        <TextField
          label="Who served it"
          maxLength={120}
          value={servedByName}
          onChange={(event) => setServedByName(event.target.value)}
        />
      ) : null}
      <Field label="Notes (optional)">
        {(control) => (
          <textarea
            {...control}
            rows={3}
            maxLength={2000}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            className={controlClass}
          />
        )}
      </Field>
      <FileField ref={photo} label="Photo of the posted notice (optional)" rule={NOTICE_UPLOAD} />
      <FileField ref={affidavit} label="Sworn affidavit (optional)" rule={NOTICE_UPLOAD} />
      {correctable.length ? (
        <SelectField
          label="Does this correct an earlier record?"
          hint="Records are never edited: a correction is a new record that names the one it corrects."
          value={corrects}
          options={[
            { value: '', label: 'No, it is a new record' },
            ...correctable.map((r) => ({
              value: r.id,
              label: `${r.methodLabel}, ${formatTime(r.servedAt, timeZone)}`,
            })),
          ]}
          onChange={(event) => setCorrects(event.target.value)}
        />
      ) : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={pending}>
          Record the service
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
