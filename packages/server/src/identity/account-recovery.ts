import { Inject, Injectable } from '@nestjs/common';
import { eq, schema, sql, withCompany, withSystem, type Database } from '@rent/db';
import { can, isPlatformRole, type Actor } from '@rent/domain/policy';
import { AuditService } from '../audit/audit.service';
import type { Clock } from '../core/clock';
import { AppError, forbidden, invalid, notFound } from '../core/errors';
import { CLOCK, DATABASE } from '../core/tokens';
import { MembershipDirectory } from './memberships';

/** Who did a recovery action: a platform admin in the console, or an operator at the CLI. */
export type RecoveryOperator =
  | { readonly kind: 'console'; readonly actor: Actor | null }
  /**
   * `pnpm identity:recover`: the operator, named by their email, must be an active platform admin
   * (as the incident commands' operator is); they then act as that platform admin would.
   */
  | { readonly kind: 'cli'; readonly operatorEmail: string };

export interface RecoveryResult {
  readonly personId: string;
  readonly sessionsRevoked: number;
  readonly twoFactorReset: boolean;
}

/** What the console shows before a recovery action, to confirm it is the right person. */
export interface RecoveryLookup {
  readonly personId: string;
  readonly name: string;
  readonly twoFactorEnabled: boolean;
  readonly sessions: number;
  /** A plain array, so the console contract's output type takes it as it is. */
  readonly companies: { companyName: string; role: string }[];
}

const REASON_MIN = 10;
const REASON_MAX = 500;

/**
 * Founder decision D4 (2026-11-10; M11 review R1 F14): a person who lost their authenticator gets
 * their two-factor reset by a platform admin, after the identity check in
 * docs/runbooks/lost-authenticator.md, with a reason. The reset removes their TOTP secret and
 * backup codes and signs them out everywhere; their next password sign-in asks them to enrol again
 * (a password-only session can do nothing else). "Sign out everywhere" is offered on its own too.
 *
 * Each action is audited in the platform's chain (who, why) and in the chain of every company the
 * person works in (that it happened, without the reason, which may describe them). Only the
 * policy's `person.two_factor.reset` and `person.sessions.revoke` allow them: platform admins.
 */
@Injectable()
export class AccountRecoveryService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Finds the person an exact email names, for the console (platform admins only). */
  async lookup(by: RecoveryOperator, email: string): Promise<RecoveryLookup | null> {
    await this.operator(by, 'person.sessions.revoke');
    const [row] = await withSystem(this.database, {}, (tx) =>
      tx
        .select({
          id: schema.person.id,
          name: schema.person.name,
          twoFactorEnabled: schema.person.twoFactorEnabled,
        })
        .from(schema.person)
        .where(eq(schema.person.email, email.trim().toLowerCase())),
    );
    if (!row) return null;
    const sessions = await withSystem(this.database, {}, (tx) =>
      tx
        .select({ id: schema.session.id })
        .from(schema.session)
        .where(eq(schema.session.userId, row.id)),
    );
    const companies = (await new MembershipDirectory(this.database).forPerson(row.id))
      .filter((m) => m.status === 'active')
      .map((m) => ({ companyName: m.companyName, role: m.role }));
    return {
      personId: row.id,
      name: row.name,
      twoFactorEnabled: row.twoFactorEnabled ?? false,
      sessions: sessions.length,
      companies,
    };
  }

  async resetTwoFactor(
    by: RecoveryOperator,
    personId: string,
    reason: string,
  ): Promise<RecoveryResult> {
    const operator = await this.operator(by, 'person.two_factor.reset');
    const why = this.reason(reason);
    await this.person(personId);
    const result = await withSystem(this.database, { personId: operator.personId }, async (tx) => {
      const removed = await tx
        .delete(schema.twoFactor)
        .where(eq(schema.twoFactor.userId, personId))
        .returning({ id: schema.twoFactor.id });
      await tx
        .update(schema.person)
        .set({ twoFactorEnabled: false, updatedAt: this.clock.now() })
        .where(eq(schema.person.id, personId));
      const sessions = await tx
        .delete(schema.session)
        .where(eq(schema.session.userId, personId))
        .returning({ id: schema.session.id });
      return { twoFactorReset: removed.length > 0, sessionsRevoked: sessions.length };
    });
    await this.record(operator, personId, 'auth.two_factor_reset', why, result);
    return { personId, ...result };
  }

  async revokeAllSessions(
    by: RecoveryOperator,
    personId: string,
    reason: string,
  ): Promise<RecoveryResult> {
    const operator = await this.operator(by, 'person.sessions.revoke');
    const why = this.reason(reason);
    await this.person(personId);
    const sessions = await withSystem(this.database, { personId: operator.personId }, (tx) =>
      tx
        .delete(schema.session)
        .where(eq(schema.session.userId, personId))
        .returning({ id: schema.session.id }),
    );
    const result = { twoFactorReset: false, sessionsRevoked: sessions.length };
    await this.record(operator, personId, 'auth.sessions_revoked_all', why, result);
    return { personId, ...result };
  }

  private async operator(
    by: RecoveryOperator,
    action: 'person.two_factor.reset' | 'person.sessions.revoke',
  ): Promise<{ readonly personId: string | null; readonly label: string }> {
    const actor = by.kind === 'cli' ? await this.platformAdminByEmail(by.operatorEmail) : by.actor;
    if (!actor) throw forbidden();
    // The policy's own decision (identity sits below the policy module, so it asks the domain
    // policy directly, as the approvals engine does): only platform admins are allowed these.
    const decision = can(actor, action);
    if (!decision.allowed) throw new AppError(403, 'forbidden', decision.message ?? 'Not allowed');
    return { personId: (actor as { personId: string }).personId, label: by.kind };
  }

  /**
   * The CLI's operator as the platform admin they are: an active platform-admin membership of an
   * active company, found by their email (never printed). Anyone else is refused.
   */
  private async platformAdminByEmail(email: string): Promise<Actor> {
    const refused = new AppError(
      403,
      'not_a_platform_admin',
      'The operator must be an active platform admin, named by their email',
    );
    const address = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw refused;
    const [row] = await withSystem(this.database, {}, (tx) =>
      tx
        .select({ id: schema.person.id })
        .from(schema.person)
        .where(eq(schema.person.email, address)),
    );
    if (!row) throw refused;
    const membership = (await new MembershipDirectory(this.database).forPerson(row.id)).find(
      (m) => m.status === 'active' && m.companyStatus === 'active' && isPlatformRole(m.role),
    );
    if (!membership) throw refused;
    return {
      kind: 'platform_admin',
      personId: row.id,
      companyId: membership.companyId,
      membershipId: membership.membershipId,
      authMethod: 'password_totp',
    };
  }

  private reason(reason: string): string {
    const why = reason.trim();
    if (why.length < REASON_MIN || why.length > REASON_MAX)
      throw invalid(
        'reason_required',
        `Give the reason and the identity check made (${REASON_MIN} to ${REASON_MAX} characters)`,
      );
    return why;
  }

  private async person(personId: string): Promise<void> {
    const [row] = await withSystem(this.database, {}, (tx) =>
      tx.select({ id: schema.person.id }).from(schema.person).where(eq(schema.person.id, personId)),
    );
    if (!row) throw notFound('Person');
  }

  private async record(
    operator: { readonly personId: string | null; readonly label: string },
    personId: string,
    action: string,
    reason: string,
    result: { readonly twoFactorReset: boolean; readonly sessionsRevoked: number },
  ): Promise<void> {
    const platform = (
      await withSystem(this.database, {}, (tx) =>
        tx.execute<{ id: string | null }>(sql`select app.platform_company_id() as id`),
      )
    ).rows[0]?.id;
    if (platform)
      await withCompany(
        this.database,
        {
          companyId: platform,
          personId: operator.personId,
          actorKind: operator.personId ? 'platform_admin' : 'system',
        },
        (tx) =>
          this.audit.append(tx, {
            companyId: platform,
            action,
            recordType: 'person',
            recordId: personId,
            data: { reason, via: operator.label, ...result },
          }),
      );
    const companies = (await new MembershipDirectory(this.database).forPerson(personId))
      .filter((m) => m.status === 'active' && m.companyId !== platform)
      .map((m) => m.companyId);
    for (const companyId of new Set(companies))
      await withCompany(
        this.database,
        { companyId, personId: operator.personId, actorKind: 'system' },
        (tx) =>
          this.audit.append(tx, {
            companyId,
            action,
            recordType: 'person',
            recordId: personId,
            data: { by: 'platform', ...result },
          }),
      );
  }
}
