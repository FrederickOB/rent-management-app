'use client';

import type { LeaseDetailView, MoveOutDetail } from '@rent/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { secondaryLink, primaryLink } from '@/components/link-styles';
import { LoadFailed, Loading } from '@/components/load-state';
import { MoveInReportStatus } from '@/components/move-in-report';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { api } from '@/lib/api';
import { formatBusinessDate } from '@/lib/business-dates';
import { statusOf, toProblem } from '@/lib/errors';
import { progressText } from '@/lib/inspections';
import {
  currentMoveOut,
  mayOfferDepositSettlement,
  MOVE_OUT_KIND_LABELS,
  moveOutReasonText,
  moveOutStatusLabel,
  PLANNABLE_LEASE_STATUSES,
} from '@/lib/move-out';
import { formatMinor } from '@/lib/tenancy-format';
import { useLoad } from '@/lib/use-load';

/** Leases a move-in inspection can be done for: signed, and not yet over (decision 11). */
const MOVE_IN_STATUSES: readonly string[] = ['signed', 'active', 'holding_over', 'ending'];

/**
 * The move-in report on the lease (TL-08): where its signing stands and its download; or the
 * move-in inspection to start or carry on, which becomes the report when submitted.
 */
export function MoveInReportCard({
  lease,
  canInspect,
}: {
  readonly lease: LeaseDetailView;
  readonly canInspect: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const [report, inspections] = await Promise.all([
      api()
        .inspections.moveInReport({ leaseId: lease.id })
        .catch((failure: unknown) => {
          if (statusOf(failure) === 404) return null;
          throw failure;
        }),
      api().inspections.list({ leaseId: lease.id, kind: 'move_in' }),
    ]);
    return { report, inspections };
  }, [lease.id]);
  const { state, reload } = useLoad(load);

  async function start() {
    setPending(true);
    setError(null);
    try {
      const started = await api().inspections.start({
        unitId: lease.unit.id,
        kind: 'move_in',
        leaseId: lease.id,
      });
      router.push(`/inspections/${started.id}`);
    } catch (failure) {
      setError(toProblem(failure).message);
      setPending(false);
    }
  }

  const inProgress =
    state.status === 'ready'
      ? state.data.inspections.find((i) => i.status === 'in_progress')
      : undefined;
  const submitted =
    state.status === 'ready'
      ? state.data.inspections.find((i) => i.status === 'submitted' && i.correctedBy === null)
      : undefined;

  return (
    <Card data-testid="lease-move-in">
      <CardHeader
        title="Move-in report"
        description="The unit’s condition at move-in, room by room with photos, signed by the tenant and the landlord. The move-out is compared with it."
      />
      <CardBody>
        {state.status === 'loading' ? <Loading what="the move-in report" /> : null}
        {state.status === 'error' ? (
          <LoadFailed message={state.problem.message} onRetry={reload} />
        ) : null}
        {error ? <Alert tone="error">{error}</Alert> : null}
        {state.status === 'ready' && state.data.report ? (
          <>
            <MoveInReportStatus report={state.data.report} />
            <Link
              href={`/inspections/${state.data.report.inspectionId}`}
              className="inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-2"
            >
              Open the move-in inspection
            </Link>
          </>
        ) : null}
        {state.status === 'ready' && !state.data.report && inProgress ? (
          <p className="text-sm">
            The move-in inspection is under way (
            {progressText(inProgress.itemsDone, inProgress.itemCount)}).{' '}
            <Link
              href={`/inspections/${inProgress.id}`}
              className="font-medium underline underline-offset-2"
            >
              Carry on with it
            </Link>
          </p>
        ) : null}
        {state.status === 'ready' && !state.data.report && !inProgress && submitted ? (
          <p className="text-sm">
            The move-in inspection was submitted; its report is on its way.{' '}
            <Link
              href={`/inspections/${submitted.id}`}
              className="font-medium underline underline-offset-2"
            >
              Open it
            </Link>
          </p>
        ) : null}
        {state.status === 'ready' && !state.data.report && !inProgress && !submitted ? (
          <>
            <p className="text-sm text-slate-700">
              No move-in inspection has been done for this lease.
            </p>
            {canInspect && MOVE_IN_STATUSES.includes(lease.status) ? (
              <Button pending={pending} onClick={() => void start()}>
                Start the move-in inspection
              </Button>
            ) : null}
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}

/**
 * Move-out on the lease (TL-11, MI-11): the move-out under way with where it stands, or the way to
 * plan one; and, on a lease already ended with a deposit still held (M3's quick move-out, or an
 * M5 early termination), "Settle the deposit".
 */
export function MoveOutCard({
  lease,
  can,
}: {
  readonly lease: LeaseDetailView;
  readonly can: { readonly manage: boolean; readonly seeMoney: boolean };
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const [moveOuts, billing] = await Promise.all([
      api().moveOuts.list({ leaseId: lease.id }),
      can.seeMoney
        ? api()
            .invoices.leaseBilling({ leaseId: lease.id })
            .catch(() => null)
        : null,
    ]);
    return { moveOuts, depositHeldMinor: billing?.depositHeldMinor ?? null };
  }, [lease.id, can.seeMoney]);
  const { state, reload } = useLoad(load);

  async function settle() {
    setPending(true);
    setError(null);
    try {
      await api().moveOuts.settleDeposit({ leaseId: lease.id, note: null });
      router.push(`/leases/${lease.id}/move-out`);
    } catch (failure) {
      setError(toProblem(failure).message);
      setPending(false);
      reload();
    }
  }

  const current = state.status === 'ready' ? currentMoveOut(state.data.moveOuts) : null;
  const offerSettlement =
    state.status === 'ready' &&
    can.manage &&
    mayOfferDepositSettlement({
      leaseStatus: lease.status,
      depositHeldMinor: state.data.depositHeldMinor,
      moveOuts: state.data.moveOuts,
    });
  const offerPlan = can.manage && !current && PLANNABLE_LEASE_STATUSES.includes(lease.status);

  if (state.status === 'ready' && !current && !offerSettlement && !offerPlan) return null;

  return (
    <Card data-testid="lease-move-out">
      <CardHeader
        title="Move-out"
        description="From the planned date to the refund: the inspection, deductions from the deposit, the final statement and one approval."
        actions={current ? <MoveOutBadge status={current.status} /> : null}
      />
      <CardBody>
        {state.status === 'loading' ? <Loading what="the move-out" /> : null}
        {state.status === 'error' ? (
          <LoadFailed message={state.problem.message} onRetry={reload} />
        ) : null}
        {error ? <Alert tone="error">{error}</Alert> : null}
        {current ? (
          <>
            <p className="text-sm text-slate-800">
              {MOVE_OUT_KIND_LABELS[current.kind]}: {moveOutReasonText(current.reason)},{' '}
              {current.kind === 'deposit_settlement' ? 'lease ended ' : 'last day '}
              {formatBusinessDate(current.plannedDate)}.
            </p>
            <Link href={`/leases/${lease.id}/move-out`} className={secondaryLink}>
              Open the move-out
            </Link>
          </>
        ) : null}
        {offerPlan ? (
          <Link href={`/leases/${lease.id}/move-out`} className={primaryLink}>
            Plan the move-out
          </Link>
        ) : null}
        {offerSettlement && state.status === 'ready' ? (
          <div className="space-y-2">
            <p className="text-sm text-slate-800">
              The lease has ended and {formatMinor(state.data.depositHeldMinor)} of deposit is still
              held. Settle it: deductions if any, the final statement, one approval and the refund.
            </p>
            <Button pending={pending} onClick={() => void settle()}>
              Settle the deposit
            </Button>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

export function MoveOutBadge({ status }: { readonly status: MoveOutDetail['status'] }) {
  const tone =
    status === 'awaiting_approval'
      ? 'blue'
      : status === 'approved' || status === 'refund_paid' || status === 'closed'
        ? 'green'
        : status === 'cancelled'
          ? 'dark'
          : 'amber';
  return (
    <span data-testid="move-out-status">
      <Badge tone={tone}>{moveOutStatusLabel(status)}</Badge>
    </span>
  );
}
