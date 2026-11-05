import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, schema, sql, withCompany, type Database, type Tx } from '@rent/db';
import { appendPdfPages } from '@rent/documents';
import {
  dueLadderSteps,
  NOTICE_TYPE_LABELS,
  noticeSettingsOf,
  SERVICE_PACK_TEMPLATE,
  servicePackContent,
  type NoticeChannel,
  type NoticeLadderStep,
  type NoticeStatus,
  type NoticeType,
} from '@rent/domain/notices';
import { v7 as uuidv7 } from 'uuid';
import { ApprovalsService } from '../approvals/approvals.service';
import { AuditService } from '../audit/audit.service';
import type { Clock } from '../core/clock';
import { queueMessage, queueMessageOnEachChannel } from '../core/messages';
import { enqueueOutbox } from '../core/outbox';
import { CLOCK, DATABASE } from '../core/tokens';
import { DocumentsService } from '../documents/documents.service';
import { EsignService } from '../esign/esign.service';
import { TasksService } from '../tasks/tasks.service';
import {
  companyFacts,
  eventsOf,
  noticeRow,
  NOTICE_ESCALATE_JOB,
  numberOf,
  partyKeyOf,
  progressOf,
  recipientsOf,
  recordEvent,
  returnedForApproval,
  syncStatus,
  type NoticeRow,
  type RecipientRow,
} from './records';

const HOUR = 3_600_000;
const LIVE = ['sent', 'delivered', 'reminded', 'opened', 'escalated', 'served', 'signed'];

interface ChannelPlanRow {
  readonly channel: NoticeChannel;
  readonly mode: 'service' | 'courtesy' | 'withheld';
  readonly reason: string | null;
}

/**
 * What happens to a notice after issue (LN-02 to LN-05, LN-07; plan 4.6, 4.7, 4.12), run by the
 * worker: the frozen PDF recorded and the links sent on every channel at once; first opens,
 * signatures and delivery reports recorded with their channel; the ladder every 15 minutes, once
 * per recipient and step; escalation with the service pack. Each is idempotent: an event's dedupe
 * key, a task's, or a document set once.
 */
@Injectable()
export class NoticeTrackingService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(EsignService) private readonly esign: EsignService,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private ctx(companyId: string) {
    return { companyId, actorKind: 'system' as const };
  }

  /**
   * `documents.rendered` for a notice (plan 4.6; job `notices.issue-delivery`, keyed by notice):
   * records the frozen PDF and its SHA-256, then queues one message per recipient per channel at
   * the same moment. The e-sign engine has already opened the requests in this job. A rendered
   * service pack is assembled instead. Returns whether it did anything.
   */
  async onDocumentRendered(companyId: string, renderRequestId: string): Promise<boolean> {
    const found = await withCompany(this.database, this.ctx(companyId), async (tx) => {
      const [notice] = await tx
        .select()
        .from(schema.notice)
        .where(
          sql`${schema.notice.renderRequestId} = ${renderRequestId} or ${schema.notice.servicePackRenderRequestId} = ${renderRequestId}`,
        );
      if (!notice) return null;
      const rendered = await this.documents.renderedDocument(tx, renderRequestId);
      if (!rendered || rendered.status !== 'rendered' || !rendered.documentId || !rendered.sha256)
        return null;
      return { notice, rendered };
    });
    if (!found) return false;
    if (found.notice.servicePackRenderRequestId === renderRequestId)
      return this.assembleServicePack(companyId, found.notice.id, found.rendered.documentId!);
    const { rendered } = found;
    return withCompany(this.database, this.ctx(companyId), async (tx) => {
      const notice = await noticeRow(tx, found.notice.id, true);
      const now = this.clock.now();
      if (!notice.documentId)
        await tx
          .update(schema.notice)
          .set({ documentId: rendered.documentId, documentSha256: rendered.sha256, updatedAt: now })
          .where(eq(schema.notice.id, notice.id));
      const first = await recordEvent(tx, notice, {
        kind: 'document_ready',
        at: now,
        data: { documentId: rendered.documentId, sha256: rendered.sha256 },
        dedupeKey: `document_ready:${notice.id}`,
      });
      if (!first) return false;
      await this.audit.append(tx, {
        companyId,
        action: 'notice.frozen',
        recordType: 'notice',
        recordId: notice.id,
        data: { documentId: rendered.documentId, documentSha256: rendered.sha256 },
      });
      // A notice closed before its PDF was ready (superseded at once) sends nothing.
      if (!LIVE.includes(notice.status)) return true;
      const company = await companyFacts(tx, companyId);
      const title = NOTICE_TYPE_LABELS[notice.type as NoticeType];
      const number = numberOf(notice)!;
      for (const r of await recipientsOf(tx, notice.id)) {
        if (!r.signerId) continue;
        const channels = (r.channels as ChannelPlanRow[]).filter((c) => c.mode !== 'withheld');
        const service = channels.filter((c) => c.mode === 'service');
        const courtesy = channels.filter((c) => c.mode === 'courtesy');
        // Decision 4: without the clause (or a served channel) the electronic copy is a courtesy.
        const courtesyText =
          service.length === 0
            ? ' This is a courtesy copy: the notice is also being served on you in person.'
            : '';
        const base = {
          recipient: { type: 'signer' as const, signerId: r.signerId },
          purpose: 'notice_link' as const,
          subject: `Notice ${number} from ${company.senderName}: ${title}`,
          body: `${company.senderName} has sent you a notice: ${title} (${number}). Read it at {{link}} and confirm you received it with a code sent to your phone. Signing confirms only that you received it.${courtesyText}`,
          link: { purpose: 'sign' as const, targetId: r.signerId },
          propertyId: notice.propertyId,
          related: { type: 'notice_recipient', id: r.id },
          requestedBy: notice.createdBy,
        };
        await queueMessageOnEachChannel(
          tx,
          companyId,
          base,
          [...service, ...courtesy]
            .filter((c) => c.channel !== 'email')
            .map((c) => ({ channel: c.channel, serviceClause: c.mode === 'service' })),
        );
        // Email carries the PDF as well as the link (plan 4.6).
        const email = channels.find((c) => c.channel === 'email');
        if (email)
          await queueMessage(tx, companyId, {
            ...base,
            channels: ['email'],
            ...(email.mode === 'service' ? { serviceClause: true } : {}),
            document: { documentId: rendered.documentId!, filename: `${number}.pdf` },
          });
      }
      return true;
    });
  }

  /**
   * The engine's notice events (plan 4.5; job `esign.notice-event`): a recipient's first open with
   * the device, their signature, and an acknowledged request. Each is recorded once.
   */
  async onSigningEvent(
    companyId: string,
    event: {
      readonly kind: 'opened' | 'signed' | 'completed';
      readonly noticeId: string;
      readonly signingRequestId: string;
      readonly signerId?: string;
      readonly at: string;
      readonly userAgent?: string;
      readonly linkId?: string;
    },
  ): Promise<void> {
    await withCompany(this.database, this.ctx(companyId), async (tx) => {
      const notice = await noticeRow(tx, event.noticeId, true);
      const recipients = await recipientsOf(tx, notice.id);
      const recipient = event.signerId
        ? recipients.find((r) => r.signerId === event.signerId)
        : null;
      const at = new Date(event.at);
      const now = this.clock.now();
      if (event.kind === 'opened' && recipient)
        await recordEvent(tx, notice, {
          kind: 'opened',
          at,
          recipient,
          data: { device: event.userAgent ?? null, linkId: event.linkId ?? null },
          dedupeKey: `opened:${recipient.id}`,
        });
      if (event.kind === 'signed' && recipient) {
        // A signature needs an open (plan 4.4); the open's own event may not have landed yet.
        await recordEvent(tx, notice, {
          kind: 'opened',
          at,
          recipient,
          data: { linkId: null },
          dedupeKey: `opened:${recipient.id}`,
        });
        await recordEvent(tx, notice, {
          kind: 'signed',
          at,
          recipient,
          data: { signingRequestId: event.signingRequestId },
          dedupeKey: `signed:${recipient.id}`,
        });
        // The party has acknowledged (LN-07): an in-person reminder for it is no longer needed.
        await this.tasks.closeOpen(
          tx,
          {
            noticeId: notice.id,
            kinds: ['notice_in_person_reminder'],
            // The party that acknowledged: a company's signatories together, a co-tenant alone.
            recipientIds: recipients
              .filter(
                (r) => notice.completion === 'any_one' || partyKeyOf(r) === partyKeyOf(recipient),
              )
              .map((r) => r.id),
          },
          'cancelled',
          'The tenant acknowledged the notice',
          null,
        );
      }
      if (event.kind === 'completed')
        await this.audit.append(tx, {
          companyId,
          action: 'notice.acknowledged',
          recordType: 'notice',
          recordId: notice.id,
          data: { signingRequestId: event.signingRequestId },
        });
      if (LIVE.includes(notice.status)) await syncStatus(tx, notice, now);
    });
  }

  /**
   * `notices.delivery-status` (plan 4.6; prd-issues 7): a provider's delivery report on a notice
   * message becomes `delivered` with the channel that confirmed it, once per recipient and channel.
   * Email counts only when the provider reports delivery.
   */
  async onDeliveryStatus(
    companyId: string,
    report: {
      readonly recipientId: string;
      readonly messageId: string;
      readonly status: string;
      readonly channel: string | null;
      readonly at: string;
    },
  ): Promise<void> {
    if (report.status !== 'delivered' && report.status !== 'read') return;
    if (!report.channel || !['whatsapp', 'sms', 'email'].includes(report.channel)) return;
    await withCompany(this.database, this.ctx(companyId), async (tx) => {
      const [recipient] = await tx
        .select()
        .from(schema.noticeRecipient)
        .where(eq(schema.noticeRecipient.id, report.recipientId));
      if (!recipient) return;
      const notice = await noticeRow(tx, recipient.noticeId, true);
      await recordEvent(tx, notice, {
        kind: 'delivered',
        at: new Date(report.at),
        recipient,
        channel: report.channel,
        messageId: report.messageId,
        data: { report: report.status },
        dedupeKey: `delivered:${recipient.id}:${report.channel}`,
      });
      if (LIVE.includes(notice.status)) await syncStatus(tx, notice, this.clock.now());
    });
  }

  /** `messaging.not_sent` for a notice message: the channel is recorded as withheld, with why. */
  async onMessageNotSent(
    companyId: string,
    event: {
      readonly messageId: string;
      readonly reason: string;
      readonly related?: { type: string; id: string } | null;
    },
  ): Promise<void> {
    if (event.related?.type !== 'notice_recipient') return;
    await withCompany(this.database, this.ctx(companyId), async (tx) => {
      const [recipient] = await tx
        .select()
        .from(schema.noticeRecipient)
        .where(eq(schema.noticeRecipient.id, event.related!.id));
      if (!recipient) return;
      const notice = await noticeRow(tx, recipient.noticeId);
      const [message] = await tx
        .select({ channels: schema.message.channels })
        .from(schema.message)
        .where(eq(schema.message.id, event.messageId));
      await recordEvent(tx, notice, {
        kind: 'channel_withheld',
        at: this.clock.now(),
        recipient,
        channel: message?.channels.length === 1 ? message.channels[0] : null,
        messageId: event.messageId,
        data: { reason: event.reason, at: 'send' },
        dedupeKey: `not_sent:${event.messageId}`,
      });
    });
  }

  /**
   * `notices.ladder` for one company (every 15 minutes; plan 4.7): each live notice's due steps,
   * once per recipient and step, with tenant reminders in the sending window. Also catches up on
   * approvals that closed without approving, so their notices return to draft.
   */
  async runLadder(companyId: string): Promise<{ fired: number; skipped: number }> {
    let fired = 0;
    let skipped = 0;
    const ids = await withCompany(this.database, this.ctx(companyId), async (tx) => {
      await this.returnClosedApprovals(tx);
      const rows = await tx
        .select({ id: schema.notice.id })
        .from(schema.notice)
        .where(
          and(
            inArray(schema.notice.status, LIVE),
            eq(schema.notice.ladderPaused, false),
            eq(schema.notice.ladderCancelled, false),
          ),
        );
      return rows.map((r) => r.id);
    });
    // Each notice in its own transaction, so one that fails never stops the rest (review note).
    // The failures are raised together at the end, so the job retries and then alerts.
    const failures: unknown[] = [];
    for (const noticeId of ids) {
      try {
        const counts = await withCompany(this.database, this.ctx(companyId), (tx) =>
          this.ladderFor(tx, noticeId),
        );
        fired += counts.fired;
        skipped += counts.skipped;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        `The notice ladder failed for ${failures.length} of ${ids.length} notices`,
      );
    return { fired, skipped };
  }

  private async ladderFor(tx: Tx, noticeId: string): Promise<{ fired: number; skipped: number }> {
    const notice = await noticeRow(tx, noticeId, true);
    if (!notice.issuedAt || !LIVE.includes(notice.status)) return { fired: 0, skipped: 0 };
    const company = await companyFacts(tx, notice.companyId);
    const settings = noticeSettingsOf(company.settings);
    const recipients = await recipientsOf(tx, notice.id);
    const events = await eventsOf(tx, notice.id);
    const progress = progressOf(notice, recipients, events);
    const signers = new Map(
      (await this.esign.noticeRequests(tx, notice.id)).flatMap((r) =>
        r.signers.map((s) => [s.id, s] as const),
      ),
    );
    const done = new Set(events.flatMap((e) => (e.dedupeKey ? [e.dedupeKey] : [])));
    const now = this.clock.now();
    const due = dueLadderSteps({
      issuedAt: notice.issuedAt,
      now,
      status: notice.status as NoticeStatus,
      flags: { paused: notice.ladderPaused, cancelled: notice.ladderCancelled },
      steps: (notice.ladder as NoticeLadderStep[] | null) ?? [],
      recipients: recipients.map((r) => ({
        recipientId: r.id,
        party: partyKeyOf(r),
        signed:
          progress.recipients.find((p) => p.recipientId === r.id)?.signed === true ||
          (r.signerId ? signers.get(r.signerId)?.status === 'signed' : false),
        doneSteps: new Set(
          [...done]
            .filter((k) => k.startsWith(`ladder:${r.id}:`))
            .map((k) => k.slice(`ladder:${r.id}:`.length)),
        ),
      })),
      completion: notice.completion as 'any_one' | 'each',
      timeZone: company.timeZone,
      window: settings.sendWindow,
      linksExpireAt: notice.linkExpiresAt,
      shiftSeconds: notice.ladderShiftSeconds,
    });
    let fired = 0;
    let skipped = 0;
    for (const d of due) {
      const recipient = recipients.find((r) => r.id === d.recipientId)!;
      // Review MF-6: a reminder is recorded as sent only when a message goes to this recipient.
      const reminder = d.decision === 'fire' && d.step.action === 'reminder';
      const channels = reminder ? reminderChannels(recipient, d.step) : [];
      const unsendable = reminder && (!recipient.signerId || channels.length === 0);
      const kind =
        d.decision === 'skip'
          ? 'step_skipped'
          : d.step.action === 'reminder'
            ? unsendable
              ? 'reminder_not_sent'
              : 'reminded'
            : d.step.action === 'manager_alert'
              ? 'manager_alerted'
              : d.step.action === 'caretaker_task'
                ? 'task_created'
                : 'escalation_requested';
      const first = await recordEvent(tx, notice, {
        kind,
        at: now,
        recipient,
        data: {
          step: d.step.key,
          dueAt: d.dueAt.toISOString(),
          ...(unsendable ? { reason: recipient.signerId ? 'no_channel' : 'no_signer' } : {}),
        },
        dedupeKey: `ladder:${recipient.id}:${d.step.key}`,
      });
      if (!first) continue;
      if (d.decision === 'skip' || unsendable) {
        skipped += 1;
        continue;
      }
      fired += 1;
      await this.runStep(tx, notice, recipient, d.step, now);
    }
    await syncStatus(tx, await noticeRow(tx, noticeId), now);
    return { fired, skipped };
  }

  private async runStep(
    tx: Tx,
    notice: NoticeRow,
    recipient: RecipientRow,
    step: NoticeLadderStep,
    now: Date,
  ) {
    const company = await companyFacts(tx, notice.companyId);
    const number = numberOf(notice)!;
    const title = NOTICE_TYPE_LABELS[notice.type as NoticeType];
    switch (step.action) {
      case 'reminder': {
        const planned = reminderChannels(recipient, step);
        if (!recipient.signerId || planned.length === 0) return;
        const body = step.statesRemainsInForce
          ? `A reminder from ${company.senderName}: notice ${number} (${title}) remains in force whether or not you sign it. Read it at {{link}}.`
          : `A reminder from ${company.senderName}: notice ${number} (${title}) is waiting for you at {{link}}. Please open it and confirm you received it.`;
        await queueMessageOnEachChannel(
          tx,
          notice.companyId,
          {
            recipient: { type: 'signer', signerId: recipient.signerId },
            purpose: step.statesRemainsInForce ? 'notice_in_force' : 'notice_reminder',
            subject: `Reminder: notice ${number} from ${company.senderName}`,
            body,
            link: { purpose: 'sign', targetId: recipient.signerId },
            propertyId: notice.propertyId,
            related: { type: 'notice_recipient', id: recipient.id },
            requestedBy: null,
          },
          planned.map((c) => ({ channel: c.channel, serviceClause: c.mode === 'service' })),
        );
        return;
      }
      case 'manager_alert': {
        // Review S8: the property's managers in scope, not whoever drafted the notice.
        for (const personId of await this.tasks.managersFor(
          tx,
          notice.companyId,
          notice.propertyId,
        ))
          await queueMessage(tx, notice.companyId, {
            recipient: { type: 'staff', personId },
            purpose: 'staff_notice',
            subject: `Not yet acknowledged: notice ${number}`,
            body: `${recipient.name} has not acknowledged notice ${number} (${title}) after ${Math.floor(step.afterHours / 24)} days. A task asks the caretaker to remind them in person; the notice escalates to physical service if it stays unsigned.`,
            channels: ['email'],
            propertyId: notice.propertyId,
            related: { type: 'notice', id: notice.id },
          });
        return;
      }
      case 'caretaker_task': {
        await this.tasks.create(tx, {
          companyId: notice.companyId,
          propertyId: notice.propertyId,
          unitId: recipient.unitId,
          tenantId: recipient.tenantId,
          kind: 'notice_in_person_reminder',
          title: `Remind ${recipient.name} in person about notice ${number}`,
          noticeId: notice.id,
          recipientId: recipient.id,
          assigneePersonId: await this.tasks.assigneeFor(tx, notice.companyId, notice.propertyId),
          dueAt: new Date(now.getTime() + 24 * HOUR),
          dedupeKey: `notice:${notice.id}:in_person:${recipient.id}`,
          createdBy: null,
        });
        return;
      }
      case 'escalate':
        await enqueueOutbox(tx, {
          companyId: notice.companyId,
          type: NOTICE_ESCALATE_JOB,
          payload: { noticeId: notice.id },
          idempotencyKey: `${NOTICE_ESCALATE_JOB}:${notice.id}`,
        });
        return;
    }
  }

  /**
   * `notices.escalate` (plan 4.7; keyed by notice): the notice becomes Escalated, its physical
   * service pack is rendered (the frozen notice appended once it is ready), and a task asks for it
   * to be served. Throws while the frozen PDF is still rendering, so the job retries.
   */
  async escalate(companyId: string, noticeId: string): Promise<void> {
    await withCompany(this.database, this.ctx(companyId), async (tx) => {
      const notice = await noticeRow(tx, noticeId, true);
      if (!LIVE.includes(notice.status)) return;
      // Review S4: a cancelled ladder never escalates; a paused one escalates when it resumes
      // (controlLadder asks again).
      if (notice.ladderCancelled || notice.ladderPaused) return;
      const now = this.clock.now();
      const events = await eventsOf(tx, noticeId);
      const progress = progressOf(notice, await recipientsOf(tx, noticeId), events);
      if (progress.signed) return;
      // Review S7: a notice already served in person needs no physical service.
      if (await this.servedInPerson(tx, notice)) {
        await recordEvent(tx, notice, {
          kind: 'step_skipped',
          at: now,
          data: { step: 'escalate', reason: 'served_in_person' },
          dedupeKey: `escalated:${notice.id}`,
        });
        return;
      }
      if (!notice.documentSha256)
        throw new Error('The notice is still rendering; escalation waits for it');
      const first = await recordEvent(tx, notice, {
        kind: 'escalated',
        at: now,
        data: { servicePack: true },
        dedupeKey: `escalated:${notice.id}`,
      });
      if (!first) return;
      const company = await companyFacts(tx, companyId);
      const recipients = (await recipientsOf(tx, noticeId)).filter(
        (r) => !progress.recipients.find((p) => p.recipientId === r.id)?.acknowledged,
      );
      const units = await this.unitCodes(tx, recipients);
      const content = servicePackContent({
        title: NOTICE_TYPE_LABELS[notice.type as NoticeType],
        number: numberOf(notice)!,
        issueDate: notice.issueDate!,
        landlordName: company.displayName,
        propertyName: await this.propertyName(tx, notice.propertyId),
        premises: notice.unitId ? (units.get(notice.unitId) ?? '') : '',
        recipients: recipients.map((r) => ({
          name: r.name,
          premises: r.unitId ? (units.get(r.unitId) ?? '') : '',
        })),
        noticeSha256: notice.documentSha256,
      });
      if (!notice.servicePackRenderRequestId) {
        const renderRequestId = await this.documents.requestRender(tx, {
          companyId,
          templateKey: SERVICE_PACK_TEMPLATE.key,
          templateVersion: SERVICE_PACK_TEMPLATE.version,
          data: content as unknown as Record<string, unknown>,
          requestedBy: null,
        });
        await tx
          .update(schema.notice)
          .set({ servicePackRenderRequestId: renderRequestId, updatedAt: now })
          .where(eq(schema.notice.id, noticeId));
      }
      // Review S7: one physical-service task is enough; the one planned at issue may be open.
      if (!(await this.tasks.hasOpen(tx, noticeId, 'notice_physical_service')))
        await this.tasks.create(tx, {
          companyId,
          propertyId: notice.propertyId,
          unitId: notice.unitId,
          tenantId: notice.tenantId,
          kind: 'notice_physical_service',
          title: `Serve notice ${numberOf(notice)} in person (escalated)`,
          noticeId,
          recipientId: null,
          assigneePersonId: await this.tasks.assigneeFor(tx, companyId, notice.propertyId),
          dueAt: new Date(now.getTime() + 48 * HOUR),
          dedupeKey: `notice:${noticeId}:escalation_service`,
          createdBy: null,
        });
      // Review S8: the property's managers in scope.
      for (const personId of await this.tasks.managersFor(tx, companyId, notice.propertyId))
        await queueMessage(tx, companyId, {
          recipient: { type: 'staff', personId },
          purpose: 'staff_notice',
          subject: `Escalated to physical service: notice ${numberOf(notice)}`,
          body: `Notice ${numberOf(notice)} (${NOTICE_TYPE_LABELS[notice.type as NoticeType]}) has not been acknowledged and is escalated to physical service. Its service pack is on the notice; record how, when and by whom it is served.`,
          channels: ['email'],
          propertyId: notice.propertyId,
          related: { type: 'notice', id: noticeId },
        });
      await syncStatus(tx, await noticeRow(tx, noticeId), now);
    });
  }

  /** The rendered cover and affidavit, with the frozen notice appended unchanged (plan 4.7). */
  private async assembleServicePack(
    companyId: string,
    noticeId: string,
    coverDocumentId: string,
  ): Promise<boolean> {
    const loaded = await withCompany(this.database, this.ctx(companyId), async (tx) => {
      const notice = await noticeRow(tx, noticeId);
      if (notice.servicePackDocumentId || !notice.documentId) return null;
      return { notice, company: await companyFacts(tx, companyId) };
    });
    if (!loaded) return false;
    const cover = await this.documents.documentFile(companyId, coverDocumentId);
    const frozen = await this.documents.documentFile(companyId, loaded.notice.documentId!);
    if (!cover?.intact || !frozen?.intact || frozen.sha256 !== loaded.notice.documentSha256)
      throw new Error('A document of the service pack no longer matches its fingerprint');
    const bytes = Buffer.from(await appendPdfPages(cover.bytes, frozen.bytes));
    const file = await this.documents.storeWriteOnce({
      companyId,
      countryCode: loaded.company.countryCode,
      key: `documents/${companyId}/notices/${noticeId}/service-pack-${uuidv7()}.pdf`,
      bytes,
      contentType: 'application/pdf',
    });
    return withCompany(this.database, this.ctx(companyId), async (tx) => {
      const notice = await noticeRow(tx, noticeId, true);
      if (notice.servicePackDocumentId) return false;
      const documentId = await this.documents.recordWriteOnce(tx, file, {
        kind: 'notice_service_pack',
        templateKey: SERVICE_PACK_TEMPLATE.key,
        templateVersion: SERVICE_PACK_TEMPLATE.version,
        createdBy: null,
      });
      const now = this.clock.now();
      await tx
        .update(schema.notice)
        .set({ servicePackDocumentId: documentId, updatedAt: now })
        .where(eq(schema.notice.id, noticeId));
      await recordEvent(tx, notice, {
        kind: 'service_pack_ready',
        at: now,
        data: { documentId, sha256: file.sha256 },
        dedupeKey: `service_pack_ready:${noticeId}`,
      });
      return true;
    });
  }

  /**
   * Notices whose approval closed without approving come back to draft (rejected, expired or
   * withdrawn). Each is locked and checked again (review S11): a notice resubmitted meanwhile, or
   * already returned by a write, is left alone, so no event is recorded twice.
   */
  private async returnClosedApprovals(tx: Tx): Promise<void> {
    const waiting = await tx
      .select({ id: schema.notice.id, approvalRequestId: schema.notice.approvalRequestId })
      .from(schema.notice)
      .where(
        and(
          eq(schema.notice.status, 'pending_approval'),
          sql`${schema.notice.approvalRequestId} is not null`,
        ),
      );
    if (waiting.length === 0) return;
    const requests = await this.approvals.requestsIn(
      tx,
      waiting.map((n) => n.approvalRequestId!),
    );
    const now = this.clock.now();
    for (const candidate of waiting) {
      const status = requests.get(candidate.approvalRequestId!)?.status;
      if (!status || status === 'pending' || status === 'cooling_off' || status === 'approved')
        continue;
      const notice = await noticeRow(tx, candidate.id, true);
      if (
        notice.status !== 'pending_approval' ||
        notice.approvalRequestId !== candidate.approvalRequestId
      )
        continue;
      const returned = returnedForApproval(status);
      await recordEvent(tx, notice, {
        kind: 'returned_to_draft',
        at: now,
        data: {
          code: returned.code,
          reason: returned.message,
          approvalRequestId: candidate.approvalRequestId,
        },
        dedupeKey: `returned:${candidate.approvalRequestId}`,
      });
      await tx
        .update(schema.notice)
        .set({
          status: 'draft',
          approvalRequestId: null,
          returnedReason: returned.message,
          updatedAt: now,
        })
        .where(eq(schema.notice.id, notice.id));
    }
  }

  /**
   * Served in person on every party (review S7): handed over, or left with an adult at the
   * premises, and not corrected since. Posting on the premises (decision 10, every notice to quit)
   * and post or courier do not count: the escalation still serves those in person.
   */
  private async servedInPerson(tx: Tx, notice: NoticeRow): Promise<boolean> {
    const records = await tx
      .select({
        id: schema.serviceRecord.id,
        method: schema.serviceRecord.method,
        recipientId: schema.serviceRecord.recipientId,
        correctsRecordId: schema.serviceRecord.correctsRecordId,
      })
      .from(schema.serviceRecord)
      .where(eq(schema.serviceRecord.noticeId, notice.id));
    const corrected = new Set(
      records.flatMap((r) => (r.correctsRecordId ? [r.correctsRecordId] : [])),
    );
    const live = records.filter(
      (r) =>
        !corrected.has(r.id) &&
        (r.method === 'handed_to_tenant' || r.method === 'left_with_adult_occupant'),
    );
    if (live.length === 0) return false;
    // A record for the premises as a whole serves everyone on it.
    if (live.some((r) => r.recipientId === null)) return true;
    const recipients = await recipientsOf(tx, notice.id);
    const servedParties = new Set(
      live.flatMap((r) => {
        const recipient = recipients.find((x) => x.id === r.recipientId);
        return recipient ? [partyKeyOf(recipient)] : [];
      }),
    );
    return recipients.every((r) => servedParties.has(partyKeyOf(r)));
  }

  private async unitCodes(
    tx: Tx,
    recipients: readonly RecipientRow[],
  ): Promise<Map<string, string>> {
    const ids = [...new Set(recipients.flatMap((r) => (r.unitId ? [r.unitId] : [])))];
    if (ids.length === 0) return new Map();
    const rows = await tx
      .select({ id: schema.unit.id, code: schema.unit.code })
      .from(schema.unit)
      .where(inArray(schema.unit.id, ids));
    return new Map(rows.map((r) => [r.id, r.code]));
  }

  private async propertyName(tx: Tx, propertyId: string): Promise<string> {
    const [row] = await tx
      .select({ name: schema.property.name })
      .from(schema.property)
      .where(eq(schema.property.id, propertyId));
    return row?.name ?? '';
  }
}

/** The channels a reminder step may use for a recipient: planned at issue, and not withheld. */
function reminderChannels(recipient: RecipientRow, step: NoticeLadderStep): ChannelPlanRow[] {
  return (recipient.channels as ChannelPlanRow[]).filter(
    (c) => c.mode !== 'withheld' && step.channels.includes(c.channel),
  );
}
