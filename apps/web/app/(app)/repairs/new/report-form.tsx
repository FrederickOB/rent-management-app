'use client';

import type { MediaKind } from '@rent/domain/maintenance';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { anyRefused, MediaPicker, usableFiles, type PickedFile } from '@/components/media';
import { PropertyUnitFields } from '@/components/property-unit-fields';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { SelectField, TextAreaField } from '@/components/ui/field';
import { api, keyedApi } from '@/lib/api';
import { errorCode, toProblem } from '@/lib/errors';
import { isKeyReused, sendOnce, useIdempotencyKeeper } from '@/lib/idempotency';
import { useHoldWhileSending } from '@/lib/in-flight';
import {
  categoryOf,
  CATEGORY_OPTIONS,
  maintenanceMessage,
  priorityOf,
  PRIORITY_OPTIONS,
} from '@/lib/maintenance';
import { MediaRefused, MediaUploads } from '@/lib/media-upload';
import { StorageUploadError } from '@/lib/upload';

const KINDS: readonly MediaKind[] = ['image', 'video', 'audio'];

export function ReportRepairForm({
  initial,
}: {
  /** From a conversation (decision 14): its unit, and the conversation the job links to. */
  readonly initial: {
    readonly propertyId: string;
    readonly unitId: string;
    readonly conversationId: string;
  };
}) {
  const router = useRouter();
  const keeper = useIdempotencyKeeper();
  const [uploads] = useState(
    () => new MediaUploads(KINDS, (input) => api().maintenance.createUpload(input)),
  );
  const [place, setPlace] = useState({ propertyId: initial.propertyId, unitId: initial.unitId });
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [priority, setPriority] = useState('');
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What the current key was used for: any change to the report makes it a new one (a new key).
  const keyedFor = useRef<string | null>(null);
  useHoldWhileSending(pending);

  const usable = usableFiles(files);
  const errors = {
    propertyId: place.propertyId ? undefined : 'Choose the property',
    description:
      description.trim().length < 3
        ? 'Describe the problem, at least 3 characters'
        : description.trim().length > 2000
          ? 'Use at most 2,000 characters'
          : undefined,
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    if (errors.propertyId || errors.description || anyRefused(files) || usable.length > 10) return;
    const content = JSON.stringify([
      place,
      description.trim(),
      category,
      priority,
      files.map((f) => f.key),
    ]);
    if (keyedFor.current !== content) {
      keeper.reset();
      keyedFor.current = content;
    }
    setPending(true);
    try {
      let uploadIds: string[] = [];
      if (usable.length > 0) {
        setStatus('Uploading the files…');
        uploadIds = await uploads.idsFor(usable, (done) =>
          setStatus(`Uploading the files… ${done} of ${usable.length}`),
        );
      }
      setStatus('Logging the repair…');
      const job = await sendOnce(keeper, (key) =>
        keyedApi(key).maintenance.report({
          propertyId: place.propertyId,
          unitId: place.unitId || null,
          description: description.trim(),
          category: categoryOf(category),
          priority: priorityOf(priority),
          uploadIds,
          conversationId: initial.conversationId || null,
        }),
      );
      router.push(`/repairs/${job.id}`);
    } catch (failure) {
      setStatus(null);
      setPending(false);
      if (failure instanceof MediaRefused || failure instanceof StorageUploadError) {
        setError(failure.message);
        return;
      }
      if (errorCode(failure).startsWith('MEDIA_')) uploads.forget(usable);
      if (isKeyReused(failure)) {
        keeper.reset();
        keyedFor.current = null;
        setError(
          'An earlier attempt may already have logged this repair. Check the board before logging it again.',
        );
        return;
      }
      setError(maintenanceMessage(failure) ?? toProblem(failure).message);
    }
  }

  return (
    <Card>
      <CardBody>
        <form onSubmit={submit} noValidate aria-label="Log a repair" className="space-y-4">
          {error ? <Alert tone="error">{error}</Alert> : null}
          {initial.conversationId ? (
            <Alert tone="info" live={false}>
              The repair is linked to the conversation it came from, so the tenant’s messages stay
              with it.
            </Alert>
          ) : null}
          <PropertyUnitFields
            propertyId={place.propertyId}
            unitId={place.unitId}
            onChange={setPlace}
            disabled={pending}
            errors={tried ? { propertyId: errors.propertyId } : undefined}
          />
          <TextAreaField
            label="What is wrong"
            rows={4}
            maxLength={2000}
            value={description}
            error={tried ? errors.description : undefined}
            onChange={(event) => setDescription(event.target.value)}
            className="[&_textarea]:font-sans"
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label="Category (optional)"
              value={category}
              options={[{ value: '', label: 'Decide when triaging' }, ...CATEGORY_OPTIONS]}
              onChange={(event) => setCategory(event.target.value)}
            />
            <SelectField
              label="Priority (optional)"
              value={priority}
              hint="An emergency alerts the property’s managers and caretakers on WhatsApp and by SMS at once."
              options={[{ value: '', label: 'Decide when triaging' }, ...PRIORITY_OPTIONS]}
              onChange={(event) => setPriority(event.target.value)}
            />
          </div>
          <MediaPicker
            label="Photos, videos and voice notes (optional)"
            kinds={KINDS}
            files={files}
            onChange={setFiles}
            disabled={pending}
          />
          {status ? (
            <p role="status" className="text-sm text-slate-700">
              {status}
            </p>
          ) : null}
          <Button type="submit" pending={pending}>
            Log the repair
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
