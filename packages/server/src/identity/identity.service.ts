import { Inject, Injectable } from '@nestjs/common';
import { eq, schema, withSystem, type Database } from '@rent/db';
import { isPlatformRole, roleUsableWith, type Actor, type StaffRole } from '@rent/domain/policy';
import type { Clock } from '../core/clock';
import type { AppConfig } from '../core/config';
import { AUTH, CLOCK, CONFIG, DATABASE } from '../core/tokens';
import type { Auth } from './auth';
import { MembershipDirectory, type MembershipView } from './memberships';
import {
  classify,
  expiryFor,
  limitsFor,
  type SessionAuthMethod,
  type SessionClass,
} from './session-policy';

/** What a request may do, decided from its session (AD-06, ADR-011). */
export type SessionState =
  /** Password only: the person must enrol TOTP before anything else. */
  | 'enrolment_required'
  /** Several companies and none chosen yet. */
  | 'company_required'
  | 'ready';

export interface ResolvedSession {
  readonly sessionId: string;
  readonly personId: string;
  readonly personName: string;
  readonly authMethod: SessionAuthMethod;
  readonly sessionClass: SessionClass;
  readonly expiresAt: Date;
  readonly state: SessionState;
  /** Memberships this session may act with (strong enough for its sign-in method). */
  readonly memberships: readonly MembershipView[];
  readonly actor: Actor | null;
}

const SLIDE_GRANULARITY_MS = 60_000;

@Injectable()
export class IdentityService {
  private readonly directory: MembershipDirectory;

  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.directory = new MembershipDirectory(database);
  }

  /** Resolves the session behind `headers`, slides its expiry, and builds the actor. */
  async resolve(headers: Headers): Promise<ResolvedSession | null> {
    const result = await this.auth.api.getSession({ headers, query: { disableRefresh: true } });
    if (!result) return null;
    const { session, user } = result;
    const now = this.clock.now();
    if (session.expiresAt.getTime() <= now.getTime()) return null;

    const authMethod = ((session as { authMethod?: string }).authMethod ??
      'password') as SessionAuthMethod;
    const all = (await this.directory.forPerson(user.id)).filter(
      (m) => m.status === 'active' && m.companyStatus === 'active',
    );
    const sessionClass = classify(
      authMethod,
      all.map((m) => m.role),
    );
    const target = expiryFor(now, session.createdAt, limitsFor(sessionClass, this.config));
    if (target.getTime() <= now.getTime()) {
      // Past the absolute limit for this kind of session: sign it out everywhere.
      await withSystem(this.database, { personId: user.id }, (tx) =>
        tx.delete(schema.session).where(eq(schema.session.id, session.id)),
      );
      return null;
    }
    if (target.getTime() - session.expiresAt.getTime() > SLIDE_GRANULARITY_MS) {
      await withSystem(this.database, { personId: user.id }, (tx) =>
        tx
          .update(schema.session)
          .set({ expiresAt: target, updatedAt: now })
          .where(eq(schema.session.id, session.id)),
      );
    }

    const base = {
      sessionId: session.id,
      personId: user.id,
      personName: user.name,
      authMethod,
      sessionClass,
      expiresAt: target.getTime() > session.expiresAt.getTime() ? target : session.expiresAt,
    };
    if (authMethod === 'password') {
      return { ...base, state: 'enrolment_required', memberships: [], actor: null };
    }
    const usable = all.filter((m) => roleUsableWith(m.role, authMethod));
    const activeCompanyId =
      (session as { activeCompanyId?: string | null }).activeCompanyId ?? null;
    const active =
      usable.find((m) => m.companyId === activeCompanyId) ??
      (usable.length === 1 ? usable[0] : undefined);

    if (active)
      return {
        ...base,
        state: 'ready',
        memberships: usable,
        actor: this.actorFor(user.id, active, authMethod),
      };
    if (usable.length > 1)
      return { ...base, state: 'company_required', memberships: usable, actor: null };
    if (authMethod === 'phone_otp') {
      return {
        ...base,
        state: 'ready',
        memberships: [],
        actor: { kind: 'tenant', personId: user.id, authMethod },
      };
    }
    return { ...base, state: 'ready', memberships: [], actor: null };
  }

  /** Chooses the company a session works in. The membership must be usable by this session. */
  async setActiveCompany(resolved: ResolvedSession, companyId: string): Promise<boolean> {
    const membership = resolved.memberships.find((m) => m.companyId === companyId);
    if (!membership) return false;
    await withSystem(this.database, { personId: resolved.personId }, (tx) =>
      tx
        .update(schema.session)
        .set({ activeCompanyId: companyId, updatedAt: this.clock.now() })
        .where(eq(schema.session.id, resolved.sessionId)),
    );
    return true;
  }

  private actorFor(
    personId: string,
    m: MembershipView,
    authMethod: Exclude<SessionAuthMethod, 'password'>,
  ): Actor {
    if (isPlatformRole(m.role)) {
      return {
        kind: 'platform_admin',
        personId,
        companyId: m.companyId,
        membershipId: m.membershipId,
        authMethod,
      };
    }
    return {
      kind: 'staff',
      personId,
      companyId: m.companyId,
      companyKind: m.companyKind,
      membershipId: m.membershipId,
      role: m.role as StaffRole,
      nominatedApprover: m.nominatedApprover,
      scope: m.scope,
      authMethod,
      // M10 decision 11: only when read-only, so a full-access actor is as before; decision 12
      // (review BE-27): an ended subscription says so in its refusals.
      ...(m.companyAccess === 'read_only'
        ? {
            subscriptionAccess: 'read_only' as const,
            ...(m.companyEnded ? { subscriptionEnded: true as const } : {}),
          }
        : {}),
    };
  }
}
