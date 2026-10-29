'use client';

import { LOGO_CONTENT_TYPES, LOGO_MAX_BYTES, type CompanyProfile } from '@rent/contracts';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';

type LogoType = (typeof LOGO_CONTENT_TYPES)[number];

const isLogoType = (type: string): type is LogoType =>
  (LOGO_CONTENT_TYPES as readonly string[]).includes(type);
const MAX_MB = LOGO_MAX_BYTES / 1_000_000;

type Status =
  | { readonly kind: 'idle' }
  | { readonly kind: 'working'; readonly label: string }
  | { readonly kind: 'done' }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Logo upload (AD-01): the API hands out a presigned POST, the browser sends the file straight
 * to storage (CLAUDE.md section 10), and the API then checks and applies it.
 */
export function LogoUpload({
  company,
  canEdit,
}: {
  readonly company: CompanyProfile;
  readonly canEdit: boolean;
}) {
  const router = useRouter();
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  function problemWith(file: File | undefined): string | null {
    if (!file) return 'Choose an image first.';
    if (!isLogoType(file.type)) return 'Choose a PNG, JPEG or WebP image.';
    if (file.size > LOGO_MAX_BYTES) return `The logo must be ${MAX_MB} MB or smaller.`;
    return null;
  }

  function choose(file: File | undefined) {
    const problem = file ? problemWith(file) : null;
    setStatus(problem ? { kind: 'error', message: problem } : { kind: 'idle' });
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Read the file from the input itself, so a choice made before the page finished loading still counts.
    const file = input.current?.files?.[0];
    const problem = problemWith(file);
    if (problem || !file || !isLogoType(file.type)) {
      setStatus({ kind: 'error', message: problem ?? 'Choose an image first.' });
      return;
    }
    try {
      setStatus({ kind: 'working', label: 'Preparing the upload…' });
      const slot = await api().company.createLogoUpload({
        contentType: file.type,
        sizeBytes: file.size,
      });

      setStatus({ kind: 'working', label: 'Uploading…' });
      const form = new FormData();
      for (const [key, value] of Object.entries(slot.fields)) form.append(key, value);
      form.append('file', file); // storage expects the file after the policy fields
      const stored = await fetch(slot.url, { method: 'POST', body: form, credentials: 'omit' });
      if (!stored.ok) throw new Error('upload_failed');

      setStatus({ kind: 'working', label: 'Checking the image…' });
      await api().company.confirmLogoUpload({ uploadId: slot.uploadId });
      setStatus({ kind: 'done' });
      if (input.current) input.current.value = '';
      router.refresh();
    } catch (failure) {
      const message =
        failure instanceof Error && failure.message === 'upload_failed'
          ? 'The file could not be uploaded to storage. Try again.'
          : toProblem(failure).message;
      setStatus({ kind: 'error', message });
    }
  }

  const working = status.kind === 'working';

  return (
    <Card>
      <CardHeader
        title="Logo"
        description={`Shown in the header and on letterheads. PNG, JPEG or WebP, up to ${MAX_MB} MB.`}
      />
      <CardBody>
        <div className="flex items-center gap-4">
          {company.branding.logoUrl ? (
            <img
              src={company.branding.logoUrl}
              alt={`Current logo of ${company.displayName}`}
              className="size-20 rounded-md border border-slate-200 bg-white object-contain p-1"
            />
          ) : (
            <p className="text-sm text-slate-600">No logo yet.</p>
          )}
        </div>
        {status.kind === 'error' ? <Alert tone="error">{status.message}</Alert> : null}
        {status.kind === 'done' ? <Alert tone="success">Logo updated.</Alert> : null}
        {working ? <Alert tone="info">{status.label}</Alert> : null}
        {canEdit ? (
          <form onSubmit={upload} className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <label htmlFor={inputId} className="block text-sm font-medium text-slate-800">
                Choose a new logo
              </label>
              <input
                ref={input}
                id={inputId}
                type="file"
                accept={LOGO_CONTENT_TYPES.join(',')}
                disabled={working}
                onChange={(event) => choose(event.target.files?.[0])}
                className="block text-sm file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-2 file:text-sm file:font-medium"
              />
            </div>
            <Button type="submit" variant="secondary" pending={working}>
              Upload logo
            </Button>
          </form>
        ) : null}
      </CardBody>
    </Card>
  );
}
