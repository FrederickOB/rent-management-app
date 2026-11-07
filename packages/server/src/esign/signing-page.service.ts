import { Inject, Injectable } from '@nestjs/common';
import { schema, sql, withCompany, withSystem, type Database, type Tx } from '@rent/db';
import {
  checkSignature,
  CURRENT_CONSENT,
  CURRENT_MOVE_IN_REPORT_CONSENT,
  CURRENT_NOTICE_CONSENT,
  NOTICE_SIGNING_STATEMENT,
  SIGNER_ROLE_LABELS,
  SIGNING_CODE,
  SIGNING_CONSENT,
  SIGNING_LIMITS,
  type SignerLinkPurpose,
  type SignerRole,
  type SignerStatus,
} from '@rent/domain/esign';
import { DomainError } from '@rent/domain/errors';
import { type EmailPort, type SmsPort } from '@rent/integrations';
import sharp from 'sharp';
import { v7 as uuidv7 } from 'uuid';
import { AuditService } from '../audit/audit.service';
import type { Clock } from '../core/clock';
import type { AppConfig } from '../core/config';
import { AppError, conflict, invalid, notFound } from '../core/errors';
import { queueMessage } from '../core/messages';
import { enqueueOutbox } from '../core/outbox';
import { consumeRateLimit, type RateLimit } from '../core/rate-limit';
import { CLOCK, CONFIG, DATABASE, EMAIL_PORT, SMS_PORT } from '../core/tokens';
import { DocumentsService, type WriteOnceFile } from '../documents/documents.service';
import {
  EsignService,
  NOTICE_SIGNING_EVENT,
  SIGNING_DECLINED_EVENT,
  SIGNING_FINALISE_JOB,
} from './esign.service';
import type {
  ClientInfo,
  LinkScreen,
  SignInput,
  SigningCodeState,
  SigningPageView,
} from './esign.types';
import {
  codeDestination,
  codesSince,
  companyFacts,
  completionOf,
  consentVersionFor,
  isMoveInReportRequest,
  isNoticeRequest,
  latestChallenge,
  linkRow,
  requestRow,
  revokeLinks,
  screenFor,
  signedByAll,
  signerRow,
  signersOf,
  signingEvent,
  type LinkRow,
  type RequestRow,
  type SignerRow,
} from './records';
import { newCode, sha256Text, SigningHasher, tokenHash, TOKEN_PATTERN } from './secrets';

const MINUTE_MS = 60_000;
/** A drawn signature is a small PNG; anything larger is refused before it is decoded. */
const MAX_DRAWING_BYTES = 300_000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const tooMany = () =>
  new AppError(429, 'rate_limited', 'Too many requests. Wait a few minutes and try again.');

const notUsable = (screen: LinkScreen) =>
  conflict('link_not_usable', 'This link can no longer be used to sign', { screen });

const locked = (until: Date) =>
  new AppError(
    423,
    'signing_locked',
    'Too many wrong codes. Signing is locked for 30 minutes; try again after that.',
    { lockedUntil: until.toISOString() },
  );

/**
 * The rows behind a link, locked in the engine's order: request, signer, link. `signers` are the
 * request's, read under its lock, so an action and the last required signature serialise.
 */
interface LinkRows {
  readonly request: RequestRow;
  readonly signer: SignerRow;
  readonly link: LinkRow;
  readonly signers: readonly SignerRow[];
}

/**
 * The signing page's actions (TL-07; M3 plan 4.8 and 4.15): the links API that apps/links calls
 * server to server. A token is the only authorisation; every call is rate-limited by address,
 * opens and codes also by link, and codes by destination. One-time codes are stored as an HMAC
 * and go straight from this request to the SMS or email port, never through the outbox, and
 * only to the phone (or, for an email-only signatory, the email) on record. Evidence times are
 * the server's.
 */
@Injectable()
export class SigningPageService {
  private readonly hasher: SigningHasher;

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SMS_PORT) private readonly sms: SmsPort,
    @Inject(EMAIL_PORT) private readonly email: EmailPort,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EsignService) private readonly esign: EsignService,
  ) {
    this.hasher = new SigningHasher(config.BETTER_AUTH_SECRET);
  }

  /** Opens a link: records the open and returns what its page shows (plan 4.8). */
  async open(token: string, client: ClientInfo): Promise<SigningPageView> {
    await this.limitAddress('open', client, SIGNING_LIMITS.opensPerIp);
    const { companyId, linkId } = await this.resolve(token);
    if (!(await this.hit(`esign:open:link:${linkId}`, SIGNING_LIMITS.opensPerLink)))
      throw tooMany();
    const page = await withCompany(this.database, this.context(companyId), async (tx) => {
      const rows = await this.lockRows(tx, linkId);
      const { request, signer, link, signers } = rows;
      const now = this.clock.now();
      const { screen, reason, downloadable } = screenFor(link, signer, request, now, signers);
      await tx
        .update(schema.secureLink)
        .set({
          firstOpenedAt: link.firstOpenedAt ?? now,
          // M7 (plan 4.5): each token keeps its first open's address and device as evidence.
          ...(link.firstOpenedAt
            ? {}
            : {
                firstOpenIp: client.ip.slice(0, 64),
                firstOpenUserAgent: client.userAgent.slice(0, 500),
              }),
          lastOpenedAt: now,
          openCount: link.openCount + 1,
        })
        .where(sql`${schema.secureLink.id} = ${link.id}`);
      if (screen === 'sign' || screen === 'copy') {
        if (!link.firstOpenedAt)
          await signingEvent(tx, request, 'link.opened', now, {
            signerId: signer.id,
            data: { linkId: link.id, purpose: link.purpose },
            client,
          });
        await tx
          .update(schema.signer)
          .set({ firstOpenedAt: signer.firstOpenedAt ?? now, lastOpenedAt: now, updatedAt: now })
          .where(sql`${schema.signer.id} = ${signer.id}`);
        if (!signer.firstOpenedAt)
          await signingEvent(tx, request, 'signer.opened', now, { signerId: signer.id, client });
        // M7 (LN-03): the notice records the recipient's first open, with the time and device.
        if (!signer.firstOpenedAt && isNoticeRequest(request) && link.purpose === 'sign')
          await enqueueOutbox(tx, {
            companyId,
            type: NOTICE_SIGNING_EVENT,
            payload: {
              kind: 'opened',
              signingRequestId: request.id,
              noticeId: request.noticeId,
              signerId: signer.id,
              linkId: link.id,
              at: now.toISOString(),
              userAgent: client.userAgent.slice(0, 300),
            },
            idempotencyKey: `${NOTICE_SIGNING_EVENT}:opened:${signer.id}`,
          });
      }
      const company = await companyFacts(tx, companyId);
      const facts = await this.esign.documentFacts(tx, request);
      const noticeView =
        isNoticeRequest(request) && request.noticeId
          ? await this.esign.describeNotice(tx, request.noticeId)
          : null;
      const notice = isNoticeRequest(request);
      // M7 (plan 4.8): a closed notice's page says whether it was corrected or closed.
      const pageReason =
        notice && screen === 'closed' && request.status === 'cancelled'
          ? noticeView?.supersededBy
            ? 'notice_superseded'
            : 'notice_closed'
          : reason;
      const consentVersion = consentVersionFor(request);
      const view: SigningPageView = {
        screen,
        reason: pageReason,
        purpose: link.purpose as SignerLinkPurpose,
        landlord: this.esign.landlordContact(company, signers),
        timeZone: company.timeZone,
        linkExpiresAt: link.expiresAt,
        document: {
          title: facts.title,
          reference: facts.reference,
          sha256: request.documentSha256,
          finalSha256: screen === 'copy' ? request.finalSha256 : null,
          html: null,
          downloadable,
        },
        signer: {
          name: signer.name,
          role: signer.signerRole as SignerRole,
          roleLabel: SIGNER_ROLE_LABELS[signer.signerRole as SignerRole],
          status: signer.status as SignerStatus,
          signedAt: signer.signedAt,
          declinedAt: signer.declinedAt,
        },
        signers:
          screen === 'sign' || screen === 'signed' || screen === 'copy'
            ? signers.map((s) => ({
                name: s.name,
                roleLabel: SIGNER_ROLE_LABELS[s.signerRole as SignerRole],
                status: s.status as SignerStatus,
                required: s.required,
              }))
            : [],
        code: screen === 'sign' ? await this.codeState(tx, link, signer, now) : null,
        consent:
          screen === 'sign'
            ? { version: consentVersion, text: SIGNING_CONSENT[consentVersion]! }
            : null,
        subject: notice ? 'notice' : 'lease',
        canDecline: !notice,
        notice: noticeView
          ? {
              number: noticeView.number,
              type: noticeView.type,
              typeLabel: noticeView.typeLabel,
              issuedAt: noticeView.issuedAt,
              effectiveDate: noticeView.effectiveDate,
              statement: NOTICE_SIGNING_STATEMENT,
              supersededBy: noticeView.supersededBy,
              acknowledgedByAnother:
                signer.status !== 'signed' &&
                completionOf(request) === 'any_one' &&
                signers.some((s) => s.status === 'signed'),
            }
          : null,
      };
      return { view, request };
    });
    if (page.view.screen !== 'sign') return page.view;
    // Read from storage after the transaction, checked against the hash stored with the request.
    const html = await this.esign.documentHtml(companyId, page.request);
    return { ...page.view, document: { ...page.view.document, html } };
  }

  /**
   * A 5-minute link to the frozen PDF (or, on a signed-copy link, the signed copy). Only a live
   * link fetches one: a revoked or expired link fetches nothing, whatever the signer's status
   * (review finding 4).
   */
  async documentUrl(token: string, client: ClientInfo): Promise<string> {
    await this.limitAddress('open', client, SIGNING_LIMITS.opensPerIp);
    const { companyId, linkId } = await this.resolve(token);
    const found = await withCompany(this.database, this.context(companyId), async (tx) => {
      const { request, signer, link, signers } = await this.lockRows(tx, linkId);
      const { screen, downloadable } = screenFor(link, signer, request, this.clock.now(), signers);
      // Only a signed-copy link fetches the signed copy, whose certificate holds every signer's
      // address and device (M3; M7 review data S8). An ordinary link, a notice's included,
      // fetches the frozen document.
      const documentId = !downloadable
        ? null
        : screen === 'copy'
          ? request.finalDocumentId
          : request.documentId;
      if (!documentId) throw notUsable(screen);
      const facts = await this.esign.documentFacts(tx, request);
      await signingEvent(tx, request, 'document.downloaded', this.clock.now(), {
        signerId: signer.id,
        data: { which: screen === 'copy' ? 'signed' : 'frozen' },
        client,
      });
      return { documentId, reference: facts.reference, signed: screen === 'copy' };
    });
    const name = found.reference.replace(/[^A-Za-z0-9-]/g, '').slice(0, 60) || 'document';
    const url = await this.documents.downloadUrl(
      companyId,
      found.documentId,
      `${found.signed ? 'signed-' : ''}${name}.pdf`,
    );
    if (!url) throw notFound('Document');
    return url;
  }

  /**
   * "Send me a code" (plan 4.8): 6 digits stored as an HMAC, valid 10 minutes, sent straight to
   * the SMS or email port, only to the destination on record. Limited per link (3 in 15
   * minutes), per destination and per address. One-time codes the person asked for need no
   * consent (CM-09).
   */
  async sendCode(
    token: string,
    client: ClientInfo,
  ): Promise<{
    channel: 'sms' | 'email';
    destinationMasked: string;
    expiresAt: Date;
    sendsLeft: number;
  }> {
    await this.limitAddress('code', client, SIGNING_LIMITS.codeSendsPerIp);
    const { companyId, linkId } = await this.resolve(token);
    const prepared = await withCompany(this.database, this.context(companyId), async (tx) => {
      const { request, signer, link, signers } = await this.lockRows(tx, linkId);
      const now = this.clock.now();
      const { screen } = screenFor(link, signer, request, now, signers);
      if (screen !== 'sign') return { refused: notUsable(screen) };
      const lock = await this.lockState(tx, signer, now);
      if (lock) return { refused: locked(lock) };
      const destination = codeDestination(signer);
      if (!destination)
        return { refused: conflict('no_destination', 'No phone or email is on record') };
      const since = new Date(
        now.getTime() - SIGNING_LIMITS.codeSendsPerLink.windowMinutes * MINUTE_MS,
      );
      const perLink = await codesSince(tx, { linkId: link.id }, since);
      if (perLink >= SIGNING_LIMITS.codeSendsPerLink.count)
        return {
          refused: new AppError(
            429,
            'code_limit',
            'We have sent you 3 codes in the last 15 minutes. Wait a few minutes before asking for another.',
          ),
        };
      // Per destination across every company (one phone may sign for several landlords), in the
      // global rate_limit table and keyed by the keyed hash, as the per-address limit is.
      const destinationHash = this.hasher.destination(destination.address);
      if (
        !(await this.hit(
          `esign:code:destination:${destinationHash}`,
          SIGNING_LIMITS.codeSendsPerDestination,
        ))
      )
        return {
          refused: new AppError(
            429,
            'code_limit',
            'Too many codes went to this phone or email recently. Wait a few minutes and try again.',
          ),
        };
      // Real adapters never send to test contacts (as in M1).
      if (signer.isTestContact && this.config.NODE_ENV === 'production')
        return {
          refused: new AppError(422, 'code_not_sent', 'Codes are not sent to test contacts'),
        };
      const code = newCode();
      const challengeId = uuidv7();
      const expiresAt = new Date(now.getTime() + SIGNING_CODE.validMinutes * MINUTE_MS);
      await tx.insert(schema.otpChallenge).values({
        id: challengeId,
        companyId,
        propertyId: signer.propertyId,
        tenantId: signer.tenantId,
        signerId: signer.id,
        secureLinkId: link.id,
        channel: destination.channel,
        destinationMasked: destination.masked,
        destinationHash,
        codeHash: this.hasher.code(challengeId, code),
        expiresAt,
        attempts: 0,
        maxAttempts: SIGNING_CODE.maxAttempts,
        createdAt: now,
      });
      await signingEvent(tx, request, 'code.requested', now, {
        signerId: signer.id,
        data: { challengeId, channel: destination.channel, destinationMasked: destination.masked },
        client,
      });
      return {
        code,
        challengeId,
        destination,
        request,
        signerId: signer.id,
        sender: (await companyFacts(tx, companyId)).senderName,
        expiresAt,
        sendsLeft: SIGNING_LIMITS.codeSendsPerLink.count - perLink - 1,
      };
    });
    if ('refused' in prepared) throw prepared.refused;
    const { code, challengeId, destination, request, sender, expiresAt } = prepared;
    // Straight to the port, outside any transaction: the code is never stored in plain text.
    let delivery: { provider: string; providerMessageId: string };
    try {
      delivery =
        destination.channel === 'sms'
          ? await this.sms.send({
              to: destination.address,
              body: `${code} is your code to sign with ${sender}. It expires in ${SIGNING_CODE.validMinutes} minutes. Never share it.`,
              reference: challengeId,
            })
          : await this.email.send({
              to: destination.address,
              subject: `Your code to sign with ${sender}`,
              text: `Your code is ${code}. It expires in ${SIGNING_CODE.validMinutes} minutes.\n\nIf you did not ask to sign a document, ignore this email.`,
            });
    } catch {
      await withCompany(this.database, this.context(companyId), (tx) =>
        signingEvent(tx, request, 'code.failed', this.clock.now(), {
          signerId: prepared.signerId,
          data: { challengeId, channel: destination.channel },
        }),
      );
      throw new AppError(
        502,
        'code_not_sent',
        'We could not send your code just now. Wait a minute and try again.',
      );
    }
    await withCompany(this.database, this.context(companyId), (tx) =>
      signingEvent(tx, request, 'code.sent', this.clock.now(), {
        signerId: prepared.signerId,
        data: {
          challengeId,
          channel: destination.channel,
          destinationMasked: destination.masked,
          provider: delivery.provider,
          providerMessageId: delivery.providerMessageId,
        },
      }),
    );
    return {
      channel: destination.channel,
      destinationMasked: destination.masked,
      expiresAt,
      sendsLeft: Math.max(0, prepared.sendsLeft),
    };
  }

  /**
   * Signs (plan 4.8): the code is checked first, and a wrong one counts against the signer (five
   * lock signing for 30 minutes). A drawing is then stored write-once, and the signature recorded
   * with its evidence: method, typed name or drawing, consent version and hash, server time,
   * verifying channel and masked destination, address, device and the document's SHA-256. The
   * last required signature queues esign.finalise.
   */
  async sign(
    token: string,
    client: ClientInfo,
    input: SignInput,
  ): Promise<{ signedAt: Date; complete: boolean }> {
    await this.limitAddress('action', client, SIGNING_LIMITS.actionsPerIp);
    const code = input.code.trim();
    if (!/^\d{6}$/.test(code)) throw invalid('code_format', 'Enter the 6-digit code we sent you');
    if (
      !input.consentAccepted ||
      (input.consentVersion !== CURRENT_CONSENT &&
        input.consentVersion !== CURRENT_NOTICE_CONSENT &&
        input.consentVersion !== CURRENT_MOVE_IN_REPORT_CONSENT)
    )
      throw invalid('consent_required', 'Tick the box to agree to sign electronically');
    const drawing = input.method === 'drawn' ? parseDrawing(input.drawing) : null;
    let signature: { method: 'typed' | 'drawn'; typedName: string | null };
    try {
      signature = checkSignature({
        method: input.method,
        typedName: input.typedName,
        hasDrawing: drawing !== null,
      });
    } catch (error) {
      if (error instanceof DomainError) throw invalid('signature_required', error.message);
      throw error;
    }
    const { companyId, linkId } = await this.resolve(token);

    // 1. The code, checked without using it up: a wrong one is counted and committed.
    const checked = await withCompany(this.database, this.context(companyId), async (tx) => {
      const { request, signer, link, signers } = await this.lockRows(tx, linkId);
      const now = this.clock.now();
      const { screen } = screenFor(link, signer, request, now, signers);
      if (screen !== 'sign') return { refused: notUsable(screen) };
      // M7 (plan 4.5): a notice is acknowledged under its own consent text, a lease signed under M3's.
      if (input.consentVersion !== consentVersionFor(request))
        return {
          refused: invalid('consent_required', 'Tick the box to confirm, then sign again'),
        };
      const lock = await this.lockState(tx, signer, now);
      if (lock) return { refused: locked(lock) };
      const challenge = await latestChallenge(tx, link.id, { lock: true });
      if (!challenge || challenge.consumedAt)
        return { refused: conflict('code_required', 'Send yourself a code first') };
      if (
        challenge.expiresAt.getTime() <= now.getTime() ||
        challenge.attempts >= challenge.maxAttempts
      )
        return {
          refused: new AppError(
            410,
            'code_expired',
            'That code has expired. Send yourself a new one.',
          ),
        };
      if (this.hasher.codeMatches(challenge.id, code, challenge.codeHash))
        return {
          challengeId: challenge.id,
          countryCode: (await companyFacts(tx, companyId)).countryCode,
        };
      const failed = (await this.failedAttempts(tx, signer.id)) + 1;
      const lockedUntil =
        failed >= SIGNING_CODE.maxAttempts
          ? new Date(now.getTime() + SIGNING_CODE.lockMinutes * MINUTE_MS)
          : null;
      await tx
        .update(schema.otpChallenge)
        .set({ attempts: challenge.attempts + 1 })
        .where(sql`${schema.otpChallenge.id} = ${challenge.id}`);
      await tx
        .update(schema.signer)
        .set({ failedCodeAttempts: failed, lockedUntil, updatedAt: now })
        .where(sql`${schema.signer.id} = ${signer.id}`);
      await signingEvent(tx, request, 'code.wrong', now, {
        signerId: signer.id,
        data: { challengeId: challenge.id, failedAttempts: failed },
        client,
      });
      if (lockedUntil) {
        await signingEvent(tx, request, 'signer.locked', now, {
          signerId: signer.id,
          data: { until: lockedUntil.toISOString() },
          client,
        });
        return { refused: locked(lockedUntil) };
      }
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
    if ('refused' in checked) throw checked.refused;

    // 2. A drawing goes to write-once storage before the transaction that records it.
    let drawingFile: WriteOnceFile | null = null;
    if (drawing) {
      let png: Buffer;
      try {
        png = await sharp(drawing, { limitInputPixels: 4_000_000 }).png().toBuffer();
      } catch {
        throw invalid('drawing_invalid', 'Draw your signature again');
      }
      drawingFile = await this.documents.storeWriteOnce({
        companyId,
        countryCode: checked.countryCode,
        key: `evidence/${companyId}/signatures/${linkId}/${uuidv7()}.png`,
        bytes: png,
        contentType: 'image/png',
      });
    }

    // 3. The signature and its evidence, using up the code.
    const done = await withCompany(this.database, this.context(companyId), async (tx) => {
      const { request, signer, link, signers } = await this.lockRows(tx, linkId);
      const now = this.clock.now();
      const { screen } = screenFor(link, signer, request, now, signers);
      if (screen !== 'sign') return { refused: notUsable(screen) };
      const challenge = await latestChallenge(tx, link.id, { lock: true });
      if (
        !challenge ||
        challenge.id !== checked.challengeId ||
        challenge.consumedAt ||
        challenge.expiresAt.getTime() <= now.getTime() ||
        !this.hasher.codeMatches(challenge.id, code, challenge.codeHash)
      )
        return {
          refused: new AppError(
            410,
            'code_expired',
            'That code has expired. Send yourself a new one.',
          ),
        };
      await tx
        .update(schema.otpChallenge)
        .set({ consumedAt: now })
        .where(sql`${schema.otpChallenge.id} = ${challenge.id}`);
      const drawingDocumentId = drawingFile
        ? await this.documents.recordWriteOnce(tx, drawingFile, { kind: 'signature_drawing' })
        : null;
      const consentVersion = consentVersionFor(request);
      const consentText = SIGNING_CONSENT[consentVersion]!;
      const [row] = await tx
        .insert(schema.signature)
        .values({
          companyId,
          propertyId: signer.propertyId,
          tenantId: signer.tenantId,
          signingRequestId: request.id,
          signerId: signer.id,
          method: signature.method,
          typedName: signature.typedName,
          drawingDocumentId,
          consentVersion,
          consentSha256: sha256Text(consentText),
          signedAt: now,
          verifiedChannel: challenge.channel,
          verifiedDestinationMasked: challenge.destinationMasked,
          ipAddress: client.ip,
          userAgent: client.userAgent,
          documentSha256: request.documentSha256!,
          otpChallengeId: challenge.id,
        })
        .returning({ id: schema.signature.id });
      await tx
        .update(schema.signer)
        .set({
          status: 'signed',
          signedAt: now,
          failedCodeAttempts: 0,
          lockedUntil: null,
          updatedAt: now,
        })
        .where(sql`${schema.signer.id} = ${signer.id}`);
      await tx
        .update(schema.secureLink)
        .set({ usedAt: now })
        .where(sql`${schema.secureLink.id} = ${link.id}`);
      await signingEvent(tx, request, 'signer.signed', now, {
        signerId: signer.id,
        data: {
          signatureId: row!.id,
          method: signature.method,
          consentVersion,
          documentSha256: request.documentSha256,
          htmlSha256: request.htmlSha256,
        },
        client,
      });
      await this.audit.append(tx, {
        companyId,
        action: 'signature.recorded',
        recordType: 'signing_request',
        recordId: request.id,
        data: {
          signatureId: row!.id,
          signerId: signer.id,
          role: signer.signerRole,
          method: signature.method,
          verifiedChannel: challenge.channel,
          consentVersion,
          documentSha256: request.documentSha256,
        },
      });
      if (isNoticeRequest(request))
        await enqueueOutbox(tx, {
          companyId,
          type: NOTICE_SIGNING_EVENT,
          payload: {
            kind: 'signed',
            signingRequestId: request.id,
            noticeId: request.noticeId,
            signerId: signer.id,
            at: now.toISOString(),
          },
          idempotencyKey: `${NOTICE_SIGNING_EVENT}:signed:${signer.id}`,
        });
      const complete = signedByAll(await signersOf(tx, request.id), completionOf(request));
      if (complete) {
        await signingEvent(tx, request, 'request.signed_by_all', now);
        await enqueueOutbox(tx, {
          companyId,
          type: SIGNING_FINALISE_JOB,
          payload: { signingRequestId: request.id },
          idempotencyKey: `${SIGNING_FINALISE_JOB}:${request.id}`,
        });
      }
      return { signedAt: now, complete };
    });
    if ('refused' in done) throw done.refused;
    return done;
  }

  /**
   * Declines, with a reason (plan 4.8): the request closes and its links are revoked, and
   * signing.declined goes out in the same transaction, so the lease returns to draft once.
   */
  async decline(token: string, client: ClientInfo, reason: string): Promise<{ declinedAt: Date }> {
    await this.limitAddress('action', client, SIGNING_LIMITS.actionsPerIp);
    const why = reason.trim();
    if (why.length < 3 || why.length > 500)
      throw invalid('reason_required', 'Say in a few words why you are declining');
    const { companyId, linkId } = await this.resolve(token);
    const result = await withCompany(this.database, this.context(companyId), async (tx) => {
      const { request, signer, link, signers } = await this.lockRows(tx, linkId);
      const now = this.clock.now();
      // M7 (plan 4.5; CLAUDE.md section 9): a notice is never declined, only left unsigned.
      if (isNoticeRequest(request))
        return {
          refused: conflict(
            'notice_not_declinable',
            'A notice cannot be declined. Signing only acknowledges that you received it; if you disagree with it, contact the landlord.',
          ),
        };
      const { screen } = screenFor(link, signer, request, now, signers);
      if (screen !== 'sign') return { refused: notUsable(screen) };
      await tx
        .update(schema.signer)
        .set({ status: 'declined', declinedAt: now, declineReason: why, updatedAt: now })
        .where(sql`${schema.signer.id} = ${signer.id}`);
      await tx
        .update(schema.signingRequest)
        .set({ status: 'declined', declinedAt: now, declineReason: why, updatedAt: now })
        .where(sql`${schema.signingRequest.id} = ${request.id}`);
      await tx
        .update(schema.secureLink)
        .set({ usedAt: now })
        .where(sql`${schema.secureLink.id} = ${link.id}`);
      const revoked = await revokeLinks(tx, { requestId: request.id }, 'request_closed', now);
      await signingEvent(tx, request, 'signer.declined', now, {
        signerId: signer.id,
        data: { reason: why, revoked },
        client,
      });
      await this.audit.append(tx, {
        companyId,
        action: 'signing.declined',
        recordType: 'signing_request',
        recordId: request.id,
        data: {
          leaseId: request.leaseId,
          signerId: signer.id,
          role: signer.signerRole,
          reason: why,
        },
      });
      // M8: a declined move-in report leaves the lease as it is (only a lease goes back to draft).
      if (!isMoveInReportRequest(request))
        await enqueueOutbox(tx, {
          companyId,
          type: SIGNING_DECLINED_EVENT,
          payload: { signingRequestId: request.id, leaseId: request.leaseId, signerId: signer.id },
          idempotencyKey: `${SIGNING_DECLINED_EVENT}:${request.id}`,
        });
      if (request.createdBy) {
        const facts = await this.esign.documentFacts(tx, request);
        await queueMessage(tx, companyId, {
          recipient: { type: 'staff', personId: request.createdBy },
          purpose: 'staff_notice',
          subject: `A signer declined: ${facts.title}`,
          body: isMoveInReportRequest(request)
            ? `${signer.name} (${SIGNER_ROLE_LABELS[signer.signerRole as SignerRole]}) declined to sign ${facts.title}. Their reason: “${why}”. Agree the conditions with them, correct the move-in inspection and send the report again.`
            : `${signer.name} (${SIGNER_ROLE_LABELS[signer.signerRole as SignerRole]}) declined to sign ${facts.title} (reference ${facts.reference}). Their reason: “${why}”. The lease is back in draft: change it and send it again, or cancel it.`,
          channels: ['email'],
          propertyId: request.propertyId,
          related: { type: 'signing_request', id: request.id },
        });
      }
      return { declinedAt: now };
    });
    if ('refused' in result) throw result.refused;
    return result;
  }

  // Internals ---------------------------------------------------------------------------------------

  private context(companyId: string) {
    return { companyId, actorKind: 'link' as const };
  }

  /** The company and link of a token, through the narrow system function (ids only). */
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

  private async lockRows(tx: Tx, linkId: string): Promise<LinkRows> {
    const found = await linkRow(tx, linkId);
    if (!found.signerId) throw notFound('Link');
    const unlockedSigner = await signerRow(tx, found.signerId);
    const request = await requestRow(tx, unlockedSigner.signingRequestId, { lock: true });
    const signer = await signerRow(tx, found.signerId, { lock: true });
    const link = await linkRow(tx, linkId, { lock: true });
    return { request, signer, link, signers: await signersOf(tx, request.id) };
  }

  /** The lock's end while it holds; a lock that has run its 30 minutes is lifted here. */
  private async lockState(tx: Tx, signer: SignerRow, now: Date): Promise<Date | null> {
    if (signer.lockedUntil && signer.lockedUntil.getTime() > now.getTime())
      return signer.lockedUntil;
    if (signer.lockedUntil || signer.failedCodeAttempts >= SIGNING_CODE.maxAttempts)
      await tx
        .update(schema.signer)
        .set({ failedCodeAttempts: 0, lockedUntil: null, updatedAt: now })
        .where(sql`${schema.signer.id} = ${signer.id}`);
    return null;
  }

  private async failedAttempts(tx: Tx, signerId: string): Promise<number> {
    const [row] = await tx
      .select({ n: schema.signer.failedCodeAttempts })
      .from(schema.signer)
      .where(sql`${schema.signer.id} = ${signerId}`);
    return row?.n ?? 0;
  }

  private async codeState(
    tx: Tx,
    link: LinkRow,
    signer: SignerRow,
    now: Date,
  ): Promise<SigningCodeState> {
    const destination = codeDestination(signer)!;
    const challenge = await latestChallenge(tx, link.id);
    const live =
      challenge &&
      !challenge.consumedAt &&
      challenge.expiresAt.getTime() > now.getTime() &&
      challenge.attempts < challenge.maxAttempts
        ? challenge
        : null;
    const since = new Date(
      now.getTime() - SIGNING_LIMITS.codeSendsPerLink.windowMinutes * MINUTE_MS,
    );
    const sent = await codesSince(tx, { linkId: link.id }, since);
    const lockHolds = signer.lockedUntil && signer.lockedUntil.getTime() > now.getTime();
    return {
      channel: destination.channel,
      destinationMasked: destination.masked,
      sentAt: live?.createdAt ?? null,
      expiresAt: live?.expiresAt ?? null,
      attemptsLeft: lockHolds
        ? 0
        : Math.max(
            0,
            SIGNING_CODE.maxAttempts -
              (signer.failedCodeAttempts >= SIGNING_CODE.maxAttempts
                ? 0
                : signer.failedCodeAttempts),
          ),
      sendsLeft: Math.max(0, SIGNING_LIMITS.codeSendsPerLink.count - sent),
      lockedUntil: lockHolds ? signer.lockedUntil : null,
    };
  }

  private async limitAddress(
    kind: 'open' | 'code' | 'action',
    client: ClientInfo,
    limit: RateLimit,
  ) {
    if (!(await this.hit(`esign:${kind}:ip:${this.hasher.address(client.ip)}`, limit)))
      throw tooMany();
  }

  private hit(key: string, limit: RateLimit): Promise<boolean> {
    return consumeRateLimit(this.database, key, limit, this.clock.now().getTime());
  }
}

/** A drawn signature: a PNG data URL (or its base64) of a sensible size, else nothing. */
function parseDrawing(value: string | null | undefined): Buffer | null {
  if (!value) return null;
  const base64 = value.startsWith('data:image/png;base64,')
    ? value.slice('data:image/png;base64,'.length)
    : value;
  if (base64.length > (MAX_DRAWING_BYTES * 4) / 3 + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64))
    throw invalid('drawing_invalid', 'Draw your signature again');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > MAX_DRAWING_BYTES || !bytes.subarray(0, 8).equals(PNG_MAGIC))
    throw invalid('drawing_invalid', 'Draw your signature again');
  return bytes;
}
