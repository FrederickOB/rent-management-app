import { Inject, Injectable } from '@nestjs/common';
import { sql, withCompany, type Database } from '@rent/db';
import { subscriptionCreditNoteV1, type SubscriptionCreditNoteDocumentData } from '@rent/documents';
import { subscriptionCreditNoteLines, subscriptionPostingKeys } from '@rent/domain/ledger';
import { allocate, format, money } from '@rent/domain/money';
import type { Actor } from '@rent/domain/policy';
import { staffActor } from '../companies/companies.service';
import { AppError, conflict, forbidden, notFound } from '../core/errors';
import type { IdempotencyClaim } from '../core/idempotency';
import { DATABASE } from '../core/tokens';
import { DocumentsService } from '../documents/documents.service';
import { PostingService } from '../ledger/posting.service';
import { PolicyService, staffContext } from '../policy/policy.service';
import { SubscriptionCoreService } from './core.service';
import { settleFromCredit } from './credit';
import { notifySubscriber } from './notices';
import { nextSubscriptionNumber } from './numbering';
import { lockSubscription, platformBookId, withPlatform } from './platform';
import { creditNoteRows } from './subscription.service';

export const SUBSCRIPTION_CREDIT_NOTE_TEMPLATE = {
  key: subscriptionCreditNoteV1.key,
  version: subscriptionCreditNoteV1.version,
} as const;

const DOWNLOAD_MS = 5 * 60_000;

export interface SubscriptionCreditNoteView {
  readonly id: string;
  readonly number: string;
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly issuedOn: string;
  readonly netMinor: number;
  readonly vatMinor: number;
  readonly amountMinor: number;
  readonly reason: string;
  readonly hasDocument: boolean;
}

/**
 * Credit notes on subscription invoices (M10 review BE-6, founder answer Q2). A platform admin
 * credits an invoice in full or in part, with a reason, never more than its total less earlier
 * credits. Gap-free `SUBC-` numbers; a PDF; P26's reversal of that part of the invoice in the
 * platform book (4600 and 2210 against 1100, or 2020 for the part an already-paid invoice no
 * longer owes, drawn on the next invoice); audited in both chains; the subscriber's admins told;
 * access restored if it clears the arrears.
 */
@Injectable()
export class SubscriptionCreditNotesService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(SubscriptionCoreService) private readonly core: SubscriptionCoreService,
    @Inject(PostingService) private readonly posting: PostingService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(PolicyService) private readonly policy: PolicyService,
  ) {}

  private platformAdmin(actor: Actor | null): Extract<Actor, { kind: 'platform_admin' }> {
    if (!actor) throw forbidden();
    this.policy.assert(actor, 'company.manage');
    switch (actor.kind) {
      case 'platform_admin':
        return actor;
      default:
        throw forbidden();
    }
  }

  async credit(
    actor: Actor | null,
    companyId: string,
    invoiceId: string,
    input: { readonly amountMinor: number; readonly reason: string },
    claim?: IdempotencyClaim | null,
  ): Promise<SubscriptionCreditNoteView> {
    const admin = this.platformAdmin(actor);
    const reason = input.reason.trim();
    if (reason.length < 5 || reason.length > 500)
      throw new AppError(400, 'reason_required', 'Give a reason of 5 to 500 characters');
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
      throw new AppError(400, 'bad_amount', 'Credit an amount above zero');
    const done = await withPlatform(
      this.database,
      { personId: admin.personId, actorKind: 'platform_admin' },
      async (tx, platformId) => {
        await lockSubscription(tx, companyId);
        const company = await this.core.subscriberCompany(tx, companyId);
        if (!company) throw notFound('Company');
        const rows = await tx.execute<{
          id: string;
          number: string;
          status: string;
          net_minor: string;
          vat_minor: string;
          total_minor: string;
          credited_minor: string;
        }>(
          sql`select i.id, i.number, i.status, i.net_minor, i.vat_minor, i.total_minor,
                coalesce((select sum(n.amount_minor) from subscription_credit_note n
                          where n.company_id = i.company_id and n.invoice_id = i.id), 0) as credited_minor
              from subscription_invoice i
              where i.id = ${invoiceId}::uuid and i.subscriber_company_id = ${companyId}::uuid
              for update`,
        );
        const invoice = rows.rows[0];
        if (!invoice) throw notFound('Invoice');
        if (invoice.status === 'void')
          throw conflict('invoice_void', 'This invoice is void; there is nothing to credit');
        const room = Number(invoice.total_minor) - Number(invoice.credited_minor);
        if (input.amountMinor > room)
          throw conflict(
            'credit_exceeds_invoice',
            `At most ${format(money(Math.max(0, room)))} of this invoice can still be credited`,
          );
        // The credit takes VAT back in the invoice's own proportion (largest remainder).
        const [netPart, vatPart] = allocate(money(input.amountMinor), [
          Number(invoice.net_minor),
          Number(invoice.vat_minor),
        ]).map((m) => m.amountMinor);
        const owed =
          (await this.core.openInvoices(tx, companyId)).find((i) => i.id === invoiceId)
            ?.outstandingMinor ?? 0;
        const toReceivable = Math.min(input.amountMinor, Math.max(0, owed));
        const toCredit = input.amountMinor - toReceivable;
        const today = this.core.todayIn(company.timeZone);
        const number = await nextSubscriptionNumber(
          tx,
          platformId,
          'credit',
          Number(today.slice(0, 4)),
        );
        const inserted = await tx.execute<{ id: string }>(
          sql`insert into subscription_credit_note (company_id, subscriber_company_id, invoice_id, number,
                issued_on, net_minor, vat_minor, amount_minor, to_credit_minor, reason, created_by,
                template_key, template_version)
              values (${platformId}::uuid, ${companyId}::uuid, ${invoiceId}::uuid, ${number}, ${today}::date,
                ${netPart}, ${vatPart}, ${input.amountMinor}, ${toCredit}, ${reason}, ${admin.personId}::uuid,
                ${SUBSCRIPTION_CREDIT_NOTE_TEMPLATE.key}, ${SUBSCRIPTION_CREDIT_NOTE_TEMPLATE.version})
              returning id`,
        );
        const creditNoteId = inserted.rows[0]!.id;
        await this.posting.post(tx, {
          companyId: platformId,
          rule: 'P26',
          key: subscriptionPostingKeys.creditNote(creditNoteId),
          valueDate: today,
          lines: subscriptionCreditNoteLines({
            bookId: await platformBookId(tx, platformId),
            invoiceId,
            netMinor: netPart!,
            vatMinor: vatPart!,
            toReceivableMinor: toReceivable,
            toCreditMinor: toCredit,
          }),
          record: { type: 'subscription_credit_note', id: creditNoteId },
          causedBy: admin.personId,
        });
        if (toReceivable > 0 && toReceivable === owed)
          await tx.execute(
            sql`update subscription_invoice set status = 'paid', paid_at = now(), updated_at = now()
                where id = ${invoiceId}::uuid and status = 'open'`,
          );
        // Credit an already-paid invoice left goes onto anything still open, oldest first.
        if (toCredit > 0)
          await settleFromCredit(
            tx,
            { core: this.core, posting: this.posting },
            platformId,
            companyId,
            today,
          );
        const data: SubscriptionCreditNoteDocumentData = {
          platformName: (
            await tx.execute<{ display_name: string }>(
              sql`select display_name from company where id = ${platformId}::uuid`,
            )
          ).rows[0]!.display_name,
          subscriberName: company.displayName,
          number,
          issuedOn: today,
          invoiceNumber: invoice.number,
          netMinor: netPart!,
          vatMinor: vatPart!,
          amountMinor: input.amountMinor,
          toCreditMinor: toCredit,
          reason,
        };
        const renderRequestId = await this.documents.requestRender(tx, {
          companyId: platformId,
          templateKey: SUBSCRIPTION_CREDIT_NOTE_TEMPLATE.key,
          templateVersion: SUBSCRIPTION_CREDIT_NOTE_TEMPLATE.version,
          data: data as unknown as Record<string, unknown>,
          requestedBy: admin.personId,
        });
        await tx.execute(
          sql`update subscription_credit_note set render_request_id = ${renderRequestId}::uuid
              where id = ${creditNoteId}::uuid`,
        );
        await this.core.auditSubscriberIn(
          tx,
          companyId,
          'subscription.invoice_credited',
          invoiceId,
          { creditNote: number, invoice: invoice.number, amountMinor: input.amountMinor, reason },
          `subscription_credit_note:${creditNoteId}`,
        );
        const sub = await this.core.find(tx, companyId);
        if (sub) await this.core.refresh(tx, platformId, sub, company, { today });
        const [view] = (await creditNoteRows(tx, companyId, invoiceId)).filter(
          (n) => n.id === creditNoteId,
        );
        await notifySubscriber(tx, platformId, companyId, {
          key: `credit_note:${creditNoteId}`,
          subject: `Credit note ${number} on invoice ${invoice.number}`,
          body: `We credited ${format(money(input.amountMinor))} on your subscription invoice ${invoice.number}: ${reason}. The credit note is on the subscription page.`,
          related: { type: 'subscription_credit_note', id: creditNoteId },
        });
        if (claim) {
          await claim.claim(tx);
          await claim.done(tx, view);
        }
        return { view: view!, company };
      },
    );
    return done.view;
  }

  /** A credit note's PDF for the console (the caller checked the platform admin). */
  async documentFor(
    actor: Actor | null,
    companyId: string,
    creditNoteId: string,
  ): Promise<{ url: string; expiresAt: Date }> {
    this.platformAdmin(actor);
    return this.document(companyId, creditNoteId);
  }

  /** A credit note's PDF for the subscriber (`subscription.read`). */
  async subscriberDocument(
    actor: Actor | null,
    creditNoteId: string,
  ): Promise<{ url: string; expiresAt: Date }> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'subscription.read');
    // The subscriber sees only its own (the select-only policy on its rows).
    const own = await withCompany(this.database, staffContext(staff), (tx) =>
      tx.execute(
        sql`select 1 from subscription_credit_note where id = ${creditNoteId}::uuid
            and subscriber_company_id = ${staff.companyId}::uuid`,
      ),
    );
    if (own.rows.length === 0) throw notFound('Credit note');
    return this.document(staff.companyId, creditNoteId);
  }

  private async document(companyId: string, creditNoteId: string) {
    const { platformId, row } = await withPlatform(
      this.database,
      {},
      async (tx, platformId) => {
        const rows = await tx.execute<{
          number: string;
          document_id: string | null;
          render_request_id: string | null;
        }>(
          sql`select number, document_id, render_request_id from subscription_credit_note
              where id = ${creditNoteId}::uuid and subscriber_company_id = ${companyId}::uuid`,
        );
        let row = rows.rows[0] ?? null;
        if (row && !row.document_id && row.render_request_id) {
          const rendered = await this.documents.renderedDocument(tx, row.render_request_id);
          if (rendered?.status === 'rendered' && rendered.documentId)
            row = { ...row, document_id: rendered.documentId };
        }
        return { platformId, row };
      },
      { accessMode: 'read only' },
    );
    if (!row) throw notFound('Credit note');
    if (!row.document_id)
      throw conflict('document_rendering', 'The PDF is still being made. Try again in a moment.');
    const url = await this.documents.downloadUrl(platformId, row.document_id, `${row.number}.pdf`);
    if (!url) throw notFound('Credit note document');
    return { url, expiresAt: new Date(Date.now() + DOWNLOAD_MS) };
  }

  /** `documents.rendered` for a credit note: its document and fingerprint, recorded once. */
  async onDocumentRendered(companyId: string, renderRequestId: string): Promise<boolean> {
    return withPlatform(this.database, {}, async (tx, platformId) => {
      if (companyId !== platformId) return false;
      const rendered = await this.documents.renderedDocument(tx, renderRequestId);
      if (
        !rendered ||
        rendered.templateKey !== SUBSCRIPTION_CREDIT_NOTE_TEMPLATE.key ||
        rendered.status !== 'rendered' ||
        !rendered.documentId ||
        !rendered.sha256
      )
        return false;
      const updated = await tx.execute(
        sql`update subscription_credit_note set document_id = ${rendered.documentId}::uuid,
              sha256 = ${rendered.sha256}
            where render_request_id = ${renderRequestId}::uuid and document_id is null`,
      );
      return (updated.rowCount ?? 0) > 0;
    });
  }
}
