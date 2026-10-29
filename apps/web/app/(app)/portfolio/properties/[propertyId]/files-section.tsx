'use client';

import type { PropertyFileRow } from '@rent/contracts';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { ConfirmBox } from '@/components/confirm-box';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { SelectField, TextField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { openFetchedLink } from '@/lib/browser-files';
import { toProblem } from '@/lib/errors';
import { formatDate } from '@/lib/format';
import { FILE_CATEGORY_LABELS, PAPER_CATEGORIES, type FileCategory } from '@/lib/register-format';
import {
  acceptFor,
  fileProblem,
  fileTypesLabel,
  PAPER_UPLOAD,
  PHOTO_UPLOAD,
  sendToStorage,
  sizeLabel,
  StorageUploadError,
} from '@/lib/upload';
import { useInterval } from '@/lib/use-interval';

const POLL_MS = 2_000;

type Status =
  | { readonly kind: 'idle' }
  | { readonly kind: 'working'; readonly label: string }
  | { readonly kind: 'done' | 'error'; readonly message: string };

/**
 * Photos and papers (PR-04). Lists show thumbnails, so the page stays light on 3G; a file opens
 * through a 5-minute link issued after the policy check. Papers are listed only for people who
 * may see them (M2 decision 4: not caretakers).
 */
export function FilesSection({
  propertyId,
  canUpload,
  canSeePhotos,
  canSeePapers,
}: {
  readonly propertyId: string;
  readonly canUpload: boolean;
  readonly canSeePhotos: boolean;
  readonly canSeePapers: boolean;
}) {
  const { timeZone } = useApp();
  const [files, setFiles] = useState<readonly PropertyFileRow[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setFiles(await api().propertyFiles.list({ propertyId }));
      setProblem(null);
    } catch (failure) {
      setProblem(toProblem(failure).message);
    }
  }, [propertyId]);

  useEffect(() => {
    void load();
  }, [load]);
  // Photos are re-encoded by the worker; keep checking until each one is ready or failed.
  const processing = files?.some((f) => f.status === 'processing') ?? false;
  useInterval(() => void load(), processing ? POLL_MS : null);

  async function open(file: PropertyFileRow) {
    setProblem(null);
    try {
      await openFetchedLink(
        async () => (await api().propertyFiles.download({ fileId: file.id })).url,
      );
    } catch (failure) {
      setProblem(toProblem(failure).message);
    }
  }

  async function remove(file: PropertyFileRow) {
    setBusy(true);
    try {
      await api().propertyFiles.archive({ fileId: file.id });
      setRemoving(null);
      setFiles((current) => current?.filter((f) => f.id !== file.id) ?? null);
    } catch (failure) {
      setProblem(toProblem(failure).message);
    } finally {
      setBusy(false);
    }
  }

  const photos = files?.filter((f) => f.category === 'photo') ?? [];
  const papers = files?.filter((f) => f.category !== 'photo') ?? [];
  const label = (f: PropertyFileRow) =>
    f.caption ?? f.originalFilename ?? FILE_CATEGORY_LABELS[f.category];

  const removeControls = (file: PropertyFileRow) =>
    canUpload ? (
      removing === file.id ? (
        <ConfirmBox
          label={`Confirm removing ${label(file)}`}
          confirmText="Remove"
          pending={busy}
          onConfirm={() => void remove(file)}
          onCancel={() => setRemoving(null)}
        >
          Remove {label(file)} from this property? The stored copy is kept for the record.
        </ConfirmBox>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Remove ${label(file)}`}
          onClick={() => setRemoving(file.id)}
        >
          Remove
        </Button>
      )
    ) : null;

  return (
    <Card>
      <CardHeader
        title={canSeePapers ? 'Photos and papers' : 'Photos'}
        description={
          canSeePapers
            ? 'Papers such as the title or indenture are visible only to people allowed to see them.'
            : undefined
        }
      />
      <CardBody>
        {problem ? <Alert tone="error">{problem}</Alert> : null}
        {files === null && !problem ? (
          <p role="status" className="text-sm text-slate-600">
            Loading…
          </p>
        ) : null}

        {canSeePhotos && files ? (
          <section
            aria-labelledby={canSeePapers ? 'photos-heading' : undefined}
            aria-label={canSeePapers ? undefined : 'Photos'}
            className="space-y-2"
          >
            {/* With papers there are two lists to tell apart; otherwise the card title says it. */}
            {canSeePapers ? (
              <h3 id="photos-heading" className="text-sm font-semibold text-slate-900">
                Photos
              </h3>
            ) : null}
            {photos.length === 0 ? (
              <p className="text-sm text-slate-600">No photos yet.</p>
            ) : (
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {photos.map((file, i) => (
                  <li key={file.id} data-testid="photo" className="space-y-1">
                    {file.status === 'ready' && file.thumbnailUrl ? (
                      <button
                        type="button"
                        onClick={() => void open(file)}
                        className="block w-full overflow-hidden rounded-md border border-slate-200"
                        aria-label={`Open photo: ${label(file)}`}
                      >
                        {/* A short-lived signed link from the API, so a plain img: next/image would cache it past its expiry. */}
                        <img
                          src={file.thumbnailUrl}
                          alt={file.caption ?? `Photo ${i + 1} of the property`}
                          loading="lazy"
                          className="aspect-[4/3] w-full bg-slate-100 object-cover"
                        />
                      </button>
                    ) : (
                      <div className="flex aspect-[4/3] w-full items-center justify-center rounded-md border border-dashed border-slate-300 bg-slate-50 p-2 text-center text-sm text-slate-600">
                        {file.status === 'processing'
                          ? 'Preparing the photo…'
                          : `This photo could not be used: ${file.error ?? 'unknown problem'}`}
                      </div>
                    )}
                    {file.caption ? <p className="text-sm break-words">{file.caption}</p> : null}
                    {removeControls(file)}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        {canSeePapers && files ? (
          <section aria-labelledby="papers-heading" className="space-y-2">
            <h3 id="papers-heading" className="text-sm font-semibold text-slate-900">
              Papers
            </h3>
            {papers.length === 0 ? (
              <p className="text-sm text-slate-600">No papers yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {papers.map((file) => (
                  <li key={file.id} data-testid="paper" className="space-y-2 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{FILE_CATEGORY_LABELS[file.category]}</p>
                        <p className="text-sm break-words text-slate-600">
                          {file.caption ?? file.originalFilename ?? 'No name'} · added{' '}
                          {formatDate(file.createdAt, timeZone)}
                        </p>
                      </div>
                      {file.status === 'ready' ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          aria-label={`Open ${label(file)}`}
                          onClick={() => void open(file)}
                        >
                          Open
                        </Button>
                      ) : (
                        <p className="text-sm text-slate-600">
                          {file.status === 'processing'
                            ? 'Checking the file…'
                            : `Could not be used: ${file.error ?? 'unknown problem'}`}
                        </p>
                      )}
                    </div>
                    {removeControls(file)}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        {canUpload ? (
          <UploadForm
            propertyId={propertyId}
            canSeePapers={canSeePapers}
            onUploaded={(file) => setFiles((current) => [...(current ?? []), file])}
          />
        ) : null}
      </CardBody>
    </Card>
  );
}

function UploadForm({
  propertyId,
  canSeePapers,
  onUploaded,
}: {
  readonly propertyId: string;
  readonly canSeePapers: boolean;
  readonly onUploaded: (file: PropertyFileRow) => void;
}) {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState<FileCategory>('photo');
  const [caption, setCaption] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const categories: readonly FileCategory[] = canSeePapers
    ? ['photo', ...PAPER_CATEGORIES]
    : ['photo'];
  // The limits come from packages/domain (M2 plan 4.7); the API checks the type and size again.
  const rule = category === 'photo' ? PHOTO_UPLOAD : PAPER_UPLOAD;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Read the file from the input itself, so a choice made before the page finished loading counts.
    const file = input.current?.files?.[0];
    if (!file) {
      setStatus({ kind: 'error', message: 'Choose a file first.' });
      return;
    }
    const problem = fileProblem(file, rule);
    if (problem) {
      setStatus({ kind: 'error', message: problem });
      return;
    }
    try {
      setStatus({ kind: 'working', label: 'Preparing the upload…' });
      const slot = await api().propertyFiles.createUpload({
        propertyId,
        category,
        contentType: file.type,
        sizeBytes: file.size,
      });
      setStatus({ kind: 'working', label: 'Uploading…' });
      await sendToStorage(slot, file);
      setStatus({ kind: 'working', label: 'Saving…' });
      const saved = await api().propertyFiles.confirmUpload({
        propertyId,
        uploadId: slot.uploadId,
        category,
        caption: caption.trim() || null,
        fileName: file.name,
      });
      onUploaded(saved);
      setCaption('');
      if (input.current) input.current.value = '';
      setStatus({
        kind: 'done',
        message:
          category === 'photo'
            ? `Uploaded ${file.name}. Location details are removed from the photo before it is shown.`
            : `Uploaded ${file.name}.`,
      });
    } catch (failure) {
      setStatus({
        kind: 'error',
        message:
          failure instanceof StorageUploadError ? failure.message : toProblem(failure).message,
      });
    }
  }

  const working = status.kind === 'working';
  return (
    <form
      onSubmit={submit}
      aria-label="Upload a photo or paper"
      className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3"
    >
      <h3 className="text-sm font-semibold text-slate-900">Upload</h3>
      <p className="text-sm text-slate-600">
        Photos: {fileTypesLabel(PHOTO_UPLOAD)}, up to {sizeLabel(PHOTO_UPLOAD.maxBytes)}.
        {canSeePapers
          ? ` Papers: ${fileTypesLabel(PAPER_UPLOAD)}, up to ${sizeLabel(PAPER_UPLOAD.maxBytes)}.`
          : ''}
      </p>
      {status.kind === 'error' ? <Alert tone="error">{status.message}</Alert> : null}
      {status.kind === 'done' ? <Alert tone="success">{status.message}</Alert> : null}
      {working ? <Alert tone="info">{status.label}</Alert> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label="What is it?"
          value={category}
          options={categories.map((c) => ({ value: c, label: FILE_CATEGORY_LABELS[c] }))}
          onChange={(event) => {
            const next = categories.find((c) => c === event.target.value);
            if (next) setCategory(next);
          }}
        />
        <TextField
          label="Caption (optional)"
          maxLength={200}
          value={caption}
          onChange={(event) => setCaption(event.target.value)}
        />
      </div>
      <div className="space-y-1">
        <label htmlFor={inputId} className="block text-sm font-medium text-slate-800">
          File
        </label>
        <input
          ref={input}
          id={inputId}
          type="file"
          accept={acceptFor(rule)}
          disabled={working}
          className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-2 file:text-sm file:font-medium"
        />
      </div>
      <Button type="submit" variant="secondary" pending={working}>
        Upload
      </Button>
    </form>
  );
}
