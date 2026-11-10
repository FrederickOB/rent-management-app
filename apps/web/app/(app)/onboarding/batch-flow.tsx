'use client';

import type { OnboardingBatchView } from '@rent/contracts';
import type { OnboardingBatchKind } from '@rent/domain/onboarding';
import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Table, Td, Th } from '@/components/ui/table';
import { api, keyedApi } from '@/lib/api';
import { saveFile } from '@/lib/browser-files';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { isKeyReused, moneyProblem, sendOnce, useIdempotencyKeeper } from '@/lib/idempotency';
import {
  approvalText,
  BATCH_KIND_LABELS,
  BATCH_STATUS_LABELS,
  canCommit,
  countRows,
  isBusy,
  onboardingMessage,
  pollEvery,
  showsPreview,
  totalsRows,
} from '@/lib/onboarding';
import { formatMinor } from '@/lib/tenancy-format';
import {
  acceptFor,
  fileProblem,
  ONBOARDING_UPLOAD,
  sendToStorage,
  sizeLabel,
  StorageUploadError,
} from '@/lib/upload';
import { useInterval } from '@/lib/use-interval';
import { BalancesPreview } from './balances-preview';

const problemText = (failure: unknown): string =>
  onboardingMessage(failure) ?? toProblem(failure).message;

const TEMPLATE_NOTES: Record<OnboardingBatchKind, string> = {
  tenancies:
    'Two sheets, Tenants and Leases, and a Lists sheet of allowed values and your unit codes. Consent per channel is a column; ID numbers are optional and stored encrypted.',
  balances:
    'Arrears, Advances, Deposits, Withholding and Owner items, each on the cut-over date, with a Lists sheet of your leases and owners.',
  adjustment:
    'Signed changes to the opening balances: a minus lowers an item, never below what has been paid or drawn from it.',
};

/**
 * One onboarding workbook (decisions 2 and 3): the template, an upload, the check's report by
 * sheet, row and column, a preview for money, then commit. Tenancies are written at once; balances
 * and adjustments wait for a second person (`opening_balances`). The worker reads the file; this
 * screen only polls.
 */
export function BatchFlow({
  kind,
  onChanged,
}: {
  readonly kind: OnboardingBatchKind;
  readonly onChanged: () => void;
}) {
  const { timeZone } = useApp();
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const keeper = useIdempotencyKeeper();
  const [batch, setBatch] = useState<OnboardingBatchView | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [templateProblem, setTemplateProblem] = useState<string | null>(null);
  const [templatePending, setTemplatePending] = useState(false);

  // The latest batch of this kind, so a step left half-way picks up where it was.
  useEffect(() => {
    let current = true;
    api()
      .onboarding.batches({ kind })
      .then(
        (rows) => {
          if (current && rows[0]) setBatch(rows[0]);
        },
        () => undefined,
      );
    return () => {
      current = false;
    };
  }, [kind]);

  const poll = useCallback(async () => {
    if (!batch) return;
    try {
      const next = await api().onboarding.batch({ batchId: batch.id });
      setBatch(next);
      if (!isBusy(next.status) && next.status !== batch.status) onChanged();
    } catch (failure) {
      setProblem(problemText(failure));
    }
  }, [batch, onChanged]);
  // While the worker is busy, and while the batch waits for the second person (M11 review), so it
  // turns to posted, or turned down, without a reload.
  useInterval(() => void poll(), batch ? pollEvery(batch.status) : null);

  async function downloadTemplate() {
    setTemplatePending(true);
    setTemplateProblem(null);
    try {
      const file = await api().onboarding.template({ kind });
      saveFile(file, file.name || `onboarding-${kind}.xlsx`);
    } catch (failure) {
      setTemplateProblem(problemText(failure));
    } finally {
      setTemplatePending(false);
    }
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProblem(null);
    const file = input.current?.files?.[0];
    if (!file) {
      setProblem('Choose your filled-in workbook first.');
      return;
    }
    const issue = fileProblem(file, ONBOARDING_UPLOAD);
    if (issue) {
      setProblem(issue);
      return;
    }
    try {
      setWorking('Preparing the upload…');
      const created = await api().onboarding.createUpload({
        kind,
        sizeBytes: file.size,
        fileName: file.name,
      });
      setWorking('Uploading…');
      await sendToStorage(created.upload, file);
      setWorking('Starting the check…');
      setBatch(await api().onboarding.validate({ batchId: created.batchId }));
      keeper.reset();
      if (input.current) input.current.value = '';
    } catch (failure) {
      setProblem(failure instanceof StorageUploadError ? failure.message : problemText(failure));
    } finally {
      setWorking(null);
    }
  }

  async function commit() {
    if (!batch) return;
    setWorking(kind === 'tenancies' ? 'Writing…' : 'Asking for approval…');
    setProblem(null);
    try {
      // One key per batch: a retried commit is the same commit (plan 4.1).
      const next = await sendOnce(keeper, (key) =>
        keyedApi(key).onboarding.commit({ batchId: batch.id }),
      );
      setBatch(next);
      onChanged();
    } catch (failure) {
      setProblem(onboardingMessage(failure) ?? moneyProblem(failure));
      // A reused key means an earlier attempt reached the API and may have committed: the key is
      // kept (M11 review), and the batch is read again so its status shows what happened.
      if (isKeyReused(failure))
        await api()
          .onboarding.batch({ batchId: batch.id })
          .then(setBatch, () => undefined);
    } finally {
      setWorking(null);
    }
  }

  const busy = working !== null || (batch !== null && isBusy(batch.status));

  return (
    <Card data-testid={`batch-${kind}`}>
      <CardHeader title={BATCH_KIND_LABELS[kind]} description={TEMPLATE_NOTES[kind]} />
      <CardBody className="space-y-4">
        <div className="space-y-2">
          {templateProblem ? <Alert tone="error">{templateProblem}</Alert> : null}
          <Button
            variant="secondary"
            pending={templatePending}
            onClick={() => void downloadTemplate()}
          >
            Download the template
          </Button>
        </div>
        <form
          onSubmit={(event) => void upload(event)}
          aria-label={`Upload the ${BATCH_KIND_LABELS[kind].toLowerCase()} workbook`}
          className="space-y-3"
        >
          <div className="space-y-1">
            <label htmlFor={inputId} className="block text-sm font-medium text-slate-800">
              Filled-in workbook ({sizeLabel(ONBOARDING_UPLOAD.maxBytes)} at most)
            </label>
            <input
              ref={input}
              id={inputId}
              type="file"
              accept={acceptFor(ONBOARDING_UPLOAD)}
              disabled={busy}
              className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-2 file:text-sm file:font-medium"
            />
          </div>
          <Button type="submit" variant="secondary" pending={busy}>
            Check the workbook
          </Button>
        </form>
        {working ? <Alert tone="info">{working}</Alert> : null}
        {problem ? <Alert tone="error">{problem}</Alert> : null}
        {batch ? (
          <Report batch={batch} timeZone={timeZone} pending={busy} onCommit={() => void commit()} />
        ) : null}
      </CardBody>
    </Card>
  );
}

function Report({
  batch,
  timeZone,
  pending,
  onCommit,
}: {
  readonly batch: OnboardingBatchView;
  readonly timeZone: string;
  readonly pending: boolean;
  readonly onCommit: () => void;
}) {
  const report = batch.report;
  const time = (iso: string) => formatTime(iso, timeZone);
  const approval = approvalText(batch.approval, time);
  const committed = ['committed', 'awaiting_approval', 'posting', 'posted'].includes(batch.status);
  return (
    <div className="space-y-3 border-t border-slate-200 pt-3" data-testid="onboarding-report">
      <p className="flex flex-wrap items-center gap-2 text-sm" aria-live="polite">
        <span className="text-slate-600">Status:</span>
        <strong data-testid="batch-status">{BATCH_STATUS_LABELS[batch.status]}</strong>
        {batch.fileName ? <span className="text-slate-600">· {batch.fileName}</span> : null}
        {batch.status === 'posted' ? <Badge tone="green">Posted</Badge> : null}
      </p>
      {batch.status === 'failed' ? (
        <Alert tone="error" title="The workbook could not be used">
          {batch.error ? `${batch.error} ` : ''}Upload it again; if it fails again, download a fresh
          template.
        </Alert>
      ) : null}
      {batch.status === 'invalid' ? (
        <Alert tone="error" title="Nothing has been written">
          Fix the problems below in the workbook, then upload it again.
        </Alert>
      ) : null}
      {batch.status === 'rejected' ? (
        <Alert tone="error" title="Turned down">
          The second person did not approve it, so nothing was posted. Correct the workbook and
          upload it again.
        </Alert>
      ) : null}
      {batch.status === 'committed' ? (
        <Alert tone="success" title="Written">
          The tenants and leases are in. No tenant was sent anything.{' '}
          <Link href="/leases" className="font-medium underline underline-offset-2">
            Go to the leases
          </Link>
        </Alert>
      ) : null}
      {batch.status === 'awaiting_approval' && approval ? (
        <Alert tone="info" title="Waiting for a second person">
          {approval}{' '}
          <Link href="/approvals" className="font-medium underline underline-offset-2">
            Approvals
          </Link>
        </Alert>
      ) : null}
      {batch.status === 'posted' ? (
        <Alert tone="success" title="Posted">
          The opening balances are on the books, dated the cut-over
          {batch.postedAt ? `, posted ${time(batch.postedAt)}` : ''}. Each lease’s balance is now on
          its lease page.{' '}
          <Link href="/leases" className="font-medium underline underline-offset-2">
            Go to the leases
          </Link>
        </Alert>
      ) : null}

      {report ? (
        <>
          <Table caption="What a commit does, sheet by sheet">
            <thead>
              <tr>
                <Th>Sheet</Th>
                <Th className="text-right">{committed ? 'Created' : 'To create'}</Th>
                <Th className="text-right">{committed ? 'Updated' : 'To update'}</Th>
                <Th className="text-right">Unchanged</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {countRows(report.counts).map((row) => (
                <tr key={row.sheet} data-testid="batch-count">
                  <Th scope="row" className="font-medium">
                    {row.sheet}
                  </Th>
                  <Td className="text-right tabular-nums">{row.create}</Td>
                  <Td className="text-right tabular-nums">{row.update}</Td>
                  <Td className="text-right tabular-nums">{row.unchanged}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {report.totals ? (
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3" data-testid="batch-totals">
              {totalsRows(report.totals).map((row) => (
                <div key={row.key}>
                  <dt className="text-slate-600">{row.label}</dt>
                  <dd className="tabular-nums">{formatMinor(row.amountMinor)}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {report.issueCount > 0 ? (
            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-slate-900">
                {report.issueCount === 1 ? '1 problem' : `${report.issueCount} problems`}
              </h3>
              {report.issues.length < report.issueCount ? (
                <p className="text-sm text-slate-600">
                  Showing the first {report.issues.length}. Fix these and check the workbook again
                  to see the rest.
                </p>
              ) : null}
              <Table caption="Problems by sheet, row and column">
                <thead>
                  <tr>
                    <Th>Sheet</Th>
                    <Th className="text-right">Row</Th>
                    <Th>Column</Th>
                    <Th>Problem</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {report.issues.map((issue, i) => (
                    <tr key={i} data-testid="batch-issue">
                      <Td>{issue.sheet}</Td>
                      <Td className="text-right tabular-nums">{issue.row ?? '–'}</Td>
                      <Td>{issue.column ?? '–'}</Td>
                      <Td className="min-w-48">{issue.message}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </section>
          ) : batch.status === 'validated' ? (
            <p className="text-sm text-slate-700">No problems found.</p>
          ) : null}
        </>
      ) : null}

      {showsPreview(batch) ? (
        <BalancesPreview batchId={batch.id} adjustment={batch.kind === 'adjustment'} />
      ) : null}

      {canCommit(batch) ? (
        <Button pending={pending} onClick={onCommit}>
          {batch.kind === 'tenancies' ? 'Write the tenants and leases' : 'Ask for approval to post'}
        </Button>
      ) : null}
    </div>
  );
}
