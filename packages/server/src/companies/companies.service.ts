import { Inject, Injectable } from '@nestjs/common';
import { eq, schema, sql, withCompany, type Database, type Tx } from '@rent/db';
import { businessDateOf, instantFrom, toIsoDate } from '@rent/domain/dates';
import {
  subscriptionAccess,
  type CompanyAccess,
  type SubscriptionStatus,
} from '@rent/domain/subscription';
import type { Actor } from '@rent/domain/policy';
import {
  brandingSchema,
  featuresOf,
  mergeCompanySettings,
  messagingSettingsOf,
  paidUntilPromptDaysOf,
  parseCompanySettings,
  signingReminderHoursOf,
  tenancySettingsOf,
  tierOf,
  type CompanySettings,
  type PlanFeature,
  type SubscriptionTier,
} from '@rent/domain/settings';
import { forbidden, notFound } from '../core/errors';
import { DATABASE } from '../core/tokens';
import { DocumentsService } from '../documents/documents.service';
import { PolicyService } from '../policy/policy.service';

export interface CompanyProfileView {
  readonly id: string;
  readonly kind: 'landlord' | 'agency' | 'platform';
  readonly legalName: string;
  readonly displayName: string;
  readonly countryCode: string;
  readonly timeZone: string;
  readonly currency: string;
  readonly branding: {
    primaryColour: string;
    accentColour: string;
    senderName: string;
    logoUrl: string | null;
  };
  readonly settings: CompanySettings;
  /** M6 decision 9: the interim plan and what it includes, so screens show only what is there. */
  readonly plan: SubscriptionTier;
  readonly features: PlanFeature[];
  /** M10: what the past-due and read-only banner needs; null with no subscription (the platform). */
  readonly subscription: SubscriptionBanner | null;
}

export interface SubscriptionBanner {
  readonly status: SubscriptionStatus;
  readonly access: CompanyAccess;
  readonly trialEndsOn: string | null;
  readonly readOnlyFrom: string | null;
  readonly oldestDueOn: string | null;
  /** Only for people with `subscription.read`. */
  readonly pastDueMinor: number | null;
  readonly canPay: boolean;
}

export type StaffActor = Extract<Actor, { kind: 'staff' }>;

/** A company's row, read in the caller's company transaction (RLS applies): for other modules. */
export type CompanyRecord = typeof schema.company.$inferSelect;

export async function companyRecord(tx: Tx, companyId: string): Promise<CompanyRecord | null> {
  const [row] = await tx.select().from(schema.company).where(eq(schema.company.id, companyId));
  return row ?? null;
}

export function staffActor(actor: Actor | null): StaffActor {
  if (!actor || actor.kind !== 'staff') throw forbidden();
  return actor;
}

const context = (actor: StaffActor) => ({
  companyId: actor.companyId,
  personId: actor.personId,
  actorKind: 'staff' as const,
});

/** Company accounts with branding and settings (AD-01). Every change is row-audited. */
@Injectable()
export class CompaniesService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
  ) {}

  async profile(actor: Actor | null): Promise<CompanyProfileView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'company.view');
    const { company, banner } = await withCompany(this.database, context(staff), async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.company)
        .where(eq(schema.company.id, staff.companyId));
      return { company: row, banner: row ? await this.banner(tx, staff, row) : null };
    });
    if (!company) throw notFound('Company');
    const logoUrl = company.logoDocumentId
      ? await this.documents.downloadUrl(staff.companyId, company.logoDocumentId)
      : null;
    return {
      id: company.id,
      kind: company.kind as CompanyProfileView['kind'],
      legalName: company.legalName,
      displayName: company.displayName,
      countryCode: company.countryCode,
      timeZone: company.timeZone,
      currency: company.currency,
      branding: {
        primaryColour: company.primaryColour,
        accentColour: company.accentColour,
        senderName: company.senderName,
        logoUrl,
      },
      settings: settingsInForce(parseCompanySettings(company.settings)),
      plan: tierOf(company.plan),
      features: [...featuresOf(tierOf(company.plan))],
      subscription: banner,
    };
  }

  /**
   * M10 (decision 11): the banner's inputs for every staff member, read in the company's own
   * context through the select-only policy on its subscription rows. The amount only for those
   * who may read the subscription.
   */
  private async banner(
    tx: Tx,
    staff: StaffActor,
    company: { readonly access: string; readonly timeZone: string },
  ): Promise<SubscriptionBanner | null> {
    const rows = await tx.execute<{ status: SubscriptionStatus; trial_ends_on: string | null }>(
      sql`select status, trial_ends_on::text from subscription
          where subscriber_company_id = ${staff.companyId}::uuid`,
    );
    const sub = rows.rows[0];
    if (!sub) return null;
    const today = toIsoDate(businessDateOf(instantFrom(new Date()), company.timeZone));
    const open = await tx.execute<{ due_on: string; outstanding: string | number }>(
      sql`select i.due_on::text, i.total_minor - coalesce((select sum(a.amount_minor) from subscription_allocation a
              left join subscription_payment p on p.company_id = a.company_id and p.id = a.payment_id
              where a.company_id = i.company_id and a.invoice_id = i.id
                and (a.payment_id is null or p.status = 'succeeded')), 0) as outstanding
          from subscription_invoice i
          where i.subscriber_company_id = ${staff.companyId}::uuid and i.status = 'open'
          order by i.due_on`,
    );
    const owing = open.rows.filter((r) => Number(r.outstanding) > 0);
    const pastDue = owing.filter((r) => r.due_on < today);
    const terms = await tx.execute<{ grace_days: number; read_only_enabled: boolean }>(
      sql`select grace_days, read_only_enabled from subscription_terms where effective_from <= ${today}::date
          order by effective_from desc, created_at desc limit 1`,
    );
    const t = terms.rows[0];
    const access = subscriptionAccess({
      today,
      trialEndsOn: sub.trial_ends_on,
      cancelsOn: null,
      oldestUnpaidDueOn: owing[0]?.due_on ?? null,
      graceDays: Number(t?.grace_days ?? 14),
      readOnlyEnabled: t?.read_only_enabled ?? true,
    });
    return {
      status: sub.status,
      access: company.access === 'read_only' ? 'read_only' : 'full',
      trialEndsOn: sub.status === 'trialing' ? sub.trial_ends_on : null,
      readOnlyFrom: access.readOnlyFrom,
      oldestDueOn: pastDue[0]?.due_on ?? null,
      pastDueMinor: this.policy.can(staff, 'subscription.read').allowed
        ? pastDue.reduce((sum, r) => sum + Number(r.outstanding), 0)
        : null,
      canPay: this.policy.can(staff, 'subscription.manage').allowed,
    };
  }

  async updateBranding(
    actor: Actor | null,
    patch: {
      displayName?: string;
      primaryColour?: string;
      accentColour?: string;
      senderName?: string;
    },
  ): Promise<CompanyProfileView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'company.update');
    const { displayName, ...brandingPatch } = patch;
    const branding = brandingSchema.partial().parse(brandingPatch);
    await withCompany(this.database, context(staff), (tx) =>
      tx
        .update(schema.company)
        .set({
          ...branding,
          ...(displayName ? { displayName: displayName.trim() } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.company.id, staff.companyId)),
    );
    return this.profile(staff);
  }

  async updateSettings(
    actor: Actor | null,
    patch: Partial<CompanySettings>,
  ): Promise<CompanyProfileView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'company.update');
    await withCompany(this.database, context(staff), async (tx) => {
      const [row] = await tx
        .select({ settings: schema.company.settings })
        .from(schema.company)
        .where(eq(schema.company.id, staff.companyId))
        .for('update');
      if (!row) throw notFound('Company');
      const merged = mergeCompanySettings(parseCompanySettings(row.settings), patch);
      await tx
        .update(schema.company)
        .set({ settings: merged, updatedAt: new Date() })
        .where(eq(schema.company.id, staff.companyId));
    });
    return this.profile(staff);
  }

  /** Sets the logo after the documents module has checked and stored the image. */
  async setLogo(actor: Actor | null, documentId: string): Promise<CompanyProfileView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'company.update');
    await withCompany(this.database, context(staff), (tx) =>
      tx
        .update(schema.company)
        .set({ logoDocumentId: documentId, updatedAt: new Date() })
        .where(eq(schema.company.id, staff.companyId)),
    );
    return this.profile(staff);
  }
}

/** Stored settings with the M3 keys' defaults applied, so screens show the values in force. */
function settingsInForce(settings: CompanySettings): CompanySettings {
  const tenancy = tenancySettingsOf(settings);
  const messaging = messagingSettingsOf(settings);
  return {
    ...settings,
    witnessRequired: tenancy.witnessRequired,
    rentControlCommercial: tenancy.rentControlCommercial,
    rentControlReminderDaysBefore: [...tenancy.rentControlReminderDaysBefore],
    stampingReminderDaysBefore: [...tenancy.stampingReminderDaysBefore],
    signingReminderHours: [...signingReminderHoursOf(settings)],
    // M5 (AR-06): the renewal prompt's lead, 90 days unless the company sets another.
    paidUntilPromptDays: paidUntilPromptDaysOf(settings),
    // M6 (CM-06, decision 10): the response target and the conversation tags in force.
    inboxFirstResponseMinutes: messaging.inboxFirstResponseMinutes,
    inboxTags: [...messaging.inboxTags],
  };
}
