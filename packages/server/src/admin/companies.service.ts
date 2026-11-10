import { Inject, Injectable } from '@nestjs/common';
import { sql, type Database, type Tx } from '@rent/db';
import { isValidTimeZone } from '@rent/domain/dates';
import type { Actor } from '@rent/domain/policy';
import { SUBSCRIPTION_TIERS, type SubscriptionTier } from '@rent/domain/settings';
import {
  normalizeCode,
  type CompanyAccess,
  type SubscriptionStatus,
} from '@rent/domain/subscription';
import { AuditService } from '../audit/audit.service';
import type { AppConfig } from '../core/config';
import { conflict, invalid, notFound } from '../core/errors';
import type { IdempotencyClaim } from '../core/idempotency';
import type { AppLogger } from '../core/logging/logger';
import { AUTH, CONFIG, DATABASE, LOGGER } from '../core/tokens';
import type { Auth } from '../identity/auth';
import { PersonAccounts } from '../identity/person-accounts';
import { PolicyService } from '../policy/policy.service';
import { SubscriptionBillingService } from '../subscription/billing.service';
import { SubscriptionCoreService } from '../subscription/core.service';
import { withPlatform } from '../subscription/platform';
import { SubscriptionService } from '../subscription/subscription.service';
import { invitationSender, personForEmail } from './invitations';
import { platformAdminFor, type PlatformAdmin } from './platform-admin';
import { SupportAccessService, type SupportGrantView } from './support.service';
import { UsageService, type UsageView } from './usage.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A subscriber company in the console's list (the contract's `platformCompanySchema`). */
export interface PlatformCompanyView {
  readonly company: { readonly id: string; readonly name: string };
  readonly kind: 'landlord' | 'agency';
  readonly tier: SubscriptionTier;
  readonly status: SubscriptionStatus;
  readonly access: CompanyAccess;
  readonly trialEndsOn: string | null;
  /** Last month's snapshot: billable units, all bands. */
  readonly billableUnits: number;
  /** The latest invoice's total. */
  readonly monthlyRevenueMinor: number;
  /** Open invoices past their due date, what is left of them. */
  readonly arrearsMinor: number;
  readonly supportGrantActive: boolean;
  readonly createdAt: Date;
}

export type SubscriptionViewOf = Awaited<ReturnType<SubscriptionService['viewFor']>>;
export type SubscriptionInvoiceViewOf = Awaited<
  ReturnType<SubscriptionService['invoiceViewsFor']>
>[number];

/** A company's console page (the contract's `platformCompanyDetailSchema`). */
export interface PlatformCompanyDetail extends PlatformCompanyView {
  readonly subscription: SubscriptionViewOf;
  readonly invoices: readonly SubscriptionInvoiceViewOf[];
  readonly usage: readonly UsageView[];
  readonly supportGrants: readonly SupportGrantView[];
  readonly events: readonly { readonly at: Date; readonly kind: string; readonly detail: string }[];
}

export interface NewCompany {
  readonly kind: 'landlord' | 'agency';
  readonly name: string;
  readonly legalName?: string | null;
  readonly timeZone?: string | null;
  readonly tier: SubscriptionTier;
  readonly trialDays?: number | null;
  readonly adminName: string;
  readonly adminEmail: string;
}

function reasonOf(text: string): string {
  const reason = text.trim();
  if (reason.length < 5 || reason.length > 500)
    throw invalid('reason_required', 'Give a reason of 5 to 500 characters; it is audited');
  return reason;
}

function tierOfInput(tier: string): SubscriptionTier {
  if (!(SUBSCRIPTION_TIERS as readonly string[]).includes(tier))
    throw invalid('bad_tier', 'Choose Starter, Growth or Portfolio');
  return tier as SubscriptionTier;
}

/**
 * The console's companies (AD-10; M10 decisions 4, 5, 6, 8 and 14): the subscriber list with tier,
 * status, access, trial, billable units, revenue, arrears and whether a support grant is active;
 * each company's page; onboarding; and a platform admin's direct changes (tier for a pilot, trial
 * extensions, discount codes), each audited. Subscription records belong to the platform company
 * (decision 1) and are read there as the platform admin. A platform admin never enters a customer
 * company (decision 13): the new company's creation and its first admin's invitation go into its
 * chain through the platform's system path with the admin's person id.
 */
@Injectable()
export class PlatformCompaniesService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SubscriptionCoreService) private readonly core: SubscriptionCoreService,
    @Inject(SubscriptionService) private readonly subscriptions: SubscriptionService,
    @Inject(SubscriptionBillingService) private readonly billing: SubscriptionBillingService,
    @Inject(SupportAccessService) private readonly support: SupportAccessService,
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(PersonAccounts) private readonly accounts: PersonAccounts,
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {}

  private context(admin: PlatformAdmin, requestId?: string | null) {
    return {
      personId: admin.personId,
      requestId: requestId ?? null,
      actorKind: 'platform_admin' as const,
    };
  }

  /** `platformAdmin.companies`. */
  async companies(actor: Actor | null): Promise<PlatformCompanyView[]> {
    const admin = platformAdminFor(this.policy, actor, 'company.manage');
    return this.rows(admin);
  }

  /** `platformAdmin.company`. */
  async company(actor: Actor | null, companyId: string): Promise<PlatformCompanyDetail> {
    const admin = platformAdminFor(this.policy, actor, 'company.manage');
    return this.detail(admin, companyId);
  }

  /**
   * `platformAdmin.createCompany` (decision 14): the company (with its company book), its
   * subscription in trial on the chosen tier, its first admin's membership (the landlord, or the
   * agency's admin), then the set-password invitation by email.
   */
  async createCompany(
    actor: Actor | null,
    input: NewCompany,
    requestId?: string | null,
    claim?: IdempotencyClaim | null,
  ): Promise<PlatformCompanyDetail> {
    const admin = platformAdminFor(this.policy, actor, 'company.create');
    return this.detail(admin, await this.onboard(admin, input, requestId, claim));
  }

  /**
   * Onboarding (decision 14; review BE-16 and BE-20), its company's id. The first admin's person
   * comes first, found by email or made (Better Auth's own transaction; a retry finds it), then ONE
   * platform-company transaction makes the company, starts its subscription, adds the first admin
   * through the narrow `app.onboard_first_admin` (the platform admin never enters the customer's
   * company) and audits it in both chains, with the Idempotency-Key's claim, so a retry under the
   * same key does nothing twice and a failure leaves nothing half made. The invitation is sent
   * once that commits.
   */
  async onboard(
    actor: Actor | null,
    input: NewCompany,
    requestId?: string | null,
    claim?: IdempotencyClaim | null,
  ): Promise<string> {
    const admin = platformAdminFor(this.policy, actor, 'company.create');
    if (input.kind !== 'landlord' && input.kind !== 'agency')
      throw invalid('bad_kind', 'A company is a landlord or an agency');
    const name = input.name.trim();
    if (name.length < 2 || name.length > 200)
      throw invalid('bad_name', 'The name is 2 to 200 characters');
    const legalName = input.legalName?.trim() || name;
    if (legalName.length > 200)
      throw invalid('bad_name', 'The legal name is 200 characters at most');
    const timeZone = input.timeZone?.trim() || 'Africa/Accra';
    if (!isValidTimeZone(timeZone)) throw invalid('bad_time_zone', 'Choose a known time zone');
    const tier = tierOfInput(input.tier);
    const trialDays = input.trialDays ?? null;
    if (
      trialDays !== null &&
      (!Number.isSafeInteger(trialDays) || trialDays < 0 || trialDays > 365)
    )
      throw invalid('bad_trial', 'A trial is 0 to 365 days');
    const adminName = input.adminName.trim();
    if (adminName.length < 2 || adminName.length > 200)
      throw invalid('bad_name', 'The admin’s name is 2 to 200 characters');
    const adminEmail = input.adminEmail.trim().toLowerCase();
    if (!EMAIL.test(adminEmail)) throw invalid('bad_email', 'Enter the admin’s email address');

    const person = await personForEmail(this.database, this.accounts, {
      name: adminName,
      email: adminEmail,
    });
    const companyId = await withPlatform(
      this.database,
      this.context(admin, requestId),
      async (tx, platformId) => {
        await claim?.claim(tx);
        const made = await tx.execute<{ id: string }>(
          sql`select app.create_company(null, ${input.kind}, ${legalName}, ${name}, 'GH', ${timeZone},
                ${name.slice(0, 40).trim()}, '{}'::jsonb) as id`,
        );
        const id = made.rows[0]!.id;
        // Its subscription, as SubscriptionService.startFor starts one, in this transaction.
        const company = await this.core.subscriberCompany(tx, id);
        if (!company) throw new Error('The new company is not a subscriber company');
        const sub = await this.core.ensure(
          tx,
          platformId,
          { ...company, plan: tier },
          { trialDays, personId: admin.personId },
        );
        await this.core.refresh(tx, platformId, sub, company);
        await this.core.auditSubscriberIn(
          tx,
          id,
          'subscription.started',
          sub.id,
          { tier: sub.tier, trialEndsOn: sub.trialEndsOn },
          `subscription_started:${sub.id}`,
        );
        // The landlord runs a landlord company; an agency's first person is its admin (AD-03).
        await tx.execute(
          sql`select app.onboard_first_admin(${id}::uuid, ${person.personId}::uuid,
                ${JSON.stringify({ tier, trialDays })}::jsonb)`,
        );
        await this.audit.append(tx, {
          companyId: platformId,
          action: 'company.onboarded',
          recordType: 'company',
          recordId: id,
          data: { kind: input.kind, tier, trialDays },
        });
        await claim?.done(tx, { companyId: id });
        return id;
      },
    );
    try {
      await invitationSender(this.auth, this.config.WEB_ORIGIN)(adminEmail);
    } catch (error) {
      // The company is made and its answer stored: a retry replays it and sends nothing, so the
      // failure is logged (ids only) for the platform team rather than reported as a failed
      // onboarding.
      this.logger.error(
        { err: error, companyId, personId: person.personId },
        'the onboarding invitation could not be sent',
      );
    }
    return companyId;
  }

  /** `platformAdmin.setTier`: directly, for example for a pilot, with an audited reason. */
  async setTier(
    actor: Actor | null,
    companyId: string,
    tier: SubscriptionTier,
    reason: string,
  ): Promise<PlatformCompanyDetail> {
    const admin = platformAdminFor(this.policy, actor, 'company.manage');
    await this.existing(admin, companyId);
    await this.subscriptions.setTierByAdmin(admin, companyId, tierOfInput(tier), reasonOf(reason));
    return this.detail(admin, companyId);
  }

  /**
   * `platformAdmin.extendTrial`: 409 `not_trialing` unless the company is on its trial. Under an
   * Idempotency-Key (review BE-21) the claim is taken in the extension's own transaction, so a
   * retry adds nothing.
   */
  async extendTrial(
    actor: Actor | null,
    companyId: string,
    days: number,
    reason: string,
    claim?: IdempotencyClaim | null,
  ): Promise<PlatformCompanyDetail> {
    const admin = platformAdminFor(this.policy, actor, 'company.manage');
    if (!Number.isSafeInteger(days) || days < 1 || days > 365)
      throw invalid('bad_days', 'Extend a trial by 1 to 365 days');
    const why = reasonOf(reason);
    await this.existing(admin, companyId);
    const subscription = await withPlatform(this.database, this.context(admin), (tx) =>
      this.core.find(tx, companyId),
    );
    if (subscription?.status !== 'trialing')
      throw conflict(
        'not_trialing',
        'The company is not on a free trial, so there is none to extend',
      );
    await this.subscriptions.extendTrial(admin, companyId, days, why, claim);
    return this.detail(admin, companyId);
  }

  /**
   * `platformAdmin.reactivate` (decision 12; review BE-4): a new subscription for a cancelled
   * company, on a tier, with an audited reason; 409 `not_cancelled` otherwise.
   */
  async reactivate(
    actor: Actor | null,
    companyId: string,
    input: {
      readonly tier: SubscriptionTier;
      readonly trialDays?: number | null;
      readonly reason: string;
    },
  ): Promise<PlatformCompanyDetail> {
    const admin = platformAdminFor(this.policy, actor, 'company.manage');
    const tier = tierOfInput(input.tier);
    const reason = reasonOf(input.reason);
    const trialDays = input.trialDays ?? null;
    if (
      trialDays !== null &&
      (!Number.isSafeInteger(trialDays) || trialDays < 0 || trialDays > 365)
    )
      throw invalid('bad_trial', 'A trial is 0 to 365 days');
    await this.existing(admin, companyId);
    await this.subscriptions.reactivate(admin, companyId, { tier, trialDays, reason });
    return this.detail(admin, companyId);
  }

  /** `platformAdmin.applyCode`: a discount code applied by a platform admin (decision 8). */
  async applyCode(
    actor: Actor | null,
    companyId: string,
    code: string,
  ): Promise<PlatformCompanyDetail> {
    const admin = platformAdminFor(this.policy, actor, 'company.manage');
    await this.existing(admin, companyId);
    await this.subscriptions.applyCodeAsAdmin(admin, companyId, normalizeCode(code));
    return this.detail(admin, companyId);
  }

  /** `platformAdmin.invoiceDocument`: a short-lived link to a company's invoice PDF. */
  async invoiceDocument(
    actor: Actor | null,
    companyId: string,
    invoiceId: string,
  ): Promise<{ url: string; expiresAt: Date }> {
    const admin = platformAdminFor(this.policy, actor, 'company.manage');
    if (!UUID.test(invoiceId)) throw notFound('Invoice');
    await this.existing(admin, companyId);
    return this.billing.invoiceDocumentFor(companyId, invoiceId);
  }

  // Reads -----------------------------------------------------------------------------------

  private async existing(admin: PlatformAdmin, companyId: string): Promise<void> {
    if (!UUID.test(companyId)) throw notFound('Company');
    const found = await withPlatform(this.database, this.context(admin), (tx) =>
      this.core.subscriberCompany(tx, companyId),
    );
    if (!found) throw notFound('Company');
  }

  private async detail(admin: PlatformAdmin, companyId: string): Promise<PlatformCompanyDetail> {
    if (!UUID.test(companyId)) throw notFound('Company');
    const [row] = await this.rows(admin, companyId);
    if (!row) throw notFound('Company');
    const subscription = await this.subscriptions.viewFor(companyId);
    const invoices = await this.subscriptions.invoiceViewsFor(companyId);
    const events = await this.subscriptions.eventsFor(companyId);
    const usage = await this.usage.ofCompany(admin, companyId);
    const supportGrants = await this.support.grantsOfCompany(admin, companyId);
    return { ...row, subscription, invoices, usage, supportGrants, events };
  }

  private async rows(admin: PlatformAdmin, companyId?: string): Promise<PlatformCompanyView[]> {
    const granted = await this.support.companiesWithActiveGrant(admin);
    return withPlatform(this.database, this.context(admin), async (tx, platformId) => {
      const companies = (await this.core.subscriberCompanies(tx)).filter(
        (c) => companyId === undefined || c.id === companyId,
      );
      const out: PlatformCompanyView[] = [];
      const facts = await this.facts(tx);
      for (const company of companies) {
        // A company from before M10 whose subscription the daily job has not started yet.
        const subscription =
          facts.subscriptions.get(company.id) ??
          (await this.core.ensure(tx, platformId, company, { personId: admin.personId }));
        const today = this.core.todayIn(company.timeZone);
        const arrears = (facts.open.get(company.id) ?? [])
          .filter((i) => i.dueOn < today)
          .reduce((sum, i) => sum + i.outstandingMinor, 0);
        out.push({
          company: { id: company.id, name: company.displayName },
          kind: company.kind,
          tier: subscription.tier,
          status: subscription.status,
          access: company.access,
          trialEndsOn: subscription.trialEndsOn,
          billableUnits: facts.billableUnits.get(company.id) ?? 0,
          monthlyRevenueMinor: facts.lastInvoiceTotal.get(company.id) ?? 0,
          arrearsMinor: arrears,
          supportGrantActive: granted.has(company.id),
          createdAt: company.createdAt,
        });
      }
      return out;
    });
  }

  /** Every subscriber's subscription, last snapshot, last invoice and open invoices, at once. */
  private async facts(tx: Tx) {
    const subscriptions = await tx.execute<{
      subscriber_company_id: string;
      tier: SubscriptionTier;
      status: SubscriptionStatus;
      trial_ends_on: string | null;
    }>(
      // A reactivated company has a cancelled subscription and its new one: the latest is live,
      // as SubscriptionCoreService.find picks it.
      sql`select distinct on (subscriber_company_id) subscriber_company_id, tier, status,
            trial_ends_on::text
          from subscription order by subscriber_company_id, created_at desc, id desc`,
    );
    const snapshots = await tx.execute<{ subscriber_company_id: string; units: number }>(
      sql`select distinct on (subscriber_company_id) subscriber_company_id,
            (single_room_units + self_contained_units + commercial_units)::int as units
          from billing_snapshot order by subscriber_company_id, month desc`,
    );
    const invoices = await tx.execute<{ subscriber_company_id: string; total_minor: number }>(
      sql`select distinct on (subscriber_company_id) subscriber_company_id, total_minor
          from subscription_invoice where status <> 'void'
          order by subscriber_company_id, month desc, issued_on desc`,
    );
    const open = await tx.execute<{
      subscriber_company_id: string;
      due_on: string;
      outstanding_minor: number;
    }>(
      sql`select i.subscriber_company_id, i.due_on::text as due_on,
            i.total_minor - coalesce((select sum(a.amount_minor) from subscription_allocation a
                left join subscription_payment p on p.company_id = a.company_id and p.id = a.payment_id
                where a.company_id = i.company_id and a.invoice_id = i.id
                  and (a.payment_id is null or p.status = 'succeeded')), 0) as outstanding_minor
          from subscription_invoice i where i.status = 'open'`,
    );
    const openBy = new Map<string, { dueOn: string; outstandingMinor: number }[]>();
    for (const r of open.rows) {
      const list = openBy.get(r.subscriber_company_id) ?? [];
      list.push({ dueOn: r.due_on, outstandingMinor: Math.max(0, Number(r.outstanding_minor)) });
      openBy.set(r.subscriber_company_id, list);
    }
    return {
      subscriptions: new Map(
        subscriptions.rows.map((r) => [
          r.subscriber_company_id,
          { tier: r.tier, status: r.status, trialEndsOn: r.trial_ends_on },
        ]),
      ),
      billableUnits: new Map(snapshots.rows.map((r) => [r.subscriber_company_id, Number(r.units)])),
      lastInvoiceTotal: new Map(
        invoices.rows.map((r) => [r.subscriber_company_id, Number(r.total_minor)]),
      ),
      open: openBy,
    };
  }
}
