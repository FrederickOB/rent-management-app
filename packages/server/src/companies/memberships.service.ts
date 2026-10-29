import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  eq,
  inArray,
  schema,
  sql,
  withCompany,
  withSystem,
  type Database,
  type Tx,
} from '@rent/db';
import { maskPhone, normalisePhone } from '@rent/domain/phone';
import {
  checkMembershipScope,
  requiresPasswordAndTotp,
  type Actor,
  type MembershipScope,
  type StaffRole,
} from '@rent/domain/policy';
import type { AppConfig } from '../core/config';
import { conflict, invalid, notFound } from '../core/errors';
import { AUTH, CONFIG, DATABASE } from '../core/tokens';
import type { Auth } from '../identity/auth';
import { isPlaceholderEmail, PersonAccounts } from '../identity/person-accounts';
import { PolicyService } from '../policy/policy.service';
import { AuditService } from '../audit/audit.service';
import { staffActor, type StaffActor } from './companies.service';

export interface CompanyMember {
  readonly membershipId: string;
  readonly personId: string;
  readonly name: string;
  readonly email: string | null;
  readonly phoneMasked: string | null;
  readonly role: StaffRole;
  readonly status: 'invited' | 'active' | 'revoked';
  readonly nominatedApprover: boolean;
  readonly scope: MembershipScope;
  readonly createdAt: Date;
}

export interface Invite {
  readonly name: string;
  readonly email?: string;
  readonly phone?: string;
  readonly role: StaffRole;
  readonly nominatedApprover?: boolean;
}

const context = (actor: StaffActor) => ({
  companyId: actor.companyId,
  personId: actor.personId,
  actorKind: 'staff' as const,
});

/** Who works in a company and in which role (AD-03). Role and scope changes are audited (AD-07). */
@Injectable()
export class MembershipsService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(PersonAccounts) private readonly accounts: PersonAccounts,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async list(actor: Actor | null): Promise<CompanyMember[]> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'membership.view');
    return withCompany(this.database, context(staff), (tx) => this.select(tx, staff.companyId));
  }

  async invite(actor: Actor | null, input: Invite): Promise<CompanyMember> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'membership.manage');
    const passwordRole = requiresPasswordAndTotp(input.role);
    if (passwordRole && !input.email)
      throw invalid('email_required', 'Staff who sign in with a password need an email address');
    if (!passwordRole && !input.phone)
      throw invalid('phone_required', 'Caretakers sign in by phone; add their number');
    const phone = input.phone ? normalisePhone(input.phone) : undefined;

    const personId =
      (await this.findPerson(input.email, phone)) ??
      (await this.accounts.create({ name: input.name, email: input.email, phone })).personId;
    const membershipId = await withCompany(this.database, context(staff), async (tx) => {
      const existing = await tx
        .select({ id: schema.membership.id })
        .from(schema.membership)
        .where(
          and(
            eq(schema.membership.companyId, staff.companyId),
            eq(schema.membership.personId, personId),
            inArray(schema.membership.status, ['invited', 'active']),
          ),
        );
      if (existing.length > 0)
        throw conflict('already_member', 'This person already works in this company');
      const [row] = await tx
        .insert(schema.membership)
        .values({
          companyId: staff.companyId,
          personId,
          role: input.role,
          nominatedApprover: input.nominatedApprover ?? false,
          invitedBy: staff.personId,
        })
        .returning({ id: schema.membership.id });
      await this.audit.append(tx, {
        companyId: staff.companyId,
        action: 'membership.invited',
        recordType: 'membership',
        recordId: row!.id,
        data: { role: input.role },
      });
      return row!.id;
    });

    if (passwordRole && input.email) {
      // Better Auth's reset flow doubles as the invite: the email links to the set-password page.
      await this.auth.api.requestPasswordReset({
        body: { email: input.email, redirectTo: `${this.config.WEB_ORIGIN}/accept-invite` },
      });
    }
    return this.get(staff, membershipId);
  }

  async update(
    actor: Actor | null,
    membershipId: string,
    patch: { role?: StaffRole; scope?: MembershipScope; nominatedApprover?: boolean },
  ): Promise<CompanyMember> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'membership.manage');
    if (membershipId === staff.membershipId && patch.role)
      throw invalid('own_role', 'You cannot change your own role');
    await withCompany(this.database, context(staff), async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.membership)
        .where(eq(schema.membership.id, membershipId))
        .for('update');
      if (!current || current.status === 'revoked') throw notFound('Membership');
      // A role change is checked against the scope it will have, and a scope against the role
      // (AD-02; M2 plan 4.4). Invites start with no scope, which sees nothing for these roles.
      const scope =
        patch.role || patch.scope
          ? checkMembershipScope(
              patch.role ?? (current.role as StaffRole),
              staff.companyKind,
              patch.scope ?? (current.scope as MembershipScope),
            )
          : undefined;
      if (scope) await this.assertScopeInCompany(tx, scope);
      await tx
        .update(schema.membership)
        .set({
          ...(patch.role ? { role: patch.role } : {}),
          ...(scope ? { scope } : {}),
          ...(patch.nominatedApprover !== undefined
            ? { nominatedApprover: patch.nominatedApprover }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.membership.id, membershipId));
    });
    return this.get(staff, membershipId);
  }

  async revoke(actor: Actor | null, membershipId: string): Promise<CompanyMember> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'membership.manage');
    if (membershipId === staff.membershipId)
      throw invalid('own_membership', 'You cannot remove yourself');
    await withCompany(this.database, context(staff), async (tx) => {
      const rows = await tx
        .update(schema.membership)
        .set({ status: 'revoked', revokedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(schema.membership.id, membershipId),
            inArray(schema.membership.status, ['invited', 'active']),
          ),
        )
        .returning({ id: schema.membership.id });
      if (rows.length === 0) throw notFound('Membership');
    });
    return this.get(staff, membershipId);
  }

  /** Every owner and property a scope names must belong to this company (RLS keeps it there). */
  private async assertScopeInCompany(tx: Tx, scope: MembershipScope): Promise<void> {
    const owners = scope.owners ?? [];
    const properties = scope.properties ?? [];
    const ownerRows = owners.length
      ? await tx
          .select({ id: schema.owner.id })
          .from(schema.owner)
          .where(inArray(schema.owner.id, [...owners]))
      : [];
    const propertyRows = properties.length
      ? await tx
          .select({ id: schema.property.id })
          .from(schema.property)
          .where(inArray(schema.property.id, [...properties]))
      : [];
    if (ownerRows.length !== owners.length || propertyRows.length !== properties.length)
      throw invalid('scope_unknown', 'Choose owners and properties from this company');
  }

  private async get(staff: StaffActor, membershipId: string): Promise<CompanyMember> {
    const rows = await withCompany(this.database, context(staff), (tx) =>
      this.select(tx, staff.companyId, membershipId),
    );
    if (!rows[0]) throw notFound('Membership');
    return rows[0];
  }

  private async select(
    tx: Parameters<Parameters<typeof withCompany>[2]>[0],
    companyId: string,
    membershipId?: string,
  ): Promise<CompanyMember[]> {
    const m = schema.membership;
    const rows = await tx
      .select({
        membershipId: m.id,
        personId: m.personId,
        name: schema.person.name,
        email: schema.person.email,
        phone: schema.person.phoneNumber,
        role: m.role,
        status: m.status,
        nominatedApprover: m.nominatedApprover,
        scope: m.scope,
        createdAt: m.createdAt,
      })
      .from(m)
      .innerJoin(schema.person, eq(schema.person.id, m.personId))
      .where(
        membershipId
          ? and(eq(m.companyId, companyId), eq(m.id, membershipId))
          : eq(m.companyId, companyId),
      )
      .orderBy(sql`${m.status} = 'revoked'`, schema.person.name);
    return rows.map((r) => ({
      membershipId: r.membershipId,
      personId: r.personId,
      name: r.name,
      email: isPlaceholderEmail(r.email) ? null : r.email,
      phoneMasked: r.phone ? maskPhone(r.phone) : null,
      role: r.role as StaffRole,
      status: r.status as CompanyMember['status'],
      nominatedApprover: r.nominatedApprover,
      scope: (r.scope ?? {}) as MembershipScope,
      createdAt: r.createdAt,
    }));
  }

  private async findPerson(
    email: string | undefined,
    phone: string | undefined,
  ): Promise<string | null> {
    return withSystem(this.database, {}, async (tx) => {
      if (email) {
        const [row] = await tx
          .select({ id: schema.person.id })
          .from(schema.person)
          .where(eq(schema.person.email, email.toLowerCase()));
        if (row) return row.id;
      }
      if (phone) {
        const [row] = await tx
          .select({ id: schema.person.id })
          .from(schema.person)
          .where(eq(schema.person.phoneNumber, phone));
        if (row) return row.id;
      }
      return null;
    });
  }
}
