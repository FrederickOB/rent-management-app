'use client';

import type { LeaseDetailView } from '@rent/contracts';
import { checkLeaseTerms } from '@rent/domain/tenancy';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { openFetchedLink } from '@/lib/browser-files';
import { formatBusinessDate } from '@/lib/business-dates';
import { toProblem } from '@/lib/errors';
import { COUNSEL_WARNING, otherWarnings, stillTracked } from '@/lib/lease-view';
import { formatMinor } from '@/lib/tenancy-format';
import { ProjectedSchedule } from '../projected-schedule';

type Period = Awaited<ReturnType<ReturnType<typeof api>['leases']['schedule']>>[number];

const FIRST_ROWS = 12;

/**
 * The rent schedule (TL-06): monthly periods anchored on the start, recorded when the lease is
 * signed (and a month at a time while it is held over). Before that, the projection from the
 * same domain rules.
 */
export function LeaseSchedule({
  lease,
  signed,
}: {
  readonly lease: LeaseDetailView;
  readonly signed: boolean;
}) {
  const [rows, setRows] = useState<readonly Period[] | null>(null);
  const [all, setAll] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const projected = useMemo(() => {
    if (signed) return null;
    const t = lease.terms;
    try {
      return checkLeaseTerms({
        startDate: t.startDate,
        endDate: t.endDate,
        monthlyRentMinor: t.monthlyRentMinor,
        cycle: t.cycle,
        initialAdvanceMonths: t.initialAdvanceMonths,
        depositMinor: t.depositMinor,
        serviceChargeMonthlyMinor: t.serviceChargeMonthlyMinor,
        steps: t.steps,
        breakClause: t.breakClause,
        noticeDays: t.noticeDays,
        use: lease.use,
      });
    } catch {
      return null;
    }
  }, [lease, signed]);

  const load = useCallback(async () => {
    if (!signed) return;
    try {
      setRows(await api().leases.schedule({ leaseId: lease.id }));
      setProblem(null);
    } catch (failure) {
      setProblem(toProblem(failure).message);
    }
  }, [lease.id, signed]);

  useEffect(() => {
    void load();
  }, [load, lease.status]);

  const shown = rows ? (all ? rows : rows.slice(0, FIRST_ROWS)) : [];
  return (
    <Card data-testid="lease-schedule">
      <CardHeader
        title="Rent schedule"
        description={
          !signed
            ? 'Recorded when the lease is signed. Until then, this is what the terms would make.'
            : stillTracked(lease)
              ? 'Monthly periods from the first day of the lease. Invoices group them by the billing cycle.'
              : 'Monthly periods recorded when the lease was signed. The lease is no longer in force.'
        }
      />
      <CardBody>
        {problem ? <Alert tone="error">{problem}</Alert> : null}
        {!signed ? <ProjectedSchedule terms={projected} /> : null}
        {signed && rows === null && !problem ? (
          <p role="status" className="text-sm text-slate-600">
            Loading…
          </p>
        ) : null}
        {signed && rows?.length === 0 ? (
          <p className="text-sm text-slate-600">No periods recorded.</p>
        ) : null}
        {shown.length ? (
          <>
            <Table caption="Rent schedule">
              <thead>
                <tr>
                  <Th>#</Th>
                  <Th>Period</Th>
                  <Th>Charge</Th>
                  <Th className="text-right">Amount</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shown.map((row) => (
                  <tr key={`${row.sequence}-${row.chargeType}`} data-testid="schedule-row">
                    <Td className="tabular-nums">{row.sequence + 1}</Td>
                    <Td className="whitespace-nowrap">
                      {formatBusinessDate(row.periodStart)} to {formatBusinessDate(row.periodEnd)}
                    </Td>
                    <Td>
                      {row.chargeType === 'rent' ? 'Rent' : 'Service charge'}
                      {row.prorated ? ' (part month, by the day)' : ''}
                      {row.source === 'holding_over' ? ' (held over)' : ''}
                    </Td>
                    <Td className="text-right tabular-nums">{formatMinor(row.amountMinor)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {rows && rows.length > FIRST_ROWS ? (
              <Button size="sm" variant="ghost" onClick={() => setAll((a) => !a)}>
                {all ? 'Show fewer' : `Show all ${rows.length} rows`}
              </Button>
            ) : null}
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}

/**
 * The lease document as its PDF will read (TL-05), rendered by the API from the template and the
 * lease's data. It shows in a sandboxed frame: no scripts run in it and it cannot reach this page.
 * On a draft, the counsel-review warning shows here, once, from the lease itself.
 */
export function LeasePreview({
  leaseId,
  counselWarning,
}: {
  readonly leaseId: string;
  readonly counselWarning: boolean;
}) {
  const [preview, setPreview] = useState<{ html: string; warnings: string[] } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPreview(await api().leases.preview({ leaseId }));
      setProblem(null);
    } catch (failure) {
      setProblem(toProblem(failure).message);
    }
  }, [leaseId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card data-testid="lease-preview">
      <CardHeader
        title="Document preview"
        description="Exactly what signers will read, filled in from this draft."
        actions={
          <Button size="sm" variant="secondary" onClick={() => void load()}>
            Refresh
          </Button>
        }
      />
      <CardBody>
        {counselWarning ? (
          <Alert tone="warning" title="Not reviewed by a lawyer">
            {COUNSEL_WARNING}
          </Alert>
        ) : null}
        {problem ? <Alert tone="error">{problem}</Alert> : null}
        {otherWarnings(preview?.warnings ?? []).map((warning) => (
          <Alert key={warning} tone="warning">
            {warning}
          </Alert>
        ))}
        {preview ? (
          <iframe
            title="Lease document preview"
            sandbox=""
            srcDoc={preview.html}
            className="h-[36rem] w-full rounded-md border border-slate-200 bg-white"
          />
        ) : !problem ? (
          <p role="status" className="text-sm text-slate-600">
            Loading the document…
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}

/** The lease's papers, each opened through a 5-minute link issued after a policy check. */
export function LeaseDocuments({ lease }: { readonly lease: LeaseDetailView }) {
  const [problem, setProblem] = useState<string | null>(null);
  const files: { which: 'signed' | 'stamped' | 'formal'; label: string; present: boolean }[] = [
    {
      which: 'signed',
      label: lease.signing.signedOnPaper ? 'The signed paper lease (scan)' : 'The signed lease',
      present: lease.signing.signedDocument,
    },
    {
      which: 'stamped',
      label: 'The stamped copy',
      present: lease.trackers.stamping.stampedCopy,
    },
    {
      which: 'formal',
      label: 'The formal lease (wet-signed)',
      present: lease.trackers.formalLease.wetSignedCopy,
    },
  ];
  const present = files.filter((f) => f.present);

  async function open(which: 'signed' | 'stamped' | 'formal') {
    setProblem(null);
    try {
      await openFetchedLink(
        async () => (await api().leases.download({ leaseId: lease.id, which })).url,
      );
    } catch (failure) {
      setProblem(toProblem(failure).message);
    }
  }

  return (
    <Card data-testid="lease-documents">
      <CardHeader title="Documents" description="Kept in write-once storage." />
      <CardBody>
        {problem ? <Alert tone="error">{problem}</Alert> : null}
        {present.length === 0 ? (
          <p className="text-sm text-slate-600">No documents yet.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {present.map((file) => (
              <li key={file.which}>
                <Button variant="secondary" onClick={() => void open(file.which)}>
                  {file.label}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
