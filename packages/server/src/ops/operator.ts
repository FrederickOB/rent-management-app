import { sql, withCompany, type Database } from '@rent/db';
import { OPS_REASON_MAX, OPS_REASON_MIN } from '@rent/domain/ops';
import type { Actor, PolicyAction } from '@rent/domain/policy';
import { platformAdminFor } from '../admin/platform-admin';
import { AppError, invalid } from '../core/errors';
import type { PolicyService } from '../policy/policy.service';
import { platformCompanyId } from '../subscription/platform';

/**
 * Who replays a webhook or retries a job (decision 9): a platform admin in the console, or an
 * operator at the incident commands, named by their platform admin email. Either way a person,
 * whose id goes on the ops_action row and the webhook's replay fields.
 */
export interface OpsOperator {
  readonly personId: string;
  readonly via: 'console' | 'cli';
  readonly requestId?: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID.test(value);

/** The console's operator: a platform admin allowed `action`, through PolicyService. */
export function consoleOperator(
  policy: PolicyService,
  actor: Actor | null,
  action: Extract<PolicyAction, 'platform.ops.replay' | 'platform.ops.redrive'>,
  requestId?: string | null,
): OpsOperator {
  const admin = platformAdminFor(policy, actor, action);
  return { personId: admin.personId, via: 'console', requestId: requestId ?? null };
}

/** A replay's or retry's reason (decision 9): 5 to 500 characters, kept in the audit chain. */
export function opsReason(reason: string): string {
  const trimmed = (reason ?? '').trim();
  if (trimmed.length < OPS_REASON_MIN || trimmed.length > OPS_REASON_MAX)
    throw invalid(
      'bad_reason',
      `Give a reason of ${OPS_REASON_MIN} to ${OPS_REASON_MAX} characters; it is kept in the audit log`,
    );
  return trimmed;
}

/**
 * The incident commands' operator: an active platform admin, by email (never printed or logged).
 * Anyone else is refused, so the commands do what the console lets a platform admin do, no more.
 */
export async function operatorByEmail(database: Database, email: string): Promise<OpsOperator> {
  const address = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))
    throw invalid('bad_operator', 'Name the operator by their platform admin email');
  const platformId = await platformCompanyId(database);
  const found = await withCompany(database, { companyId: platformId, actorKind: 'system' }, (tx) =>
    tx.execute<{ id: string }>(
      sql`select p.id from membership m join person p on p.id = m.person_id
          where m.company_id = ${platformId}::uuid and m.role = 'platform_admin'
            and m.status = 'active' and lower(p.email) = ${address}`,
    ),
  );
  const personId = found.rows[0]?.id;
  if (!personId)
    throw new AppError(
      403,
      'not_a_platform_admin',
      'The operator must be an active platform admin, named by their email',
    );
  return { personId, via: 'cli' };
}
