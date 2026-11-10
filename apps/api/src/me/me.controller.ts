import { Controller, Inject } from '@nestjs/common';
import { ArtisansService } from '@rent/server/maintenance';
import { Implement, implement } from '@orpc/nest';
import { contract, type Me } from '@rent/contracts';
import { companyOf, roleOf } from '@rent/domain/policy';
import { invalid } from '@rent/server/core';
import { MembershipsService } from '@rent/server/companies';
import { IdentityService, type ResolvedSession } from '@rent/server/identity';
import { AllowStates } from '../http/guards';
import { Ctx, type RequestContext } from '../http/request-context';

function toMe(session: ResolvedSession): Me {
  const actor = session.actor;
  return {
    personId: session.personId,
    name: session.personName,
    state: session.state,
    authMethod: session.authMethod,
    sessionExpiresAt: session.expiresAt.toISOString(),
    actorKind: actor && actor.kind !== 'system' ? actor.kind : null,
    activeCompanyId: actor?.kind === 'system' ? null : companyOf(actor),
    role: roleOf(actor),
    memberships: session.memberships.map((m) => ({
      membershipId: m.membershipId,
      companyId: m.companyId,
      companyName: m.companyName,
      companyKind: m.companyKind,
      role: m.role,
      nominatedApprover: m.nominatedApprover,
      scope: {
        owners: m.scope.owners ? [...m.scope.owners] : undefined,
        properties: m.scope.properties ? [...m.scope.properties] : undefined,
      },
    })),
  };
}

@Controller()
export class MeController {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(ArtisansService) private readonly staffAlerts: ArtisansService,
    @Inject(MembershipsService) private readonly memberships: MembershipsService,
  ) {}

  /** Founder D2 (M11): invitations waiting for the signed-in person. */
  @AllowStates('company_required', 'ready')
  @Implement(contract.me.invitations)
  invitations(@Ctx() ctx: RequestContext) {
    return implement(contract.me.invitations).handler(async () =>
      this.memberships.invitations((ctx.session as ResolvedSession).personId),
    );
  }

  @AllowStates('company_required', 'ready')
  @Implement(contract.me.acceptInvitation)
  acceptInvitation(@Ctx() ctx: RequestContext) {
    return implement(contract.me.acceptInvitation).handler(async ({ input }) => {
      const session = ctx.session as ResolvedSession;
      await this.memberships.acceptInvitation(
        { personId: session.personId, authMethod: session.authMethod },
        input.membershipId,
      );
      return toMe((await this.identity.resolve(ctx.headers)) ?? session);
    });
  }

  @AllowStates('company_required', 'ready')
  @Implement(contract.me.declineInvitation)
  declineInvitation(@Ctx() ctx: RequestContext) {
    return implement(contract.me.declineInvitation).handler(async ({ input }) => {
      await this.memberships.declineInvitation(
        { personId: (ctx.session as ResolvedSession).personId },
        input.membershipId,
      );
      return { declined: true as const };
    });
  }

  /** M8 (decision 5): the signed-in staff member's own WhatsApp opt-in for emergency alerts. */
  @Implement(contract.me.whatsappConsent)
  whatsappConsent(@Ctx() ctx: RequestContext) {
    return implement(contract.me.whatsappConsent).handler(() =>
      this.staffAlerts.ownWhatsApp(ctx.actor),
    );
  }

  @Implement(contract.me.setWhatsappConsent)
  setWhatsappConsent(@Ctx() ctx: RequestContext) {
    return implement(contract.me.setWhatsappConsent).handler(({ input }) =>
      this.staffAlerts.ownWhatsApp(ctx.actor, input.granted),
    );
  }

  @AllowStates('enrolment_required', 'company_required', 'ready')
  @Implement(contract.me.get)
  get(@Ctx() ctx: RequestContext) {
    return implement(contract.me.get).handler(() => toMe(ctx.session as ResolvedSession));
  }

  @AllowStates('company_required', 'ready')
  @Implement(contract.me.setActiveCompany)
  setActiveCompany(@Ctx() ctx: RequestContext) {
    return implement(contract.me.setActiveCompany).handler(async ({ input }) => {
      const session = ctx.session as ResolvedSession;
      if (!(await this.identity.setActiveCompany(session, input.companyId))) {
        throw invalid('company_not_available', 'You do not work in that company');
      }
      const refreshed = await this.identity.resolve(ctx.headers);
      return toMe(refreshed ?? session);
    });
  }
}
