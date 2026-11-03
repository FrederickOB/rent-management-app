import { Inject, Injectable } from '@nestjs/common';
import { schema, sql, withCompany, type Database } from '@rent/db';
import { formatBusinessDate } from '@rent/domain/dates';
import { format, money } from '@rent/domain/money';
import { companyRecord } from '../companies/companies.service';
import { ownerFacts } from '../companies/owners.service';
import { queueMessage } from '../core/messages';
import { DATABASE } from '../core/tokens';
import { membersWhoCan } from '../policy/members';
import { PolicyService } from '../policy/policy.service';
import { taxItems } from './tax-records';
import { TaxReportService } from './tax-report.service';

/**
 * TX-02's alerts (`tax.rent-tax-alerts`, daily 08:00; M5 plan 5.1 and decision 5). For each item
 * still owed to GRA, every alert day its rule names (21 and 28, `rent_tax.alert_days`) that has
 * been reached is recorded once; the company's accountants and admins (whoever the policy lets
 * pay GRA, `tax.manage`, within their owners) get one email per owner listing them. Items the
 * tenant withheld raise none, nor do items paid or reversed. The due list shows them too.
 */
@Injectable()
export class TaxAlertsService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(TaxReportService) private readonly reports: TaxReportService,
  ) {}

  /** One company's run for a day. Returns the alerts recorded. */
  async run(companyId: string, today: string): Promise<number> {
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const company = await companyRecord(tx, companyId);
      if (!company) return 0;
      const open = (await taxItems(tx, sql`i.due_date is not null`)).filter(
        (i) => i.outstandingMinor > 0,
      );
      if (open.length === 0) return 0;
      const due = await this.reports.dueOf(tx, open, today);
      const fresh = due
        .map((i) => ({ item: i, days: i.alertsReached.filter((d) => !i.alertsSent.includes(d)) }))
        .filter((x) => x.days.length > 0);
      let recorded = 0;
      const byOwner = new Map<string, typeof fresh>();
      for (const x of fresh)
        byOwner.set(x.item.ownerId, [...(byOwner.get(x.item.ownerId) ?? []), x]);
      for (const [ownerId, alerts] of byOwner) {
        const recipients = await membersWhoCan(tx, this.policy, company, 'tax.manage', {
          propertyId: null,
          ownerId,
        });
        for (const { item, days } of alerts)
          for (const day of days) {
            const inserted = await tx
              .insert(schema.rentTaxAlert)
              .values({
                companyId,
                itemId: item.id,
                ownerId,
                propertyId: item.propertyId,
                alertDay: day,
                alertDate: today,
                ruleId: item.alertRuleId,
                recipients: recipients.length,
              })
              .onConflictDoNothing()
              .returning({ id: schema.rentTaxAlert.id });
            recorded += inserted.length;
          }
        const owner = (await ownerFacts(tx, [ownerId])).get(ownerId);
        const lines = alerts.map(
          ({ item }) =>
            `${item.receiptNumber ?? 'Credit carried'} (${item.unitCode}): ${format(money(item.outstandingMinor))} due ${formatBusinessDate(item.dueDate ?? item.valueDate)}${item.dueDays === null ? '' : `, ${daysText(item.dueDays)} after it was received`}`,
        );
        // Review 8: the days come from the rules rows the items used, never from this code.
        const days = [...new Set(alerts.map(({ item }) => item.dueDays))];
        const within =
          days.length === 1 && days[0] !== null && days[0] !== undefined
            ? `within ${daysText(days[0])} of the rent being received`
            : 'by the due date shown';
        for (const personId of recipients)
          await queueMessage(tx, companyId, {
            recipient: { type: 'staff', personId },
            purpose: 'staff_notice',
            subject: `Rent tax due to GRA for ${owner?.displayName ?? 'an owner'}`,
            body: [
              `Rent tax on these receipts for ${owner?.displayName ?? 'an owner'} is due to GRA ${within}:`,
              ...lines,
              'Record the GRA payment in Rent tax once it is paid.',
            ].join('\n'),
            channels: ['email'],
            propertyId: null,
            related: { type: 'owner', id: ownerId },
            requestedBy: null,
          });
      }
      return recorded;
    });
  }
}

const daysText = (days: number) => `${days} day${days === 1 ? '' : 's'}`;
