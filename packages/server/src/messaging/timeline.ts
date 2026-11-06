import { desc, eq, inArray, or, schema, type Tx } from '@rent/db';
import type { TimelineEvent } from '../tenancy/tenancy.types';
import type { TenantsService } from '../tenancy/tenants.service';
import type { MessagingService } from './messaging.service';

const PREVIEW = 200;
/** The newest messages only; the record's own history keeps its separate cap. */
const LIMIT = 100;

/**
 * The tenant's messages on their timeline (CM-05; decision 9: on every plan, so a Starter landlord
 * finds what the tenant wrote on the record). `message.inbound` is one the tenant or a contact
 * wrote; `message.outbound` one sent to them. The words show only with tenant.view_details, as
 * every other event's data does; Row Level Security keeps a scoped person to their properties.
 */
export function registerMessageTimeline(
  tenants: TenantsService,
  messaging: MessagingService,
): void {
  tenants.useTimelineSource(async (tx: Tx, tenantId, { detailed }): Promise<TimelineEvent[]> => {
    const conversations = await tx
      .select({ id: schema.conversation.id })
      .from(schema.conversation)
      .where(eq(schema.conversation.tenantId, tenantId));
    const m = schema.message;
    const rows = await tx
      .select()
      .from(m)
      .where(
        or(
          eq(m.tenantId, tenantId),
          conversations.length
            ? inArray(
                m.conversationId,
                conversations.map((c) => c.id),
              )
            : undefined,
        ),
      )
      .orderBy(desc(m.createdAt), desc(m.id))
      .limit(LIMIT);
    const visible = rows.filter((r) => r.direction === 'inbound' || r.recipientType !== 'staff');
    if (visible.length === 0) return [];
    const statuses = await messaging.statuses(
      tx,
      visible.map((r) => r.id),
    );
    const people = [
      ...new Set(visible.flatMap((r) => (r.authorPersonId ? [r.authorPersonId] : []))),
    ];
    const names = people.length
      ? await tx
          .select({ id: schema.person.id, name: schema.person.name })
          .from(schema.person)
          .where(inArray(schema.person.id, people))
      : [];
    return visible.map((r) => {
      const status = statuses.get(r.id);
      return {
        at: r.createdAt,
        action: r.direction === 'inbound' ? 'message.inbound' : 'message.outbound',
        recordType: 'message',
        recordId: r.id,
        actorName:
          r.authorType === 'staff'
            ? (names.find((n) => n.id === r.authorPersonId)?.name ?? null)
            : r.authorType === 'bot'
              ? 'Assistant'
              : null,
        data: detailed
          ? {
              channel: r.channel ?? status?.channel ?? null,
              purpose: r.purpose,
              authorType: r.authorType,
              subject: r.subject,
              preview: r.body.slice(0, PREVIEW),
              status: r.direction === 'inbound' ? 'received' : (status?.status ?? 'queued'),
              conversationId: r.conversationId,
            }
          : null,
      };
    });
  });
}
