import { Inject, Injectable, Optional } from '@nestjs/common';
import { eq, schema, sql, withCompany, withSystem, type Database } from '@rent/db';
import type { Actor } from '@rent/domain/policy';
import {
  mergeCompanySettings,
  messagingSettingsOf,
  parseCompanySettings,
} from '@rent/domain/settings';
import { AuditService } from '../audit/audit.service';
import { staffActor } from '../companies/companies.service';
import { EntitlementsService } from '../companies/entitlements.service';
import { conflict, forbidden, invalid, notFound } from '../core/errors';
import { DATABASE } from '../core/tokens';
import { PolicyService, staffContext } from '../policy/policy.service';
import { sendingAccount } from './store';

type PlatformAdmin = Extract<Actor, { kind: 'platform_admin' }>;

type NumberRow = {
  id: string;
  phone_number_id: string;
  waba_id: string;
  display_phone: string;
  display_name: string;
  kind: 'shared' | 'company';
  company_id: string | null;
  company_name: string | null;
  status: 'active' | 'retired';
  created_at: Date;
};

const numberView = (r: NumberRow) => ({
  id: r.id,
  phoneNumberId: r.phone_number_id,
  wabaId: r.waba_id,
  displayPhone: r.display_phone,
  displayName: r.display_name,
  kind: r.kind,
  company: r.company_id ? { id: r.company_id, name: r.company_name ?? '' } : null,
  status: r.status,
  createdAt: new Date(r.created_at),
});

/**
 * Messaging settings (CM-06; decisions 9 and 10): the first-response target and the tags, read
 * by anyone who sees the company and changed by its admins; and the platform admin's WhatsApp
 * numbers (decision 3), through the narrow functions of ADR-002.
 */
@Injectable()
export class MessagingSettingsService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Optional() @Inject(AuditService) private readonly audit: AuditService | null = null,
  ) {}

  /**
   * M6 review S-7: a number registered or retired is audited in the platform company's chain,
   * with who did it; a company's own number also in that company's chain.
   */
  private async audited(
    admin: PlatformAdmin,
    action: 'whatsapp_number.registered' | 'whatsapp_number.retired',
    numberId: string,
  ): Promise<void> {
    if (!this.audit) return;
    const found = (await this.numbers(admin)).find((n) => n.id === numberId);
    if (!found) return;
    const data = {
      kind: found.kind,
      phoneNumberId: found.phoneNumberId,
      wabaId: found.wabaId,
      displayName: found.displayName,
      status: found.status,
    };
    // M10 decision 13: a platform admin's own context never enters a customer company without a
    // grant, so the customer's chain records it through the platform's system path, with the admin.
    for (const companyId of [admin.companyId, ...(found.company ? [found.company.id] : [])])
      await withCompany(
        this.database,
        {
          companyId,
          personId: admin.personId,
          actorKind: companyId === admin.companyId ? 'platform_admin' : 'system',
        },
        (tx) =>
          this.audit!.append(tx, {
            companyId,
            action,
            recordType: 'whatsapp_account',
            recordId: numberId,
            data,
          }),
      );
  }

  async get(actor: Actor | null) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'company.view');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const [row] = await tx
        .select({ settings: schema.company.settings })
        .from(schema.company)
        .where(eq(schema.company.id, staff.companyId));
      if (!row) throw notFound('Company');
      const settings = messagingSettingsOf(parseCompanySettings(row.settings));
      const plan = await this.entitlements.planIn(tx, staff.companyId);
      const features = (await this.entitlements.features(staff.companyId)).features;
      const account = await sendingAccount(tx, staff.companyId);
      return {
        firstResponseMinutes: settings.inboxFirstResponseMinutes,
        tags: [...settings.inboxTags],
        plan,
        features,
        whatsappNumber: account
          ? {
              kind: account.kind,
              displayPhone: account.displayPhone,
              displayName: account.displayName,
            }
          : null,
      };
    });
  }

  async update(
    actor: Actor | null,
    patch: { firstResponseMinutes?: number; tags?: readonly string[] },
  ) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'company.update');
    if (patch.tags && new Set(patch.tags).size !== patch.tags.length)
      throw invalid('duplicate_tags', 'Each tag once');
    await withCompany(this.database, staffContext(staff), async (tx) => {
      const [row] = await tx
        .select({ settings: schema.company.settings })
        .from(schema.company)
        .where(eq(schema.company.id, staff.companyId))
        .for('update');
      if (!row) throw notFound('Company');
      const merged = mergeCompanySettings(parseCompanySettings(row.settings), {
        ...(patch.firstResponseMinutes !== undefined
          ? { inboxFirstResponseMinutes: patch.firstResponseMinutes }
          : {}),
        ...(patch.tags !== undefined ? { inboxTags: [...patch.tags] } : {}),
      });
      await tx
        .update(schema.company)
        .set({ settings: merged, updatedAt: new Date() })
        .where(eq(schema.company.id, staff.companyId));
    });
    return this.get(staff);
  }

  // Platform admins ----------------------------------------------------------------------------

  private admin(actor: Actor | null): PlatformAdmin {
    if (!actor) throw forbidden();
    this.policy.assert(actor, 'whatsapp_account.manage');
    switch (actor.kind) {
      case 'platform_admin':
        return actor;
      default:
        throw forbidden();
    }
  }

  async numbers(actor: Actor | null) {
    const admin = this.admin(actor);
    const rows = await withSystem(
      this.database,
      { personId: admin.personId, actorKind: 'platform_admin' },
      (tx) => tx.execute<NumberRow>(sql`select * from app.whatsapp_accounts()`),
    );
    return rows.rows.map(numberView);
  }

  async registerNumber(
    actor: Actor | null,
    input: {
      phoneNumberId: string;
      wabaId: string;
      displayPhone: string;
      displayName: string;
      kind: 'shared' | 'company';
      companyId: string | null;
    },
  ) {
    const admin = this.admin(actor);
    const id = await withSystem(
      this.database,
      { personId: admin.personId, actorKind: 'platform_admin' },
      async (tx) => {
        try {
          const rows = await tx.execute<{ id: string }>(
            sql`select app.register_whatsapp_account(${input.phoneNumberId}, ${input.wabaId}, ${input.displayPhone},
                ${input.displayName}, ${input.kind}, ${input.companyId}::uuid) as id`,
          );
          return rows.rows[0]!.id;
        } catch (error) {
          const code =
            (error as { code?: string; cause?: { code?: string } }).cause?.code ??
            (error as { code?: string }).code;
          if (code === '23505')
            throw conflict(
              'number_registered',
              'That number, or a shared number, is registered already',
            );
          if (code === '23503') throw notFound('Company');
          throw error;
        }
      },
    );
    await this.audited(admin, 'whatsapp_number.registered', id);
    const found = (await this.numbers(admin)).find((n) => n.id === id);
    if (!found) throw notFound('WhatsApp number');
    return found;
  }

  async retireNumber(actor: Actor | null, numberId: string) {
    const admin = this.admin(actor);
    await withSystem(
      this.database,
      { personId: admin.personId, actorKind: 'platform_admin' },
      (tx) => tx.execute(sql`select app.retire_whatsapp_account(${numberId}::uuid)`),
    );
    await this.audited(admin, 'whatsapp_number.retired', numberId);
    const found = (await this.numbers(admin)).find((n) => n.id === numberId);
    if (!found) throw notFound('WhatsApp number');
    return found;
  }
}
