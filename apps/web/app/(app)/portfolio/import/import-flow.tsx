'use client';

import type { RegisterImportRow } from '@rent/contracts';
import { MAX_IMPORT_UNIT_ROWS } from '@rent/domain/portfolio';
import Link from 'next/link';
import { useCallback, useId, useRef, useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { saveFile } from '@/lib/browser-files';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { IMPORT_STATUS_LABELS } from '@/lib/register-format';
import {
  acceptFor,
  fileProblem,
  REGISTER_IMPORT_UPLOAD,
  sendToStorage,
  sizeLabel,
  StorageUploadError,
} from '@/lib/upload';
import { useInterval } from '@/lib/use-interval';

const POLL_MS = 1_500;
const BUSY: readonly RegisterImportRow['status'][] = ['uploaded', 'validating', 'committing'];

type Step =
  | { readonly kind: 'idle' }
  | { readonly kind: 'working'; readonly label: string }
  | { readonly kind: 'error'; readonly message: string };

/**
 * The register import (PR-08): download the template, upload a filled-in copy, read the dry
 * run's report row by row, then import. The worker parses the file; this screen only polls.
 */
export function ImportFlow() {
  const { timeZone } = useApp();
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [current, setCurrent] = useState<RegisterImportRow | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [template, setTemplate] = useState<Step>({ kind: 'idle' });

  const poll = useCallback(async () => {
    if (!current) return;
    try {
      setCurrent(await api().registerImports.get({ importId: current.id }));
    } catch (failure) {
      setStep({ kind: 'error', message: toProblem(failure).message });
    }
  }, [current]);
  const waiting = current !== null && BUSY.includes(current.status);
  useInterval(() => void poll(), waiting ? POLL_MS : null);

  async function downloadTemplate() {
    setTemplate({ kind: 'working', label: 'Preparing the template…' });
    try {
      const file = await api().registerImports.template();
      saveFile(file, file.name || 'register-import-template.xlsx');
      setTemplate({ kind: 'idle' });
    } catch (failure) {
      setTemplate({ kind: 'error', message: toProblem(failure).message });
    }
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = input.current?.files?.[0];
    if (!file) {
      setStep({ kind: 'error', message: 'Choose your filled-in template first.' });
      return;
    }
    // The API's own limits (M2 plan 4.9), checked here first for a quicker, clearer answer.
    const problem = fileProblem(file, REGISTER_IMPORT_UPLOAD);
    if (problem) {
      setStep({ kind: 'error', message: problem });
      return;
    }
    try {
      setCurrent(null);
      setStep({ kind: 'working', label: 'Preparing the upload…' });
      const created = await api().registerImports.createUpload({
        sizeBytes: file.size,
        fileName: file.name,
      });
      setStep({ kind: 'working', label: 'Uploading…' });
      await sendToStorage(created.upload, file);
      setStep({ kind: 'working', label: 'Starting the check…' });
      setCurrent(await api().registerImports.validate({ importId: created.importId }));
      setStep({ kind: 'idle' });
      if (input.current) input.current.value = '';
    } catch (failure) {
      setStep({
        kind: 'error',
        message:
          failure instanceof StorageUploadError ? failure.message : toProblem(failure).message,
      });
    }
  }

  async function commit() {
    if (!current) return;
    setStep({ kind: 'working', label: 'Starting the import…' });
    try {
      setCurrent(await api().registerImports.commit({ importId: current.id }));
      setStep({ kind: 'idle' });
    } catch (failure) {
      setStep({ kind: 'error', message: toProblem(failure).message });
    }
  }

  const working = step.kind === 'working';

  return (
    <>
      <Card>
        <CardHeader
          title="1. Get the template"
          description="Three sheets: Properties, Units, and Lists with every allowed value and your owner references."
        />
        <CardBody>
          {template.kind === 'error' ? <Alert tone="error">{template.message}</Alert> : null}
          <Button
            variant="secondary"
            pending={template.kind === 'working'}
            onClick={() => void downloadTemplate()}
          >
            Download the template
          </Button>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="2. Upload your file"
          description={`An .xlsx file of up to ${sizeLabel(REGISTER_IMPORT_UPLOAD.maxBytes)} and ${new Intl.NumberFormat('en-GB').format(MAX_IMPORT_UNIT_ROWS)} units. Rows that match an existing property or unit code update it; codes are never changed.`}
        />
        <CardBody>
          <form onSubmit={upload} aria-label="Upload a register file" className="space-y-3">
            {step.kind === 'error' ? <Alert tone="error">{step.message}</Alert> : null}
            {working ? <Alert tone="info">{step.label}</Alert> : null}
            <div className="space-y-1">
              <label htmlFor={inputId} className="block text-sm font-medium text-slate-800">
                Filled-in template
              </label>
              <input
                ref={input}
                id={inputId}
                type="file"
                accept={acceptFor(REGISTER_IMPORT_UPLOAD)}
                disabled={working || waiting}
                className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-2 file:text-sm file:font-medium"
              />
            </div>
            <Button type="submit" pending={working || waiting}>
              Check the file
            </Button>
          </form>
        </CardBody>
      </Card>

      {current ? (
        <Report
          row={current}
          timeZone={timeZone}
          pending={working}
          onCommit={() => void commit()}
        />
      ) : null}
    </>
  );
}

function Report({
  row,
  timeZone,
  pending,
  onCommit,
}: {
  readonly row: RegisterImportRow;
  readonly timeZone: string;
  readonly pending: boolean;
  readonly onCommit: () => void;
}) {
  const report = row.report;
  return (
    <Card data-testid="import-report">
      <CardHeader
        title="3. Check the report, then import"
        description={row.fileName ? `File: ${row.fileName}` : undefined}
      />
      <CardBody>
        <p className="text-sm" aria-live="polite">
          <span className="text-slate-600">Status: </span>
          <strong data-testid="import-status">{IMPORT_STATUS_LABELS[row.status]}</strong>
          {row.validatedAt && row.status !== 'validating' ? (
            <span className="text-slate-600">
              {' '}
              · checked {formatTime(row.validatedAt, timeZone)}
            </span>
          ) : null}
        </p>
        {row.status === 'validating' ? (
          <Alert tone="info">Checking every row. This takes a few seconds.</Alert>
        ) : null}
        {row.status === 'committing' ? <Alert tone="info">Importing…</Alert> : null}
        {row.status === 'failed' ? (
          <Alert tone="error" title="The file could not be used">
            {row.error ?? 'Something went wrong.'} Upload the file again.
          </Alert>
        ) : null}
        {row.status === 'invalid' ? (
          <Alert tone="error" title="Nothing has been imported">
            Fix the problems below in your file, then upload it again.
          </Alert>
        ) : null}
        {row.status === 'committed' ? (
          <Alert tone="success" title="Imported">
            The register is up to date.{' '}
            <Link href="/portfolio" className="font-medium underline underline-offset-2">
              Go to the portfolio
            </Link>
          </Alert>
        ) : null}

        {report ? (
          <>
            <Table caption="What the import does">
              <thead>
                <tr>
                  <Th>
                    <span className="sr-only">Record</span>
                  </Th>
                  <Th className="text-right">
                    {row.status === 'committed' ? 'Created' : 'To create'}
                  </Th>
                  <Th className="text-right">
                    {row.status === 'committed' ? 'Updated' : 'To update'}
                  </Th>
                  <Th className="text-right">Unchanged</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(
                  [
                    ['Properties', report.counts.properties],
                    ['Units', report.counts.units],
                  ] as const
                ).map(([label, counts]) => (
                  <tr key={label} data-testid={`counts-${label.toLowerCase()}`}>
                    <Th scope="row" className="font-medium">
                      {label}
                    </Th>
                    <Td className="text-right tabular-nums">{counts.create}</Td>
                    <Td className="text-right tabular-nums">{counts.update}</Td>
                    <Td className="text-right tabular-nums">{counts.unchanged}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <p className="text-sm text-slate-700">
              New blocks: <strong>{report.counts.blocks}</strong> · New meters:{' '}
              <strong>{report.counts.meters}</strong>
            </p>

            {report.issueCount > 0 ? (
              <section aria-labelledby="issues-heading" className="space-y-2">
                <h3 id="issues-heading" className="text-sm font-semibold text-slate-900">
                  {report.issueCount === 1 ? '1 problem' : `${report.issueCount} problems`}
                </h3>
                {report.issues.length < report.issueCount ? (
                  <p className="text-sm text-slate-600">
                    Showing the first {report.issues.length}. Fix these and check the file again to
                    see the rest.
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
                      <tr key={i} data-testid="import-issue">
                        <Td>{issue.sheet}</Td>
                        <Td className="text-right tabular-nums">{issue.row ?? '–'}</Td>
                        <Td>{issue.column ?? '–'}</Td>
                        <Td className="min-w-48">{issue.message}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </section>
            ) : row.status === 'validated' ? (
              <p className="text-sm text-slate-700">No problems found.</p>
            ) : null}
          </>
        ) : null}

        {row.status === 'validated' ? (
          <Button pending={pending} onClick={onCommit}>
            Import
          </Button>
        ) : null}
      </CardBody>
    </Card>
  );
}
