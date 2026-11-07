'use client';

import type { OwnerStatementDetail } from '@rent/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ConfirmBox } from '@/components/confirm-box';
import { LoadFailed, Loading } from '@/components/load-state';
import { PageHeader } from '@/components/page-header';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { api } from '@/lib/api';
import { formatBusinessDate } from '@/lib/business-dates';
import { cn } from '@/lib/cn';
import { toProblem, type Problem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { monthLabel } from '@/lib/rent-tax';
import {
  accrualRows,
  agentRows,
  cashRows,
  checkScopeText,
  earlierMonthsLockText,
  expenseCategoryText,
  failedChecks,
  isRendering,
  issueConfirmText,
  occupancyRows,
  STATEMENT_CHECK_LABELS,
  statementMessage,
  statementEmailText,
  statementPages,
  type StatementRow,
} from '@/lib/statements';
import { formatMinor } from '@/lib/tenancy-format';
import { startDownload } from '@/lib/browser-files';
import { useRequestGate } from '@/lib/request-gate';

const DOCUMENT_POLL_MS = 2_000;

/** The PDF did not finish rendering within the polls. */
class StillRendering extends Error {}
const DOCUMENT_POLL_TRIES = 15;

export function StatementDetailView({ statementId }: { readonly statementId: string }) {
  const [detail, setDetail] = useState<OwnerStatementDetail | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState<'issue' | 'regenerate' | 'document' | null>(null);

  // Review WEB 8: only the newest load is shown, so a slow answer never replaces a newer one.
  const gate = useRequestGate();
  const load = useCallback(async () => {
    const current = gate.begin();
    try {
      const next = await api().ownerStatements.get({ statementId });
      if (!current()) return;
      setDetail(next);
      setProblem(null);
    } catch (failure) {
      if (current()) setProblem(toProblem(failure));
    }
  }, [gate, statementId]);

  useEffect(() => {
    void load();
  }, [load]);

  const breadcrumb = (
    <nav aria-label="Breadcrumb" className="text-sm">
      <Link href="/statements" className="underline underline-offset-2">
        Owner statements
      </Link>{' '}
      <span aria-hidden="true">›</span>{' '}
      <span>{detail ? monthLabel(detail.month) : 'Statement'}</span>
    </nav>
  );

  if (!detail)
    return (
      <>
        {breadcrumb}
        <PageHeader title="Owner statement" />
        {problem ? (
          problem.status === 404 ? (
            <Alert tone="info">This statement does not exist, or it is not one you can see.</Alert>
          ) : (
            <LoadFailed message={problem.message} onRetry={() => void load()} />
          )
        ) : (
          <Loading what="the statement" />
        )}
      </>
    );

  const failing = failedChecks(detail.figures);
  const zone = detail.ownerTimeZone;

  async function issue() {
    if (!detail) return;
    setPending('issue');
    setActionError(null);
    try {
      const next = await api().ownerStatements.issue({ statementId: detail.id });
      setDetail(next);
      setConfirming(false);
      setNotice(
        `Issued. ${monthLabel(next.month)} is locked for ${next.owner.name}; the PDF is being made and emailed to the owner’s contacts who agreed to email.`,
      );
    } catch (failure) {
      setActionError(statementMessage(failure) ?? toProblem(failure).message);
      setConfirming(false);
      await load();
    } finally {
      setPending(null);
    }
  }

  async function regenerate() {
    if (!detail) return;
    setPending('regenerate');
    setActionError(null);
    try {
      const next = await api().ownerStatements.draft({
        ownerId: detail.owner.id,
        month: detail.month,
      });
      setDetail(next);
      setNotice('Worked out again from the ledger.');
    } catch (failure) {
      setActionError(statementMessage(failure) ?? toProblem(failure).message);
    } finally {
      setPending(null);
    }
  }

  /** The PDF: a 5-minute link; while it renders (409), ask again a few times. */
  /**
   * The PDF (review WEB 2): its 5-minute link is served as an attachment, so it downloads from
   * the page itself and no empty tab is left. While it renders (409), ask again a few times.
   */
  async function openDocument() {
    if (!detail) return;
    setPending('document');
    setActionError(null);
    try {
      let url: string | null = null;
      for (let tries = 0; url === null && tries < DOCUMENT_POLL_TRIES; tries += 1) {
        try {
          url = (await api().ownerStatements.document({ statementId: detail.id })).url;
        } catch (failure) {
          if (!isRendering(failure)) throw failure;
          await new Promise((resolve) => window.setTimeout(resolve, DOCUMENT_POLL_MS));
        }
      }
      if (!url) throw new StillRendering();
      startDownload(url);
    } catch (failure) {
      setActionError(
        failure instanceof StillRendering
          ? 'The PDF is still being made. Try again in a minute.'
          : failure instanceof Error && failure.message === 'unexpected link'
            ? 'The PDF link could not be opened. Try again.'
            : (statementMessage(failure) ?? toProblem(failure).message),
      );
    } finally {
      setPending(null);
    }
  }

  return (
    <>
      {breadcrumb}
      <div className="space-y-2">
        <PageHeader title={`${detail.owner.name}, ${monthLabel(detail.month)}`} />
        <p className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
          <span data-testid="statement-status">
            <Badge tone={detail.status === 'issued' ? 'green' : 'amber'}>
              {detail.status === 'issued' ? 'Issued' : 'Draft'}
            </Badge>
          </span>
          <span>
            {formatBusinessDate(detail.figures.firstDay)} to{' '}
            {formatBusinessDate(detail.figures.lastDay)}, a calendar month in the company’s time
            zone ({detail.companyTimeZone})
          </span>
        </p>
        <p className="text-sm text-slate-600">
          Times are in the owner’s time zone. Worked out {formatTime(detail.generatedAt, zone)}
          {detail.issuedAt
            ? `; issued ${formatTime(detail.issuedAt, zone)}${detail.issuedBy ? ` by ${detail.issuedBy.name}` : ''}`
            : ''}
          .
        </p>
        {detail.status === 'issued' ? (
          <p className="text-sm text-slate-700" data-testid="statement-email">
            {statementEmailText(detail, zone)}
          </p>
        ) : null}
      </div>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {actionError ? <Alert tone="error">{actionError}</Alert> : null}

      {detail.status === 'issued' && detail.matchesIssued !== null ? (
        detail.matchesIssued ? (
          <Alert tone="success" title="Still the issued figures">
            <span data-testid="matches-issued" data-matches="true">
              Worked out again from the ledger, the month gives exactly the figures issued.
            </span>
          </Alert>
        ) : (
          <Alert tone="error" title="The figures no longer match what was issued">
            <span data-testid="matches-issued" data-matches="false">
              Worked out again, the month gives different figures from those issued. The issued
              statement stands; report this so it can be checked.
            </span>
          </Alert>
        )
      ) : null}

      {failing.length > 0 ? (
        <Alert
          tone="error"
          title={failing.length === 1 ? 'A check fails' : `${failing.length} checks fail`}
        >
          <ul className="list-disc space-y-1 pl-5" data-testid="failing-checks">
            {failing.map((c) => (
              <li key={`${c.name}-${c.scope}`}>
                {STATEMENT_CHECK_LABELS[c.name]}
                {checkScopeText(c, detail.properties)
                  ? ` (${checkScopeText(c, detail.properties)})`
                  : ''}
                : expected {formatMinor(c.expectedMinor)}, found {formatMinor(c.actualMinor)}.
              </li>
            ))}
          </ul>
          <p className="mt-1">A statement that fails a check cannot be issued.</p>
        </Alert>
      ) : null}

      <Card data-testid="statement-actions">
        <CardBody>
          <div className="flex flex-wrap gap-2">
            {detail.actions.issue && !confirming ? (
              <Button disabled={failing.length > 0} onClick={() => setConfirming(true)}>
                Issue the statement
              </Button>
            ) : null}
            {detail.actions.regenerate ? (
              <Button
                variant="secondary"
                pending={pending === 'regenerate'}
                onClick={() => {
                  setConfirming(false);
                  void regenerate();
                }}
              >
                Work it out again
              </Button>
            ) : null}
            {detail.status === 'issued' ? (
              <Button
                variant="secondary"
                pending={pending === 'document'}
                onClick={() => void openDocument()}
              >
                Download the PDF
              </Button>
            ) : null}
          </div>
          {/* Review WEB 8: the confirmation closes while the figures are worked out again or a
              check fails, so nobody confirms figures they have not seen. */}
          {confirming && failing.length === 0 && pending !== 'regenerate' ? (
            <ConfirmBox
              label={`Confirm issuing ${monthLabel(detail.month)} for ${detail.owner.name}`}
              confirmText="Issue and lock the month"
              pending={pending === 'issue'}
              onConfirm={() => void issue()}
              onCancel={() => setConfirming(false)}
            >
              <span data-testid="issue-confirm">{issueConfirmText(detail)}</span>{' '}
              <span data-testid="issue-confirm-earlier">{earlierMonthsLockText(detail)}</span>
            </ConfirmBox>
          ) : null}
          {detail.sha256 ? (
            <p className="break-all text-xs text-slate-600">
              Fingerprint (SHA-256) of the issued PDF:{' '}
              <span className="font-mono">{detail.sha256}</span>
            </p>
          ) : null}
        </CardBody>
      </Card>

      {statementPages(detail).map(({ key, title, page }) => (
        <Card key={key} data-testid={key === 'summary' ? 'statement-summary' : 'statement-page'}>
          <CardHeader title={title} />
          <CardBody>
            <div className="grid gap-6 lg:grid-cols-2">
              <Rows title="Cash in the month" rows={cashRows(page)} />
              <Rows title="At the month’s end" rows={accrualRows(page)} />
            </div>
            <section aria-label="Occupancy" className="space-y-1">
              <h3 className="text-sm font-semibold text-slate-900">Occupancy at the month’s end</h3>
              <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                {occupancyRows(page).map((row) => (
                  <div key={row.label} className="flex justify-between gap-2">
                    <dt className="text-slate-700">{row.label}</dt>
                    <dd className="tabular-nums">{row.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
            {key !== 'summary' ? <Expenses detail={detail} propertyId={page.propertyId} /> : null}
          </CardBody>
        </Card>
      ))}

      {detail.figures.agent ? (
        <Card data-testid="statement-agent">
          <CardHeader
            title="The agency’s side"
            description="The owner’s money the agency held in the month, the fees, and what could be paid to the owner."
          />
          <CardBody>
            <Rows title="Money held for the owner" rows={agentRows(detail.figures.agent)} />
            <p className="text-sm text-slate-700" data-testid="rent-tax-held-back">
              {detail.figures.agent.graPaidBy === 'agency'
                ? `The agency pays this owner’s rent tax to GRA, so ${formatMinor(detail.figures.agent.rentTaxHeldBackMinor)} of rent tax payable is held back before anything is paid to the owner.`
                : 'The owner pays their own rent tax to GRA, so none is held back.'}
            </p>
          </CardBody>
        </Card>
      ) : null}
      {/* Review WEB 3: rent tax payable and processing fees show for every owner, a landlord who
          manages their own property included, not only with the agency's side. */}
      {detail.figures.rentTaxPayable || detail.figures.processingFeesMinor !== 0 ? (
        <Card data-testid="statement-tax">
          <CardHeader title="Rent tax payable and processing fees" />
          <CardBody>
            {detail.figures.rentTaxPayable ? (
              <Rows
                title="Rent tax payable to GRA"
                rows={[
                  {
                    key: 'open',
                    label: 'At the start of the month',
                    amountMinor: detail.figures.rentTaxPayable.openingMinor,
                  },
                  {
                    key: 'acc',
                    label: 'On the month’s receipts',
                    amountMinor: detail.figures.rentTaxPayable.accruedMinor,
                    part: true,
                  },
                  {
                    key: 'paid',
                    label: 'Paid to GRA',
                    amountMinor: -detail.figures.rentTaxPayable.paidMinor,
                    part: true,
                  },
                  {
                    key: 'cert',
                    label: 'Settled by withholding certificates',
                    amountMinor: -detail.figures.rentTaxPayable.certifiedMinor,
                    part: true,
                  },
                  {
                    key: 'close',
                    label: 'At the end of the month',
                    amountMinor: detail.figures.rentTaxPayable.closingMinor,
                    strong: true,
                  },
                ]}
              />
            ) : null}
            {detail.figures.processingFeesMinor !== 0 ? (
              <p className="text-sm text-slate-700">
                Payment processing fees in the month:{' '}
                {formatMinor(detail.figures.processingFeesMinor)}.
              </p>
            ) : null}
          </CardBody>
        </Card>
      ) : null}
    </>
  );
}

function Rows({ title, rows }: { readonly title: string; readonly rows: readonly StatementRow[] }) {
  return (
    <section aria-label={title} className="space-y-1">
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      <dl className="divide-y divide-slate-100 rounded-md border border-slate-200 text-sm">
        {rows.map((row) => (
          <div
            key={row.key}
            className={cn(
              'flex flex-wrap justify-between gap-2 px-3 py-1.5',
              row.part && 'pl-6 text-slate-700',
            )}
            data-testid={`row-${row.key}`}
          >
            <dt className={cn(row.strong && 'font-semibold')}>{row.label}</dt>
            <dd className={cn('tabular-nums', row.strong && 'font-semibold')}>
              {formatMinor(row.amountMinor)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Expenses({
  detail,
  propertyId,
}: {
  readonly detail: OwnerStatementDetail;
  readonly propertyId: string | null;
}) {
  const expenses = detail.expenses.filter((e) => e.propertyId === propertyId);
  if (expenses.length === 0) return null;
  return (
    <section aria-label="Expenses" className="space-y-1">
      <h3 className="text-sm font-semibold text-slate-900">Expenses recorded in the month</h3>
      <ul className="divide-y divide-slate-100 text-sm">
        {expenses.map((e) => (
          <li
            key={e.id}
            className="flex flex-wrap items-center justify-between gap-2 py-1.5"
            data-testid="statement-expense"
          >
            <span>
              {formatBusinessDate(e.expenseDate)} · {e.supplierName} ·{' '}
              {expenseCategoryText(e.category)}
            </span>
            <span className="flex items-center gap-2">
              <span className="tabular-nums">{formatMinor(e.amountMinor)}</span>
              {e.noReceipt ? (
                <span data-testid="no-receipt">
                  <Badge tone="red">No receipt</Badge>
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
