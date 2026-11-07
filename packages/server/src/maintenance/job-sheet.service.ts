import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  schema,
  sql,
  withCompany,
  withSystem,
  type Database,
  type Tx,
} from '@rent/db';
import { SIGNING_CODE, SIGNING_LIMITS } from '@rent/domain/esign';
import {
  formatTicketNumber,
  type MaintenanceCategory,
  type MaintenanceJobStatus,
  type MaintenancePriority,
} from '@rent/domain/maintenance';
import { maskPhone } from '@rent/domain/phone';
import type { SmsPort } from '@rent/integrations';
import { v7 as uuidv7 } from 'uuid';
import type { Clock } from '../core/clock';
import type { AppConfig } from '../core/config';
import { maintenanceCheckConflict } from '../core/db-errors';
import { AppError, conflict, invalid, notFound } from '../core/errors';
import { consumeRateLimit, type RateLimit } from '../core/rate-limit';
import { CLOCK, CONFIG, DATABASE, SMS_PORT } from '../core/tokens';
import {
  DocumentsService,
  JOB_MEDIA_UPLOAD,
  type StagedMedia,
} from '../documents/documents.service';
import { newCode, newToken, SigningHasher, tokenHash, TOKEN_PATTERN } from '../esign/secrets';
import { MaintenanceService } from './maintenance.service';
import { ARTISAN_KIND } from './kinds';

/** A job sheet works until the job closes, or 30 days (decision 6). */
export const JOB_SHEET_LINK_DAYS = 30;
const MINUTE = 60_000;

export interface ClientInfo {
  readonly ip: string;
  readonly userAgent: string;
}

type LinkRow = typeof schema.secureLink.$inferSelect;
type JobRow = typeof schema.maintenanceJob.$inferSelect;

export interface JobSheetView {
  readonly screen: 'sheet' | 'done' | 'closed' | 'expired' | 'revoked';
  readonly ticket: string;
  readonly status: MaintenanceJobStatus;
  /** Null on a dead link (closed, expired or revoked). */
  readonly description: string | null;
  readonly category: MaintenanceCategory | null;
  readonly priority: MaintenancePriority | null;
  readonly property: { readonly name: string; readonly address: string | null };
  readonly unitCode: string | null;
  readonly contact: { readonly name: string; readonly phone: string | null } | null;
  readonly artisan: { readonly name: string; readonly response: 'accepted' | 'declined' | null };
  readonly visitAt: Date | null;
  /** F1: the report's photos and videos only. */
  readonly attachments: readonly {
    readonly id: string;
    readonly kind: 'image' | 'video';
    readonly stage: 'report';
    readonly contentType: string;
  }[];
  readonly timeZone: string;
  readonly linkExpiresAt: Date;
  readonly actions: {
    readonly accept: boolean;
    readonly decline: boolean;
    readonly start: boolean;
    readonly complete: boolean;
  };
  readonly code: {
    readonly destinationMasked: string;
    readonly sentAt: Date | null;
    readonly expiresAt: Date | null;
    readonly attemptsLeft: number;
    readonly sendsLeft: number;
    readonly lockedUntil: Date | null;
  } | null;
}

/** F1: what the job sheet shows of the job's files, the report's photos and videos. */
const SHEET_FILE_STAGE = 'report';
const SHEET_FILE_KINDS = ['image', 'video'] as const;
/** A link that shows only the closed screen's facts and serves nothing. */
const DEAD_SCREENS: readonly JobSheetView['screen'][] = ['closed', 'expired', 'revoked'];

const codeLocked = (until: Date) =>
  new AppError(
    429,
    'code_locked',
    'Too many wrong codes. Try again in 30 minutes, or ask the property contact.',
    { lockedUntil: until.toISOString() },
  );

const tooMany = () =>
  new AppError(429, 'too_many_requests', 'Too many tries. Wait a few minutes and try again.');

/**
 * The artisan's job sheet (MI-04; decision 6; apps/links /j/[token]): a secure link for one
 * artisan and one job. It shows the unit, the description, the tenant's photos and the property
 * contact's phone, never the tenant's own phone or anything else about them. The artisan accepts or
 * declines, records the start with a before photo, and sends the completion with after photos, a
 * note and a one-time code to their phone (M3's code rules). The link works until the job closes,
 * is unassigned, or 30 days pass.
 */
@Injectable()
export class JobSheetService {
  private readonly hasher: SigningHasher;

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SMS_PORT) private readonly sms: SmsPort,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(MaintenanceService) private readonly maintenance: MaintenanceService,
  ) {
    this.hasher = new SigningHasher(config.BETTER_AUTH_SECRET);
  }

  // The link messages carry (messaging's `job_sheet` link resolver) -----------------------------

  /**
   * Mints the job's sheet link at send time for the artisan the message is addressed to, while the
   * job is still theirs; only its hash is stored.
   */
  async messageLinkUrl(companyId: string, jobId: string, messageId: string): Promise<string> {
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const job = await this.maintenance.lockJob(tx, jobId);
      const [message] = await tx
        .select({ artisanId: schema.message.artisanId })
        .from(schema.message)
        .where(eq(schema.message.id, messageId));
      const artisanId = message?.artisanId ?? null;
      if (!artisanId || job.assigneeKind !== ARTISAN_KIND || job.assigneeArtisanId !== artisanId)
        throw conflict('job_sheet_unassigned', 'The job is no longer with this artisan');
      if (job.status === 'closed' || job.status === 'cancelled')
        throw conflict('maintenance_closed', 'The job is closed');
      const token = newToken();
      const now = this.clock.now();
      await tx.insert(schema.secureLink).values({
        companyId,
        propertyId: job.propertyId,
        purpose: 'job_sheet',
        tokenHash: tokenHash(token),
        jobId: job.id,
        artisanId,
        messageId,
        expiresAt: new Date(now.getTime() + JOB_SHEET_LINK_DAYS * 24 * 60 * MINUTE),
        createdAt: now,
      });
      return `${this.config.LINKS_ORIGIN}/j/${token}`;
    });
  }

  /**
   * The message was sent: the same artisan's earlier links for the job stop working. Another
   * artisan's link is never touched, nor a newer link of this artisan's (an older message that
   * sends late supersedes nothing).
   */
  async messageLinkSent(tx: Tx, jobId: string, messageId: string): Promise<void> {
    const [sent] = await tx
      .select({ artisanId: schema.secureLink.artisanId, createdAt: schema.secureLink.createdAt })
      .from(schema.secureLink)
      .where(
        and(
          eq(schema.secureLink.jobId, jobId),
          eq(schema.secureLink.purpose, 'job_sheet'),
          eq(schema.secureLink.messageId, messageId),
        ),
      )
      .orderBy(desc(schema.secureLink.createdAt))
      .limit(1);
    if (!sent?.artisanId) return;
    await tx
      .update(schema.secureLink)
      .set({ revokedAt: this.clock.now(), revokeReason: 'superseded' })
      .where(
        and(
          eq(schema.secureLink.jobId, jobId),
          eq(schema.secureLink.purpose, 'job_sheet'),
          eq(schema.secureLink.artisanId, sent.artisanId),
          sql`${schema.secureLink.revokedAt} is null`,
          sql`${schema.secureLink.messageId} is distinct from ${messageId}`,
          sql`${schema.secureLink.createdAt} < ${sent.createdAt}`,
        ),
      );
  }

  /** The message was not sent: its link reached nobody and is withdrawn. */
  async messageLinkNotSent(tx: Tx, jobId: string, messageId: string): Promise<void> {
    await tx
      .update(schema.secureLink)
      .set({ revokedAt: this.clock.now(), revokeReason: 'not_delivered' })
      .where(
        and(
          eq(schema.secureLink.jobId, jobId),
          eq(schema.secureLink.messageId, messageId),
          sql`${schema.secureLink.revokedAt} is null`,
        ),
      );
  }

  // The page (apps/links) ------------------------------------------------------------------------

  async open(token: string, client: ClientInfo): Promise<JobSheetView> {
    await this.limit('open', client, SIGNING_LIMITS.opensPerIp);
    const { companyId, linkId } = await this.resolve(token);
    if (!(await this.hit(`jobsheet:open:link:${linkId}`, SIGNING_LIMITS.opensPerLink)))
      throw tooMany();
    return withCompany(this.database, this.context(companyId), async (tx) => {
      const { link, job } = await this.rows(tx, linkId);
      const now = this.clock.now();
      await tx
        .update(schema.secureLink)
        .set({
          firstOpenedAt: link.firstOpenedAt ?? now,
          firstOpenIp: link.firstOpenIp ?? client.ip.slice(0, 64),
          firstOpenUserAgent: link.firstOpenUserAgent ?? client.userAgent.slice(0, 500),
          lastOpenedAt: now,
          openCount: link.openCount + 1,
        })
        .where(eq(schema.secureLink.id, link.id));
      return this.view(tx, link, job);
    });
  }

  async respond(
    token: string,
    client: ClientInfo,
    input: { response: 'accepted' | 'declined'; reason?: string | null },
  ): Promise<JobSheetView> {
    await this.limit('action', client, SIGNING_LIMITS.actionsPerIp);
    const { companyId, linkId } = await this.resolve(token);
    return this.act(companyId, linkId, async (tx, link, job, now) => {
      if (job.status !== 'assigned' || job.artisanResponse !== null)
        throw conflict('job_sheet_answered', 'This job has already been answered');
      const actor = { kind: 'artisan' as const, artisanId: link.artisanId! };
      const name = await this.artisanName(tx, link.artisanId!);
      if (input.response === 'accepted') {
        await tx
          .update(schema.maintenanceJob)
          .set({ artisanResponse: 'accepted', updatedAt: now })
          .where(eq(schema.maintenanceJob.id, job.id));
        await this.maintenance.event(tx, job, 'accepted', actor, { assigneeName: name });
        return;
      }
      // A decline sends the job back to triage for someone else (plan 4.2).
      this.maintenance.move(job, 'unassign');
      await tx
        .update(schema.maintenanceJob)
        .set({
          status: 'triaged',
          assigneeKind: null,
          assigneeArtisanId: null,
          artisanResponse: null,
          updatedAt: now,
        })
        .where(eq(schema.maintenanceJob.id, job.id));
      await this.maintenance.event(tx, job, 'declined', actor, {
        assigneeName: name,
        ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
      });
      await this.maintenance.revokeSheets(tx, job.id, now, 'declined');
    });
  }

  async createUpload(
    token: string,
    client: ClientInfo,
    declared: { contentType: string; sizeBytes: number; durationSeconds?: number | null },
  ) {
    await this.limit('action', client, SIGNING_LIMITS.actionsPerIp);
    const { companyId, linkId } = await this.resolve(token);
    const { link } = await withCompany(this.database, this.context(companyId), (tx) =>
      this.rows(tx, linkId, true),
    );
    return this.documents.createMediaUpload(
      { companyId, personId: null, actorKind: 'system' },
      link.artisanId!,
      JOB_MEDIA_UPLOAD,
      declared,
    );
  }

  async start(
    token: string,
    client: ClientInfo,
    input: { uploadIds: readonly string[]; beforePhotoReason?: string | null },
  ): Promise<JobSheetView> {
    await this.limit('action', client, SIGNING_LIMITS.actionsPerIp);
    const { companyId, linkId } = await this.resolve(token);
    // The state first: staged files are kept write-once, so nothing is staged for a refused step.
    await this.expect(companyId, linkId, (job) => {
      if (job.artisanResponse !== 'accepted')
        throw conflict('job_sheet_not_accepted', 'Accept the job before starting it');
      if (job.status !== 'assigned')
        throw conflict('maintenance_transition', 'This job has already started');
    });
    const media = await this.stage(companyId, linkId, input.uploadIds);
    return this.act(
      companyId,
      linkId,
      async (tx, link, job, now) => {
        if (job.artisanResponse !== 'accepted')
          throw conflict('job_sheet_not_accepted', 'Accept the job before starting it');
        await this.maintenance.startWork(
          tx,
          job,
          media,
          input.beforePhotoReason ?? null,
          { kind: 'artisan', artisanId: link.artisanId! },
          now,
        );
      },
      media,
    );
  }

  /** A one-time code for the completion, to the artisan's phone on record only. */
  async sendCode(
    token: string,
    client: ClientInfo,
  ): Promise<{ destinationMasked: string; expiresAt: Date; sendsLeft: number }> {
    await this.limit('code', client, SIGNING_LIMITS.codeSendsPerIp);
    const { companyId, linkId } = await this.resolve(token);
    const prepared = await withCompany(this.database, this.context(companyId), async (tx) => {
      // The link row is locked, so two sends at once are counted one after the other.
      const { link, job } = await this.rows(tx, linkId, true, true);
      if (job.status !== 'in_progress')
        throw conflict('job_sheet_not_started', 'A code is sent once the work has started');
      const now = this.clock.now();
      if (link.codeLockedUntil && link.codeLockedUntil > now)
        throw codeLocked(link.codeLockedUntil);
      const since = new Date(
        now.getTime() - SIGNING_LIMITS.codeSendsPerLink.windowMinutes * MINUTE,
      );
      const sent = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.jobSheetCode)
        .where(
          and(
            eq(schema.jobSheetCode.secureLinkId, link.id),
            gte(schema.jobSheetCode.createdAt, since),
          ),
        );
      const perLink = Number(sent[0]?.n ?? 0);
      if (perLink >= SIGNING_LIMITS.codeSendsPerLink.count)
        throw new AppError(
          429,
          'code_limit',
          'We have sent you 3 codes in the last 15 minutes. Wait a few minutes before asking for another.',
        );
      const [artisan] = await tx
        .select()
        .from(schema.artisan)
        .where(eq(schema.artisan.id, link.artisanId!));
      if (!artisan) throw notFound('Link');
      const destinationHash = this.hasher.destination(artisan.phone);
      if (
        !(await this.hit(
          `jobsheet:code:destination:${destinationHash}`,
          SIGNING_LIMITS.codeSendsPerDestination,
        ))
      )
        throw new AppError(
          429,
          'code_limit',
          'Too many codes went to this phone recently. Wait a few minutes and try again.',
        );
      if (artisan.isTestContact && this.config.NODE_ENV === 'production')
        throw new AppError(422, 'code_not_sent', 'Codes are not sent to test contacts');
      const code = newCode();
      const challengeId = uuidv7();
      const expiresAt = new Date(now.getTime() + SIGNING_CODE.validMinutes * MINUTE);
      await tx.insert(schema.jobSheetCode).values({
        id: challengeId,
        companyId,
        propertyId: job.propertyId,
        jobId: job.id,
        artisanId: artisan.id,
        secureLinkId: link.id,
        channel: 'sms',
        destinationMasked: maskPhone(artisan.phone),
        destinationHash,
        codeHash: this.hasher.code(challengeId, code),
        expiresAt,
        maxAttempts: SIGNING_CODE.maxAttempts,
        createdAt: now,
      });
      const facts = await this.maintenance.jobFacts(tx, job);
      return {
        code,
        challengeId,
        phone: artisan.phone,
        masked: maskPhone(artisan.phone),
        sender: facts.companyName,
        expiresAt,
        sendsLeft: SIGNING_LIMITS.codeSendsPerLink.count - perLink - 1,
      };
    });
    // Straight to the port, outside any transaction: the code is never stored in plain text.
    try {
      await this.sms.send({
        to: prepared.phone,
        body: `${prepared.code} is your code to complete the job for ${prepared.sender}. It expires in ${SIGNING_CODE.validMinutes} minutes. Never share it.`,
        reference: prepared.challengeId,
      });
    } catch {
      throw new AppError(
        502,
        'code_not_sent',
        'We could not send your code just now. Wait a minute and try again.',
      );
    }
    return {
      destinationMasked: prepared.masked,
      expiresAt: prepared.expiresAt,
      sendsLeft: prepared.sendsLeft,
    };
  }

  async complete(
    token: string,
    client: ClientInfo,
    input: { code: string; uploadIds: readonly string[]; completionNote: string },
  ): Promise<JobSheetView> {
    await this.limit('action', client, SIGNING_LIMITS.actionsPerIp);
    const { companyId, linkId } = await this.resolve(token);
    await this.expect(companyId, linkId, (job) => {
      if (job.status !== 'in_progress')
        throw conflict('job_sheet_not_started', 'Start the work before sending the completion');
    });
    // The code next, in its own transaction, so a wrong code's attempt is recorded; files are
    // staged only once it is right.
    await this.checkCode(companyId, linkId, input.code);
    const media = await this.stage(companyId, linkId, input.uploadIds);
    return this.act(
      companyId,
      linkId,
      async (tx, link, job, now) => {
        const consumed = await tx
          .update(schema.jobSheetCode)
          .set({ consumedAt: now })
          .where(
            and(
              eq(schema.jobSheetCode.secureLinkId, link.id),
              sql`${schema.jobSheetCode.consumedAt} is null`,
              sql`${schema.jobSheetCode.expiresAt} > ${now}`,
            ),
          )
          .returning({ id: schema.jobSheetCode.id });
        if (consumed.length === 0)
          throw invalid('code_expired', 'Ask for a new code and try again');
        await this.maintenance.completeWork(
          tx,
          job,
          media,
          input.completionNote,
          { kind: 'artisan', artisanId: link.artisanId! },
          now,
        );
      },
      media,
    );
  }

  async attachmentUrl(token: string, client: ClientInfo, attachmentId: string) {
    await this.limit('open', client, SIGNING_LIMITS.opensPerIp);
    const { companyId, linkId } = await this.resolve(token);
    const documentId = await withCompany(this.database, this.context(companyId), async (tx) => {
      const { link, job } = await this.rows(tx, linkId);
      // A dead link serves nothing (M8 review); a live one only the files it lists (F1).
      if (DEAD_SCREENS.includes(this.screen(link, job))) return null;
      const [row] = await tx
        .select({ documentId: schema.maintenanceJobAttachment.documentId })
        .from(schema.maintenanceJobAttachment)
        .where(
          and(
            eq(schema.maintenanceJobAttachment.id, attachmentId),
            eq(schema.maintenanceJobAttachment.jobId, job.id),
            eq(schema.maintenanceJobAttachment.stage, SHEET_FILE_STAGE),
            inArray(schema.maintenanceJobAttachment.kind, [...SHEET_FILE_KINDS]),
          ),
        );
      return row?.documentId ?? null;
    });
    const url = documentId ? await this.documents.downloadUrl(companyId, documentId) : null;
    if (!url) throw notFound('File');
    return { url };
  }

  // Internals -------------------------------------------------------------------------------------

  private async checkCode(companyId: string, linkId: string, code: string): Promise<void> {
    const result = await withCompany(this.database, this.context(companyId), async (tx) => {
      const { link } = await this.rows(tx, linkId, true, true);
      const now = this.clock.now();
      if (link.codeLockedUntil && link.codeLockedUntil > now)
        return { refused: codeLocked(link.codeLockedUntil) };
      const [challenge] = await tx
        .select()
        .from(schema.jobSheetCode)
        .where(
          and(
            eq(schema.jobSheetCode.secureLinkId, link.id),
            sql`${schema.jobSheetCode.consumedAt} is null`,
          ),
        )
        .orderBy(desc(schema.jobSheetCode.createdAt))
        .limit(1)
        .for('update');
      if (!challenge || challenge.expiresAt <= now)
        return { refused: invalid('code_expired', 'Ask for a new code and try again') };
      if (
        /^\d{6}$/.test(code.trim()) &&
        this.hasher.codeMatches(challenge.id, code.trim(), challenge.codeHash)
      ) {
        if (link.failedCodeAttempts > 0)
          await tx
            .update(schema.secureLink)
            .set({ failedCodeAttempts: 0 })
            .where(eq(schema.secureLink.id, link.id));
        return { refused: null };
      }
      // Wrong codes count across every code the link was sent, as M3's signer lock (five lock
      // the link for 30 minutes); a new code does not reset them.
      const failed = link.failedCodeAttempts + 1;
      const lockedUntil =
        failed >= SIGNING_CODE.maxAttempts
          ? new Date(now.getTime() + SIGNING_CODE.lockMinutes * MINUTE)
          : null;
      await tx
        .update(schema.jobSheetCode)
        .set({ attempts: challenge.attempts + 1 })
        .where(eq(schema.jobSheetCode.id, challenge.id));
      await tx
        .update(schema.secureLink)
        .set({ failedCodeAttempts: lockedUntil ? 0 : failed, codeLockedUntil: lockedUntil })
        .where(eq(schema.secureLink.id, link.id));
      if (lockedUntil) return { refused: codeLocked(lockedUntil) };
      const left = SIGNING_CODE.maxAttempts - failed;
      return {
        refused: new AppError(
          400,
          'code_wrong',
          `That code is not right. You have ${left} ${left === 1 ? 'try' : 'tries'} left.`,
          { attemptsLeft: String(left) },
        ),
      };
    });
    if (result.refused) throw result.refused;
  }

  /** Refuses a step the job's state does not allow, before anything is staged. */
  private async expect(
    companyId: string,
    linkId: string,
    check: (job: JobRow) => void,
  ): Promise<void> {
    await withCompany(this.database, this.context(companyId), async (tx) => {
      const { job } = await this.rows(tx, linkId, true);
      check(job);
    });
  }

  private async act(
    companyId: string,
    linkId: string,
    fn: (tx: Tx, link: LinkRow, job: JobRow, now: Date) => Promise<void>,
    media: readonly StagedMedia[] = [],
  ): Promise<JobSheetView> {
    let view: JobSheetView;
    try {
      view = await withCompany(this.database, this.context(companyId), async (tx) => {
        const { link } = await this.rows(tx, linkId, true);
        const job = await this.maintenance.lockJob(tx, link.jobId!);
        await fn(tx, link, job, this.clock.now());
        const fresh = await this.rows(tx, linkId);
        return this.view(tx, fresh.link, fresh.job);
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw maintenanceCheckConflict(error) ?? error;
    }
    for (const m of media) await this.documents.discardStagedMedia(m);
    return view;
  }

  private async stage(companyId: string, linkId: string, uploadIds: readonly string[]) {
    if (uploadIds.length === 0) return [];
    const { link } = await withCompany(this.database, this.context(companyId), (tx) =>
      this.rows(tx, linkId, true),
    );
    const out: StagedMedia[] = [];
    for (const id of new Set(uploadIds))
      out.push(
        await this.documents.stageMediaUpload(
          { companyId, personId: null, actorKind: 'system' },
          link.artisanId!,
          id,
          JOB_MEDIA_UPLOAD,
        ),
      );
    return out;
  }

  /** The link and its job. `usable` refuses a link that no longer works; `lock` locks the link. */
  private async rows(tx: Tx, linkId: string, usable = false, lock = false) {
    const query = tx.select().from(schema.secureLink).where(eq(schema.secureLink.id, linkId));
    const [link] = lock ? await query.for('update') : await query;
    if (!link || link.purpose !== 'job_sheet' || !link.jobId || !link.artisanId)
      throw notFound('Link');
    const [job] = await tx
      .select()
      .from(schema.maintenanceJob)
      .where(eq(schema.maintenanceJob.id, link.jobId));
    if (!job) throw notFound('Link');
    if (usable) {
      const screen = this.screen(link, job);
      if (screen !== 'sheet')
        throw new AppError(
          410,
          `job_sheet_${screen}`,
          screen === 'expired'
            ? 'This link has expired. Ask the property contact for a new one.'
            : screen === 'revoked'
              ? 'This job is no longer assigned to you.'
              : 'This job is finished.',
        );
    }
    return { link, job };
  }

  private screen(link: LinkRow, job: JobRow): JobSheetView['screen'] {
    if (job.status === 'closed' || job.status === 'cancelled') return 'closed';
    if (link.revokedAt) return 'revoked';
    if (link.expiresAt <= this.clock.now()) return 'expired';
    if (job.assigneeArtisanId !== link.artisanId) return 'revoked';
    if (job.status === 'work_done') return 'done';
    return 'sheet';
  }

  private async view(tx: Tx, link: LinkRow, job: JobRow): Promise<JobSheetView> {
    const facts = await this.maintenance.jobFacts(tx, job);
    const [property] = await tx
      .select({ name: schema.property.name, address: schema.property.street })
      .from(schema.property)
      .where(eq(schema.property.id, job.propertyId));
    const contact = await this.contactFor(tx, job);
    const files = await tx
      .select({
        id: schema.maintenanceJobAttachment.id,
        kind: schema.maintenanceJobAttachment.kind,
        stage: schema.maintenanceJobAttachment.stage,
        contentType: schema.document.contentType,
      })
      .from(schema.maintenanceJobAttachment)
      .innerJoin(
        schema.document,
        and(
          eq(schema.document.companyId, schema.maintenanceJobAttachment.companyId),
          eq(schema.document.id, schema.maintenanceJobAttachment.documentId),
        ),
      )
      .where(
        and(
          eq(schema.maintenanceJobAttachment.jobId, job.id),
          eq(schema.maintenanceJobAttachment.stage, SHEET_FILE_STAGE),
          inArray(schema.maintenanceJobAttachment.kind, [...SHEET_FILE_KINDS]),
        ),
      );
    const [code] = await tx
      .select()
      .from(schema.jobSheetCode)
      .where(eq(schema.jobSheetCode.secureLinkId, link.id))
      .orderBy(desc(schema.jobSheetCode.createdAt))
      .limit(1);
    const screen = this.screen(link, job);
    const mine = screen === 'sheet';
    // A dead link shows only the closed screen's facts (M8 review).
    const dead = DEAD_SCREENS.includes(screen);
    const now = this.clock.now();
    const since = new Date(now.getTime() - SIGNING_LIMITS.codeSendsPerLink.windowMinutes * MINUTE);
    const recent = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.jobSheetCode)
      .where(
        and(
          eq(schema.jobSheetCode.secureLinkId, link.id),
          gte(schema.jobSheetCode.createdAt, since),
        ),
      );
    const [artisan] = await tx
      .select({ name: schema.artisan.name, phone: schema.artisan.phone })
      .from(schema.artisan)
      .where(eq(schema.artisan.id, link.artisanId!));
    return {
      screen,
      ticket: formatTicketNumber(job.ticketNumber),
      status: job.status as MaintenanceJobStatus,
      description: dead ? null : job.description,
      category: job.category as MaintenanceCategory | null,
      priority: job.priority as MaintenancePriority | null,
      property: {
        name: property?.name ?? facts.propertyName,
        address: dead ? null : (property?.address ?? null),
      },
      unitCode: facts.unitCode,
      contact: dead ? null : contact,
      artisan: {
        name: artisan?.name ?? '',
        response: job.artisanResponse as 'accepted' | 'declined' | null,
      },
      visitAt: dead ? null : job.visitAt,
      attachments: dead
        ? []
        : files.map((f) => ({
            id: f.id,
            kind: f.kind as 'image' | 'video',
            stage: SHEET_FILE_STAGE,
            contentType: f.contentType,
          })),
      timeZone: facts.timeZone,
      linkExpiresAt: link.expiresAt,
      actions: {
        accept: mine && job.status === 'assigned' && job.artisanResponse === null,
        decline: mine && job.status === 'assigned' && job.artisanResponse === null,
        start: mine && job.status === 'assigned' && job.artisanResponse === 'accepted',
        complete: mine && job.status === 'in_progress',
      },
      code:
        mine && job.status === 'in_progress' && artisan
          ? {
              destinationMasked: maskPhone(artisan.phone),
              sentAt: code && !code.consumedAt ? code.createdAt : null,
              expiresAt: code && !code.consumedAt ? code.expiresAt : null,
              attemptsLeft: SIGNING_CODE.maxAttempts - link.failedCodeAttempts,
              sendsLeft: Math.max(
                0,
                SIGNING_LIMITS.codeSendsPerLink.count - Number(recent[0]?.n ?? 0),
              ),
              lockedUntil:
                link.codeLockedUntil && link.codeLockedUntil > now ? link.codeLockedUntil : null,
            }
          : null,
    };
  }

  /** Who the artisan calls (decision 6): the property's caretaker or manager, never the tenant. */
  private async contactFor(tx: Tx, job: JobRow) {
    const facts = await this.maintenance.jobFacts(tx, job);
    const [person] = await tx
      .execute<{ name: string; phone: string | null }>(
        sql`
      select p.name, p.phone_number as phone from task t join person p on p.id = t.assignee_person_id
      where t.job_id = ${job.id} order by t.created_at desc limit 1`,
      )
      .then((r) => r.rows);
    if (person) return { name: person.name, phone: person.phone };
    return { name: facts.companyName, phone: null };
  }

  private async artisanName(tx: Tx, artisanId: string): Promise<string> {
    const [a] = await tx
      .select({ name: schema.artisan.name })
      .from(schema.artisan)
      .where(eq(schema.artisan.id, artisanId));
    return a?.name ?? '';
  }

  private async resolve(token: string): Promise<{ companyId: string; linkId: string }> {
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

  private context(companyId: string) {
    return { companyId, actorKind: 'link' as const };
  }

  private async limit(kind: 'open' | 'code' | 'action', client: ClientInfo, limit: RateLimit) {
    if (!(await this.hit(`jobsheet:${kind}:ip:${this.hasher.address(client.ip)}`, limit)))
      throw tooMany();
  }

  private hit(key: string, limit: RateLimit): Promise<boolean> {
    return consumeRateLimit(this.database, key, limit, this.clock.now().getTime());
  }
}
