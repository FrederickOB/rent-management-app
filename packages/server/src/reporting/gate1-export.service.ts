import { Inject, Injectable } from '@nestjs/common';
import { withCompany, type Database } from '@rent/db';
import { money, toDecimal } from '@rent/domain/money';
import type { Actor } from '@rent/domain/policy';
import { XLSX_CONTENT_TYPE } from '@rent/domain/portfolio';
import type { Ratio } from '@rent/domain/reporting';
import { v7 as uuidv7 } from 'uuid';
import writeXlsxFile from 'write-excel-file/node';
import { AuditService } from '../audit/audit.service';
import { companyRecord } from '../companies/companies.service';
import type { Clock } from '../core/clock';
import { forbidden, notFound } from '../core/errors';
import { CLOCK, DATABASE } from '../core/tokens';
import { DocumentsService } from '../documents/documents.service';
import { PolicyService } from '../policy/policy.service';
import { percentText } from './dashboard.service';
import { Gate1Service, type Gate1View, type PlatformGate1View } from './gate1.service';

/** The link lasts five minutes (contract: "a 5-minute link"). */
const DOWNLOAD_MS = 300_000;

/** The trend workbook's columns, in order (DA-06; M11 decision 4). */
export const GATE1_TREND_COLUMNS = [
  'Month',
  'Company',
  'Status',
  'Worked out (UTC)',
  'Rent due (GHS)',
  'Rent due (pesewas)',
  'Collected (GHS)',
  'Collected (pesewas)',
  'Collection rate',
  'Collection target (95%)',
  'Auto-matched',
  'Auto-match target (95%)',
  'Digital share',
  'Receipts sent within a minute',
  'Receipts delivered within a minute',
  'Arrears over 60 days',
  'Arrears baseline month',
  'Arrears baseline',
  'Weekly active managers',
  'WhatsApp adoption',
  'Notices acknowledged in 7 days',
  'Emergency repairs attended in time',
  'Net revenue retention',
] as const;

const share = (r: Ratio | null | undefined): string => percentText(r ? r.bps : null);
const met = (m: boolean | null): string => (m === null ? 'Not measurable' : m ? 'Met' : 'Not met');

/**
 * One row of the workbook: a company's month, or the platform's total. Amounts are exact, in
 * cedis and in pesewas; shares as the screen shows them, half up to two places.
 */
function rowOf(month: string, company: string, g: Gate1View | null) {
  const text = (value: string | null) => (value === null ? null : { value });
  const number = (value: number) => ({ value, type: Number });
  if (!g) return [text(month), text(company), text('No figures yet')];
  return [
    text(month),
    text(company),
    text(g.status === 'final' ? 'Final' : 'Provisional'),
    text(g.computedAt.toISOString()),
    text(toDecimal(money(g.collectionRate.dueMinor))),
    number(g.collectionRate.dueMinor),
    text(toDecimal(money(g.collectionRate.collectedMinor))),
    number(g.collectionRate.collectedMinor),
    text(share(g.collectionRate.rate)),
    text(met(g.targets.collectionRate.met)),
    text(share(g.autoMatch.provider.rate)),
    text(met(g.targets.autoMatch.met)),
    text(share(g.digitalShare.share)),
    text(share(g.timeToReceipt.share)),
    text(g.timeToReceiptDelivered ? share(g.timeToReceiptDelivered.share) : 'Not recorded'),
    text(g.arrearsOver60 ? share(g.arrearsOver60.share) : 'Not recorded'),
    text(g.arrearsOver60?.baselineMonth ?? null),
    text(g.arrearsOver60?.baselineShare ? share(g.arrearsOver60.baselineShare) : null),
    text(g.weeklyActiveManagers ? share(g.weeklyActiveManagers.share) : 'Not recorded'),
    text(g.whatsappAdoption ? share(g.whatsappAdoption.share) : 'Not recorded'),
    text(share(g.noticeAcknowledgement.rate)),
    text(share(g.repairResponse.rate)),
    text(
      g.netRevenueRetention === undefined
        ? null
        : g.netRevenueRetention.available
          ? share(g.netRevenueRetention.share)
          : `Needs 12 months of subscription invoices; ${g.netRevenueRetention.monthsOfHistory} so far`,
    ),
  ];
}

/** The platform's Gate 1 trend as one sheet: each month's total, then each company's figures. */
export async function gate1TrendWorkbook(
  months: readonly PlatformGate1View[],
  at: Date,
): Promise<Buffer> {
  const bold = (value: string) => ({ value, fontWeight: 'bold' as const });
  const head = [
    [bold('Gate 1 metrics, month by month')],
    [{ value: 'Exported (UTC)' }, { value: at.toISOString() }],
    [{ value: 'Targets' }, { value: 'Collection rate 95%; provider payments auto-matched 95%' }],
    [],
    GATE1_TREND_COLUMNS.map((c) => bold(c)),
  ];
  const body = months.flatMap((m) => [
    rowOf(m.month, 'All companies', m.total),
    ...m.companies.map((c) => rowOf(m.month, c.company.name, c.gate1)),
  ]);
  return writeXlsxFile([{ sheet: 'Gate 1', data: [...head, ...body] }]).toBuffer();
}

/**
 * The Gate 1 trend as Excel for platform admins (M11 decision 4; `metrics.platform.read`): the
 * same figures as the platform page, stored write-once in the platform company and returned as a
 * five-minute link. The export is a semantic audit event in the platform's chain.
 */
@Injectable()
export class Gate1ExportService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(Gate1Service) private readonly gate1: Gate1Service,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async platformExport(
    actor: Actor | null,
    range: { readonly from?: string; readonly to?: string } = {},
  ): Promise<{ url: string; expiresAt: Date }> {
    if (!actor) throw forbidden();
    this.policy.assert(actor, 'metrics.platform.read');
    let admin: Extract<Actor, { kind: 'platform_admin' }>;
    switch (actor.kind) {
      case 'platform_admin':
        admin = actor;
        break;
      default:
        throw forbidden();
    }
    const trend = await this.gate1.platformGate1Trend(admin, range);
    const ctx = {
      companyId: admin.companyId,
      personId: admin.personId,
      actorKind: 'platform_admin' as const,
    };
    const country = await withCompany(
      this.database,
      ctx,
      async (tx) => (await companyRecord(tx, admin.companyId))?.countryCode ?? 'GH',
      { accessMode: 'read only' },
    );
    const exportId = uuidv7();
    const bytes = await gate1TrendWorkbook(trend.months, this.clock.now());
    // Stored write-once before the transaction that records it; nothing is held open meanwhile.
    const file = await this.documents.storeWriteOnce({
      companyId: admin.companyId,
      countryCode: country,
      key: `documents/${admin.companyId}/gate1-exports/${exportId}.xlsx`,
      bytes,
      contentType: XLSX_CONTENT_TYPE,
    });
    const documentId = await withCompany(this.database, ctx, async (tx) => {
      const id = await this.documents.recordWriteOnce(tx, file, {
        kind: 'gate1_export',
        createdBy: admin.personId,
      });
      await this.audit.append(tx, {
        companyId: admin.companyId,
        action: 'metrics.gate1_exported',
        recordType: 'document',
        recordId: id,
        data: {
          from: trend.months[0]?.month ?? null,
          to: trend.months.at(-1)?.month ?? null,
          months: trend.months.length,
        },
      });
      return id;
    });
    const url = await this.documents.downloadUrl(admin.companyId, documentId, 'gate-1-trend.xlsx');
    if (!url) throw notFound('Export');
    return { url, expiresAt: new Date(this.clock.now().getTime() + DOWNLOAD_MS) };
  }
}
