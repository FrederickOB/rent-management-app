'use client';

import type { ApiClient } from '@rent/contracts/client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '@/components/app-context';
import { primaryLink, secondaryLink } from '@/components/link-styles';
import { Empty, Loading, LoadFailed } from '@/components/load-state';
import { RentTaxTable } from '@/components/rent-tax-table';
import { RuleList } from '@/components/rule-list';
import { RulesWarning } from '@/components/rules-warning';
import { TaxFileButton } from '@/components/tax-file-button';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { SelectField, TextField } from '@/components/ui/field';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { RECEIVING_ACCOUNT_LABELS } from '@/lib/billing-format';
import { openFetchedLink, saveFile } from '@/lib/browser-files';
import { formatBusinessDate, todayIn } from '@/lib/business-dates';
import { toProblem } from '@/lib/errors';
import {
  dueCounts,
  dueList,
  dueRuleText,
  monthOf,
  monthPeriod,
  NOT_ASSESSED_EVENT_LABELS,
  NOT_ASSESSED_REASON_LABELS,
  parsePeriod,
  periodWords,
  previousMonth,
  type Period,
} from '@/lib/rent-tax';
import { RenderFailed, RenderTimeout, waitForRender } from '@/lib/render-wait';
import { useRequestGate } from '@/lib/request-gate';
import { formatMinor } from '@/lib/tenancy-format';
import { useLoad } from '@/lib/use-load';

type RentTaxReport = Awaited<ReturnType<ApiClient['rentTax']['report']>>;

export interface OwnerChoice {
  readonly id: string;
  readonly label: string;
  /** Taxed on income as a letting business: no rent tax per receipt (decision 2). */
  readonly lettingBusiness: boolean;
}

/** Rent tax (TX-01 to TX-03): the due list, then the report by owner and period. */
export function RentTaxView({
  owners,
  initialOwnerId,
  initialPeriod,
  canPay,
}: {
  readonly owners: readonly OwnerChoice[];
  readonly initialOwnerId: string | null;
  readonly initialPeriod: Period | null;
  readonly canPay: boolean;
}) {
  const { timeZone } = useApp();
  const today = todayIn(timeZone);
  return (
    <>
      <DueSection
        today={today}
        canPay={canPay}
        ownerNames={new Map(owners.map((o) => [o.id, o.label]))}
      />
      <NotAssessedSection ownerNames={new Map(owners.map((o) => [o.id, o.label]))} />
      <ReportSection
        owners={owners}
        initialOwnerId={initialOwnerId ?? (owners.length === 1 ? owners[0]!.id : null)}
        initialPeriod={initialPeriod ?? monthPeriod(previousMonth(today))!}
        today={today}
        canPay={canPay}
      />
    </>
  );
}

/**
 * What is due to GRA (TX-02): every item still owed, oldest due first, with the alert days its
 * rules rows set, said from the items themselves (CLAUDE.md section 7). Items the tenant withheld
 * are the tenant's to pay and are not on it.
 */
function DueSection({
  today,
  canPay,
  ownerNames,
}: {
  readonly today: string;
  readonly canPay: boolean;
  readonly ownerNames: ReadonlyMap<string, string>;
}) {
  const load = useCallback(() => api().rentTax.due({}), []);
  const { state, reload } = useLoad(load);
  const items = state.status === 'ready' ? dueList(state.data) : [];
  const counts = dueCounts(items, today);
  const rules = state.status === 'ready' ? state.data.flatMap((item) => item.rules) : [];
  // The due and alert days the items' own rules rows hold (CLAUDE.md section 7).
  const rule = dueRuleText(items);
  return (
    <Card data-testid="rent-tax-due">
      <CardHeader
        title="Due to GRA"
        description={
          state.status === 'ready' && items.length
            ? `${items.length} item${items.length === 1 ? '' : 's'} owed: ${counts.overdue} overdue, ${counts.alerted} past an alert day. Rent tax is ${rule.due}${rule.alerts ? `; accountants and admins are alerted ${rule.alerts}` : ''}.`
            : 'What is owed to GRA, oldest due first, with the alerts its rules set.'
        }
        actions={
          canPay ? (
            <Link href="/tax/rent/payments/new" className={primaryLink}>
              Record a GRA payment
            </Link>
          ) : null
        }
      />
      <CardBody>
        {state.status === 'loading' ? <Loading what="what is due" /> : null}
        {state.status === 'error' ? (
          <LoadFailed message={state.problem.message} onRetry={reload} />
        ) : null}
        {state.status === 'ready' ? <RulesWarning rules={rules} /> : null}
        {state.status === 'ready' ? <RuleList rules={rules} /> : null}
        {state.status === 'ready' && items.length === 0 ? (
          <Empty>Nothing is owed to GRA.</Empty>
        ) : null}
        {items.length ? (
          <RentTaxTable
            items={items}
            today={today}
            caption="Rent tax due to GRA, oldest due first"
            ownerNames={ownerNames}
            linkPayments
          />
        ) : null}
      </CardBody>
    </Card>
  );
}

/**
 * Rent tax not worked out when the money posted (TX-08; M5 review 7), because a rules row was
 * missing or held a value this version cannot apply: an exception list for staff. A daily run
 * assesses each once the rules allow; until then it is listed here, and shown only when there is
 * something to see.
 */
function NotAssessedSection({ ownerNames }: { readonly ownerNames: ReadonlyMap<string, string> }) {
  const load = useCallback(() => api().rentTax.notAssessed({ open: 'true' }), []);
  const { state, reload } = useLoad(load);
  if (state.status === 'loading' || (state.status === 'ready' && state.data.length === 0))
    return null;
  return (
    <Card data-testid="rent-tax-not-assessed">
      <CardHeader
        title="Rent tax not worked out"
        description="These receipts’ rent tax could not be worked out, because a tax rule was missing or could not be applied. It is worked out once the rules table allows; until then no rent tax is recorded for them."
      />
      <CardBody>
        {state.status === 'error' ? (
          <LoadFailed message={state.problem.message} onRetry={reload} />
        ) : (
          <Table caption="Rent tax not worked out">
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Lease</Th>
                <Th>What</Th>
                <Th>Why</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {state.data.map((row) => (
                <tr key={row.eventKey} data-testid="not-assessed-row">
                  <Td className="whitespace-nowrap">
                    {row.paymentId ? (
                      <Link
                        href={`/payments/${row.paymentId}`}
                        className="font-medium underline underline-offset-2"
                      >
                        {formatBusinessDate(row.valueDate)}
                      </Link>
                    ) : (
                      formatBusinessDate(row.valueDate)
                    )}
                  </Td>
                  <Td>
                    {/* M11 (P25): an owner-level item has no lease to link to. */}
                    {row.leaseId && row.unitCode ? (
                      <Link
                        href={`/leases/${row.leaseId}`}
                        className="font-mono underline underline-offset-2"
                      >
                        {row.unitCode}
                      </Link>
                    ) : null}
                    <p className="text-xs text-slate-600">
                      {ownerNames.get(row.ownerId) ?? 'An owner'}
                    </p>
                  </Td>
                  <Td>{NOT_ASSESSED_EVENT_LABELS[row.event]}</Td>
                  <Td className="min-w-64 space-y-1">
                    <p className="font-medium">{NOT_ASSESSED_REASON_LABELS[row.reason]}</p>
                    {row.ruleKey ? <p className="font-mono text-xs">{row.ruleKey}</p> : null}
                    <p className="text-xs text-slate-700">{row.message}</p>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </CardBody>
    </Card>
  );
}

function ReportSection({
  owners,
  initialOwnerId,
  initialPeriod,
  today,
  canPay,
}: {
  readonly owners: readonly OwnerChoice[];
  readonly initialOwnerId: string | null;
  readonly initialPeriod: Period;
  readonly today: string;
  readonly canPay: boolean;
}) {
  const [ownerId, setOwnerId] = useState(initialOwnerId ?? '');
  const [from, setFrom] = useState(initialPeriod.from);
  const [to, setTo] = useState(initialPeriod.to);
  const [report, setReport] = useState<RentTaxReport | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [downloadProblem, setDownloadProblem] = useState<string | null>(null);
  const gate = useRequestGate();
  const period = parsePeriod(from, to);
  const owner = owners.find((o) => o.id === ownerId) ?? null;
  // The dates, not the period object rebuilt on every render, decide when to load again.
  const periodFrom = period?.from ?? null;
  const periodTo = period?.to ?? null;

  const load = useCallback(async () => {
    const current = gate.begin();
    setReport(null);
    setProblem(null);
    if (!ownerId || !periodFrom || !periodTo) return;
    try {
      const result = await api().rentTax.report({ ownerId, from: periodFrom, to: periodTo });
      if (current()) setReport(result);
    } catch (failure) {
      if (current()) setProblem(toProblem(failure).message);
    }
  }, [gate, ownerId, periodFrom, periodTo]);

  useEffect(() => {
    void load();
    return gate.cancel;
  }, [gate, load]);

  function month(which: string) {
    const whole = monthPeriod(which);
    if (!whole) return;
    setFrom(whole.from);
    setTo(whole.to);
  }

  async function download(format: 'pdf' | 'csv') {
    if (!ownerId || !period) return;
    setDownloadProblem(null);
    const input = { ownerId, from: period.from, to: period.to };
    try {
      if (format === 'csv') {
        // The API writes the CSV (RFC 4180); the same report always gives the same bytes.
        const csv = await api().rentTax.reportCsv(input);
        saveFile(new Blob([csv.content], { type: csv.contentType }), csv.filename);
        return;
      }
      // The PDF is rendered by the worker and stored write-once; it opens once it is ready.
      await openFetchedLink(async () => {
        const { renderRequestId } = await api().rentTax.requestReportPdf(input);
        return waitForRender(async () => {
          const result = await api().rentTax.reportPdf({ renderRequestId });
          return result.status === 'ready' && result.url
            ? { status: 'ready', url: result.url }
            : result.status === 'failed'
              ? { status: 'failed' }
              : { status: 'rendering' };
        });
      });
    } catch (failure) {
      setDownloadProblem(
        failure instanceof RenderTimeout || failure instanceof RenderFailed
          ? failure.message
          : toProblem(failure).message,
      );
    }
  }

  return (
    <Card data-testid="rent-tax-report">
      <CardHeader
        title="Rent tax report"
        description="For one owner and a period: each receipt with the base it was taxed on, the rate, the tax, the due date and where it stands, then GRA payments. A past month regenerates exactly."
      />
      <CardBody>
        <div className="grid gap-4 sm:grid-cols-3">
          <SelectField
            label="Owner"
            value={ownerId}
            options={[
              { value: '', label: owners.length ? 'Choose the owner' : 'No owners to choose from' },
              ...owners.map((o) => ({ value: o.id, label: o.label })),
            ]}
            onChange={(event) => setOwnerId(event.target.value)}
          />
          <TextField
            label="From"
            type="date"
            value={from}
            max={to || undefined}
            error={from && to && !period ? 'Choose a start on or before the end' : null}
            onChange={(event) => setFrom(event.target.value)}
          />
          <TextField
            label="To"
            type="date"
            value={to}
            min={from || undefined}
            onChange={(event) => setTo(event.target.value)}
          />
        </div>
        <div role="group" aria-label="Choose a month" className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => month(previousMonth(today))}>
            Last month
          </Button>
          <Button size="sm" variant="secondary" onClick={() => month(monthOf(today))}>
            This month
          </Button>
        </div>

        {!ownerId ? <Empty>Choose an owner to see their rent tax.</Empty> : null}
        {owner?.lettingBusiness ? (
          <Alert tone="info" title="Taxed on income">
            {owner.label} lets property as a business, so rent tax is not worked out per receipt;
            tax withheld by tenants is a tax credit for them (decision 2).
          </Alert>
        ) : null}
        {problem ? <Alert tone="error">{problem}</Alert> : null}
        {ownerId && period && !report && !problem ? <Loading what="the report" /> : null}
        {report ? (
          <ReportBody
            report={report}
            today={today}
            canPay={canPay}
            onDownload={(format) => void download(format)}
            downloadProblem={downloadProblem}
          />
        ) : null}
      </CardBody>
    </Card>
  );
}

function ReportBody({
  report,
  today,
  canPay,
  onDownload,
  downloadProblem,
}: {
  readonly report: RentTaxReport;
  readonly today: string;
  readonly canPay: boolean;
  readonly onDownload: (format: 'pdf' | 'csv') => void;
  readonly downloadProblem: string | null;
}) {
  const items = report.items;
  const facts = [
    { key: 'base', label: 'Rent taxed', value: report.totals.baseMinor },
    { key: 'tax', label: 'Rent tax', value: report.totals.taxMinor },
    { key: 'withheld', label: 'Withheld by tenants', value: report.totals.withheldMinor },
    // M5 review 3: the tenant pays it to GRA, so it is not in what the owner still owes.
    ...(report.totals.withheldAwaitingCertificateMinor === undefined
      ? []
      : [
          {
            key: 'awaiting-certificate',
            label: 'Withheld by the tenant, awaiting the certificate',
            value: report.totals.withheldAwaitingCertificateMinor,
          },
        ]),
    { key: 'paid', label: 'Paid to GRA', value: report.totals.paidToGraMinor },
    {
      key: 'certificates',
      label: 'Settled by certificates',
      value: report.totals.settledByCertificatesMinor,
    },
    { key: 'outstanding', label: 'Still to pay GRA', value: report.totals.outstandingMinor },
  ];
  return (
    <div className="space-y-4">
      <RulesWarning rules={report.items.flatMap((i) => i.rules)} apiWarnings={report.warnings} />
      <RuleList rules={report.items.flatMap((i) => i.rules)} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-slate-900">
          {report.ownerName}, {periodWords({ from: report.from, to: report.to })}
        </p>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Download the report">
          <Button size="sm" variant="secondary" onClick={() => onDownload('pdf')}>
            Download the PDF
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onDownload('csv')}>
            Download the CSV
          </Button>
          {canPay ? (
            <Link
              href={`/tax/rent/payments/new?ownerId=${report.ownerId}`}
              className={secondaryLink}
            >
              Record a GRA payment
            </Link>
          ) : null}
        </div>
      </div>
      {downloadProblem ? <Alert tone="error">{downloadProblem}</Alert> : null}
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
        {facts.map((fact) => (
          <div key={fact.key} className="min-w-0" data-testid={`rent-tax-total-${fact.key}`}>
            <dt className="text-slate-600">{fact.label}</dt>
            <dd className="text-lg font-semibold tabular-nums text-slate-900">
              {formatMinor(fact.value)}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-slate-600">
        Receipts are reported by the period they were accounted in, so a report for a locked month
        never changes. A reversed payment shows its tax reversed.
      </p>
      {items.length === 0 ? (
        <Empty>No rent tax in this period.</Empty>
      ) : (
        <RentTaxTable
          items={items}
          today={today}
          caption={`Rent tax for ${report.ownerName}`}
          linkPayments
        />
      )}
      <div className="space-y-2" data-testid="gra-payments">
        <h3 className="text-sm font-semibold text-slate-900">GRA payments in this period</h3>
        {report.graPayments.length === 0 ? (
          <Empty>None recorded.</Empty>
        ) : (
          <ul className="divide-y divide-slate-100">
            {report.graPayments.map((payment) => (
              <li
                key={payment.id}
                data-testid="gra-payment"
                className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm"
              >
                <span>
                  <span className="font-medium">{formatMinor(payment.amountMinor)}</span> paid{' '}
                  {formatBusinessDate(payment.paidOn)} from{' '}
                  {RECEIVING_ACCOUNT_LABELS[payment.paidFrom].toLowerCase()}, GRA receipt{' '}
                  <span className="font-mono">{payment.graReceiptNumber}</span>, settling{' '}
                  {payment.items.length} item{payment.items.length === 1 ? '' : 's'}
                </span>
                <TaxFileButton
                  documentId={payment.receiptDocumentId}
                  label={`Open GRA receipt ${payment.graReceiptNumber}`}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
