import { Inject, Injectable, Optional } from '@nestjs/common';
import { asc, eq, schema, sql, withCompany, withSystem, type Database, type Tx } from '@rent/db';
import type { ConsentChannel } from '@rent/domain/messaging';
import { invoiceRemainingMinor, PAY_LINK_DAYS } from '@rent/domain/payments';
import type { Actor } from '@rent/domain/policy';
import { format, money } from '@rent/domain/money';
import { BillingEngine } from '../billing/engine';
import { formatInvoiceNumber } from '../billing/records';
import { staffActor } from '../companies/companies.service';
import { destinationForOwner } from '../companies/settlement-destinations';
import type { Clock } from '../core/clock';
import type { AppConfig } from '../core/config';
import { AppError, conflict, forbidden, notFound } from '../core/errors';
import { queueMessage } from '../core/messages';
import { CLOCK, CONFIG, DATABASE } from '../core/tokens';
import { newToken, tokenHash, TOKEN_PATTERN } from '../esign/secrets';
import { MessagingService } from '../messaging/messaging.service';
import { PolicyService, staffContext } from '../policy/policy.service';
import { TenantsService } from '../tenancy/tenants.service';

const DAY_MS = 86_400_000;

/** A pay link's row with what the page needs to know about it. */
export type PayLinkRow = typeof schema.secureLink.$inferSelect;

export interface InvoiceFacts {
  readonly id: string;
  readonly number: number;
  readonly leaseId: string;
  readonly tenantId: string;
  readonly propertyId: string;
  readonly dueDate: string;
  readonly ownerId: string;
  readonly kind: string;
}

/**
 * Pay links (BC-04; M4b plan 4.3): one secure link per tenant and invoice, purpose `pay`. 256
 * random bits, only the hash stored; it expires after 60 days and stops taking money once the
 * invoice is settled. Links are made at send time, outside any transaction, so a raw token is
 * never stored (CLAUDE.md section 9).
 */
@Injectable()
export class PayLinksService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(BillingEngine) private readonly engine: BillingEngine,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    /** M6 (review C2): the channels the send job will try, push and WhatsApp included. */
    @Optional()
    @Inject(MessagingService)
    private readonly messaging: MessagingService | null = null,
  ) {}

  /** The URL the links app serves the pay page at. */
  urlFor(token: string): string {
    return `${this.config.LINKS_ORIGIN}/p/${token}`;
  }

  /** Makes a pay link in the caller's transaction and returns its URL. */
  async mint(
    tx: Tx,
    invoice: InvoiceFacts,
    options: { readonly createdBy?: string | null; readonly messageId?: string | null } = {},
  ): Promise<{ url: string; expiresAt: Date; linkId: string }> {
    const now = this.clock.now();
    const token = newToken();
    const expiresAt = new Date(now.getTime() + PAY_LINK_DAYS * DAY_MS);
    const [link] = await tx
      .insert(schema.secureLink)
      .values({
        companyId: (await this.companyOf(tx)) as string,
        propertyId: invoice.propertyId,
        tenantId: invoice.tenantId,
        purpose: 'pay',
        tokenHash: tokenHash(token),
        invoiceId: invoice.id,
        messageId: options.messageId ?? null,
        expiresAt,
        createdBy: options.createdBy ?? null,
        createdAt: now,
      })
      .returning({ id: schema.secureLink.id });
    return { url: this.urlFor(token), expiresAt, linkId: link!.id };
  }

  /** The `pay` link resolver for messaging: a fresh link at send time, only while money is owed. */
  async urlForMessage(companyId: string, invoiceId: string, messageId: string): Promise<string> {
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const invoice = await this.invoice(tx, invoiceId);
      await this.payable(tx, companyId, invoice);
      return (await this.mint(tx, invoice, { messageId })).url;
    });
  }

  /**
   * Refuses a pay link nobody could pay through: a lease whose rent has nowhere to settle, or an
   * invoice with nothing left to pay after the lease's credit.
   */
  async payable(tx: Tx, companyId: string, invoice: InvoiceFacts): Promise<void> {
    const reason = await this.unavailableReason(tx, companyId, invoice);
    if (reason) throw conflict('pay_link_unavailable', reason);
  }

  async unavailableReason(
    tx: Tx,
    companyId: string,
    invoice: InvoiceFacts,
  ): Promise<string | null> {
    const state = await this.engine.load(tx, companyId, invoice.leaseId);
    const today = this.engine.today(state);
    const destination = await destinationForOwner(tx, state.company, invoice.ownerId, today);
    if (destination.kind === 'problem') return destination.text;
    const walk = this.engine.walk(state);
    const remaining = invoiceRemainingMinor({
      invoiceLines: state.lines.filter((l) => l.invoiceId === invoice.id),
      allocations: state.allocations,
      walk,
    });
    if (remaining <= 0) return 'Nothing is left to pay on this invoice';
    return null;
  }

  /**
   * Sends the tenant a pay link by SMS or email where consent is recorded (BC-04;
   * paymentsQueue.sendPayLink). The message goes through the outbox; the link is made as it is
   * sent.
   */
  async send(
    actor: Actor | null,
    invoiceId: string,
  ): Promise<{ channels: ConsentChannel[]; notSentReason: string | null }> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'billing.manage');
    const scoped = await withCompany(this.database, staffContext(staff), (tx) =>
      this.invoice(tx, invoiceId),
    );
    return withCompany(
      this.database,
      { companyId: staff.companyId, personId: staff.personId, actorKind: 'staff' },
      async (tx) => {
        const invoice = scoped;
        const reason = await this.unavailableReason(tx, staff.companyId, invoice);
        if (reason) return { channels: [], notSentReason: reason };
        const channels = await this.consentedChannels(tx, staff.companyId, invoice.tenantId);
        if (channels.length === 0)
          return {
            channels: [],
            notSentReason: this.messaging
              ? 'The tenant has not agreed to messages on any channel we can reach them on; hand them the link in person'
              : 'The tenant has not agreed to messages by SMS or email; hand them the link in person',
          };
        const company = await tx
          .select({ name: schema.company.displayName })
          .from(schema.company)
          .where(eq(schema.company.id, staff.companyId));
        const due = await this.dueOn(tx, staff.companyId, invoice);
        await queueMessage(tx, staff.companyId, {
          recipient: { type: 'tenant', tenantId: invoice.tenantId },
          purpose: 'pay_link',
          subject: `Pay ${formatInvoiceNumber(invoice.number)}`,
          body: `${company[0]?.name ?? 'Your landlord'}: ${format(money(due))} is due on ${formatInvoiceNumber(invoice.number)}. Pay by MoMo or card here: {{link}}`,
          link: { purpose: 'pay', targetId: invoice.id },
          // Exactly the channels the answer names, in the order the send job tries them.
          channels,
          propertyId: invoice.propertyId,
          related: { type: 'invoice', id: invoice.id },
          requestedBy: staff.personId,
        });
        return { channels, notSentReason: null };
      },
    );
  }

  /**
   * The tenant's channels with an address and consent now (CM-09), in send order. M6 (review C2):
   * push, WhatsApp (with the window or an approved template), SMS and email, as the send job would
   * try them; without the messaging core (M4b tests), SMS and email only.
   */
  async consentedChannels(tx: Tx, companyId: string, tenantId: string): Promise<ConsentChannel[]> {
    if (this.messaging)
      return this.messaging.plannedChannels(tx, companyId, {
        recipient: { type: 'tenant', tenantId },
        purpose: 'pay_link',
        channels: ['push', 'whatsapp', 'sms', 'email'],
        link: { purpose: 'pay', targetId: tenantId },
      });
    const reach = await this.tenants.reach(tx, { tenantId });
    if (!reach) return [];
    const out: ('sms' | 'email')[] = [];
    if (reach.phone && reach.consented.has('sms')) out.push('sms');
    if (reach.email && reach.consented.has('email')) out.push('email');
    return out;
  }

  /** What is due on an invoice and anything older, as the pay page shows it. */
  async dueOn(tx: Tx, companyId: string, invoice: InvoiceFacts): Promise<number> {
    const state = await this.engine.load(tx, companyId, invoice.leaseId);
    const walk = this.engine.walk(state);
    return invoiceRemainingMinor({
      invoiceLines: state.lines.filter((l) => l.dueDate <= invoice.dueDate),
      allocations: state.allocations,
      walk,
    });
  }

  /**
   * A fresh pay link for the tenant's oldest open invoice on a lease, for the app to open in its
   * browser (tenantMoney.payLink). The tenant session's own lease only.
   */
  async forTenant(
    actor: Actor | null,
    companyId: string,
    leaseId: string,
  ): Promise<{ url: string; expiresAt: Date }> {
    if (!actor) throw forbidden();
    switch (actor.kind) {
      case 'tenant':
        break;
      default:
        throw forbidden();
    }
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const invoices = await tx
        .select()
        .from(schema.invoice)
        .where(eq(schema.invoice.leaseId, leaseId))
        .orderBy(asc(schema.invoice.dueDate), asc(schema.invoice.number));
      for (const row of invoices) {
        const invoice = facts(row);
        if (await this.unavailableReason(tx, companyId, invoice)) continue;
        const { url, expiresAt } = await this.mint(tx, invoice, { createdBy: actor.personId });
        return { url, expiresAt };
      }
      throw new AppError(409, 'nothing_to_pay', 'Nothing is due on this tenancy now');
    });
  }

  /** The company and link of a pay token, through the narrow system function (ids only). */
  async resolve(token: string): Promise<{ companyId: string; linkId: string }> {
    if (!TOKEN_PATTERN.test(token)) throw notFound('Link');
    const result = await withSystem(this.database, { actorKind: 'link' }, (tx) =>
      tx.execute<{ company_id: string; link_id: string }>(
        sql`select company_id, link_id from app.secure_link_company(${tokenHash(token)})`,
      ),
    );
    const row = result.rows[0];
    if (!row) throw notFound('Link');
    return { companyId: row.company_id, linkId: row.link_id };
  }

  async invoice(tx: Tx, invoiceId: string): Promise<InvoiceFacts> {
    const [row] = await tx.select().from(schema.invoice).where(eq(schema.invoice.id, invoiceId));
    if (!row) throw notFound('Invoice');
    return facts(row);
  }

  private async companyOf(tx: Tx): Promise<string | null> {
    const result = await tx.execute<{ id: string | null }>(
      sql`select app.current_company_id() as id`,
    );
    return result.rows[0]?.id ?? null;
  }
}

export function facts(row: typeof schema.invoice.$inferSelect): InvoiceFacts {
  return {
    id: row.id,
    number: row.number,
    leaseId: row.leaseId,
    tenantId: row.tenantId,
    propertyId: row.propertyId,
    dueDate: row.dueDate,
    ownerId: row.ownerId,
    kind: row.kind,
  };
}
