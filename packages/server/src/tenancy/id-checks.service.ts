import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, schema, withCompany, type Database, type Tx } from '@rent/db';
import type { Actor } from '@rent/domain/policy';
import type { IdentityVerificationPort } from '@rent/integrations';
import type { Clock } from '../core/clock';
import { AppError, conflict, invalid, notFound } from '../core/errors';
import { queueMessage } from '../core/messages';
import { enqueueOutbox } from '../core/outbox';
import { CLOCK, DATABASE, IDENTITY_VERIFICATION_PORT } from '../core/tokens';
import { companyRecord, staffActor } from '../companies/companies.service';
import { PolicyService, staffContext } from '../policy/policy.service';
import type { IdCheckView } from './tenancy.types';
import { idCheckView, TenantsService } from './tenants.service';

export const IDENTITY_VERIFY_JOB = 'identity.verify-id';

/** Polls after a check starts (M3 plan 4.4): 5 minutes, 30 minutes, 2, 12 and 24 hours. */
export const ID_CHECK_POLL_MINUTES = [5, 30, 120, 720, 1440] as const;

/** A step of the verify job: 0 starts the check, 1 to 5 are the scheduled polls, null "check again". */
export type VerifyAttempt = number | null;

const unavailable = () =>
  new AppError(
    409,
    'identity_unavailable',
    'Identity checks are not available yet; no provider is connected (OQ-22)',
  );

/**
 * Biometric identity checks (TL-02; OQ-22, OQ-39). Staff start a check; the worker opens it with
 * the provider, texts the tenant the provider's capture link (if they agreed to SMS) and polls
 * for the result. Nothing about the selfie is stored here: only the check id, status and times.
 * A provider failure leaves the check pending, and it is tried again.
 */
@Injectable()
export class IdChecksService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(IDENTITY_VERIFICATION_PORT) private readonly port: IdentityVerificationPort | null,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async start(actor: Actor | null, tenantId: string): Promise<IdCheckView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'tenant.id.verify');
    if (!this.port) throw unavailable();
    const provider = this.port.provider;
    const row = await withCompany(this.database, staffContext(staff), async (tx) => {
      const [tenant] = await tx
        .select()
        .from(schema.tenant)
        .where(and(eq(schema.tenant.id, tenantId), isNull(schema.tenant.archivedAt)))
        .for('update');
      if (!tenant) throw notFound('Tenant');
      if (tenant.idType !== 'ghana_card' || !tenant.idNumberEncrypted)
        throw invalid(
          'id_check_ghana_card_only',
          'A biometric check needs a Ghana Card number; a passport is recorded, not verified',
        );
      if (tenant.idStatus === 'verified')
        throw conflict('id_already_verified', 'This tenant’s Ghana Card is already verified');
      await tx
        .update(schema.idCheck)
        .set({ status: 'cancelled', completedAt: this.clock.now(), updatedAt: this.clock.now() })
        .where(and(eq(schema.idCheck.tenantId, tenantId), eq(schema.idCheck.status, 'pending')));
      const [check] = await tx
        .insert(schema.idCheck)
        .values({
          companyId: staff.companyId,
          tenantId,
          idType: 'ghana_card',
          provider,
          startedBy: staff.personId,
        })
        .returning();
      await tx
        .update(schema.tenant)
        .set({ idStatus: 'pending', updatedAt: this.clock.now() })
        .where(eq(schema.tenant.id, tenantId));
      await enqueueOutbox(tx, {
        companyId: staff.companyId,
        type: IDENTITY_VERIFY_JOB,
        payload: { checkId: check!.id, attempt: 0 },
        idempotencyKey: `${IDENTITY_VERIFY_JOB}:${check!.id}:0`,
      });
      return check!;
    });
    return idCheckView(row);
  }

  /**
   * "Check again" after the scheduled polls (plan 4.4). The worker asks the provider, through the
   * outbox, so the request itself never calls a provider (CLAUDE.md section 8).
   */
  async refresh(actor: Actor | null, tenantId: string): Promise<IdCheckView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'tenant.id.verify');
    if (!this.port) throw unavailable();
    const check = await withCompany(this.database, staffContext(staff), async (tx) => {
      const [open] = await tx
        .select()
        .from(schema.idCheck)
        .where(and(eq(schema.idCheck.tenantId, tenantId), eq(schema.idCheck.status, 'pending')))
        .orderBy(desc(schema.idCheck.createdAt))
        .limit(1);
      if (!open) throw notFound('Pending identity check');
      await enqueueOutbox(tx, {
        companyId: staff.companyId,
        type: IDENTITY_VERIFY_JOB,
        payload: { checkId: open.id, attempt: null },
        idempotencyKey: `${IDENTITY_VERIFY_JOB}:${open.id}:manual:${this.clock.now().getTime()}`,
      });
      return open;
    });
    return idCheckView(check);
  }

  /**
   * The `identity.verify-id` job (plan 4.17). Idempotent: each scheduled poll runs once, and a
   * check that is no longer pending is left alone. Provider calls happen outside transactions.
   */
  async run(
    companyId: string,
    checkId: string,
    attempt: VerifyAttempt,
    schedule: (attempt: number, at: Date) => Promise<void>,
  ): Promise<void> {
    if (!this.port) throw unavailable();
    const ctx = { companyId, actorKind: 'system' as const };
    const loaded = await withCompany(this.database, ctx, async (tx) => {
      const [check] = await tx.select().from(schema.idCheck).where(eq(schema.idCheck.id, checkId));
      if (!check || check.status !== 'pending') return null;
      const id = await this.tenants.idNumberFor(tx, companyId, check.tenantId);
      return id ? { check, id } : null;
    });
    if (!loaded) return;
    const { check } = loaded;

    if (attempt === 0) {
      if (check.providerCheckId) return; // already started
      const started = await this.port.startCheck({
        idType: loaded.id.idType,
        idNumber: loaded.id.idNumber,
        reference: check.id,
      });
      await withCompany(this.database, ctx, async (tx) => {
        await tx
          .update(schema.idCheck)
          .set({
            providerCheckId: started.checkId,
            lastResult: 'started',
            updatedAt: this.clock.now(),
          })
          .where(and(eq(schema.idCheck.id, check.id), isNull(schema.idCheck.providerCheckId)));
        await this.queueCaptureLink(tx, companyId, check);
      });
      await schedule(1, this.pollAt(check.createdAt, 1));
      return;
    }

    if (attempt !== null && check.polls >= attempt) return; // this poll already ran
    if (!check.providerCheckId) return;
    let result: string;
    let checkedAt: Date | null = null;
    try {
      const answer = await this.port.getResult(check.providerCheckId);
      result = answer.status;
      checkedAt = answer.checkedAt ? new Date(answer.checkedAt) : null;
    } catch {
      result = 'provider_unavailable'; // tried again at the next poll (OQ-22)
    }
    const now = this.clock.now();
    const done = result === 'verified' || result === 'not_matched';
    await withCompany(this.database, ctx, async (tx) => {
      await tx
        .update(schema.idCheck)
        .set({
          polls: check.polls + 1,
          lastPolledAt: now,
          lastResult: result,
          ...(done ? { status: result, checkedAt, completedAt: now } : {}),
          updatedAt: now,
        })
        .where(and(eq(schema.idCheck.id, check.id), eq(schema.idCheck.status, 'pending')));
      if (done)
        await tx
          .update(schema.tenant)
          .set({
            idStatus: result,
            idVerifiedAt: result === 'verified' ? (checkedAt ?? now) : null,
            updatedAt: now,
          })
          .where(eq(schema.tenant.id, check.tenantId));
    });
    if (!done && attempt !== null && attempt < ID_CHECK_POLL_MINUTES.length)
      await schedule(attempt + 1, this.pollAt(check.createdAt, attempt + 1));
  }

  /**
   * The capture link for a check, for the messaging core's `id_capture` link (never stored).
   * Starting a check again with the same reference returns the same check and link.
   */
  async captureUrl(companyId: string, checkId: string): Promise<string> {
    if (!this.port) throw unavailable();
    const loaded = await withCompany(
      this.database,
      { companyId, actorKind: 'system' },
      async (tx) => {
        const [check] = await tx
          .select()
          .from(schema.idCheck)
          .where(eq(schema.idCheck.id, checkId));
        if (!check || check.status !== 'pending') return null;
        const id = await this.tenants.idNumberFor(tx, companyId, check.tenantId);
        return id ? { check, id } : null;
      },
    );
    if (!loaded) throw notFound('Pending identity check');
    const started = await this.port.startCheck({
      idType: loaded.id.idType,
      idNumber: loaded.id.idNumber,
      reference: loaded.check.id,
    });
    return started.captureUrl;
  }

  private pollAt(startedAt: Date, attempt: number): Date {
    const minutes = ID_CHECK_POLL_MINUTES[attempt - 1] ?? ID_CHECK_POLL_MINUTES.at(-1)!;
    return new Date(startedAt.getTime() + minutes * 60_000);
  }

  /** The capture link goes by SMS only, and only with consent (plan 4.4; CM-09). */
  private async queueCaptureLink(
    tx: Tx,
    companyId: string,
    check: typeof schema.idCheck.$inferSelect,
  ): Promise<void> {
    const company = await companyRecord(tx, companyId);
    await queueMessage(tx, companyId, {
      recipient: { type: 'tenant', tenantId: check.tenantId },
      purpose: 'id_check_link',
      body: `${company?.senderName ?? 'Your landlord'}: to verify your Ghana Card for your tenancy, take a selfie on our identity provider's page: {{link}}. Never share this link.`,
      link: { purpose: 'id_capture', targetId: check.id },
      channels: ['sms'],
      related: { type: 'id_check', id: check.id },
      requestedBy: check.startedBy,
    });
  }
}
