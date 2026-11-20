import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  eq,
  isNull,
  schema,
  sql,
  withCompany,
  withSystem,
  type Database,
  type Tx,
} from '@rent/db';
import {
  CONSENT_CHANNELS,
  consentTextVersion,
  type ConsentChannel,
  type ConsentSource,
} from '@rent/domain/messaging';
import type { Actor } from '@rent/domain/policy';
import { companyRecord, staffActor } from '../companies/companies.service';
import type { Clock } from '../core/clock';
import { AppError, forbidden, notFound } from '../core/errors';
import { consumeRateLimit } from '../core/rate-limit';
import type { AppConfig } from '../core/config';
import { CLOCK, CONFIG, DATABASE } from '../core/tokens';
import { SigningHasher } from '../esign/secrets';
import { PolicyService, staffContext } from '../policy/policy.service';
import { TenantsService } from '../tenancy/tenants.service';
import { maskEmail, unsubscribeAddressHash } from './store';

type TenantActor = Extract<Actor, { kind: 'tenant' }>;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export interface ChannelConsentView {
  readonly channel: ConsentChannel;
  readonly granted: boolean;
  readonly source: ConsentSource | null;
  readonly recordedAt: Date | null;
  readonly reachable: boolean;
  readonly reason: 'address_changed' | null;
}

/**
 * Consent on every channel (CM-09; plan 4.8): staff record what a tenant or contact agreed to,
 * the app's notification toggle records push consent per landlord (decision 5), and the email
 * unsubscribe link withdraws email at once (decision 7). Every change is a new consent event.
 */
@Injectable()
export class MessagingConsentService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
  ) {}

  // Staff ----------------------------------------------------------------------------------------

  async get(actor: Actor | null, tenantId: string) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'tenant.view');
    return withCompany(this.database, staffContext(staff), (tx) => this.view(tx, tenantId));
  }

  async record(
    actor: Actor | null,
    tenantId: string,
    input: { contactId?: string | null; channel: ConsentChannel; action: 'grant' | 'withdraw' },
  ) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'tenant.manage');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const [tenant] = await tx
        .select({ id: schema.tenant.id })
        .from(schema.tenant)
        .where(eq(schema.tenant.id, tenantId));
      if (!tenant) throw notFound('Tenant');
      if (input.contactId) {
        const [contact] = await tx
          .select({ id: schema.tenantContact.id })
          .from(schema.tenantContact)
          .where(
            and(
              eq(schema.tenantContact.id, input.contactId),
              eq(schema.tenantContact.tenantId, tenantId),
              isNull(schema.tenantContact.archivedAt),
            ),
          );
        if (!contact) throw notFound('Contact');
      }
      await this.tenants.recordSystemConsent(tx, staff.companyId, {
        tenantId,
        contactId: input.contactId ?? null,
        channel: input.channel,
        action: input.action,
        source: 'staff',
        textVersion: consentTextVersion('staff', input.action),
        recordedBy: staff.personId,
      });
      return this.view(tx, tenantId);
    });
  }

  private async view(tx: Tx, tenantId: string) {
    const [tenant] = await tx
      .select({ id: schema.tenant.id, name: schema.tenant.displayName })
      .from(schema.tenant)
      .where(eq(schema.tenant.id, tenantId));
    if (!tenant) throw notFound('Tenant');
    const contacts = await tx
      .select({
        id: schema.tenantContact.id,
        name: schema.tenantContact.name,
        kind: schema.tenantContact.kind,
      })
      .from(schema.tenantContact)
      .where(
        and(eq(schema.tenantContact.tenantId, tenantId), isNull(schema.tenantContact.archivedAt)),
      )
      .orderBy(schema.tenantContact.name);
    const devices = await tx.execute<{ token: string }>(
      sql`select token from app.push_tokens_for_tenant(${tenantId}::uuid)`,
    );
    const subjects = [];
    for (const s of [
      { id: null as string | null, name: tenant.name, kind: 'tenant' },
      ...contacts,
    ]) {
      const point = await this.tenants.messagingPoint(tx, { tenantId, contactId: s.id });
      if (!point) continue;
      const reachable: Record<ConsentChannel, boolean> = {
        push: s.id === null && devices.rows.length > 0,
        whatsapp: Boolean(point.whatsappPhone),
        sms: Boolean(point.phone),
        email: Boolean(point.email),
      };
      subjects.push({
        contactId: s.id,
        name: s.name,
        kind: s.kind,
        channels: CONSENT_CHANNELS.map((channel): ChannelConsentView => {
          const e = point.consent[channel];
          return {
            channel,
            granted: e?.action === 'grant',
            source: (e?.source as ConsentSource | undefined) ?? null,
            recordedAt: e?.at ?? null,
            reachable: reachable[channel],
            reason: e?.textVersion === 'address_changed.v1' ? 'address_changed' : null,
          };
        }),
      });
    }
    return { tenantId, subjects };
  }

  // The tenant app's notification toggle (decision 5) -----------------------------------------

  private tenantActor(actor: Actor | null): TenantActor {
    if (!actor) throw forbidden();
    this.policy.assert(actor, 'messaging.own');
    switch (actor.kind) {
      case 'tenant':
        return actor;
      default:
        throw forbidden();
    }
  }

  async pushConsent(actor: Actor | null) {
    const tenant = this.tenantActor(actor);
    const out: { companyId: string; landlordName: string; granted: boolean }[] = [];
    for (const [companyId, tenantIds] of await tenancyCompanies(this.database, tenant.personId)) {
      out.push(
        await withCompany(
          this.database,
          { companyId, personId: tenant.personId, actorKind: 'tenant', tenantScope: { tenantIds } },
          async (tx) => ({
            companyId,
            landlordName: (await companyRecord(tx, companyId))?.displayName ?? '',
            granted: await this.pushGranted(tx, tenantIds),
          }),
        ),
      );
    }
    return out.sort((a, b) => a.landlordName.localeCompare(b.landlordName));
  }

  /** Granted when the latest push event of every one of the person's tenant records is a grant. */
  private async pushGranted(tx: Tx, tenantIds: readonly string[]): Promise<boolean> {
    if (tenantIds.length === 0) return false;
    const rows = await tx.execute<{ tenant_id: string; action: string }>(
      sql`select distinct on (tenant_id) tenant_id, action from consent_event
          where channel = 'push' and tenant_contact_id is null and tenant_id = any(${`{${tenantIds.join(',')}}`}::uuid[])
          order by tenant_id, recorded_at desc, id desc`,
    );
    return tenantIds.every((id) => rows.rows.find((r) => r.tenant_id === id)?.action === 'grant');
  }

  async setPushConsent(actor: Actor | null, input: { granted: boolean; companyId?: string }) {
    const tenant = this.tenantActor(actor);
    const companies = await tenancyCompanies(this.database, tenant.personId);
    if (input.companyId && !companies.has(input.companyId)) throw notFound('Landlord');
    for (const [companyId, tenantIds] of companies) {
      if (input.companyId && companyId !== input.companyId) continue;
      // Written in the system's name (tenants do not write consent rows), with the person on it.
      await withCompany(
        this.database,
        { companyId, personId: tenant.personId, actorKind: 'system' },
        async (tx) => {
          const action = input.granted ? 'grant' : 'withdraw';
          for (const tenantId of tenantIds) {
            const [latest] = (
              await tx.execute<{ action: string }>(
                sql`select action from consent_event where tenant_id = ${tenantId}::uuid and tenant_contact_id is null
                  and channel = 'push' order by recorded_at desc, id desc limit 1`,
              )
            ).rows;
            if (latest?.action === action) continue;
            await this.tenants.recordSystemConsent(tx, companyId, {
              tenantId,
              contactId: null,
              channel: 'push',
              action,
              source: 'tenant_app',
              textVersion: consentTextVersion('tenant_app', action),
            });
          }
        },
      );
    }
    return this.pushConsent(tenant);
  }

  // The email unsubscribe page (decision 7) ------------------------------------------------------

  /**
   * The email unsubscribe page (decision 7). M6 review L3, L4, L5: the link is bound to a keyed
   * hash of the address it went to. While that is still the address on record, it works for as
   * long as it exists (an opt-out is always honoured); once the address has changed, the page is
   * neutral and changes nothing. Opening is limited per browser address as well as per link; the
   * one-click confirm (RFC 8058, from a few mail providers' servers) only per link.
   */
  async unsubscribe(token: string, confirm: boolean, client?: { readonly ip: string }) {
    const nowMs = this.clock.now().getTime();
    const limited = async (key: string, count: number) =>
      !(await consumeRateLimit(this.database, key, { count, windowMinutes: 15 }, nowMs));
    if (await limited(`unsubscribe:${sha256(token)}`, 30))
      throw new AppError(429, 'rate_limited', 'Too many tries; wait a few minutes');
    // M11 review R3 F6: the browser's address as a keyed hash, never a plain SHA-256.
    const address = client?.ip
      ? new SigningHasher(this.config.BETTER_AUTH_SECRET).address(client.ip)
      : null;
    if (!confirm && address && (await limited(`unsubscribe-ip:${address}`, 60)))
      throw new AppError(429, 'rate_limited', 'Too many tries; wait a few minutes');
    const found = await withSystem(this.database, { actorKind: 'link' }, (tx) =>
      tx.execute<{ company_id: string; token_id: string }>(
        sql`select * from app.unsubscribe_token_company(${sha256(token)})`,
      ),
    );
    const match = found.rows[0];
    if (!match) return { screen: 'invalid' as const, landlordName: null, emailMasked: null };
    return withCompany(
      this.database,
      { companyId: match.company_id, actorKind: 'system' },
      async (tx) => {
        const [row] = await tx
          .select()
          .from(schema.unsubscribeToken)
          .where(eq(schema.unsubscribeToken.id, match.token_id));
        if (!row) return { screen: 'invalid' as const, landlordName: null, emailMasked: null };
        const landlordName = (await companyRecord(tx, match.company_id))?.displayName ?? null;
        const point = await this.tenants.messagingPoint(tx, {
          tenantId: row.tenantId,
          contactId: row.tenantContactId,
        });
        if (
          row.addressHash &&
          (!point?.email || unsubscribeAddressHash(this.config, point.email) !== row.addressHash)
        )
          return { screen: 'address_changed' as const, landlordName, emailMasked: null };
        const emailMasked = point?.email ? maskEmail(point.email) : null;
        const withdrawn = point?.consent.email?.action === 'withdraw';
        if (withdrawn) return { screen: 'done' as const, landlordName, emailMasked };
        // A link that cannot be checked against its address (issued before the binding) expires.
        if (!row.addressHash && row.expiresAt.getTime() <= nowMs)
          return { screen: 'expired' as const, landlordName, emailMasked };
        if (!confirm) return { screen: 'confirm' as const, landlordName, emailMasked };
        await this.tenants.recordSystemConsent(tx, match.company_id, {
          tenantId: row.tenantId,
          contactId: row.tenantContactId,
          channel: 'email',
          action: 'withdraw',
          source: 'email_unsubscribe',
          textVersion: consentTextVersion('email_unsubscribe', 'withdraw'),
        });
        return { screen: 'done' as const, landlordName, emailMasked };
      },
    );
  }
}

/** The person's tenant records by company, from the narrow system function (ids only, TL-12). */
export async function tenancyCompanies(
  database: Database,
  personId: string,
): Promise<Map<string, string[]>> {
  const rows = await withSystem(database, { personId, actorKind: 'tenant' }, (tx) =>
    tx.execute<{ company_id: string; tenant_id: string }>(
      sql`select company_id, tenant_id from app.tenancies_for_person(${personId}::uuid)`,
    ),
  );
  const byCompany = new Map<string, string[]>();
  for (const r of rows.rows)
    byCompany.set(r.company_id, [...(byCompany.get(r.company_id) ?? []), r.tenant_id]);
  return byCompany;
}
