import {
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PolicyAction } from '@rent/domain/policy';
import { AppError, forbidden, notAuthenticated } from '@rent/server/core';
import { IdentityService, type SessionState } from '@rent/server/identity';
import { PolicyService } from '@rent/server/policy';
import type { FastifyRequest } from 'fastify';
import { headersOf } from './request-context';

const PUBLIC = 'rent:public';
const STATES = 'rent:session-states';
const PERMISSION = 'rent:permission';

/** No session needed (health checks, public pages). */
export const Public = () => SetMetadata(PUBLIC, true);

/** Session states a route accepts; `ready` only by default. */
export const AllowStates = (...states: SessionState[]) => SetMetadata(STATES, states);

/** The policy action a route needs (AD-03). Checked by the policy service, nowhere else. */
export const RequirePermission = (action: PolicyAction) => SetMetadata(PERMISSION, action);

const STATE_MESSAGES: Record<SessionState, string> = {
  enrolment_required: 'Set up two-factor authentication before continuing',
  company_required: 'Choose a company before continuing',
  ready: '',
};

/** Resolves the session for every request and refuses routes the session may not use. */
@Injectable()
export class ActorGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;
    const session = await this.identity.resolve(headersOf(request));
    request.rentSession = session;
    if (!session) throw notAuthenticated();
    const allowed = this.reflector.getAllAndOverride<SessionState[]>(STATES, targets) ?? ['ready'];
    if (!allowed.includes(session.state))
      throw new AppError(403, session.state, STATE_MESSAGES[session.state]);
    return true;
  }
}

/** Applies @RequirePermission through PolicyService. Routes without it need only a session. */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PolicyService) private readonly policy: PolicyService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const action = this.reflector.getAllAndOverride<PolicyAction | undefined>(PERMISSION, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!action) return true;
    const actor = context.switchToHttp().getRequest<FastifyRequest>().rentSession?.actor;
    if (!actor) throw forbidden();
    this.policy.assert(actor, action);
    return true;
  }
}
