import { Inject, Injectable } from '@nestjs/common';
import { eq, schema, sql, withCompany, type Database, type Tx } from '@rent/db';
import { templates, type RentTaxReportV2Data as RentTaxReportData } from '@rent/documents';
import { addDays, daysBetween, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { toDecimal, money } from '@rent/domain/money';
import type { Actor } from '@rent/domain/policy';
import type { VerificationStatus } from '@rent/domain/rules';
import {
  rentTaxAlertsReached,
  TAX_ITEM_STATUS_LABELS,
  toCsv,
  type TaxItemKind,
  type TaxItemStatus,
} from '@rent/domain/tax';
import { isoNow } from '../billing/records';
import { companyRecord, staffActor } from '../companies/companies.service';
import { ownerFacts } from '../companies/owners.service';
import type { Clock } from '../core/clock';
import { invalid, notFound } from '../core/errors';
import { CLOCK, DATABASE } from '../core/tokens';
import { DocumentsService } from '../documents/documents.service';
import { PolicyService, staffContext } from '../policy/policy.service';
import { GraService, type GraPaymentView } from './gra.service';
import { ruleStatuses, ruleWarnings, taxItems, type TaxItemRecord, uuids } from './tax-records';
import { WithholdingService } from './withholding.service';

/** Version 2 (M5 review 3) adds tax withheld by tenants and awaiting a certificate. */
export const RENT_TAX_REPORT_TEMPLATE = { key: 'tax.rent-tax-report', version: 2 } as const;

const KIND_LABELS: Record<TaxItemKind, string> = {
  receipt: 'Receipt',
  carry_over: 'Credit carried to a renewal',
  deposit_applied: 'Deposit applied to rent at move-out',
  withholding: 'Withheld by the tenant',
  reversal: 'Payment reversed',
  withholding_offset: 'Replaced by withholding',
};

export interface TaxItemView extends TaxItemRecord {
  readonly rules: readonly {
    readonly ruleId: string;
    readonly key: string;
    readonly verificationStatus: VerificationStatus;
  }[];
  readonly warning: boolean;
}

export interface RentTaxReport {
  readonly ownerId: string;
  readonly ownerName: string;
  readonly ownerTin: string | null;
  readonly from: string;
  readonly to: string;
  readonly items: readonly TaxItemView[];
  readonly graPayments: readonly GraPaymentView[];
  readonly totals: RentTaxReportData['totals'];
  readonly warnings: readonly string[];
}

export interface DueItem extends TaxItemView {
  readonly daysToDue: number;
  /** TX-02: the alert days reached (21, 28 by the item's rule) and those already sent. */
  readonly alertsReached: readonly number[];
  readonly alertsSent: readonly number[];
}

/**
 * Rent tax for people (TX-01 to TX-03; M5 plan 5.3, 5.8): the items with their status, the due
 * list with TX-02's alert days, and the per-owner report on screen, as RFC 4180 CSV and as a PDF
 * through the documents service. The report selects by accounting date and states each item as of
 * the period's end, and carries no time of generation, so a report for a locked month
 * regenerates identically (invariants 6 and 10).
 */
@Injectable()
export class TaxReportService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(GraService) private readonly gra: GraService,
    @Inject(WithholdingService) private readonly withholding: WithholdingService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private async withRules(tx: Tx, items: readonly TaxItemRecord[]): Promise<TaxItemView[]> {
    const statuses = await ruleStatuses(
      tx,
      items.flatMap((i) => i.ruleIds),
    );
    return items.map((i) => {
      const rules = i.ruleIds.map((id) => ({
        ruleId: id,
        key: statuses.get(id)?.key ?? '',
        verificationStatus: statuses.get(id)?.status ?? ('unverified' as const),
      }));
      return { ...i, rules, warning: rules.some((r) => r.verificationStatus !== 'verified') };
    });
  }

  /** Items by lease, payment or owner, and accounting dates; each person sees their scope. */
  async items(
    actor: Actor | null,
    filter: {
      readonly ownerId?: string;
      readonly leaseId?: string;
      readonly paymentId?: string;
      readonly from?: string;
      readonly to?: string;
      readonly status?: TaxItemStatus;
      readonly limit?: number;
    },
  ): Promise<TaxItemView[]> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.view');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const conditions = [sql`true`];
      if (filter.ownerId) conditions.push(sql`i.owner_id = ${filter.ownerId}`);
      if (filter.leaseId) conditions.push(sql`i.lease_id = ${filter.leaseId}`);
      if (filter.paymentId) conditions.push(sql`i.payment_id = ${filter.paymentId}`);
      if (filter.from) conditions.push(sql`i.accounting_date >= ${filter.from}::date`);
      if (filter.to) conditions.push(sql`i.accounting_date <= ${filter.to}::date`);
      const items = (await taxItems(tx, sql.join(conditions, sql` and `))).filter(
        (i) => !filter.status || i.status === filter.status,
      );
      return this.withRules(tx, items.slice(-(filter.limit ?? 500)));
    });
  }

  /** TX-02: open items to pay GRA, by due date, with the alert days each has reached. */
  async dueList(
    actor: Actor | null,
    filter: { readonly ownerId?: string } = {},
  ): Promise<DueItem[]> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.view');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const company = await companyRecord(tx, staff.companyId);
      const today = isoNow(this.clock, company!.timeZone);
      const open = (
        await taxItems(tx, filter.ownerId ? sql`i.owner_id = ${filter.ownerId}` : sql`true`)
      ).filter((i) => i.outstandingMinor > 0);
      return this.dueOf(tx, open, today);
    });
  }

  async dueOf(tx: Tx, open: readonly TaxItemRecord[], today: string): Promise<DueItem[]> {
    const alertDays = await this.alertDays(
      tx,
      open.map((i) => i.alertRuleId),
    );
    const sent = await tx.execute<{ item_id: string; alert_day: number }>(
      sql`select item_id, alert_day from rent_tax_alert where item_id = any(${uuids(open.map((i) => i.id))})`,
    );
    const views = await this.withRules(tx, open);
    return views
      .map((i) => ({
        ...i,
        daysToDue: daysBetween(
          parseBusinessDate(today),
          parseBusinessDate(i.dueDate ?? i.valueDate),
        ),
        alertsReached: rentTaxAlertsReached(
          i.valueDate,
          (i.alertRuleId && alertDays.get(i.alertRuleId)) || [],
          today,
        ),
        alertsSent: sent.rows.filter((s) => s.item_id === i.id).map((s) => s.alert_day),
      }))
      .sort((a, b) =>
        (a.dueDate ?? '') < (b.dueDate ?? '') ? -1 : (a.dueDate ?? '') > (b.dueDate ?? '') ? 1 : 0,
      );
  }

  /** The alert days each rules row (`rent_tax.alert_days`) holds. */
  async alertDays(tx: Tx, ruleIds: readonly (string | null)[]): Promise<Map<string, number[]>> {
    const ids = [...new Set(ruleIds.filter((x): x is string => x !== null))];
    if (ids.length === 0) return new Map();
    const rows = await tx
      .select({ id: schema.rule.id, value: schema.rule.value })
      .from(schema.rule)
      .where(sql`${schema.rule.id} = any(${uuids(ids)})`);
    return new Map(
      rows.map((r) => [r.id, ((r.value as { days?: number[] } | null)?.days ?? []).slice()]),
    );
  }

  // The report (TX-03) ------------------------------------------------------------------------------

  /** The per-owner rent tax report for a period, by accounting date, on screen. */
  async report(
    actor: Actor | null,
    input: { readonly ownerId: string; readonly from: string; readonly to: string },
  ): Promise<RentTaxReport> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.view');
    checkPeriod(input.from, input.to);
    return withCompany(this.database, staffContext(staff), (tx) => this.reportIn(tx, input));
  }

  async reportIn(
    tx: Tx,
    input: { readonly ownerId: string; readonly from: string; readonly to: string },
  ): Promise<RentTaxReport> {
    const owner = (await ownerFacts(tx, [input.ownerId])).get(input.ownerId);
    if (!owner) throw notFound('Owner');
    const items = await this.withRules(
      tx,
      await taxItems(
        tx,
        sql`i.owner_id = ${input.ownerId} and i.accounting_date between ${input.from}::date and ${input.to}::date`,
        input.to,
      ),
    );
    const graPayments = await this.gra.graPaymentsIn(tx, {
      ownerId: input.ownerId,
      from: input.from,
      to: input.to,
    });
    const sums = await tx.execute<{ certificates: string; balance: string; awaiting: string }>(
      sql`select
            coalesce((select sum(i.tax_minor) from rent_tax_item i
              where i.owner_id = ${input.ownerId} and i.kind = 'withholding'
                and i.accounting_date <= ${input.to}::date
                and not exists (select 1 from withholding_certificate c where c.company_id = i.company_id
                  and c.withholding_id = i.withholding_id and c.status = 'confirmed'
                  and c.accounting_date <= ${input.to}::date)
                and not exists (select 1 from withholding_write_off o where o.company_id = i.company_id
                  and o.withholding_id = i.withholding_id and o.accounting_date <= ${input.to}::date)), 0)::bigint as awaiting,
            coalesce((select sum(l.amount_minor) from journal_line l
              join journal_entry e on e.company_id = l.company_id and e.id = l.entry_id
              join book b on b.company_id = l.company_id and b.id = l.book_id
              where b.owner_id = ${input.ownerId} and l.account_code = '2200' and e.rule = 'P20'
                and e.accounting_date between ${input.from}::date and ${input.to}::date), 0)::bigint as certificates,
            coalesce((select -sum(l.amount_minor) from journal_line l
              join journal_entry e on e.company_id = l.company_id and e.id = l.entry_id
              join book b on b.company_id = l.company_id and b.id = l.book_id
              where b.owner_id = ${input.ownerId} and l.account_code = '2200'
                and e.accounting_date <= ${input.to}::date), 0)::bigint as balance`,
    );
    const warnings = await ruleWarnings(
      tx,
      items.flatMap((i) => i.ruleIds),
    );
    return {
      ownerId: input.ownerId,
      ownerName: owner.name,
      ownerTin: owner.tinMasked,
      from: input.from,
      to: input.to,
      items,
      graPayments,
      totals: {
        baseMinor: items.reduce((s, i) => s + i.baseMinor, 0),
        taxMinor: items.reduce((s, i) => s + i.taxMinor, 0),
        withheldMinor: items
          .filter((i) => i.kind === 'withholding')
          .reduce((s, i) => s + i.taxMinor, 0),
        paidToGraMinor: graPayments.reduce((s, g) => s + g.amountMinor, 0),
        settledByCertificatesMinor: Number(sums.rows[0]?.certificates ?? 0),
        // Review 3: tax a tenant withheld is the tenant's to pay GRA; while its certificate is
        // awaited it is shown on its own, never as still owed by the owner.
        withheldAwaitingCertificateMinor: Number(sums.rows[0]?.awaiting ?? 0),
        outstandingMinor: Number(sums.rows[0]?.balance ?? 0) - Number(sums.rows[0]?.awaiting ?? 0),
      },
      warnings: warnings.map((w) => `Rules not yet verified: ${w}`),
    };
  }

  /** The report as the PDF and CSV print it: nothing of when it was made. */
  documentData(report: RentTaxReport): RentTaxReportData {
    return {
      ownerId: report.ownerId,
      owner: { name: report.ownerName.slice(0, 200), tin: report.ownerTin },
      from: report.from,
      to: report.to,
      items: report.items.map((i) => ({
        valueDate: i.valueDate,
        accountingDate: i.accountingDate,
        kind: KIND_LABELS[i.kind],
        receiptNumber: i.receiptNumber,
        unitCode: i.unitCode,
        tenantName: i.tenantName,
        baseMinor: i.baseMinor,
        rateBps: i.rateBps,
        taxMinor: i.taxMinor,
        dueDate: i.dueDate,
        status: TAX_ITEM_STATUS_LABELS[i.status],
      })),
      graPayments: report.graPayments.map((g) => ({
        paidOn: g.paidOn,
        graReceiptNumber: g.graReceiptNumber,
        amountMinor: g.amountMinor,
      })),
      totals: report.totals,
      warnings: [...report.warnings],
    };
  }

  /** The report as RFC 4180 CSV: the same report always gives the same bytes. */
  async csv(
    actor: Actor | null,
    input: { readonly ownerId: string; readonly from: string; readonly to: string },
  ): Promise<{ filename: string; contentType: 'text/csv'; content: string }> {
    const report = await this.report(actor, input);
    return {
      filename: `rent-tax-${report.from}-to-${report.to}.csv`,
      contentType: 'text/csv',
      content: reportCsv(this.documentData(report)),
    };
  }

  /** Queues the report's PDF (the documents service renders and stores it write-once). */
  async requestPdf(
    actor: Actor | null,
    input: { readonly ownerId: string; readonly from: string; readonly to: string },
  ): Promise<{ renderRequestId: string }> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.view');
    checkPeriod(input.from, input.to);
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const data = this.documentData(await this.reportIn(tx, input));
      templates
        .get(RENT_TAX_REPORT_TEMPLATE.key, RENT_TAX_REPORT_TEMPLATE.version)
        .schema.parse(data);
      const renderRequestId = await this.documents.requestRender(tx, {
        companyId: staff.companyId,
        templateKey: RENT_TAX_REPORT_TEMPLATE.key,
        templateVersion: RENT_TAX_REPORT_TEMPLATE.version,
        data: data as unknown as Record<string, unknown>,
        requestedBy: staff.personId,
      });
      return { renderRequestId };
    });
  }

  /** Where a report's PDF is: rendering, or ready with its fingerprint and a short-lived link. */
  async pdf(
    actor: Actor | null,
    renderRequestId: string,
  ): Promise<{
    status: 'rendering' | 'ready' | 'failed';
    documentId: string | null;
    sha256: string | null;
    url: string | null;
  }> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.view');
    const found = await withCompany(this.database, staffContext(staff), async (tx) => {
      const [request] = await tx
        .select()
        .from(schema.documentRenderRequest)
        .where(eq(schema.documentRenderRequest.id, renderRequestId));
      if (!request || request.templateKey !== RENT_TAX_REPORT_TEMPLATE.key)
        throw notFound('Report');
      // Only someone who may see that owner sees its report's PDF (AD-02).
      const ownerId = (request.data as { ownerId?: string }).ownerId;
      if (!ownerId || !(await ownerFacts(tx, [ownerId])).has(ownerId)) throw notFound('Report');
      return { request, rendered: await this.documents.renderedDocument(tx, renderRequestId) };
    });
    if (found.request.status === 'failed')
      return { status: 'failed', documentId: null, sha256: null, url: null };
    if (!found.rendered?.documentId)
      return { status: 'rendering', documentId: null, sha256: null, url: null };
    const url = await this.documents.downloadUrl(
      staff.companyId,
      found.rendered.documentId,
      `rent-tax-report.pdf`,
    );
    return {
      status: 'ready',
      documentId: found.rendered.documentId,
      sha256: found.rendered.sha256,
      url,
    };
  }

  /** A short-lived link to a GRA receipt or a withholding certificate the person may see. */
  async fileUrl(actor: Actor | null, documentId: string): Promise<string> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.view');
    const visible = await withCompany(
      this.database,
      staffContext(staff),
      async (tx) =>
        (await this.gra.receiptDocumentVisible(tx, documentId)) ||
        (await this.withholding.certificateDocumentVisible(tx, documentId)) ||
        (
          await tx.execute<{ n: number }>(
            sql`select count(*)::int as n from early_termination where proof_document_id = ${documentId}`,
          )
        ).rows[0]!.n > 0,
    );
    if (!visible) throw notFound('File');
    const url = await this.documents.downloadUrl(staff.companyId, documentId);
    if (!url) throw notFound('File');
    return url;
  }
}

/** A report's period: two dates, in order, at most a year apart. */
export function checkPeriod(from: string, to: string): void {
  parseBusinessDate(from);
  parseBusinessDate(to);
  if (from > to) throw invalid('period', 'The period starts before it ends');
  if (to > toIsoDate(addDays(parseBusinessDate(from), 366)))
    throw invalid('period', 'A report covers a year at most');
}

/** The CSV of a report: a header, one record per item, and the totals. */
export function reportCsv(data: RentTaxReportData): string {
  const amount = (minor: number) => toDecimal(money(minor));
  const rate = (bps: number) => toDecimal(money(bps));
  return toCsv([
    [
      'Received',
      'Accounting date',
      'Kind',
      'Receipt',
      'Unit',
      'Tenant',
      'Base (GHS)',
      'Rate (%)',
      'Tax (GHS)',
      'Due',
      'Status',
    ],
    ...data.items.map((i) => [
      i.valueDate,
      i.accountingDate,
      i.kind,
      i.receiptNumber,
      i.unitCode,
      i.tenantName,
      amount(i.baseMinor),
      rate(i.rateBps),
      amount(i.taxMinor),
      i.dueDate,
      i.status,
    ]),
    [
      'Total',
      '',
      '',
      '',
      '',
      '',
      amount(data.totals.baseMinor),
      '',
      amount(data.totals.taxMinor),
      '',
      '',
    ],
    [
      'Paid to GRA in the period',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      amount(data.totals.paidToGraMinor),
      '',
      '',
    ],
    [
      'Withheld by tenants, awaiting certificate',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      amount(data.totals.withheldAwaitingCertificateMinor),
      '',
      '',
    ],
    [
      'Still owed at the end of the period',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      amount(data.totals.outstandingMinor),
      '',
      '',
    ],
  ]);
}
