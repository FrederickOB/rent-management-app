import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, schema, withCompany, type Database, type Tx } from '@rent/db';
import { formatBusinessDate } from '@rent/domain/dates';
import { format, money } from '@rent/domain/money';
import type { AlertPort } from '@rent/integrations';
import { v7 as uuidv7 } from 'uuid';
import { BillingEngine } from '../billing/engine';
import { formatReceiptNumber } from '../billing/records';
import type { Clock } from '../core/clock';
import type { AppConfig } from '../core/config';
import { AppError, conflict, notFound } from '../core/errors';
import { messageRequestSchema, type MessageRequest } from '../core/messages';
import { consumeRateLimit } from '../core/rate-limit';
import { ALERT_PORT, CLOCK, CONFIG, DATABASE } from '../core/tokens';
import { DocumentsService } from '../documents/documents.service';
import { newToken, SigningHasher, tokenHash } from '../esign/secrets';
import { MessagingService } from '../messaging/messaging.service';
import { PolicyService } from '../policy/policy.service';
import { landlordContact } from './landlord-contact';
import { PayLinksService } from './pay-links.service';
import { ProviderPaymentsService } from './provider-payments.service';

/** A receipt link lives 30 days; each download it gives lasts 5 minutes (plan 4.6). */
export const RECEIPT_LINK_DAYS = 30;
/** BC-06: a receipt reaches the tenant within a minute of the payment's confirmation. */
export const RECEIPT_SLA_MS = 60_000;

export type ReceiptScreen = 'receipt' | 'preparing' | 'expired' | 'revoked';

export interface ReceiptPageView {
  readonly screen: ReceiptScreen;
  readonly landlord: {
    readonly name: string;
    readonly phone: string | null;
    readonly email: string | null;
  };
  readonly timeZone: string;
  readonly linkExpiresAt: Date;
  readonly receiptNumber: string;
  readonly kind: 'receipt' | 'credit_receipt';
  readonly amountMinor: number;
  readonly receivedOn: string;
  readonly tenantName: string;
  readonly unitCode: string;
  readonly propertyName: string;
  readonly paidUntil: string | null;
  readonly downloadable: boolean;
}

/**
 * Receipts to tenants within a minute (BC-06; M4b plan 4.6). On `payment.posted` the receipt goes
 * on the tenant's consented channel with a 30-day link (purpose `receipt`) that serves the M4a
 * receipt PDF as 5-minute downloads. Each delivery records the time from the payment's
 * confirmation to the send, and raises an alert past 60 seconds. The receipt also stays in the
 * tenant app and on the lease page.
 */
@Injectable()
export class ReceiptsService {
  private readonly hasher: SigningHasher;

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
    @Inject(MessagingService) private readonly messaging: MessagingService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(BillingEngine) private readonly engine: BillingEngine,
    @Inject(PayLinksService) private readonly links: PayLinksService,
    @Inject(ProviderPaymentsService) private readonly payments: ProviderPaymentsService,
    @Inject(PolicyService) private readonly policy: PolicyService,
  ) {
    this.hasher = new SigningHasher(config.BETTER_AUTH_SECRET);
  }

  /**
   * `payments.issue-receipt` (on `payment.posted`): sends one receipt once. The message is
   * recorded and sent at once through the messaging core (consent, channels, retries, the next
   * channel), not through the outbox, so the minute is spent sending, not queueing. A retry finds
   * the delivery and its message and changes nothing that was sent.
   */
  async issue(
    companyId: string,
    receiptId: string,
  ): Promise<'sent' | 'not_sent' | 'failed' | 'skipped'> {
    const ctx = { companyId, actorKind: 'system' as const };
    const prepared = await withCompany(this.database, ctx, async (tx) => {
      const [receipt] = await tx
        .select()
        .from(schema.receipt)
        .where(eq(schema.receipt.id, receiptId));
      if (!receipt || receipt.kind !== 'receipt') return null;
      const [payment] = await tx
        .select()
        .from(schema.payment)
        .where(eq(schema.payment.id, receipt.paymentId));
      if (!payment) return null;
      let [delivery] = await tx
        .select()
        .from(schema.receiptDelivery)
        .where(eq(schema.receiptDelivery.receiptId, receiptId));
      if (!delivery) {
        [delivery] = await tx
          .insert(schema.receiptDelivery)
          .values({
            companyId,
            propertyId: receipt.propertyId,
            tenantId: receipt.tenantId,
            leaseId: receipt.leaseId,
            receiptId,
            paymentId: payment.id,
            messageId: uuidv7(),
            // Confirmed when it posted: the receipt is numbered in the posting transaction.
            confirmedAt: receipt.issuedAt,
          })
          .onConflictDoNothing()
          .returning();
        if (!delivery)
          [delivery] = await tx
            .select()
            .from(schema.receiptDelivery)
            .where(eq(schema.receiptDelivery.receiptId, receiptId));
      }
      if (delivery!.status !== 'queued') return null;
      const company = await tx
        .select()
        .from(schema.company)
        .where(eq(schema.company.id, companyId));
      const state = await this.engine.load(tx, companyId, receipt.leaseId);
      const walk = this.engine.walk(state);
      const request: MessageRequest = messageRequestSchema.parse({
        messageId: delivery!.messageId,
        recipient: { type: 'tenant', tenantId: receipt.tenantId },
        purpose: 'receipt',
        subject: `Receipt ${formatReceiptNumber(receipt.number)}`,
        body: [
          `${company[0]?.displayName ?? 'Your landlord'}: receipt ${formatReceiptNumber(receipt.number)}.`,
          `${format(money(receipt.amountMinor))} received on ${formatBusinessDate(payment.receivedOn)} for ${state.lease.unitCode}.`,
          walk.paidUntil ? `Paid until ${formatBusinessDate(walk.paidUntil)}.` : null,
          'Your receipt: {{link}}',
        ]
          .filter(Boolean)
          .join(' '),
        link: { purpose: 'receipt', targetId: receiptId },
        // M6 (plan 4.9): the app first, then WhatsApp, SMS and email, each with its consent.
        channels: ['push', 'whatsapp', 'sms', 'email'],
        propertyId: receipt.propertyId,
        related: { type: 'receipt', id: receiptId },
        requestedBy: null,
      });
      return { delivery: delivery!, request };
    });
    if (!prepared) return 'skipped';
    const outcome = await this.messaging.deliver(companyId, prepared.request);
    return withCompany(this.database, ctx, async (tx) => {
      const events = await tx
        .select()
        .from(schema.messageEvent)
        .where(eq(schema.messageEvent.messageId, prepared.request.messageId))
        .orderBy(asc(schema.messageEvent.occurredAt));
      const sent = events.find((e) => e.status === 'sent');
      const status = sent ? 'sent' : outcome === 'failed' ? 'failed' : 'not_sent';
      const latency = sent
        ? Math.max(0, sent.occurredAt.getTime() - prepared.delivery.confirmedAt.getTime())
        : null;
      const late = latency !== null && latency > RECEIPT_SLA_MS;
      await tx
        .update(schema.receiptDelivery)
        .set({
          status,
          channel: sent?.channel ?? null,
          sentAt: sent?.occurredAt ?? null,
          latencyMs: latency,
          lateAlerted: late,
          updatedAt: this.clock.now(),
        })
        .where(eq(schema.receiptDelivery.id, prepared.delivery.id));
      if (late) {
        await this.payments.flag(tx, companyId, {
          kind: 'receipt_late',
          provider: 'messaging',
          paymentId: prepared.delivery.paymentId,
          propertyId: prepared.delivery.propertyId,
          detail: `A receipt reached the tenant ${Math.floor(latency / 1000)} seconds after the payment was confirmed, past the one-minute target (BC-06).`,
          dedupeKey: `receipt_late:${receiptId}`,
        });
        await this.alerts.raise({
          severity: 'warning',
          code: 'payments.receipt_late',
          message: 'A receipt took longer than a minute to reach the tenant',
          context: { companyId, receiptId, latencyMs: latency },
        });
      }
      return status;
    });
  }

  /** The `receipt` link resolver for messaging: a fresh 30-day link at send time. */
  async urlForMessage(companyId: string, receiptId: string, messageId: string): Promise<string> {
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const [receipt] = await tx
        .select()
        .from(schema.receipt)
        .where(eq(schema.receipt.id, receiptId));
      if (!receipt) throw conflict('link_unavailable', 'The receipt is gone');
      const now = this.clock.now();
      const token = newToken();
      await tx.insert(schema.secureLink).values({
        companyId,
        propertyId: receipt.propertyId,
        tenantId: receipt.tenantId,
        purpose: 'receipt',
        tokenHash: tokenHash(token),
        receiptId,
        messageId,
        expiresAt: new Date(now.getTime() + RECEIPT_LINK_DAYS * 86_400_000),
        createdAt: now,
      });
      return `${this.config.LINKS_ORIGIN}/r/${token}`;
    });
  }

  /** A receipt link's page (receiptLinks.open). */
  async open(token: string, client: { ip: string; userAgent: string }): Promise<ReceiptPageView> {
    const { companyId, link } = await this.resolve(token, client);
    return withCompany(this.database, { companyId, actorKind: 'link' }, async (tx) => {
      const now = this.clock.now();
      await tx
        .update(schema.secureLink)
        .set({
          firstOpenedAt: link.firstOpenedAt ?? now,
          lastOpenedAt: now,
          openCount: link.openCount + 1,
        })
        .where(eq(schema.secureLink.id, link.id));
      const [receipt] = await tx
        .select()
        .from(schema.receipt)
        .where(eq(schema.receipt.id, link.receiptId!));
      const [payment] = await tx
        .select()
        .from(schema.payment)
        .where(eq(schema.payment.id, receipt!.paymentId));
      // M11 review R3 F9: a closed link answers the closed screen, the receipt's number (which
      // the page tells the tenant to quote) and the landlord's contact, nothing about the tenancy
      // or the money. The contract's other fields are present and empty; the date stays, as the
      // contract requires one.
      const closed: ReceiptScreen | null = link.revokedAt
        ? 'revoked'
        : link.expiresAt.getTime() <= now.getTime()
          ? 'expired'
          : null;
      if (closed) {
        const [company] = await tx
          .select({ timeZone: schema.company.timeZone })
          .from(schema.company)
          .where(eq(schema.company.id, companyId));
        return {
          screen: closed,
          landlord: await landlordContact(tx, this.policy, companyId),
          timeZone: company?.timeZone ?? 'Africa/Accra',
          linkExpiresAt: link.expiresAt,
          receiptNumber: formatReceiptNumber(receipt!.number),
          kind: receipt!.kind as 'receipt' | 'credit_receipt',
          amountMinor: 0,
          receivedOn: payment!.receivedOn,
          tenantName: '',
          unitCode: '',
          propertyName: '',
          paidUntil: null,
          downloadable: false,
        };
      }
      const state = await this.engine.load(tx, companyId, receipt!.leaseId);
      const documentId = await this.documentOf(tx, receipt!.renderRequestId);
      const company = state.company;
      const screen: ReceiptScreen = link.revokedAt
        ? 'revoked'
        : link.expiresAt.getTime() <= now.getTime()
          ? 'expired'
          : documentId
            ? 'receipt'
            : 'preparing';
      const landlord = await landlordContact(tx, this.policy, companyId);
      return {
        screen,
        landlord,
        timeZone: company.timeZone,
        linkExpiresAt: link.expiresAt,
        receiptNumber: formatReceiptNumber(receipt!.number),
        kind: receipt!.kind as 'receipt' | 'credit_receipt',
        amountMinor: receipt!.amountMinor,
        receivedOn: payment!.receivedOn,
        tenantName: state.lease.tenantName,
        unitCode: state.lease.unitCode,
        propertyName: state.lease.propertyName,
        paidUntil: this.engine.walk(state).paidUntil,
        downloadable: screen === 'receipt',
      };
    });
  }

  /** A 5-minute download of a receipt link's PDF (receiptLinks.document). */
  async documentUrl(token: string, client: { ip: string; userAgent: string }): Promise<string> {
    const { companyId, link } = await this.resolve(token, client);
    const now = this.clock.now();
    if (link.revokedAt || link.expiresAt.getTime() <= now.getTime())
      throw conflict('link_not_usable', 'This link can no longer be used');
    const documentId = await withCompany(
      this.database,
      { companyId, actorKind: 'link' },
      async (tx) => {
        const [receipt] = await tx
          .select()
          .from(schema.receipt)
          .where(eq(schema.receipt.id, link.receiptId!));
        return this.documentOf(tx, receipt?.renderRequestId ?? null);
      },
    );
    if (!documentId) throw notFound('Receipt PDF');
    const url = await this.documents.downloadUrl(companyId, documentId);
    if (!url) throw notFound('Receipt PDF');
    return url;
  }

  /** A 5-minute download of a receipt the tenant session may see (tenantMoney.receiptDownload). */
  async tenantDownload(companyId: string, tx: Tx, receiptId: string): Promise<string | null> {
    const [receipt] = await tx
      .select()
      .from(schema.receipt)
      .where(eq(schema.receipt.id, receiptId));
    if (!receipt) return null;
    const documentId = await this.documentOf(tx, receipt.renderRequestId);
    return documentId ? this.documents.downloadUrl(companyId, documentId) : null;
  }

  private async documentOf(tx: Tx, renderRequestId: string | null): Promise<string | null> {
    if (!renderRequestId) return null;
    return (await this.documents.renderedDocument(tx, renderRequestId))?.documentId ?? null;
  }

  private async resolve(token: string, client: { ip: string }) {
    if (
      !(await consumeRateLimit(
        this.database,
        `receipt:open:ip:${this.hasher.address(client.ip)}`,
        { count: 60, windowMinutes: 10 },
        this.clock.now().getTime(),
      ))
    )
      throw new AppError(
        429,
        'rate_limited',
        'Too many requests. Wait a few minutes and try again.',
      );
    const { companyId, linkId } = await this.links.resolve(token);
    const [link] = await withCompany(this.database, { companyId, actorKind: 'link' }, (tx) =>
      tx
        .select()
        .from(schema.secureLink)
        .where(and(eq(schema.secureLink.id, linkId), eq(schema.secureLink.purpose, 'receipt'))),
    );
    if (!link || !link.receiptId) throw notFound('Link');
    return { companyId, link };
  }
}
