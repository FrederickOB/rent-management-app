import { schema, type Tx } from '@rent/db';

export interface OutboxEvent {
  readonly companyId: string;
  /** Event type; the relay publishes it to the job queue of the same name. */
  readonly type: string;
  readonly payload: Record<string, unknown>;
  /** Unique per company: a replayed business action writes the event once. */
  readonly idempotencyKey: string;
}

/**
 * Records a domain event in the caller's transaction (ADR-005). If the transaction rolls back,
 * the event never existed, so nothing is ever sent for work that did not happen.
 */
export async function enqueueOutbox(tx: Tx, event: OutboxEvent): Promise<void> {
  await tx
    .insert(schema.outboxEvent)
    .values({
      companyId: event.companyId,
      type: event.type,
      payload: event.payload,
      idempotencyKey: event.idempotencyKey,
    })
    .onConflictDoNothing({
      target: [schema.outboxEvent.companyId, schema.outboxEvent.idempotencyKey],
    });
}
