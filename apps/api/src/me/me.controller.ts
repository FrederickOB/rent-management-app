import { Controller, Inject } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract, type Me } from '@rent/contracts';
import { companyOf, roleOf } from '@rent/domain/policy';
import { invalid } from '@rent/server/core';
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
  constructor(@Inject(IdentityService) private readonly identity: IdentityService) {}

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
