import { Inject, Injectable } from '@nestjs/common';
import { sql, withCompany, withSystem, type Database, type Tx } from '@rent/db';
import type { Actor } from '@rent/domain/policy';
import { SUPPORT_GRANT_DEFAULT_HOURS, SUPPORT_GRANT_MAX_HOURS } from '@rent/domain/subscription';
import { AuditService } from '../audit/audit.service';
import { staffActor } from '../companies/companies.service';
import { AppError, conflict, invalid, notFound } from '../core/errors';
import { DATABASE } from '../core/tokens';
import { PolicyService, staffContext } from '../policy/policy.service';
import { platformAdminFor, platformSystemContext, type PlatformAdmin } from './platform-admin';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One request a platform admin made under a grant, from the customer's own chain. */
export interface SupportSessionView {
  readonly at: Date;
  readonly adminName: string;
  readonly route: string;
  readonly record: string | null;
}

/** A support grant (AD-10, decision 13), as the contract's `supportGrantSchema` carries it. */
export interface SupportGrantView {
  readonly id: string;
  readonly reason: string;
  readonly grantedBy: { readonly personId: string; readonly name: string };
  readonly from: Date;
  readonly until: Date;
  readonly revokedAt: Date | null;
  readonly revokedByName: string | null;
  /** Active now by the database's clock, as the guard in app.current_company_id() decides. */
  readonly active: boolean;
  readonly sessions: readonly SupportSessionView[];
}

export interface CompanySupportGrantView extends SupportGrantView {
  readonly company: { readonly id: string; readonly name: string };
}

/** A company opened read-only under its grant: counts and recent activity, no personal data. */
export interface SupportOverview {
  readonly company: { readonly id: string; readonly name: string };
  readonly grant: { readonly id: string; readonly until: Date; readonly reason: string };
  readonly counts: {
    readonly properties: number;
    readonly units: number;
    readonly leases: number;
    readonly tenants: number;
    readonly openApprovals: number;
  };
  readonly recentPayments: readonly {
    readonly id: string;
    readonly receivedOn: string;
    readonly amountMinor: number;
    readonly method: string;
  }[];
  readonly recentAudit: readonly {
    readonly at: Date;
    readonly action: string;
    readonly actorName: string | null;
  }[];
}

/** Refused: the company has granted no support access that is active now (decision 13). */
export const supportNoGrant = () =>
  new AppError(
    403,
    'support_no_grant',
    'This company has not granted support access, or its grant has ended. One of its admins can grant it under Settings, Subscription.',
  );

interface GrantRow extends Record<string, unknown> {
  id: string;
  company_id: string;
  company_name?: string;
  reason: string;
  granted_by: string;
  granted_by_name: string;
  starts_at: Date | string;
  ends_at: Date | string;
  revoked_at: Date | string | null;
  revoked_by_name: string | null;
  active: boolean;
}

interface SessionRow extends Record<string, unknown> {
  grant_id: string;
  occurred_at: Date | string;
  admin_name: string | null;
  route: string | null;
  record: string | null;
}

const at = (value: Date | string) => new Date(value);
const idArray = (ids: readonly string[]) => `{${ids.join(',')}}`;

function sessionsByGrant(rows: readonly SessionRow[]): Map<string, SupportSessionView[]> {
  const out = new Map<string, SupportSessionView[]>();
  for (const r of rows) {
    const list = out.get(r.grant_id) ?? [];
    list.push({
      at: at(r.occurred_at),
      adminName: r.admin_name ?? 'Platform support',
      route: r.route ?? '',
      record: r.record ?? null,
    });
    out.set(r.grant_id, list);
  }
  return out;
}

function grantView(r: GrantRow, sessions: readonly SupportSessionView[]): SupportGrantView {
  return {
    id: r.id,
    reason: r.reason,
    grantedBy: { personId: r.granted_by, name: r.granted_by_name },
    from: at(r.starts_at),
    until: at(r.ends_at),
    revokedAt: r.revoked_at === null ? null : at(r.revoked_at),
    revokedByName: r.revoked_by_name,
    active: r.active,
    sessions,
  };
}

/**
 * Support access (AD-10; M10 decision 13; plan 4.6).
 *
 * - A company's own admins (`support.grant`, allowed while read-only) grant the platform's support
 *   read-only access, for a reason and a time (24 hours by default, at most 7 days), and revoke it
 *   once. Both are in the company's audit chain: the row trigger, and `support.granted` and
 *   `support.revoked`.
 * - A platform admin (`support.use`) opens a company only through `withSupport`, which first
 *   appends `support.request` (route and record) to the company's chain as the platform admin,
 *   which the database allows only under an active grant, then runs the read in a read-only
 *   transaction in the company's context. Without a grant the API refuses with 403
 *   `support_no_grant`, and the database itself returns nothing: `app.current_company_id()` is
 *   null for a platform admin in a customer company that has granted nothing.
 * - Grants across companies, with their sessions, come through narrow functions
 *   (`app.support_grants_all`, `app.support_sessions`), never by entering a company.
 *
 * Every time here is the database's (`now()`), the same clock the guard reads.
 */
@Injectable()
export class SupportAccessService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // The company's admins ---------------------------------------------------------------------

  /** The grants the company made, newest first, each with the requests made under it. */
  async list(actor: Actor | null): Promise<SupportGrantView[]> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'support.grant');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const rows = await this.grantRows(tx);
      const sessions = await this.sessionsIn(
        tx,
        rows.map((r) => r.id),
      );
      return rows.map((r) => grantView(r, sessions.get(r.id) ?? []));
    });
  }

  async grant(
    actor: Actor | null,
    input: { readonly reason: string; readonly hours?: number | null },
    requestId?: string | null,
  ): Promise<SupportGrantView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'support.grant');
    const reason = input.reason.trim();
    if (reason.length < 5 || reason.length > 500)
      throw invalid('support_reason', 'Say why support needs access, in 5 to 500 characters');
    const hours = input.hours ?? SUPPORT_GRANT_DEFAULT_HOURS;
    if (!Number.isSafeInteger(hours) || hours < 1 || hours > SUPPORT_GRANT_MAX_HOURS)
      throw invalid(
        'support_hours',
        `Support access lasts from 1 hour to ${SUPPORT_GRANT_MAX_HOURS} hours (7 days)`,
      );
    return withCompany(this.database, staffContext(staff, requestId), async (tx) => {
      const inserted = await tx.execute<{ id: string; ends_at: Date | string }>(
        sql`insert into support_grant (company_id, granted_by, reason, starts_at, ends_at)
            values (${staff.companyId}::uuid, ${staff.personId}::uuid, ${reason}, now(),
                    now() + make_interval(hours => ${hours}::int))
            returning id, ends_at`,
      );
      const row = inserted.rows[0]!;
      await this.audit.append(tx, {
        companyId: staff.companyId,
        action: 'support.granted',
        recordType: 'support_grant',
        recordId: row.id,
        data: { hours, until: at(row.ends_at).toISOString() },
      });
      const [granted] = await this.grantRows(tx, row.id);
      return grantView(granted!, []);
    });
  }

  /** Ends a grant at once; a grant is revoked once (409 `support_grant_revoked` after that). */
  async revoke(
    actor: Actor | null,
    grantId: string,
    requestId?: string | null,
  ): Promise<SupportGrantView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'support.grant');
    if (!UUID.test(grantId)) throw notFound('Support grant');
    return withCompany(this.database, staffContext(staff, requestId), async (tx) => {
      const updated = await tx.execute<{ id: string }>(
        sql`update support_grant set revoked_at = now(), revoked_by = ${staff.personId}::uuid
            where id = ${grantId}::uuid and revoked_at is null
            returning id`,
      );
      if (updated.rows.length === 0) {
        const found = await this.grantRows(tx, grantId);
        if (found.length === 0) throw notFound('Support grant');
        throw conflict('support_grant_revoked', 'This support access was already revoked');
      }
      await this.audit.append(tx, {
        companyId: staff.companyId,
        action: 'support.revoked',
        recordType: 'support_grant',
        recordId: grantId,
        data: {},
      });
      const [row] = await this.grantRows(tx, grantId);
      const sessions = await this.sessionsIn(tx, [grantId]);
      return grantView(row!, sessions.get(grantId) ?? []);
    });
  }

  // Platform admins ------------------------------------------------------------------------

  /**
   * Runs `fn` in the company, read-only, as the platform admin, under the company's active grant
   * (decision 13). First, in a transaction of its own, the request (route and record) is appended
   * to the company's chain as `support.request`, so it is audited even if the read fails. 403
   * `support_no_grant` without an active grant.
   */
  async withSupport<T>(
    actor: Actor | null,
    companyId: string,
    route: string,
    record: string | null,
    fn: (tx: Tx, grantId: string) => Promise<T>,
    requestId?: string | null,
  ): Promise<T> {
    const admin = platformAdminFor(this.policy, actor, 'support.use');
    if (!UUID.test(companyId)) throw supportNoGrant();
    const context = {
      companyId,
      personId: admin.personId,
      actorKind: 'platform_admin' as const,
      requestId: requestId ?? null,
    };
    const grantId = await withCompany(this.database, context, async (tx) => {
      const found = await tx.execute<{ id: string | null }>(
        sql`select app.active_support_grant(${companyId}::uuid) as id`,
      );
      const id = found.rows[0]?.id ?? null;
      if (!id) return null;
      await this.audit.append(tx, {
        companyId,
        action: 'support.request',
        recordType: 'support_grant',
        recordId: id,
        data: { grantId: id, route, record },
      });
      return id;
    });
    if (!grantId) throw supportNoGrant();
    return withCompany(this.database, context, (tx) => fn(tx, grantId), {
      accessMode: 'read only',
    });
  }

  /** `platformAdmin.supportOverview`: a company opened read-only under its grant. */
  async overview(
    actor: Actor | null,
    companyId: string,
    requestId?: string | null,
  ): Promise<SupportOverview> {
    return this.withSupport(
      actor,
      companyId,
      'platformAdmin.supportOverview',
      null,
      async (tx, grantId) => {
        const company = await tx.execute<{ id: string; display_name: string }>(
          sql`select id, display_name from company where id = ${companyId}::uuid`,
        );
        const grant = await tx.execute<{ id: string; ends_at: Date | string; reason: string }>(
          sql`select id, ends_at, reason from support_grant where id = ${grantId}::uuid`,
        );
        const counts = await tx.execute<{
          properties: number;
          units: number;
          leases: number;
          tenants: number;
          open_approvals: number;
        }>(
          sql`select
                (select count(*) from property where archived_at is null)::int as properties,
                (select count(*) from unit where archived_at is null)::int as units,
                (select count(*) from lease
                  where status in ('signed', 'active', 'ending', 'holding_over'))::int as leases,
                (select count(*) from tenant where archived_at is null)::int as tenants,
                (select count(*) from approval_request
                  where status in ('pending', 'cooling_off'))::int as open_approvals`,
        );
        const payments = await tx.execute<{
          id: string;
          received_on: string;
          amount_minor: number;
          method: string;
        }>(
          sql`select id, received_on::text, amount_minor, method from payment
              order by received_on desc, created_at desc, id desc limit 10`,
        );
        const audit = await tx.execute<{
          occurred_at: Date | string;
          action: string;
          actor_name: string | null;
        }>(
          sql`select e.occurred_at, e.action, p.name as actor_name
              from audit_event e left join person p on p.id = e.actor_person_id
              order by e.seq desc limit 20`,
        );
        const c = company.rows[0];
        const g = grant.rows[0];
        // The guard let the session in, so both are visible; anything else is a broken grant.
        if (!c || !g) throw supportNoGrant();
        const n = counts.rows[0]!;
        return {
          company: { id: c.id, name: c.display_name },
          grant: { id: g.id, until: at(g.ends_at), reason: g.reason },
          counts: {
            properties: Number(n.properties),
            units: Number(n.units),
            leases: Number(n.leases),
            tenants: Number(n.tenants),
            openApprovals: Number(n.open_approvals),
          },
          recentPayments: payments.rows.map((p) => ({
            id: p.id,
            receivedOn: p.received_on,
            amountMinor: Number(p.amount_minor),
            method: p.method,
          })),
          recentAudit: audit.rows.map((e) => ({
            at: at(e.occurred_at),
            action: e.action,
            actorName: e.actor_name,
          })),
        };
      },
      requestId,
    );
  }

  /** `platformAdmin.supportGrants`: grants across companies, newest first, with their sessions. */
  async grantsAcrossCompanies(
    actor: Actor | null,
    activeOnly = false,
  ): Promise<CompanySupportGrantView[]> {
    const admin = platformAdminFor(this.policy, actor, 'support.use');
    return this.platformGrants(admin, { activeOnly });
  }

  /** One company's grants, for the console's company page (the caller has checked the policy). */
  async grantsOfCompany(admin: PlatformAdmin, companyId: string): Promise<SupportGrantView[]> {
    return this.platformGrants(admin, { activeOnly: false, companyId });
  }

  /** The companies with a grant active now (the caller has checked the policy). */
  async companiesWithActiveGrant(admin: PlatformAdmin): Promise<Set<string>> {
    const rows = await withSystem(this.database, platformSystemContext(admin), (tx) =>
      tx.execute<{ company_id: string }>(
        sql`select distinct company_id from app.support_grants_all(true)`,
      ),
    );
    return new Set(rows.rows.map((r) => r.company_id));
  }

  private async platformGrants(
    admin: PlatformAdmin,
    filter: { readonly activeOnly: boolean; readonly companyId?: string },
  ): Promise<CompanySupportGrantView[]> {
    return withSystem(this.database, platformSystemContext(admin), async (tx) => {
      const rows = await tx.execute<GrantRow>(
        sql`select g.id, g.company_id, g.company_name, g.reason, g.granted_by, g.granted_by_name,
              g.starts_at, g.ends_at, g.revoked_at, g.revoked_by_name,
              (g.revoked_at is null and g.starts_at <= now() and g.ends_at > now()) as active
            from app.support_grants_all(${filter.activeOnly}) g
            where ${filter.companyId ?? null}::uuid is null or g.company_id = ${filter.companyId ?? null}::uuid
            order by g.starts_at desc, g.id desc`,
      );
      const ids = rows.rows.map((r) => r.id);
      const sessions = sessionsByGrant(
        ids.length === 0
          ? []
          : (
              await tx.execute<SessionRow>(
                sql`select grant_id, occurred_at, admin_name, route, record
                    from app.support_sessions(${idArray(ids)}::uuid[])`,
              )
            ).rows,
      );
      return rows.rows.map((r) => ({
        ...grantView(r, sessions.get(r.id) ?? []),
        company: { id: r.company_id, name: r.company_name ?? '' },
      }));
    });
  }

  // Reads in the company's own context -------------------------------------------------------

  private async grantRows(tx: Tx, grantId?: string): Promise<GrantRow[]> {
    const rows = await tx.execute<GrantRow>(
      sql`select g.id, g.company_id, g.reason, g.granted_by, p.name as granted_by_name, g.starts_at,
            g.ends_at, g.revoked_at, r.name as revoked_by_name,
            (g.revoked_at is null and g.starts_at <= now() and g.ends_at > now()) as active
          from support_grant g
          join person p on p.id = g.granted_by
          left join person r on r.id = g.revoked_by
          where ${grantId ?? null}::uuid is null or g.id = ${grantId ?? null}::uuid
          order by g.starts_at desc, g.id desc`,
    );
    return rows.rows;
  }

  /** The `support.request` events in the company's own chain for these grants. */
  private async sessionsIn(
    tx: Tx,
    grantIds: readonly string[],
  ): Promise<Map<string, SupportSessionView[]>> {
    if (grantIds.length === 0) return new Map();
    const rows = await tx.execute<SessionRow>(
      sql`select e.record_id as grant_id, e.occurred_at, p.name as admin_name,
            e.data ->> 'route' as route, e.data ->> 'record' as record
          from audit_event e left join person p on p.id = e.actor_person_id
          where e.record_type = 'support_grant' and e.action = 'support.request'
            and e.record_id = any(${idArray(grantIds)}::text[])
          order by e.seq desc`,
    );
    return sessionsByGrant(rows.rows);
  }
}
