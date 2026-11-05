'use client';

import type { MediaKind } from '@rent/domain/maintenance';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '@/components/app-context';
import { LoadFailed, Loading } from '@/components/load-state';
import {
  anyRefused,
  MediaPicker,
  MediaView,
  usableFiles,
  type PickedFile,
} from '@/components/media';
import { MoveInReportStatus } from '@/components/move-in-report';
import { PageHeader } from '@/components/page-header';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { TextAreaField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { toProblem, type Problem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import {
  conditionLabel,
  CONDITION_OPTIONS,
  conditionOf,
  inspectionStatusText,
  itemNoteProblem,
  kindLabel,
  moveInText,
  progressText,
  roomsOf,
  submitReadiness,
  type InspectionDetail,
  type InspectionItem,
} from '@/lib/inspections';
import { maintenanceMessage } from '@/lib/maintenance';
import { MediaRefused, MediaUploads } from '@/lib/media-upload';
import { StorageUploadError } from '@/lib/upload';

const PHOTOS: readonly MediaKind[] = ['image'];

export function InspectionForm({ inspectionId }: { readonly inspectionId: string }) {
  const { timeZone } = useApp();
  const router = useRouter();
  const [inspection, setInspection] = useState<InspectionDetail | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setInspection(await api().inspections.get({ inspectionId }));
      setProblem(null);
    } catch (failure) {
      setProblem(toProblem(failure));
    }
  }, [inspectionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const itemChanged = useCallback((item: InspectionItem) => {
    setInspection((current) =>
      current
        ? {
            ...current,
            items: current.items.map((i) => (i.id === item.id ? item : i)),
            itemsDone: current.items.filter((i) => (i.id === item.id ? item : i).condition !== null)
              .length,
          }
        : current,
    );
  }, []);

  if (!inspection) {
    return (
      <>
        <PageHeader title="Inspection" />
        {problem ? (
          problem.status === 404 ? (
            <Alert tone="info">This inspection does not exist, or it is not one you can see.</Alert>
          ) : (
            <LoadFailed message={problem.message} onRetry={() => void load()} />
          )
        ) : (
          <Loading what="the inspection" />
        )}
      </>
    );
  }

  const rooms = roomsOf(inspection.items);
  const readiness = submitReadiness(inspection.items);
  const editable = inspection.status === 'in_progress' && inspection.actions.edit;
  const moveOut = inspection.kind === 'move_out';
  const worse = inspection.items.filter((i) => i.worsened).length;

  async function submit() {
    if (!inspection) return;
    setPending(true);
    setActionError(null);
    try {
      const next = await api().inspections.submit({ inspectionId: inspection.id });
      setInspection(next);
      setConfirming(false);
      setNotice(
        next.kind === 'move_in'
          ? 'Submitted. The move-in report is being prepared, then goes to every party to sign.'
          : 'Submitted. The inspection cannot change now; a mistake is corrected by a new inspection.',
      );
    } catch (failure) {
      setActionError(toProblem(failure).message);
      await load();
    } finally {
      setPending(false);
    }
  }

  async function correct() {
    if (!inspection) return;
    setPending(true);
    setActionError(null);
    try {
      const started = await api().inspections.start({
        unitId: inspection.unit.id,
        kind: inspection.kind,
        leaseId: inspection.leaseId,
        correctsInspectionId: inspection.id,
      });
      router.push(`/inspections/${started.id}`);
    } catch (failure) {
      setActionError(toProblem(failure).message);
      setPending(false);
    }
  }

  return (
    <>
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link href="/inspections" className="underline underline-offset-2">
          Inspections
        </Link>{' '}
        <span aria-hidden="true">›</span> <span className="font-mono">{inspection.unit.code}</span>
      </nav>
      <div className="space-y-2">
        <PageHeader
          title={`${kindLabel(inspection.kind)}, ${inspection.unit.code}`}
          description={`${inspection.property.name}${inspection.tenant ? ` · ${inspection.tenant.name}` : ''}`}
        />
        <p className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
          <span data-testid="inspection-status">
            <Badge tone={inspection.status === 'submitted' ? 'green' : 'amber'}>
              {inspectionStatusText(inspection)}
            </Badge>
          </span>
          <span data-testid="inspection-progress">
            {progressText(inspection.itemsDone, inspection.itemCount)}
          </span>
          {moveOut && worse > 0 ? <Badge tone="amber">{worse} worse than at move-in</Badge> : null}
        </p>
        <p className="text-sm text-slate-600">
          Started {formatTime(inspection.startedAt, timeZone)}
          {inspection.performedByName ? ` by ${inspection.performedByName}` : ''}
          {inspection.submittedAt
            ? ` · submitted ${formatTime(inspection.submittedAt, timeZone)}`
            : ''}
        </p>
        {inspection.corrects ? (
          <p className="text-sm">
            This corrects{' '}
            <Link
              href={`/inspections/${inspection.corrects.id}`}
              className="underline underline-offset-2"
            >
              an earlier inspection
            </Link>
            .
          </p>
        ) : null}
        {inspection.correctedBy ? (
          <Alert tone="info" live={false}>
            A later inspection corrects this one.{' '}
            <Link
              href={`/inspections/${inspection.correctedBy.id}`}
              className="font-medium underline underline-offset-2"
            >
              Open the correction
            </Link>
          </Alert>
        ) : null}
        {inspection.leaseId ? (
          <Link
            href={`/leases/${inspection.leaseId}`}
            className="inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-2"
          >
            Open the lease
          </Link>
        ) : null}
      </div>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {moveOut && inspection.moveInInspectionId === null ? (
        <Alert tone="warning" live={false}>
          There is no move-in report for this lease, so nothing is compared item by item.
        </Alert>
      ) : null}
      {moveOut && inspection.moveInInspectionId ? (
        <p className="text-sm text-slate-700">
          Each item shows its{' '}
          <Link
            href={`/inspections/${inspection.moveInInspectionId}`}
            className="underline underline-offset-2"
          >
            move-in result
          </Link>{' '}
          beside it. Items now worse are marked.
        </p>
      ) : null}

      {inspection.moveInReport ? (
        <Card>
          <CardHeader
            title="The move-in report"
            description="Signed by every tenant party and the landlord’s representative."
          />
          <CardBody>
            <MoveInReportStatus report={inspection.moveInReport} />
          </CardBody>
        </Card>
      ) : null}

      {rooms.map((room) => (
        <details
          key={room.key}
          open={editable || room.worsened > 0}
          className="rounded-lg border border-slate-200 bg-white shadow-sm"
          data-testid="inspection-room"
        >
          <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-2 px-4 py-3 text-base font-semibold text-slate-900">
            {room.label}
            <span className="text-sm font-normal text-slate-600">
              {room.done} of {room.items.length}
            </span>
            {room.worsened > 0 ? <Badge tone="amber">{room.worsened} worse</Badge> : null}
          </summary>
          <ul className="divide-y divide-slate-100 border-t border-slate-200">
            {room.items.map((item) => (
              <ItemRow
                key={item.id}
                inspection={inspection}
                item={item}
                editable={editable}
                onChanged={itemChanged}
              />
            ))}
          </ul>
        </details>
      ))}

      <Card data-testid="inspection-submit">
        <CardBody>
          {actionError ? <Alert tone="error">{actionError}</Alert> : null}
          {inspection.status === 'in_progress' ? (
            <>
              <p
                className={cn(
                  'text-sm',
                  readiness.ready ? 'text-slate-800' : 'font-medium text-slate-900',
                )}
              >
                {readiness.text}
              </p>
              {inspection.actions.submit && !confirming ? (
                <Button disabled={!readiness.ready} onClick={() => setConfirming(true)}>
                  Submit the inspection
                </Button>
              ) : null}
              {confirming ? (
                <div
                  className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm"
                  role="group"
                  aria-label="Confirm the submission"
                >
                  <p>
                    Submit it now? It is then frozen.
                    {inspection.kind === 'move_in'
                      ? ' It becomes the move-in report, which every party signs.'
                      : ''}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button pending={pending} onClick={() => void submit()}>
                      Submit
                    </Button>
                    <Button variant="ghost" onClick={() => setConfirming(false)}>
                      Not yet
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-slate-700">
              Submitted inspections never change. A mistake is corrected by a new inspection that
              refers to this one.
            </p>
          )}
          {inspection.actions.correct ? (
            <Button variant="secondary" pending={pending} onClick={() => void correct()}>
              Correct this inspection
            </Button>
          ) : null}
        </CardBody>
      </Card>
    </>
  );
}

function ItemRow({
  inspection,
  item,
  editable,
  onChanged,
}: {
  readonly inspection: InspectionDetail;
  readonly item: InspectionItem;
  readonly editable: boolean;
  readonly onChanged: (item: InspectionItem) => void;
}) {
  const [note, setNote] = useState(item.note ?? '');
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [uploads] = useState(
    () => new MediaUploads(PHOTOS, (input) => api().inspections.createUpload(input)),
  );
  const noteError = itemNoteProblem(note);
  const moveIn = moveInText(item);
  const groupName = `condition-${item.id}`;

  async function save(
    patch: { condition?: InspectionItem['condition']; note?: string | null },
    text: string,
  ) {
    setSaving(text);
    setError(null);
    try {
      onChanged(
        await api().inspections.updateItem({
          inspectionId: inspection.id,
          itemId: item.id,
          ...patch,
        }),
      );
      setSaving(null);
    } catch (failure) {
      setSaving(null);
      setError(toProblem(failure).message);
    }
  }

  async function addPhotos() {
    const usable = usableFiles(files);
    if (usable.length === 0 || anyRefused(files)) return;
    setSaving('Uploading the photos…');
    setError(null);
    try {
      const uploadIds = await uploads.idsFor(usable, (done) =>
        setSaving(`Uploading the photos… ${done} of ${usable.length}`),
      );
      onChanged(
        await api().inspections.addPhotos({
          inspectionId: inspection.id,
          itemId: item.id,
          uploadIds,
        }),
      );
      setFiles([]);
      setSaving(null);
    } catch (failure) {
      setSaving(null);
      if (failure instanceof MediaRefused || failure instanceof StorageUploadError)
        setError(failure.message);
      else {
        uploads.forget(usable);
        setError(maintenanceMessage(failure) ?? toProblem(failure).message);
      }
    }
  }

  return (
    <li
      className={cn(
        'space-y-3 px-4 py-4',
        item.worsened && 'border-l-8 border-amber-500 bg-amber-50/50',
      )}
      data-testid="inspection-item"
      data-item-key={item.itemKey}
      data-worsened={item.worsened ? 'true' : undefined}
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold text-slate-900">{item.itemLabel}</p>
        {item.worsened ? (
          <span data-testid="item-worsened">
            <Badge tone="amber">Worse than at move-in</Badge>
          </span>
        ) : null}
      </div>
      {moveIn ? (
        <div
          className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm"
          data-testid="move-in-result"
        >
          <p className="text-slate-800">{moveIn}</p>
          {item.moveIn && item.moveIn.photos.length > 0 && inspection.moveInInspectionId ? (
            <ul className="grid grid-cols-2 gap-2">
              {item.moveIn.photos.map((photo, index) => (
                <li key={photo.id}>
                  <MediaView
                    kind="image"
                    name={`Move-in photo ${index + 1} of ${item.itemLabel}`}
                    load={async () =>
                      (
                        await api().inspections.photoDownload({
                          inspectionId: inspection.moveInInspectionId!,
                          photoId: photo.id,
                        })
                      ).url
                    }
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {editable ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-slate-800">
            Condition{item.moveIn ? ' now' : ''}
          </legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {CONDITION_OPTIONS.map((option) => (
              <label
                key={option.value}
                className={cn(
                  'flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm',
                  item.condition === option.value
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-300 bg-white text-slate-900',
                )}
              >
                <input
                  type="radio"
                  name={groupName}
                  value={option.value}
                  checked={item.condition === option.value}
                  disabled={saving !== null}
                  onChange={() => void save({ condition: conditionOf(option.value) }, 'Saving…')}
                  className="size-4"
                />
                {option.label}
              </label>
            ))}
          </div>
        </fieldset>
      ) : (
        <p className="text-sm">
          <span className="text-slate-600">Condition: </span>
          <span className="font-medium" data-testid="item-condition">
            {conditionLabel(item.condition)}
          </span>
        </p>
      )}

      {editable ? (
        <TextAreaField
          label={`Note on ${item.itemLabel.toLowerCase()} (optional)`}
          rows={2}
          maxLength={1000}
          value={note}
          error={noteError}
          onChange={(event) => setNote(event.target.value)}
          onBlur={() => {
            const next = note.trim();
            if (!noteError && next !== (item.note ?? ''))
              void save({ note: next || null }, 'Saving the note…');
          }}
          className="[&_textarea]:font-sans"
        />
      ) : item.note ? (
        <p className="whitespace-pre-wrap text-sm text-slate-800">{item.note}</p>
      ) : null}

      {item.photos.length > 0 ? (
        <ul
          className="grid grid-cols-2 gap-2 sm:grid-cols-3"
          aria-label={`Photos of ${item.itemLabel}`}
        >
          {item.photos.map((photo, index) => (
            <li key={photo.id}>
              <MediaView
                kind="image"
                name={`Photo ${index + 1} of ${item.itemLabel}`}
                load={async () =>
                  (
                    await api().inspections.photoDownload({
                      inspectionId: inspection.id,
                      photoId: photo.id,
                    })
                  ).url
                }
              />
            </li>
          ))}
        </ul>
      ) : null}

      {editable ? (
        <div className="space-y-2">
          <MediaPicker
            label={`Photos of ${item.itemLabel.toLowerCase()}`}
            kinds={PHOTOS}
            files={files}
            onChange={setFiles}
            disabled={saving !== null}
            capture
          />
          {usableFiles(files).length > 0 ? (
            <Button size="sm" pending={saving !== null} onClick={() => void addPhotos()}>
              Add{' '}
              {usableFiles(files).length === 1
                ? 'the photo'
                : `the ${usableFiles(files).length} photos`}
            </Button>
          ) : null}
        </div>
      ) : null}
      {saving ? (
        <p role="status" className="text-sm text-slate-600">
          {saving}
        </p>
      ) : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
    </li>
  );
}
