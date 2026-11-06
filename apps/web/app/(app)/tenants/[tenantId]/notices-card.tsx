'use client';

import type { TenantDetailView } from '@rent/contracts';
import { NOTICE_SUBTYPE_LABELS, RECEIVED_VIA, type ReceivedVia } from '@rent/domain/notices';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { FileField } from '@/components/file-field';
import { useApp } from '@/components/app-context';
import { Empty, LoadFailed, Loading } from '@/components/load-state';
import { NoticeOutcomeBadge, NoticeStatusBadge } from '@/components/notice-badges';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, SelectField, TextField, controlClass } from '@/components/ui/field';
import { api, keyedApi } from '@/lib/api';
import { formatBusinessDate, todayIn } from '@/lib/business-dates';
import { toProblem } from '@/lib/errors';
import { sendOnce, useIdempotencyKeeper } from '@/lib/idempotency';
import { NOTICE_UPLOAD, UploadCache, uploadNoticeFile } from '@/lib/notice-uploads';
import { noticeRefusal, noticeTitle, RECEIVED_VIA_LABELS, type NoticeRow } from '@/lib/notices';
import { termLabel } from '@/lib/tenancy-format';
import { fileProblem } from '@/lib/upload';

type Received = 'intention_to_vacate' | 'complaint';

/**
 * The tenant's notices (LN-09) on their profile: every notice to or from them, a new one for a
 * lease, and recording a notice the tenant gave (decision 13): an intention to vacate or a formal
 * complaint, with the date, how it arrived and the document.
 */
export function NoticesCard({
  tenant,
  canDraft,
}: {
  readonly tenant: TenantDetailView;
  readonly canDraft: boolean;
}) {
  const [rows, setRows] = useState<readonly NoticeRow[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const tenantId = tenant.id;

  const load = useCallback(async () => {
    try {
      setRows(await api().notices.list({ tenantId }));
      setProblem(null);
    } catch (failure) {
      setProblem(toProblem(failure).message);
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const leases = tenant.leases.filter((l) => l.status !== 'draft' && l.status !== 'cancelled');
  return (
    <Card data-testid="tenant-notices">
      <CardHeader
        title="Notices"
        description="Notices to this tenant, and notices they gave."
        actions={
          canDraft && !recording ? (
            <div className="flex flex-wrap gap-2">
              {leases.length === 1 ? (
                <Link
                  href={`/notices/new?leaseId=${leases[0]!.id}`}
                  className="inline-flex min-h-9 items-center text-sm font-medium underline underline-offset-2"
                >
                  New notice
                </Link>
              ) : null}
              {leases.length ? (
                <Button size="sm" variant="secondary" onClick={() => setRecording(true)}>
                  Record a notice from the tenant
                </Button>
              ) : null}
            </div>
          ) : null
        }
      />
      <CardBody>
        {message ? <Alert tone="success">{message}</Alert> : null}
        {recording ? (
          <RecordReceived
            leases={leases}
            onSaved={async (text) => {
              setRecording(false);
              setMessage(text);
              await load();
            }}
            onCancel={() => setRecording(false)}
            onReload={() => void load()}
          />
        ) : null}
        {problem ? <LoadFailed message={problem} onRetry={() => void load()} /> : null}
        {rows === null && !problem ? <Loading what="notices" /> : null}
        {rows?.length === 0 ? <Empty>No notice yet.</Empty> : null}
        {rows?.length ? (
          <ul className="divide-y divide-slate-100 text-sm" aria-label="Notices">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center gap-2 py-2"
                data-testid="tenant-notice"
              >
                <Link
                  href={`/notices/${row.id}`}
                  className="font-medium underline underline-offset-2"
                >
                  {noticeTitle(row)}
                </Link>
                <NoticeStatusBadge status={row.status} />
                {row.outcome ? <NoticeOutcomeBadge outcome={row.outcome} /> : null}
                {row.effectiveDate ? (
                  <span className="text-slate-600">
                    effective {formatBusinessDate(row.effectiveDate)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </CardBody>
    </Card>
  );
}

function RecordReceived({
  leases,
  onSaved,
  onCancel,
  onReload,
}: {
  readonly leases: TenantDetailView['leases'];
  readonly onSaved: (text: string) => Promise<void>;
  readonly onCancel: () => void;
  readonly onReload: () => void;
}) {
  const { timeZone } = useApp();
  const today = todayIn(timeZone);
  const [leaseId, setLeaseId] = useState(leases.length === 1 ? leases[0]!.id : '');
  const [subtype, setSubtype] = useState<Received>('intention_to_vacate');
  const [receivedOn, setReceivedOn] = useState(today);
  const [receivedVia, setReceivedVia] = useState<ReceivedVia>('in_person');
  const [details, setDetails] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const keeper = useIdempotencyKeeper();
  const keyedFor = useRef<string | null>(null);
  const [uploads] = useState(() => new UploadCache());

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const document = file.current?.files?.[0] ?? null;
    if (!leaseId) return setError('Choose the lease.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedOn) || receivedOn > today)
      return setError('Give the date it was received, not in the future.');
    if (!document) return setError('Add the document the tenant gave, or a photo of it.');
    const wrong = fileProblem(document, NOTICE_UPLOAD);
    if (wrong) return setError(wrong);
    setPending(true);
    try {
      // A retry reuses the upload of the same file (review item 4).
      const uploadId = await uploads.upload(document, 'received_notice', (file, purpose) =>
        uploadNoticeFile(file, purpose, api().notices),
      );
      const content = JSON.stringify([
        leaseId,
        subtype,
        receivedOn,
        receivedVia,
        details.trim(),
        uploadId,
      ]);
      if (keyedFor.current !== content) {
        keeper.reset();
        keyedFor.current = content;
      }
      await sendOnce(keeper, (key) =>
        keyedApi(key).notices.recordReceived({
          leaseId,
          subtype,
          receivedOn,
          receivedVia,
          uploadId,
          details: details.trim() || null,
        }),
      );
      await onSaved(`Recorded the tenant’s ${NOTICE_SUBTYPE_LABELS[subtype].toLowerCase()}.`);
    } catch (failure) {
      if (noticeRefusal(failure) === 'key_reused') {
        keeper.reset();
        keyedFor.current = null;
        setError(
          'An earlier attempt with other details was already recorded. The list below is up to date: check it before recording again.',
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
      aria-label="Record a notice from the tenant"
      className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label="Lease"
          value={leaseId}
          options={[
            ...(leases.length === 1 ? [] : [{ value: '', label: 'Choose the lease' }]),
            ...leases.map((l) => ({
              value: l.id,
              label: `${l.unitCode} · ${termLabel(l.startDate, l.endDate)}`,
            })),
          ]}
          onChange={(event) => setLeaseId(event.target.value)}
        />
        <SelectField
          label="What it is"
          value={subtype}
          options={(['intention_to_vacate', 'complaint'] as const).map((s) => ({
            value: s,
            label: NOTICE_SUBTYPE_LABELS[s],
          }))}
          onChange={(event) => setSubtype(event.target.value as Received)}
        />
        <TextField
          label="Date received"
          type="date"
          max={today}
          value={receivedOn}
          onChange={(event) => setReceivedOn(event.target.value)}
        />
        <SelectField
          label="How it arrived"
          value={receivedVia}
          options={RECEIVED_VIA.map((v) => ({ value: v, label: RECEIVED_VIA_LABELS[v] }))}
          onChange={(event) => setReceivedVia(event.target.value as ReceivedVia)}
        />
      </div>
      <FileField ref={file} label="The document" rule={NOTICE_UPLOAD} />
      <Field label="Details (optional)">
        {(control) => (
          <textarea
            {...control}
            rows={3}
            maxLength={2000}
            value={details}
            onChange={(event) => setDetails(event.target.value)}
            className={controlClass}
          />
        )}
      </Field>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={pending}>
          Record it
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
