'use client';

import { RECEIVING_ACCOUNTS } from '@rent/contracts';
import { LEASE_STATUSES } from '@rent/domain/tenancy';
import type { LeaseDetailView, MoveOutDetail } from '@rent/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useRef, useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { DeductionList } from '@/components/deduction-list';
import { FileField } from '@/components/file-field';
import { FinalStatement } from '@/components/final-statement';
import { secondaryLink } from '@/components/link-styles';
import { LoadFailed, Loading } from '@/components/load-state';
import { PageHeader } from '@/components/page-header';
import { ReasonForm } from '@/components/reason-form';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { CheckboxField, SelectField, TextAreaField, TextField } from '@/components/ui/field';
import { api, keyedApi } from '@/lib/api';
import { RECEIVING_ACCOUNT_LABELS } from '@/lib/billing-format';
import { openFetchedLink } from '@/lib/browser-files';
import { formatBusinessDate, todayIn } from '@/lib/business-dates';
import { errorCode, toProblem } from '@/lib/errors';
import {
  isKeyReused,
  moneyProblem,
  sendOnce,
  useIdempotencyKeeper,
  useKeepers,
} from '@/lib/idempotency';
import { useHoldWhileSending } from '@/lib/in-flight';
import { conditionLabel, progressText, type InspectionDetail } from '@/lib/inspections';
import {
  chargesInput,
  currentMoveOut,
  DEDUCTION_OPTIONS,
  deductionInput,
  deductionKindOf,
  depositLeftMinor,
  emptyCharge,
  emptyDeduction,
  evidenceGuidance,
  FIGURES_NO_LONGER_HOLD,
  isEarly,
  liveDeductions,
  deductionsTotal,
  mayOfferDepositSettlement,
  MOVE_OUT_KIND_LABELS,
  MOVE_OUT_REFUSAL_TEXT,
  moveOutNext,
  moveOutRefusal,
  moveOutReasonText,
  PLANNABLE_LEASE_STATUSES,
  planInput,
  REASON_OPTIONS,
  reasonOf,
  refundInput,
  rowsOfCharges,
  type ChargeRow,
  type DeductionDraft,
  type PlanDraft,
} from '@/lib/move-out';
import { fileAgainMessage, needsFileAgain } from '@/lib/payment-upload';
import { TAX_FILE_UPLOAD, taxUploadOnce } from '@/lib/tax-upload';
import { formatMinor, leaseStatusLabel } from '@/lib/tenancy-format';
import { fileProblem, StorageUploadError } from '@/lib/upload';
import { useLoad } from '@/lib/use-load';
import { MoveOutBadge } from '../lease-move';

/** The lease's status in words, as the lease page says it. */
function leaseStatusText(status: string): string {
  const known = LEASE_STATUSES.find((s) => s === status);
  return known ? leaseStatusLabel(known) : status;
}

export interface MoveOutPermissions {
  readonly manage: boolean;
  readonly seeMoney: boolean;
  readonly seeApprovals: boolean;
  readonly seeNotices: boolean;
  readonly agency: boolean;
}

interface Loaded {
  readonly detail: MoveOutDetail | null;
  readonly inspection: InspectionDetail | null;
  readonly depositHeldMinor: number | null;
  readonly anyMoveOut: readonly { readonly status: MoveOutDetail['status'] }[];
}

export function MoveOutView({
  lease,
  can,
}: {
  readonly lease: LeaseDetailView;
  readonly can: MoveOutPermissions;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const load = useCallback(async (): Promise<Loaded> => {
    const [moveOuts, billing] = await Promise.all([
      api().moveOuts.list({ leaseId: lease.id }),
      can.seeMoney
        ? api()
            .invoices.leaseBilling({ leaseId: lease.id })
            .catch(() => null)
        : null,
    ]);
    const current = currentMoveOut(moveOuts);
    const detail = current ? await api().moveOuts.get({ moveOutId: current.id }) : null;
    const inspection = detail?.inspectionId
      ? await api()
          .inspections.get({ inspectionId: detail.inspectionId })
          .catch(() => null)
      : null;
    return {
      detail,
      inspection,
      depositHeldMinor: billing?.depositHeldMinor ?? null,
      anyMoveOut: moveOuts,
    };
  }, [lease.id, can.seeMoney]);
  const { state, reload } = useLoad(load);

  const changed = (text: string) => {
    setNotice(text);
    reload();
  };

  const header = (
    <>
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link href="/leases" className="underline underline-offset-2">
          Leases
        </Link>{' '}
        <span aria-hidden="true">›</span>{' '}
        <Link href={`/leases/${lease.id}`} className="font-mono underline underline-offset-2">
          {lease.unit.code}
        </Link>{' '}
        <span aria-hidden="true">›</span> <span>Move-out</span>
      </nav>
      <PageHeader
        title={`Move-out, ${lease.unit.code}`}
        description={`${lease.unit.propertyName} · ${lease.tenant.displayName} · lease ${formatBusinessDate(lease.terms.startDate)} to ${formatBusinessDate(lease.terms.endDate)}`}
      />
    </>
  );

  if (state.status !== 'ready')
    return (
      <>
        {header}
        {state.status === 'loading' ? <Loading what="the move-out" /> : null}
        {state.status === 'error' ? (
          <LoadFailed message={state.problem.message} onRetry={reload} />
        ) : null}
      </>
    );

  const { detail } = state.data;
  if (!detail) {
    const settle =
      can.manage &&
      mayOfferDepositSettlement({
        leaseStatus: lease.status,
        depositHeldMinor: state.data.depositHeldMinor,
        moveOuts: state.data.anyMoveOut,
      });
    return (
      <>
        {header}
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        {can.manage && PLANNABLE_LEASE_STATUSES.includes(lease.status) ? (
          <PlanForm lease={lease} canSeeNotices={can.seeNotices} onDone={changed} />
        ) : settle ? (
          <SettleDeposit
            lease={lease}
            depositHeldMinor={state.data.depositHeldMinor ?? 0}
            onDone={changed}
          />
        ) : (
          <Alert tone="info">
            No move-out has been planned for this lease
            {can.manage ? ', and it is not one a move-out can be planned for now.' : '.'}
          </Alert>
        )}
      </>
    );
  }

  return (
    <>
      {header}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <MoveOutSummary
        detail={detail}
        lease={lease}
        canSeeApprovals={can.seeApprovals}
        cancelling={cancelling}
        onCancelling={setCancelling}
        onDone={changed}
      />
      <InspectionStep detail={detail} inspection={state.data.inspection} onDone={changed} />
      <DeductionsStep
        detail={detail}
        inspection={state.data.inspection}
        depositHeldMinor={detail.statement?.depositHeldMinor ?? state.data.depositHeldMinor}
        onDone={changed}
      />
      {/* Review WEB 1: damage beyond the deposit is a charge on any move-out, not only an early end. */}
      <ChargesStep detail={detail} onDone={changed} />
      <StatementStep detail={detail} />
      {detail.actions.submit ? (
        <SubmitStep
          detail={detail}
          canSeeApprovals={can.seeApprovals}
          onCancelMoveOut={() => {
            setCancelling(true);
            document
              .querySelector('[data-testid="move-out-summary"]')
              ?.scrollIntoView({ block: 'start' });
          }}
          onDone={changed}
        />
      ) : null}
      {detail.actions.recordRefundPaid || detail.refundPaid ? (
        <RefundStep detail={detail} agency={can.agency} onDone={changed} />
      ) : null}
    </>
  );
}

function PlanForm({
  lease,
  canSeeNotices,
  onDone,
}: {
  readonly lease: LeaseDetailView;
  readonly canSeeNotices: boolean;
  readonly onDone: (text: string) => void;
}) {
  const { timeZone } = useApp();
  const [draft, setDraft] = useState<PlanDraft>(() => ({
    plannedDate: lease.terms.endDate,
    reason: '',
    noticeId: '',
    note: '',
  }));
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notices = useLoad(
    useCallback(
      async () =>
        canSeeNotices
          ? (await api().notices.list({ leaseId: lease.id })).filter((n) => n.issuedAt !== null)
          : [],
      [canSeeNotices, lease.id],
    ),
  );
  const parsed = planInput(draft, {
    startDate: lease.terms.startDate,
    endDate: lease.terms.endDate,
  });
  const errors = tried ? parsed.errors : {};
  const early =
    /^\d{4}-\d{2}-\d{2}$/.test(draft.plannedDate) &&
    isEarly(draft.plannedDate, lease.terms.endDate);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    if (!parsed.input) return;
    setPending(true);
    try {
      await api().moveOuts.plan({ leaseId: lease.id, ...parsed.input });
      onDone(
        'Planned the move-out. The lease is now Ending; it stays in force until the last day.',
      );
    } catch (failure) {
      setError(toProblem(failure).message);
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Plan the move-out"
        description="The tenancy’s last day and why it ends. Unpaid rent and charges come from the ledger; nothing about money is typed here."
      />
      <CardBody>
        <form onSubmit={submit} noValidate aria-label="Plan the move-out" className="space-y-4">
          {error ? <Alert tone="error">{error}</Alert> : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Last day"
              type="date"
              min={lease.terms.startDate}
              value={draft.plannedDate}
              error={errors.plannedDate}
              hint={`The lease runs to ${formatBusinessDate(lease.terms.endDate)}. Today is ${formatBusinessDate(todayIn(timeZone))}.`}
              onChange={(event) => setDraft((d) => ({ ...d, plannedDate: event.target.value }))}
            />
            <SelectField
              label="Why it ends"
              value={draft.reason}
              error={errors.reason}
              options={[{ value: '', label: 'Choose why' }, ...REASON_OPTIONS]}
              onChange={(event) =>
                setDraft((d) => ({ ...d, reason: reasonOf(event.target.value) ?? '' }))
              }
            />
          </div>
          {early ? (
            <Alert tone="info" live={false}>
              This is before the end date, so it is an early end: agreed charges and the break
              clause can apply, and the lease will show Terminated once the settlement is approved.
            </Alert>
          ) : null}
          {canSeeNotices && notices.state.status === 'ready' && notices.state.data.length > 0 ? (
            <SelectField
              label="The notice it follows (optional)"
              value={draft.noticeId}
              error={errors.noticeId}
              options={[
                { value: '', label: 'None' },
                ...notices.state.data.map((n) => ({
                  value: n.id,
                  label: `${n.number ?? n.typeLabel}: ${n.typeLabel}${n.effectiveDate ? `, from ${formatBusinessDate(n.effectiveDate)}` : ''}`,
                })),
              ]}
              onChange={(event) => setDraft((d) => ({ ...d, noticeId: event.target.value }))}
            />
          ) : null}
          <p className="text-sm text-slate-700">
            A notice to quit never ends a tenancy by itself; possession needs a court or Rent
            Control order.
          </p>
          <TextAreaField
            label="Note (optional)"
            rows={2}
            maxLength={1000}
            value={draft.note}
            error={errors.note}
            onChange={(event) => setDraft((d) => ({ ...d, note: event.target.value }))}
            className="[&_textarea]:font-sans"
          />
          <Button type="submit" pending={pending}>
            Plan the move-out
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

function SettleDeposit({
  lease,
  depositHeldMinor,
  onDone,
}: {
  readonly lease: LeaseDetailView;
  readonly depositHeldMinor: number;
  readonly onDone: (text: string) => void;
}) {
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api().moveOuts.settleDeposit({ leaseId: lease.id, note: note.trim() || null });
      onDone(
        'Started the deposit settlement. Inspect the unit first if you can, so deductions have photos behind them.',
      );
    } catch (failure) {
      setError(toProblem(failure).message);
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Settle the deposit"
        description={`The lease has ended and ${formatMinor(depositHeldMinor)} of deposit is still held.`}
      />
      <CardBody>
        <form onSubmit={submit} noValidate aria-label="Settle the deposit" className="space-y-4">
          {error ? <Alert tone="error">{error}</Alert> : null}
          <p className="text-sm text-slate-700">
            The deposit pays any unpaid rent and charges first, then any deductions, and the rest is
            refunded. A second person approves it.
          </p>
          <TextAreaField
            label="Note (optional)"
            rows={2}
            maxLength={1000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className="[&_textarea]:font-sans"
          />
          <Button type="submit" pending={pending}>
            Settle the deposit
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

function MoveOutSummary({
  detail,
  lease,
  canSeeApprovals,
  cancelling,
  onCancelling: setCancelling,
  onDone,
}: {
  readonly detail: MoveOutDetail;
  readonly lease: LeaseDetailView;
  readonly canSeeApprovals: boolean;
  /** Open from here, or from a refusal elsewhere on the page (LEASE_ENDED_FIRST). */
  readonly cancelling: boolean;
  readonly onCancelling: (open: boolean) => void;
  readonly onDone: (text: string) => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <Card data-testid="move-out-summary">
      <CardHeader
        title={MOVE_OUT_KIND_LABELS[detail.kind]}
        description={moveOutNext(detail)}
        actions={<MoveOutBadge status={detail.status} />}
      />
      <CardBody>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-slate-600">Why</dt>
            <dd>{moveOutReasonText(detail.reason)}</dd>
          </div>
          <div>
            <dt className="text-slate-600">
              {detail.kind === 'deposit_settlement' ? 'Lease ended' : 'Last day'}
            </dt>
            <dd>{formatBusinessDate(detail.plannedDate)}</dd>
          </div>
          <div>
            <dt className="text-slate-600">Lease</dt>
            <dd>{leaseStatusText(detail.leaseStatus)}</dd>
          </div>
          {detail.approvedOn ? (
            <div>
              <dt className="text-slate-600">Approved</dt>
              <dd>{formatBusinessDate(detail.approvedOn)}</dd>
            </div>
          ) : null}
          {detail.noticeId ? (
            <div>
              <dt className="text-slate-600">Notice</dt>
              <dd>
                <Link href={`/notices/${detail.noticeId}`} className="underline underline-offset-2">
                  Open the notice
                </Link>
              </dd>
            </div>
          ) : null}
          {detail.note ? (
            <div className="sm:col-span-2">
              <dt className="text-slate-600">Note</dt>
              <dd className="whitespace-pre-wrap">{detail.note}</dd>
            </div>
          ) : null}
        </dl>
        {detail.approvalFiguresHold === false ? (
          <Alert tone="warning" title="The figures no longer hold" live={false}>
            <span data-testid="figures-no-longer-hold">{FIGURES_NO_LONGER_HOLD}</span>
          </Alert>
        ) : null}
        {detail.status === 'awaiting_approval' && canSeeApprovals ? (
          <Link href="/approvals" className={secondaryLink}>
            Open Approvals
          </Link>
        ) : null}
        {detail.statementDocument ? (
          <Button
            variant="secondary"
            onClick={() =>
              void openFetchedLink(
                async () => (await api().moveOuts.statementDocument({ moveOutId: detail.id })).url,
              ).catch((failure: unknown) => setProblem(toProblem(failure).message))
            }
          >
            Open the final statement (PDF)
          </Button>
        ) : null}
        {problem ? <Alert tone="error">{problem}</Alert> : null}
        {detail.actions.cancel && !cancelling ? (
          <Button variant="ghost" onClick={() => setCancelling(true)}>
            Cancel the move-out
          </Button>
        ) : null}
        {cancelling ? (
          <ReasonForm
            label="Cancel the move-out"
            intro={
              detail.kind === 'deposit_settlement'
                ? 'The deposit stays held. Deductions recorded are kept, withdrawn.'
                : 'The lease goes back to Active. Anything recorded is kept in the history.'
            }
            minLength={3}
            submitText="Cancel the move-out"
            danger
            onSubmit={async (reason) => {
              await api().moveOuts.cancel({ moveOutId: detail.id, reason });
              setCancelling(false);
              onDone(`Cancelled the move-out of ${lease.unit.code}.`);
            }}
            onCancel={() => setCancelling(false)}
          />
        ) : null}
      </CardBody>
    </Card>
  );
}

function InspectionStep({
  detail,
  inspection,
  onDone,
}: {
  readonly detail: MoveOutDetail;
  readonly inspection: InspectionDetail | null;
  readonly onDone: (text: string) => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setPending(true);
    setError(null);
    try {
      const next = await api().moveOuts.startInspection({ moveOutId: detail.id });
      if (next.inspectionId) router.push(`/inspections/${next.inspectionId}`);
      else onDone('Started the move-out inspection.');
    } catch (failure) {
      setError(toProblem(failure).message);
      setPending(false);
    }
  }

  const worse = inspection?.items.filter((i) => i.worsened) ?? [];
  return (
    <Card data-testid="move-out-inspection">
      <CardHeader
        title="1. The move-out inspection"
        description="Room by room, compared item by item with the move-in report."
      />
      <CardBody>
        {error ? <Alert tone="error">{error}</Alert> : null}
        {inspection ? (
          <>
            <p className="text-sm">
              {inspection.status === 'submitted' ? 'Submitted' : 'In progress'}:{' '}
              {progressText(inspection.itemsDone, inspection.itemCount)}
              {worse.length > 0 ? `; ${worse.length} worse than at move-in` : ''}.
            </p>
            {worse.length > 0 ? (
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {worse.map((item) => (
                  <li key={item.id}>
                    {item.roomLabel}, {item.itemLabel}:{' '}
                    {conditionLabel(item.moveIn?.condition ?? null)} at move-in,{' '}
                    {conditionLabel(item.condition)} now
                  </li>
                ))}
              </ul>
            ) : null}
            <Link href={`/inspections/${inspection.id}`} className={secondaryLink}>
              {inspection.status === 'submitted'
                ? 'Open the inspection'
                : 'Carry on with the inspection'}
            </Link>
          </>
        ) : detail.inspectionId ? (
          <Link href={`/inspections/${detail.inspectionId}`} className={secondaryLink}>
            Open the inspection
          </Link>
        ) : (
          <>
            <p className="text-sm text-slate-700">
              {detail.kind === 'deposit_settlement'
                ? 'The lease ended without an inspection. Inspect the unit now if you can, before adding deductions, so each has photos behind it. It is optional.'
                : 'Not started yet.'}
            </p>
            {detail.actions.inspect ? (
              <Button pending={pending} onClick={() => void start()}>
                Start the move-out inspection
              </Button>
            ) : null}
          </>
        )}
      </CardBody>
    </Card>
  );
}

function DeductionsStep({
  detail,
  inspection,
  depositHeldMinor,
  onDone,
}: {
  readonly detail: MoveOutDetail;
  readonly inspection: InspectionDetail | null;
  /** From the statement, or the lease's money card while there is none. */
  readonly depositHeldMinor: number | null;
  readonly onDone: (text: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const held = depositHeldMinor;
  const live = liveDeductions(detail.deductions);
  const total = deductionsTotal(live);
  const left = held === null ? null : depositLeftMinor(held, detail.deductions);
  // Review WEB 3: one key per deduction withdrawn, so a retry never withdraws twice.
  const keepers = useKeepers();

  async function withdraw(id: string) {
    setWithdrawing(id);
    setError(null);
    const keeper = keepers(`withdraw:${id}`);
    try {
      await sendOnce(keeper, (key) =>
        keyedApi(key).moveOuts.withdrawDeduction({ moveOutId: detail.id, deductionId: id }),
      );
      onDone('Withdrew the deduction. It stays in the history.');
    } catch (failure) {
      setError(moneyProblem(failure));
      if (isKeyReused(failure)) keeper.reset();
    } finally {
      setWithdrawing(null);
    }
  }

  return (
    <Card data-testid="move-out-deductions">
      <CardHeader
        title="2. Deductions from the deposit"
        description="Each with the inspection items and photos behind it. They never add up to more than the deposit held; damage beyond it is a charge to the tenant."
      />
      <CardBody>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <dl className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4" data-testid="deposit-left">
          <div>
            <dt className="text-slate-600">Deposit held</dt>
            <dd className="tabular-nums">
              {held === null ? 'Shown with the statement' : formatMinor(held)}
            </dd>
          </div>
          <div>
            <dt className="text-slate-600">Deductions</dt>
            <dd className="tabular-nums">{formatMinor(total)}</dd>
          </div>
          <div>
            <dt className="text-slate-600">Most that can still be deducted</dt>
            <dd className="font-semibold tabular-nums" data-testid="deposit-left-amount">
              {left === null ? 'Not known yet' : formatMinor(left)}
            </dd>
          </div>
          {/* Review WEB 7: the deposit pays unpaid rent first, so the API's own figure says what
              is left of it; a deduction past that is charged to the tenant. */}
          {detail.statement ? (
            <div>
              <dt className="text-slate-600">
                Left of the deposit after unpaid rent and deductions
              </dt>
              <dd className="tabular-nums" data-testid="deposit-refund-left">
                {formatMinor(detail.statement.depositRefundMinor)}
              </dd>
            </div>
          ) : null}
        </dl>
        {detail.statement && detail.statement.depositAppliedMinor > 0 ? (
          <p className="text-sm text-slate-700" data-testid="deposit-pays-arrears">
            The deposit pays {formatMinor(detail.statement.depositAppliedMinor)} of unpaid rent and
            charges first. Deductions beyond what is then left are charged to the tenant, not kept
            from the deposit.
          </p>
        ) : null}
        <DeductionList
          deductions={detail.deductions}
          items={inspection?.items ?? []}
          inspectionId={detail.inspectionId}
          withdrawing={withdrawing}
          {...(detail.actions.editSettlement ? { onWithdraw: (d) => void withdraw(d.id) } : {})}
        />
        {detail.actions.editSettlement && !adding ? (
          <Button variant="secondary" onClick={() => setAdding(true)}>
            Add a deduction
          </Button>
        ) : null}
        {adding ? (
          <DeductionForm
            detail={detail}
            inspection={inspection}
            leftMinor={left}
            onDone={(text) => {
              setAdding(false);
              onDone(text);
            }}
            onCancel={() => setAdding(false)}
          />
        ) : null}
      </CardBody>
    </Card>
  );
}

function DeductionForm({
  detail,
  inspection,
  leftMinor,
  onDone,
  onCancel,
}: {
  readonly detail: MoveOutDetail;
  readonly inspection: InspectionDetail | null;
  readonly leftMinor: number | null;
  readonly onDone: (text: string) => void;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState<DeductionDraft>(emptyDeduction);
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  // Review WEB 3: the deduction's key belongs to what was typed; any change is a new deduction.
  const keeper = useIdempotencyKeeper();
  const keyedFor = useRef<string | null>(null);
  // Unknown until the statement can be shown: the API checks the limit regardless.
  const parsed = deductionInput(draft, leftMinor ?? Number.MAX_SAFE_INTEGER);
  const errors = tried ? parsed.errors : {};
  const items = [...(inspection?.items ?? [])].sort(
    (a, b) => Number(b.worsened) - Number(a.worsened),
  );
  // Founder, 2026-11-06: damage and missing items need evidence; without an inspection, guide
  // the person to do it first.
  const guidance = evidenceGuidance(draft.kind, items.length > 0);

  async function startInspection() {
    setStarting(true);
    setError(null);
    try {
      const next = await api().moveOuts.startInspection({ moveOutId: detail.id });
      if (next.inspectionId) router.push(`/inspections/${next.inspectionId}`);
      else setStarting(false);
    } catch (failure) {
      setError(toProblem(failure).message);
      setStarting(false);
    }
  }

  const photos = items
    .filter((i) => draft.itemIds.includes(i.id))
    .flatMap((i) =>
      i.photos.map((p, index) => ({ ...p, label: `${i.itemLabel}, photo ${index + 1}` })),
    );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    setRefused(null);
    const input = parsed.input;
    if (!input) return;
    const content = JSON.stringify(input);
    if (keyedFor.current !== content) {
      keeper.reset();
      keyedFor.current = content;
    }
    setPending(true);
    try {
      await sendOnce(keeper, (key) =>
        keyedApi(key).moveOuts.addDeduction({ moveOutId: detail.id, ...input }),
      );
      onDone(`Added the deduction of ${formatMinor(input.amountMinor)}.`);
    } catch (failure) {
      setPending(false);
      // ★ MI-11: the deductions never exceed the deposit held; the API refuses it (409).
      // The API's evidence rule, on a move-out with an inspection: damage needs an inspection
      // item or a photo behind it.
      if (errorCode(failure) === 'DEDUCTION_EVIDENCE_REQUIRED') {
        setError(
          evidenceGuidance(draft.kind, items.length > 0) ??
            'Damage and missing items need an inspection item or a photo behind them. Choose them from the inspection below.',
        );
        return;
      }
      if (errorCode(failure) === 'DEDUCTIONS_EXCEED_DEPOSIT') {
        setRefused(
          `${toProblem(failure).message.replace(/\.$/, '')}.${leftMinor !== null ? ` Only ${formatMinor(leftMinor)} of the deposit is left.` : ''}`,
        );
        return;
      }
      setError(moneyProblem(failure));
      if (isKeyReused(failure)) {
        keeper.reset();
        keyedFor.current = null;
      }
    }
  }

  const toggle = (key: 'itemIds' | 'photoIds', id: string, on: boolean) =>
    setDraft((d) => {
      const next = on ? [...d[key], id] : d[key].filter((x) => x !== id);
      if (key === 'itemIds' && !on) {
        const dropped = new Set(items.find((i) => i.id === id)?.photos.map((p) => p.id) ?? []);
        return { ...d, itemIds: next, photoIds: d.photoIds.filter((p) => !dropped.has(p)) };
      }
      return { ...d, [key]: next };
    });

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="Add a deduction"
      className="space-y-4 rounded-md border border-slate-200 bg-slate-50 p-4"
    >
      {error ? <Alert tone="error">{error}</Alert> : null}
      {refused ? (
        <Alert tone="error" title="More than the deposit held">
          <span data-testid="deduction-refused">{refused}</span> Record damage beyond the deposit as
          a charge instead.
        </Alert>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label="For"
          value={draft.kind}
          error={errors.kind}
          options={[{ value: '', label: 'Choose' }, ...DEDUCTION_OPTIONS]}
          onChange={(event) =>
            setDraft((d) => ({ ...d, kind: deductionKindOf(event.target.value) ?? '' }))
          }
        />
        <TextField
          label="Amount (GH₵)"
          inputMode="decimal"
          autoComplete="off"
          value={draft.amount}
          error={errors.amount}
          hint={
            leftMinor !== null
              ? `At most ${formatMinor(leftMinor)}: what is left of the deposit.`
              : undefined
          }
          onChange={(event) => setDraft((d) => ({ ...d, amount: event.target.value }))}
        />
      </div>
      <TextAreaField
        label="Reason"
        hint="The tenant sees it on the final statement."
        rows={2}
        maxLength={500}
        value={draft.reason}
        error={errors.reason}
        onChange={(event) => setDraft((d) => ({ ...d, reason: event.target.value }))}
        className="[&_textarea]:font-sans"
      />
      {items.length > 0 ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-slate-800">
            The inspection items behind it
          </legend>
          <div className="max-h-72 space-y-1 overflow-y-auto rounded border border-slate-200 bg-white p-2">
            {items.map((item) => (
              <CheckboxField
                key={item.id}
                label={`${item.roomLabel}, ${item.itemLabel}: ${conditionLabel(item.condition)}${item.worsened ? ' (worse than at move-in)' : ''}`}
                checked={draft.itemIds.includes(item.id)}
                onChange={(event) => toggle('itemIds', item.id, event.target.checked)}
              />
            ))}
          </div>
          {photos.length > 0 ? (
            <div className="space-y-1">
              <p className="text-sm font-medium text-slate-800">Their photos</p>
              {photos.map((photo) => (
                <CheckboxField
                  key={photo.id}
                  label={photo.label}
                  checked={draft.photoIds.includes(photo.id)}
                  onChange={(event) => toggle('photoIds', photo.id, event.target.checked)}
                />
              ))}
            </div>
          ) : null}
          {errors.evidence ? (
            <p className="text-sm font-medium text-red-700">{errors.evidence}</p>
          ) : null}
        </fieldset>
      ) : guidance ? (
        <Alert tone="warning" title="Do the move-out inspection first" live={false}>
          <p data-testid="evidence-guidance">{guidance}</p>
          {detail.actions.inspect ? (
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              pending={starting}
              onClick={() => void startInspection()}
            >
              Start the move-out inspection
            </Button>
          ) : null}
        </Alert>
      ) : (
        <Alert tone="warning" live={false}>
          There is no move-out inspection, so this deduction will have no items or photos behind it,
          and the approver is told.
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={pending}>
          Add the deduction
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ChargesStep({
  detail,
  onDone,
}: {
  readonly detail: MoveOutDetail;
  readonly onDone: (text: string) => void;
}) {
  const [rows, setRows] = useState<ChargeRow[]>(() =>
    detail.charges.length > 0 ? rowsOfCharges(detail.charges) : [emptyCharge],
  );
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = chargesInput(rows);
  const editable = detail.actions.editSettlement;
  // Review WEB 3: the charges' key belongs to the list sent; a changed list is a new request.
  const keeper = useIdempotencyKeeper();
  const keyedFor = useRef<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    const charges = parsed.charges;
    if (!charges) return;
    const content = JSON.stringify(charges);
    if (keyedFor.current !== content) {
      keeper.reset();
      keyedFor.current = content;
    }
    setPending(true);
    try {
      await sendOnce(keeper, (key) =>
        keyedApi(key).moveOuts.setCharges({ moveOutId: detail.id, charges }),
      );
      onDone('Saved the charges. The final statement has been worked out again.');
    } catch (failure) {
      setError(moneyProblem(failure));
      if (isKeyReused(failure)) {
        keeper.reset();
        keyedFor.current = null;
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <Card data-testid="move-out-charges">
      <CardHeader
        title="3. Charges to the tenant"
        description="Damage beyond the deposit, on any move-out, and what the tenant agreed to pay for leaving early. They are raised as one-off charges (P01) when the settlement is approved, and the statement shows them in what is owed."
      />
      <CardBody>
        {editable ? (
          <form
            onSubmit={submit}
            noValidate
            aria-label="Charges to the tenant"
            className="space-y-3"
          >
            {error ? <Alert tone="error">{error}</Alert> : null}
            {rows.map((row, index) => (
              <div key={index} className="grid gap-2 sm:grid-cols-[1fr_10rem_auto] sm:items-end">
                <TextField
                  label={`Charge ${index + 1}`}
                  maxLength={120}
                  value={row.description}
                  error={tried ? parsed.errors[index] : undefined}
                  onChange={(event) =>
                    setRows((r) =>
                      r.map((x, i) =>
                        i === index ? { ...x, description: event.target.value } : x,
                      ),
                    )
                  }
                />
                <TextField
                  label="Amount (GH₵)"
                  inputMode="decimal"
                  autoComplete="off"
                  value={row.amount}
                  onChange={(event) =>
                    setRows((r) =>
                      r.map((x, i) => (i === index ? { ...x, amount: event.target.value } : x)),
                    )
                  }
                />
                <Button
                  variant="ghost"
                  onClick={() =>
                    setRows((r) => (r.length > 1 ? r.filter((_, i) => i !== index) : [emptyCharge]))
                  }
                >
                  Remove <span className="sr-only">charge {index + 1}</span>
                </Button>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={() => setRows((r) => [...r, emptyCharge])}
                disabled={rows.length >= 20}
              >
                Add a charge
              </Button>
              <Button type="submit" pending={pending}>
                Save the charges
              </Button>
            </div>
          </form>
        ) : detail.charges.length === 0 ? (
          <p className="text-sm text-slate-600">None.</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {detail.charges.map((c, index) => (
              <li key={index} className="flex justify-between gap-2 py-2">
                <span>{c.description}</span>
                <span className="tabular-nums">{formatMinor(c.amountMinor)}</span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function StatementStep({ detail }: { readonly detail: MoveOutDetail }) {
  return (
    <Card data-testid="move-out-statement">
      <CardHeader
        title="4. The final statement"
        description={
          detail.approvedOn
            ? 'As it was done when the settlement was approved.'
            : 'As it would be done now, from the ledger. It always balances.'
        }
      />
      <CardBody>
        {detail.statement ? (
          <FinalStatement statement={detail.statement} />
        ) : (
          <Alert tone="info">
            {detail.statementUnavailable?.message ?? 'The statement cannot be shown yet.'}
          </Alert>
        )}
      </CardBody>
    </Card>
  );
}

function SubmitStep({
  detail,
  canSeeApprovals,
  onCancelMoveOut,
  onDone,
}: {
  readonly detail: MoveOutDetail;
  readonly canSeeApprovals: boolean;
  readonly onCancelMoveOut: () => void;
  readonly onDone: (text: string) => void;
}) {
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [endedFirst, setEndedFirst] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const next = await api().moveOuts.submit({ moveOutId: detail.id, note: note.trim() || null });
      onDone(
        next.approval?.mode === 'single_user'
          ? 'Asked for the settlement. Nobody else can approve it, so you can confirm it yourself in Approvals after the cooling-off period.'
          : `Asked for the settlement. A second person must approve it${canSeeApprovals ? ' in Approvals' : ''}; you cannot approve it yourself.`,
      );
    } catch (failure) {
      setPending(false);
      // The lease ended on another day: this settlement gives way to a deposit settlement.
      if (moveOutRefusal(failure) === 'lease_ended_first') {
        setEndedFirst(true);
        return;
      }
      setError(toProblem(failure).message);
    }
  }

  return (
    <Card data-testid="move-out-submit">
      <CardHeader
        title="5. Ask for approval"
        description="A second person approves the settlement with the statement and every deduction’s photos in front of them. Nothing is posted until then."
      />
      <CardBody>
        <form onSubmit={submit} noValidate aria-label="Ask for approval" className="space-y-3">
          {error ? <Alert tone="error">{error}</Alert> : null}
          {endedFirst ? (
            <Alert tone="error" title="The lease ended first">
              <p data-testid="lease-ended-first">{MOVE_OUT_REFUSAL_TEXT.lease_ended_first}</p>
              <div className="mt-2 flex flex-wrap gap-3">
                <Button size="sm" variant="secondary" onClick={onCancelMoveOut}>
                  Cancel this move-out
                </Button>
                <Link
                  href={`/leases/${detail.leaseId}`}
                  className="inline-flex min-h-9 items-center text-sm font-medium underline underline-offset-2"
                >
                  Settle the deposit, from the lease, once it is cancelled
                </Link>
              </div>
            </Alert>
          ) : null}
          <TextAreaField
            label="Note for the approver (optional)"
            rows={2}
            maxLength={500}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className="[&_textarea]:font-sans"
          />
          <Button type="submit" pending={pending}>
            Ask for approval
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

function RefundStep({
  detail,
  agency,
  onDone,
}: {
  readonly detail: MoveOutDetail;
  readonly agency: boolean;
  readonly onDone: (text: string) => void;
}) {
  const { timeZone } = useApp();
  const today = todayIn(timeZone);
  const keeper = useIdempotencyKeeper();
  const [uploads] = useState(() => taxUploadOnce());
  const proof = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState({
    paidOn: today,
    reference: '',
    paidFrom: agency ? '' : 'owner_account',
  });
  const [tried, setTried] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [reused, setReused] = useState(false);
  const parsed = refundInput(draft, detail.approvedOn, today);
  const errors = tried ? parsed.errors : {};
  const refund = detail.statement?.refundMinor ?? 0;
  const working = status !== null;
  useHoldWhileSending(working);
  const keyedFor = useRef<string | null>(null);

  if (detail.refundPaid)
    return (
      <Card data-testid="move-out-refund">
        <CardHeader title="6. The refund" />
        <CardBody>
          <p className="text-sm" data-testid="refund-paid">
            {formatMinor(detail.refundPaid.amountMinor)} paid on{' '}
            {formatBusinessDate(detail.refundPaid.paidOn)} from{' '}
            {RECEIVING_ACCOUNT_LABELS[detail.refundPaid.paidFrom].toLowerCase()}, reference{' '}
            <span className="font-mono">{detail.refundPaid.reference}</span>.
          </p>
        </CardBody>
      </Card>
    );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    setReused(false);
    const file = proof.current?.files?.[0];
    const issue = file ? fileProblem(file, TAX_FILE_UPLOAD) : 'Attach the proof of the refund.';
    setFileError(issue);
    const input = parsed.input;
    if (!input || issue || !file) return;
    // Changed details, or another proof, are a new submission with a new key.
    const content = JSON.stringify([input, file.name, file.size, file.lastModified]);
    if (keyedFor.current !== content) {
      keeper.reset();
      keyedFor.current = content;
    }
    try {
      setStatus('Uploading the proof…');
      const proofUploadId = await uploads.idFor(file, 'refund_proof');
      setStatus('Recording the refund…');
      await sendOnce(keeper, (key) =>
        keyedApi(key).moveOuts.recordRefundPaid({ moveOutId: detail.id, ...input, proofUploadId }),
      );
      setStatus(null);
      onDone(`Recorded the refund of ${formatMinor(refund)} as paid.`);
    } catch (failure) {
      setStatus(null);
      if (failure instanceof StorageUploadError) {
        setError(failure.message);
        return;
      }
      if (needsFileAgain(failure)) {
        uploads.forget(file);
        if (proof.current) proof.current.value = '';
        setFileError(fileAgainMessage('proof'));
        return;
      }
      // A deposit payment behind it was charged back: nothing was recorded, and a person looks.
      if (moveOutRefusal(failure) === 'deposit_charged_back') {
        setError(MOVE_OUT_REFUSAL_TEXT.deposit_charged_back);
        return;
      }
      setError(moneyProblem(failure));
      setReused(isKeyReused(failure));
    }
  }

  return (
    <Card data-testid="move-out-refund">
      <CardHeader
        title="6. The refund"
        description="Paid outside the platform, from the owner’s or the agency’s account; record it here with its proof."
      />
      <CardBody>
        <form
          onSubmit={submit}
          noValidate
          aria-label="Record the refund as paid"
          className="space-y-3"
        >
          <p className="text-sm font-medium text-slate-900">
            Record the refund of {formatMinor(refund)} as paid
          </p>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Date paid"
              type="date"
              max={today}
              value={draft.paidOn}
              error={errors.paidOn}
              onChange={(event) => setDraft((d) => ({ ...d, paidOn: event.target.value }))}
            />
            <TextField
              label="Transfer or MoMo reference"
              autoComplete="off"
              spellCheck={false}
              maxLength={120}
              value={draft.reference}
              error={errors.reference}
              onChange={(event) => setDraft((d) => ({ ...d, reference: event.target.value }))}
            />
            {agency ? (
              <SelectField
                label="Paid from"
                value={draft.paidFrom}
                error={errors.paidFrom}
                options={[
                  { value: '', label: 'Choose the account' },
                  ...RECEIVING_ACCOUNTS.map((a) => ({
                    value: a,
                    label: RECEIVING_ACCOUNT_LABELS[a],
                  })),
                ]}
                onChange={(event) => setDraft((d) => ({ ...d, paidFrom: event.target.value }))}
              />
            ) : null}
          </div>
          <FileField
            ref={proof}
            label="Proof of the refund"
            rule={TAX_FILE_UPLOAD}
            disabled={working}
            error={fileError}
            note="A screenshot of the transfer or the MoMo confirmation."
          />
          {status ? <Alert tone="info">{status}</Alert> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" pending={working}>
              Record the refund as paid
            </Button>
            {reused ? (
              <Button
                variant="secondary"
                onClick={() => {
                  keeper.reset();
                  setReused(false);
                  setError(null);
                }}
              >
                Start again
              </Button>
            ) : null}
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
