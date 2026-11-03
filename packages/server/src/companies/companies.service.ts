import { Inject, Injectable } from '@nestjs/common';
import { eq, schema, withCompany, type Database, type Tx } from '@rent/db';
import type { Actor } from '@rent/domain/policy';
import {
  brandingSchema,
  mergeCompanySettings,
  paidUntilPromptDaysOf,
  parseCompanySettings,
  signingReminderHoursOf,
  tenancySettingsOf,
  type CompanySettings,
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
    const company = await withCompany(this.database, context(staff), async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.company)
        .where(eq(schema.company.id, staff.companyId));
      return row;
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
  return {
    ...settings,
    witnessRequired: tenancy.witnessRequired,
    rentControlCommercial: tenancy.rentControlCommercial,
    rentControlReminderDaysBefore: [...tenancy.rentControlReminderDaysBefore],
    stampingReminderDaysBefore: [...tenancy.stampingReminderDaysBefore],
    signingReminderHours: [...signingReminderHoursOf(settings)],
    // M5 (AR-06): the renewal prompt's lead, 90 days unless the company sets another.
    paidUntilPromptDays: paidUntilPromptDaysOf(settings),
  };
}
