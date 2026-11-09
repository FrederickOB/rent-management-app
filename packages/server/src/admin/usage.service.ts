import { Inject, Injectable } from '@nestjs/common';
import { sql, type Database } from '@rent/db';
import { businessDateOf, DEFAULT_TIME_ZONE, instantFrom, toIsoDate } from '@rent/domain/dates';
import type { Actor } from '@rent/domain/policy';
import { monthOf, previousMonth, shiftMonth } from '@rent/domain/subscription';
import type { Clock } from '../core/clock';
import { invalid } from '../core/errors';
import { CLOCK, DATABASE } from '../core/tokens';
import { PolicyService } from '../policy/policy.service';
import { SubscriptionCoreService, type SubscriberCompany } from '../subscription/core.service';
import { withPlatform } from '../subscription/platform';
import { platformAdminFor, type PlatformAdmin } from './platform-admin';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** One company's month (decision 15), as the contract's usage schema carries it. */
export interface UsageView {
  readonly company: { readonly id: string; readonly name: string };
  readonly month: string;
  /** The units in its register today. */
  readonly units: number;
  /** The month's snapshot (PB-02, D8): billable units by band; zero before it is taken. */
  readonly billableUnits: {
    readonly single_room: number;
    readonly self_contained: number;
    readonly commercial: number;
  };
  /** The month's invoice. */
  readonly invoicedMinor: number;
  /** What is settled of it (payments and prepaid credit). */
  readonly paidMinor: number;
  /** What is left of it once it is past its due date. */
  readonly arrearsMinor: number;
  readonly messages: {
    readonly sms: number;
    readonly whatsapp: number;
    readonly email: number;
    readonly push: number;
  };
  /** As recorded per message. */
  readonly smsCostMinor: number;
  /** From the editable rate table: an estimate, labelled so (decision 15). */
  readonly whatsappCostEstimatedMinor: number;
}

interface SnapshotRow extends Record<string, unknown> {
  subscriber_company_id: string;
  month: string;
  single_room_units: number;
  self_contained_units: number;
  commercial_units: number;
}

interface InvoiceRow extends Record<string, unknown> {
  subscriber_company_id: string;
  month: string;
  status: string;
  due_on: string;
  total_minor: number;
  settled_minor: number;
}

interface MessagingRow extends Record<string, unknown> {
  company_id: string;
  sms: number;
  whatsapp: number;
  email: number;
  push: number;
  sms_cost_minor: number;
  whatsapp_estimated_minor: number;
}

const key = (companyId: string, month: string) => `${companyId}:${month}`;

/**
 * Usage and messaging costs per company and month (AD-10; M10 decision 15). The billable units
 * come from the month's frozen snapshot, the money from the subscription's own records in the
 * platform company, and the units and messages from each company through narrow functions
 * (`app.platform_unit_counts`, `app.platform_messaging_usage`), never by entering a company. SMS
 * cost is what providers reported; WhatsApp's is estimated from the rate table. No overage is
 * billed (PB-06 is P2).
 */
@Injectable()
export class UsageService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(SubscriptionCoreService) private readonly core: SubscriptionCoreService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** This month in Accra, the platform's own time zone. */
  private thisMonth(): string {
    return monthOf(toIsoDate(businessDateOf(instantFrom(this.clock.now()), DEFAULT_TIME_ZONE)));
  }

  /** `platformAdmin.usage`: every company for a month, by default last month. */
  async usage(actor: Actor | null, month?: string): Promise<UsageView[]> {
    const admin = platformAdminFor(this.policy, actor, 'usage.read');
    if (month !== undefined && !MONTH.test(month))
      throw invalid('bad_month', 'Use a month such as 2026-10');
    return this.forMonths(admin, [month ?? previousMonth(this.thisMonth())]);
  }

  /**
   * One company's last `count` months, newest first, ending last month, for the console's company
   * page. The caller has checked the policy.
   */
  async ofCompany(admin: PlatformAdmin, companyId: string, count = 6): Promise<UsageView[]> {
    const last = previousMonth(this.thisMonth());
    const months = Array.from({ length: count }, (_, i) => shiftMonth(last, -i));
    return this.forMonths(admin, months, companyId);
  }

  private async forMonths(
    admin: PlatformAdmin,
    months: readonly string[],
    companyId?: string,
  ): Promise<UsageView[]> {
    return withPlatform(
      this.database,
      { personId: admin.personId, actorKind: 'platform_admin' },
      async (tx) => {
        const companies = (await this.core.subscriberCompanies(tx)).filter(
          (c) => companyId === undefined || c.id === companyId,
        );
        const monthList = `{${months.join(',')}}`;
        const snapshots = await tx.execute<SnapshotRow>(
          sql`select subscriber_company_id, month, single_room_units, self_contained_units,
                commercial_units
              from billing_snapshot where month = any(${monthList}::text[])`,
        );
        const invoices = await tx.execute<InvoiceRow>(
          sql`select i.subscriber_company_id, i.month, i.status, i.due_on::text as due_on,
                i.total_minor,
                coalesce((select sum(a.amount_minor) from subscription_allocation a
                          left join subscription_payment p
                            on p.company_id = a.company_id and p.id = a.payment_id
                          where a.company_id = i.company_id and a.invoice_id = i.id
                            and (a.payment_id is null or p.status = 'succeeded')), 0) as settled_minor
              from subscription_invoice i
              where i.month = any(${monthList}::text[]) and i.status <> 'void'`,
        );
        const units = await tx.execute<{ company_id: string; units: number }>(
          sql`select company_id, units from app.platform_unit_counts()`,
        );
        const messaging = new Map<string, MessagingRow>();
        for (const month of months) {
          const rows = await tx.execute<MessagingRow>(
            sql`select * from app.platform_messaging_usage(${month})`,
          );
          for (const r of rows.rows) messaging.set(key(r.company_id, month), r);
        }
        const snapshotOf = new Map(
          snapshots.rows.map((r) => [key(r.subscriber_company_id, r.month), r]),
        );
        const unitsOf = new Map(units.rows.map((r) => [r.company_id, Number(r.units)]));
        const out: UsageView[] = [];
        for (const company of companies) {
          for (const month of months) {
            out.push(
              this.view(company, month, {
                snapshot: snapshotOf.get(key(company.id, month)) ?? null,
                invoices: invoices.rows.filter(
                  (i) => i.subscriber_company_id === company.id && i.month === month,
                ),
                units: unitsOf.get(company.id) ?? 0,
                messaging: messaging.get(key(company.id, month)) ?? null,
              }),
            );
          }
        }
        return out;
      },
    );
  }

  private view(
    company: SubscriberCompany,
    month: string,
    facts: {
      snapshot: SnapshotRow | null;
      invoices: InvoiceRow[];
      units: number;
      messaging: MessagingRow | null;
    },
  ): UsageView {
    const today = this.core.todayIn(company.timeZone);
    let invoiced = 0;
    let paid = 0;
    let arrears = 0;
    for (const i of facts.invoices) {
      const total = Number(i.total_minor);
      const settled = Math.min(Number(i.settled_minor), total);
      invoiced += total;
      paid += settled;
      if (i.status === 'open' && i.due_on < today) arrears += total - settled;
    }
    const s = facts.snapshot;
    const m = facts.messaging;
    return {
      company: { id: company.id, name: company.displayName },
      month,
      units: facts.units,
      billableUnits: {
        single_room: s ? Number(s.single_room_units) : 0,
        self_contained: s ? Number(s.self_contained_units) : 0,
        commercial: s ? Number(s.commercial_units) : 0,
      },
      invoicedMinor: invoiced,
      paidMinor: paid,
      arrearsMinor: arrears,
      messages: {
        sms: m ? Number(m.sms) : 0,
        whatsapp: m ? Number(m.whatsapp) : 0,
        email: m ? Number(m.email) : 0,
        push: m ? Number(m.push) : 0,
      },
      smsCostMinor: m ? Number(m.sms_cost_minor) : 0,
      whatsappCostEstimatedMinor: m ? Number(m.whatsapp_estimated_minor) : 0,
    };
  }
}
