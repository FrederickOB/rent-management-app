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
import { keptStep } from '@rent/domain/subscription';
import {
  checkMembershipScope,
  narrowsApproverSet,
  widensApproverSet,
  type ApproverShape,
  requiresPasswordAndTotp,
  roleUsableWith,
  scopeOf,
  scopeRuleFor,
  type Actor,
  type AuthMethod,
  type CompanyKind,
  type MembershipRole,
  type MembershipScope,
  type StaffRole,
} from '@rent/domain/policy';
import { z } from 'zod';
import { APPROVER_REMOVED_ACTION, ApprovalsService } from '../approvals/approvals.service';
import type { AppConfig } from '../core/config';
import { AppError, conflict, forbidden, invalid, notFound } from '../core/errors';
import { queueMessage } from '../core/messages';
import { AUTH, CONFIG, DATABASE } from '../core/tokens';
import type { Auth } from '../identity/auth';
import { MembershipDirectory } from '../identity/memberships';
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
  /**
   * Founder D1 (M11 review R2 F2): the approval request a change waits for, when it adds someone
   * to the people who can approve two-person actions. The membership is unchanged until then.
   */
  readonly approvalRequestId?: string;
}

export interface Invite {
  readonly name: string;
  readonly email?: string;
  readonly phone?: string;
  readonly role: StaffRole;
  readonly nominatedApprover?: boolean;
}

/** An invitation waiting for the invited person (founder D2). */
export interface PendingInvitation {
  readonly membershipId: string;
  readonly companyId: string;
  readonly companyName: string;
  /** A staff role, or `platform_admin` for an existing person added by platform:bootstrap. */
  readonly role: MembershipRole;
}

/** The approvals engine's action for a membership change that widens the approver set (D1). */
export const APPROVER_CHANGE_ACTION = 'membership.approver_change';

const scopeSchema = z
  .object({
    owners: z.array(z.string().uuid()).optional(),
    properties: z.array(z.string().uuid()).optional(),
  })
  .strict();
const stateSchema = z
  .object({ role: z.string(), nominatedApprover: z.boolean(), scope: scopeSchema })
  .strict();
const changeSchema = z
  .object({
    membershipId: z.string().uuid(),
    /**
     * Who the change is about, for the approver's screen (review C2): the name the inviter typed,
     * or the name this company sees, never another landlord's record of the person (TL-12).
     */
    personName: z.string().min(1).max(200),
    change: z.enum(['invite', 'update']),
    from: stateSchema.extend({ status: z.enum(['invited', 'active']) }).strict(),
    to: stateSchema,
    /** An invite of someone who already existed: approval alone does not make it active (D2). */
    needsAcceptance: z.boolean(),
  })
  .strict();
type Change = z.infer<typeof changeSchema>;

const context = (actor: StaffActor) => ({
  companyId: actor.companyId,
  personId: actor.personId,
  actorKind: 'staff' as const,
});

const NIL = '00000000-0000-0000-0000-000000000000';

/** A scope as stored and hashed in a request's payload. */
interface StoredScope {
  owners?: string[];
  properties?: string[];
}

interface MemberState {
  readonly role: string;
  readonly nominatedApprover: boolean;
  readonly scope: StoredScope;
}

/** A scope as stored: sorted lists, empty ones left out (so equal scopes hash the same). */
function canonicalScope(scope: MembershipScope | null | undefined): StoredScope {
  const owners = [...new Set(scope?.owners ?? [])].sort();
  const properties = [...new Set(scope?.properties ?? [])].sort();
  return { ...(owners.length ? { owners } : {}), ...(properties.length ? { properties } : {}) };
}

/**
 * Who works in a company and in which role (AD-03). Role and scope changes are audited (AD-07).
 *
 * M11 (security review R2 F1 to F3; founder decisions D1 and D2, 2026-11-10):
 * - nobody changes their own role, scope or nominated-approver flag, and a person limited to some
 *   owners or properties manages only people within that part of the company, giving no one more
 *   than they have themselves;
 * - a change that adds someone to the people who can approve two-person actions (an invite or a
 *   role change into an approver role, or a nomination) goes through the approvals engine; a
 *   single user follows OQ-29's cooling-off. A change that removes someone takes effect at once and
 *   is told to the other admins and to the person removed;
 * - an invite attaches to an existing person only through the identifier the role signs in with
 *   (email for password roles, phone for caretakers); that person's membership stays `invited`
 *   until they accept it from a session that proved that identifier. Caretakers never get an
 *   email stored. Responses echo the name the inviter typed, never another landlord's record.
 */
@Injectable()
export class MembershipsService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(PersonAccounts) private readonly accounts: PersonAccounts,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(CONFIG) private readonly config: AppConfig,
    // Founder D1: approver-widening changes go to the engine, in the same transaction.
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
  ) {
    approvals.register<Change>({
      actionType: APPROVER_CHANGE_ACTION,
      // Who may manage people; a nominated approver too, as for every action type.
      eligibleRoles: ['owner', 'agency_admin'],
      schema: changeSchema,
      onePerSubject: true,
      currentPayload: async (tx, request) => {
        const asked = changeSchema.parse(request.payload);
        const [row] = await tx
          .select()
          .from(schema.membership)
          .where(eq(schema.membership.id, asked.membershipId));
        if (!row || (row.status !== 'invited' && row.status !== 'active'))
          // Gone or removed: a role no row has, so the request is cancelled as changed.
          return { ...asked, from: { ...asked.from, role: '' } };
        return {
          ...asked,
          from: {
            role: row.role,
            nominatedApprover: row.nominatedApprover,
            scope: canonicalScope(row.scope as MembershipScope),
            status: row.status,
          },
        };
      },
      execute: async (tx, _request, change) => {
        if (change.change === 'invite') {
          if (change.needsAcceptance) return; // approved; active once the person accepts
          await tx
            .update(schema.membership)
            .set({ status: 'active', updatedAt: new Date() })
            .where(eq(schema.membership.id, change.membershipId));
          return;
        }
        await tx
          .update(schema.membership)
          .set({
            role: change.to.role,
            nominatedApprover: change.to.nominatedApprover,
            scope: change.to.scope,
            updatedAt: new Date(),
          })
          .where(eq(schema.membership.id, change.membershipId));
      },
    });
  }

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
    // D2: a caretaker's record never holds an email, whatever the form sent.
    const email = passwordRole ? input.email!.trim().toLowerCase() : undefined;
    const phone = input.phone ? normalisePhone(input.phone) : undefined;
    const scope = this.inviteScope(staff, input.role);
    const nominatedApprover = input.nominatedApprover ?? false;
    const widens = widensApproverSet(null, this.shape(staff, input.role, nominatedApprover));

    // D2: matched only through the identifier this role signs in with.
    const existing = passwordRole
      ? await this.personByEmail(email!)
      : await this.personByPhone(phone!);
    const personId =
      existing ??
      (
        await this.accounts.create({
          name: input.name,
          email,
          // M11 review B-M1: only the identifier the role signs in with. A phone typed beside a
          // password role's email is never stored: nobody proved it, and it could later link
          // its owner's tenancies to this record.
          phone: passwordRole ? undefined : phone,
        })
      ).personId;
    const needsAcceptance = existing !== null;
    const passwordSet = passwordRole && (await this.hasPassword(personId));

    const { membershipId, approvalRequestId } = await withCompany(
      this.database,
      context(staff),
      async (tx) => {
        const open = await tx
          .select({ id: schema.membership.id })
          .from(schema.membership)
          .where(
            and(
              eq(schema.membership.companyId, staff.companyId),
              eq(schema.membership.personId, personId),
              inArray(schema.membership.status, ['invited', 'active']),
            ),
          );
        if (open.length > 0)
          throw conflict('already_member', 'This person already works in this company');
        const status = needsAcceptance || widens ? 'invited' : 'active';
        const [row] = await tx
          .insert(schema.membership)
          .values({
            companyId: staff.companyId,
            personId,
            role: input.role,
            scope,
            nominatedApprover,
            status,
            invitedBy: staff.personId,
            invitedName: input.name,
          })
          .returning({ id: schema.membership.id });
        await this.audit.append(tx, {
          companyId: staff.companyId,
          action: 'membership.invited',
          recordType: 'membership',
          recordId: row!.id,
          data: { role: input.role, ...(widens ? { needsApproval: true } : {}) },
        });
        const requestId = widens
          ? await this.approvals.createInTx(tx, staff, {
              actionType: APPROVER_CHANGE_ACTION,
              subjectType: 'membership',
              subjectId: row!.id,
              propertyId: null,
              excludeApprovers: [personId],
              payload: {
                membershipId: row!.id,
                personName: input.name.trim().slice(0, 200),
                change: 'invite',
                from: { role: input.role, nominatedApprover, scope, status: 'invited' },
                to: { role: input.role, nominatedApprover, scope },
                needsAcceptance,
              } satisfies Change,
            })
          : undefined;
        // Someone who can already sign in is told where to accept; anyone else gets the
        // set-password link below, which is their invitation.
        if (needsAcceptance && (!passwordRole || passwordSet))
          await this.tellInvited(tx, staff, row!.id, personId, input.role);
        return { membershipId: row!.id, approvalRequestId: requestId };
      },
    );

    if (passwordRole && !passwordSet) {
      // Better Auth's reset flow doubles as the invite: the email links to the set-password page.
      await this.auth.api.requestPasswordReset({
        body: { email: email!, redirectTo: `${this.config.WEB_ORIGIN}/accept-invite` },
      });
    }
    const member = await this.get(staff, membershipId);
    return {
      ...member,
      // Never another landlord's record of this person (TL-12): what the inviter typed.
      name: input.name,
      ...(approvalRequestId ? { approvalRequestId } : {}),
    };
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
    // R2 F1: nor their own scope or nominated-approver flag.
    if (
      membershipId === staff.membershipId &&
      (patch.scope !== undefined || patch.nominatedApprover !== undefined)
    )
      throw invalid('own_membership', 'Someone else must change your access');
    const approvalRequestId = await withCompany(this.database, context(staff), async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.membership)
        .where(eq(schema.membership.id, membershipId))
        .for('update');
      if (!current || current.status === 'revoked') throw notFound('Membership');
      const before: MemberState = {
        role: current.role,
        nominatedApprover: current.nominatedApprover,
        scope: canonicalScope(current.scope as MembershipScope),
      };
      await this.assertManages(tx, staff, before);
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
      const after: MemberState = {
        role: patch.role ?? current.role,
        nominatedApprover: patch.nominatedApprover ?? current.nominatedApprover,
        scope: canonicalScope(scope ?? before.scope),
      };
      if (scope) await this.assertWithinOwnScope(tx, staff, after);

      if (widensApproverSet(this.shapeOf(staff, before), this.shapeOf(staff, after))) {
        return this.approvals.createInTx(tx, staff, {
          actionType: APPROVER_CHANGE_ACTION,
          subjectType: 'membership',
          subjectId: membershipId,
          propertyId: null,
          excludeApprovers: [current.personId],
          payload: {
            membershipId,
            personName: await this.nameSeenBy(tx, current),
            change: 'update',
            from: { ...before, status: current.status as 'invited' | 'active' },
            to: after,
            needsAcceptance: false,
          } satisfies Change,
        });
      }
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
      if (
        current.status === 'active' &&
        narrowsApproverSet(this.shapeOf(staff, before), this.shapeOf(staff, after))
      )
        await this.approverRemoved(tx, staff, membershipId, current.personId, 'changed');
      return undefined;
    });
    const member = await this.get(staff, membershipId);
    return approvalRequestId ? { ...member, approvalRequestId } : member;
  }

  async revoke(actor: Actor | null, membershipId: string): Promise<CompanyMember> {
    const staff = staffActor(actor);
    // M10 review BE-18: removing someone stays open while the subscription is read-only (their
    // sessions lose the company at once); who may is still `membership.manage`'s roles.
    const removal = keptStep(staff, 'membership.revoke');
    this.policy.assert(removal.actor, removal.action);
    if (membershipId === staff.membershipId)
      throw invalid('own_membership', 'You cannot remove yourself');
    await withCompany(this.database, context(staff), async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.membership)
        .where(eq(schema.membership.id, membershipId))
        .for('update');
      if (!current || (current.status !== 'invited' && current.status !== 'active'))
        throw notFound('Membership');
      const before: MemberState = {
        role: current.role,
        nominatedApprover: current.nominatedApprover,
        scope: canonicalScope(current.scope as MembershipScope),
      };
      await this.assertManages(tx, staff, before);
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
      // Founder D1: removing an approver is immediate, and told to the others and to them.
      if (current.status === 'active' && narrowsApproverSet(this.shapeOf(staff, before), null))
        await this.approverRemoved(tx, staff, membershipId, current.personId, 'removed');
    });
    return this.get(staff, membershipId);
  }

  /** The signed-in person's invitations waiting for them (D2). */
  async invitations(personId: string): Promise<PendingInvitation[]> {
    return (await new MembershipDirectory(this.database).forPerson(personId))
      .filter((m) => m.status === 'invited' && m.companyStatus === 'active')
      .map((m) => ({
        membershipId: m.membershipId,
        companyId: m.companyId,
        companyName: m.companyName,
        role: m.role,
      }));
  }

  /**
   * The invited person accepts (D2). Only from a session that proved the identifier the role
   * signs in with: a password and TOTP for password roles, an SMS code for caretakers. When the
   * invite needed a second person's approval (D1), it must have been approved first.
   */
  async acceptInvitation(
    session: { readonly personId: string; readonly authMethod: AuthMethod | 'password' },
    membershipId: string,
  ): Promise<PendingInvitation> {
    const invitation = await this.invitationOf(session.personId, membershipId);
    if (session.authMethod === 'password' || !roleUsableWith(invitation.role, session.authMethod))
      throw new AppError(
        403,
        'sign_in_method',
        requiresPasswordAndTotp(invitation.role)
          ? 'Sign in with your email, password and authenticator app to accept this invitation'
          : 'Sign in with a code sent to your phone to accept this invitation',
      );
    await withCompany(
      this.database,
      { companyId: invitation.companyId, personId: session.personId, actorKind: 'staff' },
      async (tx) => {
        const approval = await this.approvals.latestForSubject(tx, 'membership', membershipId, [
          APPROVER_CHANGE_ACTION,
        ]);
        if (approval && approval.status !== 'approved') {
          if (approval.status === 'pending' || approval.status === 'cooling_off')
            throw conflict(
              'invitation_awaiting_approval',
              'This invitation is waiting for a second person in the company to approve it',
            );
          throw conflict('invitation_refused', 'This invitation was not approved');
        }
        const rows = await tx
          .update(schema.membership)
          .set({ status: 'active', updatedAt: new Date() })
          .where(
            and(
              eq(schema.membership.id, membershipId),
              eq(schema.membership.personId, session.personId),
              eq(schema.membership.status, 'invited'),
            ),
          )
          .returning({ id: schema.membership.id });
        if (rows.length === 0) throw notFound('Invitation');
        await this.audit.append(tx, {
          companyId: invitation.companyId,
          action: 'membership.accepted',
          recordType: 'membership',
          recordId: membershipId,
          data: { role: invitation.role, authMethod: session.authMethod },
        });
      },
    );
    return invitation;
  }

  /** The invited person declines: the invitation is revoked (D2). */
  async declineInvitation(
    session: { readonly personId: string },
    membershipId: string,
  ): Promise<void> {
    const invitation = await this.invitationOf(session.personId, membershipId);
    await withCompany(
      this.database,
      { companyId: invitation.companyId, personId: session.personId, actorKind: 'staff' },
      async (tx) => {
        const rows = await tx
          .update(schema.membership)
          .set({ status: 'revoked', revokedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(schema.membership.id, membershipId),
              eq(schema.membership.personId, session.personId),
              eq(schema.membership.status, 'invited'),
            ),
          )
          .returning({ id: schema.membership.id });
        if (rows.length === 0) throw notFound('Invitation');
        await this.audit.append(tx, {
          companyId: invitation.companyId,
          action: 'membership.declined',
          recordType: 'membership',
          recordId: membershipId,
          data: { role: invitation.role },
        });
      },
    );
  }

  private async invitationOf(personId: string, membershipId: string): Promise<PendingInvitation> {
    const invitation = (await this.invitations(personId)).find(
      (i) => i.membershipId === membershipId,
    );
    if (!invitation) throw notFound('Invitation');
    return invitation;
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

  /**
   * R2 F1: a person limited to some owners or properties invites within that part only. Their
   * invitee starts with their own lists (those the role uses), never the whole company.
   */
  private inviteScope(staff: StaffActor, role: StaffRole): StoredScope {
    const own = scopeOf(staff);
    if (!own) return {};
    const rule = scopeRuleFor(role, staff.companyKind);
    return canonicalScope({
      owners: rule.owners === 'unused' ? [] : own.ownerIds,
      properties: rule.properties === 'unused' ? [] : own.propertyIds,
    });
  }

  /** R2 F1: a scoped person changes or removes only people inside their own part of the company. */
  private async assertManages(tx: Tx, staff: StaffActor, target: MemberState): Promise<void> {
    if (!scopeOf(staff)) return;
    await this.assertWithinOwnScope(tx, staff, target);
  }

  /** The target's view of the company must be within the actor's: owners and resolved properties. */
  private async assertWithinOwnScope(
    tx: Tx,
    staff: StaffActor,
    target: MemberState,
  ): Promise<void> {
    const own = scopeOf(staff);
    if (!own) return;
    const refusal = forbidden(
      'You can give people access only within the owners and properties you have yourself',
    );
    const theirs = scopeOf(this.candidate(staff, target));
    if (!theirs) throw refusal; // the whole company
    if (!theirs.ownerIds.every((o) => own.ownerIds.includes(o))) throw refusal;
    const resolve = async (ids: { ownerIds: readonly string[]; propertyIds: readonly string[] }) =>
      (
        await tx.execute<{ scope: string[] | null }>(
          sql`select app.resolve_property_scope(${`{${ids.ownerIds.join(',')}}`}::uuid[],
                ${`{${ids.propertyIds.join(',')}}`}::uuid[])::text[] as scope`,
        )
      ).rows[0]?.scope ?? [];
    const ownProperties = new Set(await resolve(own));
    if (!(await resolve(theirs)).every((p) => ownProperties.has(p))) throw refusal;
  }

  /** A membership of this shape as the actor the guard would build, for the policy to judge. */
  private candidate(staff: StaffActor, state: MemberState): StaffActor {
    return {
      kind: 'staff',
      personId: NIL,
      companyId: staff.companyId,
      companyKind: staff.companyKind as CompanyKind,
      membershipId: NIL,
      role: state.role as StaffRole,
      nominatedApprover: state.nominatedApprover,
      scope: state.scope,
      authMethod: 'password_totp',
    };
  }

  /** A membership's shape for the domain's approver-set rules (founder D1). */
  private shape(staff: StaffActor, role: string, nominatedApprover: boolean): ApproverShape {
    return { role: role as StaffRole, nominatedApprover, companyKind: staff.companyKind };
  }

  private shapeOf(staff: StaffActor, state: MemberState): ApproverShape {
    return this.shape(staff, state.role, state.nominatedApprover);
  }

  /**
   * D1: someone left the approver set. Recorded (single-user requests in the next 30 days are told
   * to them) and told to the company's other admins and to the person.
   */
  private async approverRemoved(
    tx: Tx,
    staff: StaffActor,
    membershipId: string,
    personId: string,
    how: 'removed' | 'changed',
  ): Promise<void> {
    await this.audit.append(tx, {
      companyId: staff.companyId,
      action: APPROVER_REMOVED_ACTION,
      recordType: 'person',
      recordId: personId,
      data: { membershipId, how },
    });
    const admins = await tx
      .select({ personId: schema.membership.personId, role: schema.membership.role })
      .from(schema.membership)
      .where(eq(schema.membership.status, 'active'));
    const recipients = new Set(
      admins
        .filter(
          (m) =>
            this.policy.can(
              { ...this.candidate(staff, { role: m.role, nominatedApprover: false, scope: {} }) },
              'membership.manage',
            ).allowed,
        )
        .map((m) => m.personId),
    );
    recipients.add(personId);
    recipients.delete(staff.personId);
    for (const recipient of recipients)
      await queueMessage(tx, staff.companyId, {
        recipient: { type: 'staff', personId: recipient },
        purpose: 'staff_notice',
        channels: ['email', 'sms'],
        subject: 'Someone can no longer approve requests',
        body:
          how === 'removed'
            ? 'A person who could approve requests in your company was removed from it. If you did not expect this, contact your company admin at once.'
            : 'A person in your company can no longer approve requests: their role changed. If you did not expect this, contact your company admin at once.',
        related: { type: 'membership', id: membershipId },
      });
  }

  /** D2: an existing person is told they were invited, on the channel their role signs in with. */
  private async tellInvited(
    tx: Tx,
    staff: StaffActor,
    membershipId: string,
    personId: string,
    role: StaffRole,
  ): Promise<void> {
    const [company] = await tx
      .select({ name: schema.company.displayName })
      .from(schema.company)
      .where(eq(schema.company.id, staff.companyId));
    const where = requiresPasswordAndTotp(role)
      ? `Sign in at ${this.config.WEB_ORIGIN} to accept or decline.`
      : `Sign in with your phone at ${this.config.WEB_ORIGIN} to accept or decline.`;
    await queueMessage(tx, staff.companyId, {
      recipient: { type: 'staff', personId },
      purpose: 'staff_notice',
      channels: requiresPasswordAndTotp(role) ? ['email'] : ['sms'],
      subject: `${this.config.APP_NAME}: an invitation from ${company?.name ?? 'a company'}`,
      body: `${company?.name ?? 'A company'} invited you to work with them on ${this.config.APP_NAME}. ${where}`,
      related: { type: 'membership', id: membershipId },
    });
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
        invitedName: m.invitedName,
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
    return rows.map((r) => {
      // D2 (TL-12): until someone accepts, the company sees what it typed, and only the
      // identifier the role signs in with, never the rest of another landlord's record.
      const pending = r.status === 'invited';
      const passwordRole = requiresPasswordAndTotp(r.role as StaffRole);
      return {
        membershipId: r.membershipId,
        personId: r.personId,
        name: pending ? (r.invitedName ?? r.name) : r.name,
        email: isPlaceholderEmail(r.email) || (pending && !passwordRole) ? null : r.email,
        phoneMasked: r.phone && !(pending && passwordRole) ? maskPhone(r.phone) : null,
        role: r.role as StaffRole,
        status: r.status as CompanyMember['status'],
        nominatedApprover: r.nominatedApprover,
        scope: (r.scope ?? {}) as MembershipScope,
        createdAt: r.createdAt,
      };
    });
  }

  private async personByEmail(email: string): Promise<string | null> {
    return withSystem(this.database, {}, async (tx) => {
      const [row] = await tx
        .select({ id: schema.person.id })
        .from(schema.person)
        .where(eq(schema.person.email, email));
      return row?.id ?? null;
    });
  }

  /**
   * The person a caretaker invite attaches to (M11 review B-M1): one whose phone is verified, or a
   * phone-only person (no real email, no password), whom only the phone's owner can sign in as. An
   * unverified phone on anyone else's record was never proved: it is released from that record,
   * as app.ensure_tenant_person does, and the caller makes a new person for it.
   */
  private async personByPhone(phone: string): Promise<string | null> {
    return withSystem(this.database, {}, async (tx) => {
      const result = await tx.execute<{ id: string }>(sql`
        select p.id from person p
        where p.phone_number = ${phone}
          and (p.phone_number_verified is true
               or (p.email like '%@users.invalid'
                   and not exists (select 1 from account a
                                   where a.user_id = p.id and a.provider_id = 'credential')))`);
      if (result.rows[0]) return result.rows[0].id;
      await tx
        .update(schema.person)
        .set({ phoneNumber: null, phoneNumberVerified: null, updatedAt: new Date() })
        .where(
          sql`${schema.person.phoneNumber} = ${phone} and ${schema.person.phoneNumberVerified} is not true`,
        );
      return null;
    });
  }

  /** The name this company sees for a member: what it typed while invited, else their own. */
  private async nameSeenBy(
    tx: Tx,
    membership: {
      readonly personId: string;
      readonly status: string;
      readonly invitedName: string | null;
    },
  ): Promise<string> {
    if (membership.status === 'invited' && membership.invitedName) return membership.invitedName;
    const [row] = await tx
      .select({ name: schema.person.name })
      .from(schema.person)
      .where(eq(schema.person.id, membership.personId));
    return (row?.name ?? 'Member').slice(0, 200);
  }

  private async hasPassword(personId: string): Promise<boolean> {
    return withSystem(this.database, { personId }, async (tx) => {
      const rows = await tx
        .select({ id: schema.account.id })
        .from(schema.account)
        .where(
          and(
            eq(schema.account.userId, personId),
            eq(schema.account.providerId, 'credential'),
            sql`${schema.account.password} is not null`,
          ),
        );
      return rows.length > 0;
    });
  }
}
