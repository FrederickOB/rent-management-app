import { Inject, Injectable, Optional } from '@nestjs/common';
import { asc, schema, sql, withCompany, withSystem, type Database } from '@rent/db';
import { TEMPLATE_STATUSES, type TemplateKey, type TemplateStatus } from '@rent/domain/messaging';
import type { Actor } from '@rent/domain/policy';
import type { WhatsAppPort, WhatsAppTemplateStatusEvent } from '@rent/integrations';
import { staffActor } from '../companies/companies.service';
import { DATABASE, WHATSAPP_PORT } from '../core/tokens';
import { PolicyService } from '../policy/policy.service';

export interface MessageTemplateView {
  readonly key: TemplateKey;
  readonly version: number;
  readonly whatsappName: string;
  readonly category: 'utility' | 'marketing' | 'authentication';
  readonly language: string;
  readonly body: string;
  readonly parameters: string[];
  readonly statuses: {
    readonly number: {
      readonly kind: 'shared' | 'company';
      readonly displayPhone: string;
      readonly displayName: string;
    };
    readonly sending: boolean;
    readonly status: TemplateStatus | null;
    readonly reason: string | null;
    readonly checkedAt: Date | null;
  }[];
}

const toStatus = (value: string): TemplateStatus | null => {
  const word = value.toLowerCase();
  if (word === 'flagged') return 'paused';
  return (TEMPLATE_STATUSES as readonly string[]).includes(word) ? (word as TemplateStatus) : null;
};

/**
 * The template registry (CM-07; plan section 3): our texts, and their approval on each WhatsApp
 * number, kept current by Meta's template webhook and a daily check (`messaging.sync-templates`).
 * Statuses are read and written only through the narrow system functions (ADR-002).
 */
@Injectable()
export class TemplatesService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Optional() @Inject(WHATSAPP_PORT) private readonly whatsapp: WhatsAppPort | null = null,
  ) {}

  /** Each template's latest version with its status on the company's numbers. */
  async list(actor: Actor | null): Promise<MessageTemplateView[]> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'messaging.templates.read');
    return withCompany(
      this.database,
      { companyId: staff.companyId, actorKind: 'staff', personId: staff.personId },
      async (tx) => {
        const templates = await tx
          .select()
          .from(schema.messageTemplate)
          .orderBy(asc(schema.messageTemplate.key), asc(schema.messageTemplate.version));
        const latest = new Map<string, (typeof templates)[number]>();
        for (const t of templates) latest.set(`${t.key}:${t.language}`, t);
        const numbers = await tx.execute<{
          account_id: string;
          kind: 'shared' | 'company';
          display_phone: string;
          display_name: string;
        }>(
          sql`select a.id as account_id, a.kind, a.display_phone, a.display_name from (
              select account_id as id, kind, display_phone, display_name from app.whatsapp_sending_account(${staff.companyId}::uuid)
            ) a`,
        );
        const statuses = await tx.execute<{
          account_id: string;
          account_kind: 'shared' | 'company';
          display_phone: string;
          display_name: string;
          is_sending: boolean;
          template_id: string;
          status: TemplateStatus;
          reason: string | null;
          checked_at: Date;
        }>(sql`select * from app.whatsapp_template_statuses(${staff.companyId}::uuid)`);
        const accounts = new Map<
          string,
          {
            kind: 'shared' | 'company';
            displayPhone: string;
            displayName: string;
            sending: boolean;
          }
        >();
        for (const n of numbers.rows)
          accounts.set(n.account_id, {
            kind: n.kind,
            displayPhone: n.display_phone,
            displayName: n.display_name,
            sending: true,
          });
        for (const s of statuses.rows)
          if (!accounts.has(s.account_id))
            accounts.set(s.account_id, {
              kind: s.account_kind,
              displayPhone: s.display_phone,
              displayName: s.display_name,
              sending: s.is_sending,
            });
        return [...latest.values()].map((t) => ({
          key: t.key as TemplateKey,
          version: t.version,
          whatsappName: t.whatsappName,
          category: t.category as MessageTemplateView['category'],
          language: t.language,
          body: t.body,
          parameters: t.parameters as string[],
          statuses: [...accounts.entries()]
            .sort((a, b) => Number(b[1].sending) - Number(a[1].sending))
            .map(([accountId, a]) => {
              const s = statuses.rows.find(
                (r) => r.account_id === accountId && r.template_id === t.id,
              );
              return {
                number: { kind: a.kind, displayPhone: a.displayPhone, displayName: a.displayName },
                sending: a.sending,
                status: s?.status ?? null,
                reason: s?.reason ?? null,
                checkedAt: s?.checked_at ?? null,
              };
            }),
        }));
      },
    );
  }

  /** Meta's template review webhook (CM-07). */
  async fromWebhook(events: readonly WhatsAppTemplateStatusEvent[]): Promise<string> {
    let recorded = 0;
    for (const e of events)
      recorded += await this.record(
        e.wabaId,
        e.name,
        e.language,
        e.status,
        e.reason ?? null,
        e.metaTemplateId,
        null,
      );
    return recorded > 0 ? `templates_${recorded}` : 'unknown_template';
  }

  /** `messaging.sync-templates`: every number's templates, from Meta, daily (plan 4.13). */
  async sync(): Promise<number> {
    if (!this.whatsapp) return 0;
    const accounts = await withSystem(this.database, {}, (tx) =>
      tx.execute<{ id: string; waba_id: string; status: string }>(
        sql`select id, waba_id, status from app.whatsapp_accounts()`,
      ),
    );
    let recorded = 0;
    const seen = new Set<string>();
    for (const account of accounts.rows) {
      if (account.status !== 'active' || seen.has(account.waba_id)) continue;
      seen.add(account.waba_id);
      const listed = await this.whatsapp.listTemplates(account.waba_id);
      for (const t of listed)
        recorded += await this.record(
          account.waba_id,
          t.name,
          t.language,
          t.status,
          t.reason ?? null,
          t.metaTemplateId,
          t.category ?? null,
        );
    }
    return recorded;
  }

  /** Records a template's status on every active number of a WhatsApp Business Account. */
  private async record(
    wabaId: string,
    name: string,
    language: string,
    status: string,
    reason: string | null,
    metaTemplateId: string,
    category: string | null,
  ): Promise<number> {
    const ours = toStatus(status);
    if (!ours) return 0;
    return withSystem(this.database, {}, async (tx) => {
      const [template] = await tx
        .execute<{ id: string }>(
          sql`select id from message_template where whatsapp_name = ${name} and language = ${language.split('_')[0]!}`,
        )
        .then((r) => r.rows);
      if (!template) return 0;
      const accounts = await tx.execute<{ id: string; waba_id: string; status: string }>(
        sql`select id, waba_id, status from app.whatsapp_accounts()`,
      );
      let n = 0;
      for (const a of accounts.rows.filter((r) => r.waba_id === wabaId && r.status === 'active')) {
        await tx.execute(
          sql`select app.record_whatsapp_template_status(${a.id}::uuid, ${template.id}::uuid, ${ours},
                ${category && ['utility', 'marketing', 'authentication'].includes(category) ? category : null}, ${metaTemplateId}, ${reason})`,
        );
        n += 1;
      }
      return n;
    });
  }
}
