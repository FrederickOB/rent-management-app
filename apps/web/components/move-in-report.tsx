'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { openFetchedLink } from '@/lib/browser-files';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import {
  MOVE_IN_REPORT_STATUS_LABELS,
  SIGNER_STATUS_LABELS,
  signedText,
  type MoveInReport,
} from '@/lib/inspections';
import { useApp } from './app-context';
import { Alert } from './ui/alert';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

/**
 * The move-in report's signing (TL-08; decision 11): where it stands, each signer, and the
 * download (the signed copy, with its certificate page, once everyone has signed).
 */
export function MoveInReportStatus({ report }: { readonly report: MoveInReport }) {
  const { timeZone } = useApp();
  const [problem, setProblem] = useState<string | null>(null);
  const tone =
    report.status === 'completed' ? 'green' : report.status === 'cancelled' ? 'dark' : 'amber';
  return (
    <div className="space-y-3 text-sm" data-testid="move-in-report">
      <p className="flex flex-wrap items-center gap-2">
        <span data-testid="move-in-report-status">
          <Badge tone={tone}>{MOVE_IN_REPORT_STATUS_LABELS[report.status]}</Badge>
        </span>
        {report.signers.length > 0 ? <span>{signedText(report.signers)}</span> : null}
      </p>
      {report.late ? (
        <Alert tone="warning" live={false}>
          This report comes more than 14 days after the lease started, so it may say less about the
          unit as it was at move-in.
        </Alert>
      ) : null}
      {report.signers.length > 0 ? (
        <ul className="divide-y divide-slate-100" aria-label="Who signs">
          {report.signers.map((signer) => (
            <li
              key={signer.id}
              className="flex flex-wrap justify-between gap-2 py-2"
              data-testid="report-signer"
            >
              <span>
                {signer.name} <span className="text-slate-600">({signer.roleLabel})</span>
              </span>
              <span>
                {SIGNER_STATUS_LABELS[signer.status]}
                {signer.signedAt ? `, ${formatTime(signer.signedAt, timeZone)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {report.status !== 'rendering' ? (
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            void openFetchedLink(
              async () =>
                (await api().inspections.moveInReportDownload({ leaseId: report.leaseId })).url,
            ).catch((failure: unknown) => setProblem(toProblem(failure).message))
          }
        >
          {report.status === 'completed' ? 'Download the signed report' : 'Download the report'}
        </Button>
      ) : (
        <p className="text-slate-600">
          The PDF is being prepared; it then goes to every party to sign.
        </p>
      )}
      {report.sha256 ? (
        <p className="break-all text-xs text-slate-600">
          Fingerprint (SHA-256) of the report everyone signs:{' '}
          <span className="font-mono">{report.sha256}</span>
        </p>
      ) : null}
      {problem ? <Alert tone="error">{problem}</Alert> : null}
    </div>
  );
}
