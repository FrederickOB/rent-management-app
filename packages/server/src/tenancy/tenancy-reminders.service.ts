import { Inject, Injectable } from '@nestjs/common';
import { schema, sql, withCompany, type Database, type Tx } from '@rent/db';
import { addDays, formatBusinessDate, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { isPlatformRole, type Actor, type StaffRole } from '@rent/domain/policy';
import {
  dueReminderSteps,
  dueRenewalReminders,
  reminderToSend,
  type ReminderStep,
} from '@rent/domain/tenancy';
import type { Clock } from '../core/clock';
import { queueMessage } from '../core/messages';
import { CLOCK, DATABASE } from '../core/tokens';
import { activeMembers } from '../identity/memberships';
import { PolicyService } from '../policy/policy.service';
import { companyFacts, todayIn, type CompanyFacts } from './lease-records';
import { uuidArray } from './tenants.service';

export const RENEWAL_REMINDERS_JOB = 'tenancy.renewal-reminders';
export const RENT_CONTROL_REMINDERS_JOB = 'tenancy.rent-control-reminders';
export const STAMPING_REMINDERS_JOB = 'tenancy.stamping-reminders';
export const FORMAL_LEASE_REMINDERS_JOB = 'tenancy.formal-lease-reminders';

type LeaseFacts = {
  readonly id: string;
  readonly property_id: string;
  readonly unit_code: string;
  readonly property_name: string;
  readonly tenant_name: string;
  readonly end_date: string;
  readonly rent_control_deadline: string | null;
  readonly stamp_deadline: string | null;
  readonly formal_practitioner: string | null;
  readonly formal_wet_signed_document_id: string | null;
  readonly formal_registered_on: string | null;
  readonly period_count: number;
};

const LEASE_FACTS = sql`select l.id, l.property_id, u.code as unit_code, p.name as property_name,
    coalesce(t.display_name, '') as tenant_name, l.end_date, l.rent_control_deadline, l.stamp_deadline,
    l.formal_practitioner, l.formal_wet_signed_document_id, l.formal_registered_on,
    (select count(*)::int from charge_period c where c.company_id = l.company_id and c.lease_id = l.id
       and c.charge_type = 'rent' and c.source = 'schedule') as period_count
  from lease l
  join unit u on u.company_id = l.company_id and u.id = l.unit_id
  join property p on p.company_id = l.company_id and p.id = l.property_id
  left join tenant t on t.company_id = l.company_id and t.id = l.tenant_id`;

const UNVERIFIED = 'This period comes from the rules table and is unverified: counsel to confirm.';

/**
 * Staff reminders (M3 plan 4.10, 4.11 and 4.17): renewals at 90, 60 and 30 days, and the Rent
 * Control, stamping and formal-lease trackers. Each step is sent once, by email to the people who
 * manage the property and to its owner's users; after a gap only the latest step goes out.
 * Nothing here blocks a lease or rent collection.
 */
@Injectable()
export class TenancyRemindersService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** `tenancy.renewal-reminders` (TL-09): leases ending, with no renewal signed or out for signing. */
  async renewals(companyId: string, today?: string): Promise<number> {
    return this.run(companyId, today, RENEWAL_REMINDERS_JOB, async (tx, company, day) => {
      const leases = await tx.execute<LeaseFacts>(
        sql`${LEASE_FACTS} where l.status = 'active'
            and not exists (select 1 from lease r where r.company_id = l.company_id and r.renews_lease_id = l.id
              and r.status in ('pending_signatures', 'signed', 'active'))`,
      );
      let sent = 0;
      for (const lease of leases.rows) {
        const due = dueRenewalReminders(lease.end_date, company.settings.renewalReminderDays, day);
        sent += await this.remind(tx, company, lease, RENEWAL_REMINDERS_JOB, due, (step) => {
          const days = Number(step.key.replace('before-', ''));
          return {
            subject: `Lease ending in ${days} days: ${lease.unit_code}`,
            body: `The lease for ${lease.unit_code} at ${lease.property_name} (${lease.tenant_name}) ends on ${formatBusinessDate(lease.end_date)}. Offer a renewal, or record that it will not be renewed.`,
          };
        });
      }
      return sent;
    });
  }

  /** `tenancy.rent-control-reminders` (TX-05): until the registration number and date are recorded. */
  async rentControl(companyId: string, today?: string): Promise<number> {
    return this.run(companyId, today, RENT_CONTROL_REMINDERS_JOB, async (tx, company, day) => {
      const leases = await tx.execute<LeaseFacts>(
        sql`${LEASE_FACTS} where l.status in ('signed', 'active', 'ending', 'holding_over')
            and l.rent_control_applies and l.rent_control_registered_on is null
            and l.rent_control_deadline is not null`,
      );
      let sent = 0;
      for (const lease of leases.rows) {
        const due = dueReminderSteps(
          lease.rent_control_deadline!,
          company.settings.rentControlReminderDaysBefore,
          day,
        );
        sent += await this.remind(tx, company, lease, RENT_CONTROL_REMINDERS_JOB, due, () => ({
          subject: `Rent Control registration: ${lease.unit_code}`,
          body: `Register the lease for ${lease.unit_code} at ${lease.property_name} (${lease.tenant_name}) with Rent Control by ${formatBusinessDate(lease.rent_control_deadline!)}, then record the registration number and date on the lease. ${UNVERIFIED} (OQ-52) Rent collection is not affected.`,
        }));
      }
      return sent;
    });
  }

  /** `tenancy.stamping-reminders` (OQ-45): until the stamped copy and its date are recorded. */
  async stamping(companyId: string, today?: string): Promise<number> {
    return this.run(companyId, today, STAMPING_REMINDERS_JOB, async (tx, company, day) => {
      const leases = await tx.execute<LeaseFacts>(
        sql`${LEASE_FACTS} where l.status in ('signed', 'active', 'ending', 'holding_over')
            and l.stamp_deadline is not null and (l.stamped_on is null or l.stamped_document_id is null)`,
      );
      let sent = 0;
      for (const lease of leases.rows) {
        const due = dueReminderSteps(
          lease.stamp_deadline!,
          company.settings.stampingReminderDaysBefore,
          day,
        );
        sent += await this.remind(tx, company, lease, STAMPING_REMINDERS_JOB, due, () => ({
          subject: `Stamp the tenancy agreement: ${lease.unit_code}`,
          body: `The tenancy agreement for ${lease.unit_code} at ${lease.property_name} (${lease.tenant_name}) is due to be stamped by ${formatBusinessDate(lease.stamp_deadline!)}. Upload the stamped copy and its date on the lease. ${UNVERIFIED} (OQ-45)`,
        }));
      }
      return sent;
    });
  }

  /** `tenancy.formal-lease-reminders` (OQ-44): weekly, until the formal lease is complete. */
  async formalLeases(companyId: string, today?: string): Promise<number> {
    return this.run(companyId, today, FORMAL_LEASE_REMINDERS_JOB, async (tx, company, day) => {
      const leases = await tx.execute<LeaseFacts>(
        sql`${LEASE_FACTS} where l.status in ('signed', 'active', 'ending', 'holding_over')
            and l.formal_required
            and (l.formal_practitioner is null or l.formal_wet_signed_document_id is null
                 or l.formal_registered_on is null)`,
      );
      const date = parseBusinessDate(day);
      const week = toIsoDate(addDays(date, 1 - date.dayOfWeek)); // the Monday of this week
      let sent = 0;
      for (const lease of leases.rows) {
        const missing = [
          lease.formal_practitioner ? null : 'the legal practitioner',
          lease.formal_wet_signed_document_id ? null : 'the wet-signed copy',
          lease.formal_registered_on ? null : 'the Lands Commission registration',
        ].filter(Boolean);
        sent += await this.remind(
          tx,
          company,
          lease,
          FORMAL_LEASE_REMINDERS_JOB,
          [{ key: `week-${week}`, date: week }],
          () => ({
            subject: `Formal lease needed: ${lease.unit_code}`,
            body: `The lease for ${lease.unit_code} at ${lease.property_name} (${lease.tenant_name}) runs for ${lease.period_count} months, longer than the writing exemption, so it takes the formal path. Still to record: ${missing.join(', ')}. ${UNVERIFIED} (OQ-44) Nothing is blocked.`,
          }),
        );
      }
      return sent;
    });
  }

  // Internals ------------------------------------------------------------------------------------

  private run(
    companyId: string,
    today: string | undefined,
    job: string,
    fn: (tx: Tx, company: CompanyFacts, day: string) => Promise<number>,
  ): Promise<number> {
    return withCompany(
      this.database,
      { companyId, actorKind: 'system', requestId: `job:${job}` },
      async (tx) => {
        const company = await companyFacts(tx, companyId);
        return fn(tx, company, today ?? todayIn(this.clock, company.timeZone));
      },
    );
  }

  /** Sends the latest unsent step to the lease's people, and marks older steps as passed. */
  private async remind(
    tx: Tx,
    company: CompanyFacts,
    lease: LeaseFacts,
    job: string,
    due: readonly ReminderStep[],
    compose: (step: ReminderStep) => { subject: string; body: string },
  ): Promise<number> {
    if (due.length === 0) return 0;
    const keys = due.map((s) => `${job}:${lease.id}:${s.key}`);
    const done = await tx.execute<{ key: string }>(
      sql`select key from processed_job where key = any(${`{${keys.map((k) => `"${k}"`).join(',')}}`}::text[])`,
    );
    const sentKeys = new Set(done.rows.map((r) => r.key.slice(`${job}:${lease.id}:`.length)));
    const { send, skip } = reminderToSend(due, sentKeys);
    for (const step of [...skip, ...(send ? [send] : [])])
      await tx
        .insert(schema.processedJob)
        .values({ companyId: company.id, key: `${job}:${lease.id}:${step.key}`, jobName: job })
        .onConflictDoNothing();
    if (!send) return 0;
    const message = compose(send);
    const recipients = await this.recipients(tx, company, lease.property_id);
    for (const personId of recipients)
      await queueMessage(tx, company.id, {
        recipient: { type: 'staff', personId },
        purpose: 'staff_notice',
        subject: message.subject,
        body: message.body,
        channels: ['email'],
        propertyId: lease.property_id,
        related: { type: 'lease', id: lease.id },
      });
    return recipients.length;
  }

  /**
   * Who hears about a lease (plan 4.10): the people who may manage leases on its property, and
   * the users of the property's owner. The policy decides; no role is compared here.
   */
  private async recipients(tx: Tx, company: CompanyFacts, propertyId: string): Promise<string[]> {
    const owners = await tx.execute<{ owner_id: string }>(
      sql`select owner_id from property_current_ownership where property_id = ${propertyId}`,
    );
    const ownerIds = new Set(owners.rows.map((r) => r.owner_id));
    const people = new Set<string>();
    for (const m of await activeMembers(tx)) {
      if (isPlatformRole(m.role)) continue;
      const actor: Actor = {
        kind: 'staff',
        personId: m.personId,
        companyId: company.id,
        companyKind: company.kind,
        membershipId: m.membershipId,
        role: m.role as StaffRole,
        nominatedApprover: m.nominatedApprover,
        scope: m.scope,
        authMethod: 'password_totp',
      };
      const scope = this.policy.scopeFor(actor);
      let inScope = scope === null;
      if (scope) {
        const resolved = await tx.execute<{ ids: string[] }>(
          sql`select app.resolve_property_scope(${uuidArray(scope.ownerIds)}::uuid[], ${uuidArray(scope.propertyIds)}::uuid[]) as ids`,
        );
        inScope = (resolved.rows[0]?.ids ?? []).includes(propertyId);
      }
      const manages = this.policy.can(actor, 'lease.manage').allowed && inScope;
      const ownersUser =
        scope !== null &&
        scope.ownerIds.some((o) => ownerIds.has(o)) &&
        this.policy.can(actor, 'lease.view').allowed;
      if (manages || ownersUser) people.add(m.personId);
    }
    return [...people].sort();
  }
}
