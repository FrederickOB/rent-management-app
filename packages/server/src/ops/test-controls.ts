import { randomUUID } from 'node:crypto';
import { eq, schema, sql, withCompany, withSystem, type Database } from '@rent/db';
import { conflict, invalid, notFound } from '../core/errors';
import { DEAD_LETTER_QUEUE } from '../core/jobs/job';
import { MESSAGING_WEBHOOK_PREFIX } from '../core/messages';
import type { PaymentProviders } from '../core/payment-providers';
import type { PayLinksService } from '../payments/pay-links.service';
import type { PayPageService } from '../payments/pay-page.service';

/**
 * The web e2e specs' operations controls (M11 decision 9), called only by the api's test controls
 * controller (E2E_TEST_CONTROLS=on, never in production).
 *
 * `storeFailedWebhook` stores a webhook as a real one that failed looks: signed, with its body,
 * published to its job and dead-lettered (or failed), with a last error. Replaying it goes down the
 * normal path and succeeds in a defined way, posting and sending nothing:
 * - a payments provider (`paystack`): a `charge.success` for a reference no provider knows; the
 *   verify answers 404, and the row ends `processed` with outcome `unknown`;
 * - `messaging.whatsapp`: a `delivered` status for a message we never sent; the row ends
 *   `processed` with outcome `unknown_message`.
 */
export async function storeFailedWebhook(
  database: Database,
  input: { readonly provider: string; readonly status: 'failed' | 'dead_lettered' },
): Promise<string> {
  const tag = randomUUID();
  let event: { eventId: string; eventType: string; reference: string; body: string };
  if (input.provider === `${MESSAGING_WEBHOOK_PREFIX}whatsapp`) {
    const wamid = `wamid.e2e-${tag}`;
    event = {
      eventId: `status:${wamid}:delivered`,
      eventType: 'status',
      reference: wamid,
      body: JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: '200000000000001',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    display_phone_number: '233302000001',
                    phone_number_id: '100000000000001',
                  },
                  statuses: [
                    {
                      id: wamid,
                      status: 'delivered',
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      recipient_id: '233200000000',
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    };
  } else if (input.provider.startsWith(MESSAGING_WEBHOOK_PREFIX)) {
    throw invalid('bad_provider', 'Use a payments provider or messaging.whatsapp');
  } else {
    const reference = `E2E-${tag.replaceAll('-', '').slice(0, 24)}`;
    event = {
      eventId: `e2e:${tag}`,
      eventType: 'charge.success',
      reference,
      body: JSON.stringify({
        event: 'charge.success',
        data: { id: tag, reference, status: 'success', amount: 100_000, currency: 'GHS' },
      }),
    };
  }
  const [row] = await withSystem(database, {}, (tx) =>
    tx
      .insert(schema.webhookInbox)
      .values({
        provider: input.provider,
        eventId: event.eventId,
        eventType: event.eventType,
        reference: event.reference,
        rawBody: event.body,
        bodySha256: null,
        bodyBytes: Buffer.byteLength(event.body),
        headers: { 'content-type': 'application/json', 'user-agent': 'e2e-test-control' },
        signatureValid: true,
        status: 'failed',
        outcome: input.status === 'dead_lettered' ? 'dead_lettered' : 'failed',
        publishedAt: new Date(),
        processedAt: new Date(),
        lastError: 'ProviderError: provider unavailable (HTTP 503)',
      })
      .returning({ id: schema.webhookInbox.id }),
  );
  return row!.id;
}

/**
 * `storeDeadLetter` puts a job in the dead-letter queue as pg-boss's own transfer does (the copy
 * keeps its queue, payload, retry count and last error), for a queue that exists. A retry sends it
 * to that queue again. With the default queue, `ops.queue-age`, the retried job is the minute's
 * queue check: it runs and succeeds, changing nothing.
 */
export async function storeDeadLetter(
  database: Database,
  input: { readonly queue: string },
): Promise<string> {
  return withSystem(database, {}, async (tx) => {
    const installed = await tx.execute<{ ok: boolean }>(
      sql`select to_regclass('pgboss.queue') is not null and to_regclass('pgboss.job') is not null as ok`,
    );
    if (installed.rows[0]?.ok !== true)
      throw conflict('queue_missing', 'The job queues are not installed yet (pnpm db:migrate)');
    const queues = await tx.execute<{ name: string }>(
      sql`select name from pgboss.queue where name in (${input.queue}, ${DEAD_LETTER_QUEUE})`,
    );
    const names = new Set(queues.rows.map((r) => r.name));
    if (!names.has(input.queue) || !names.has(DEAD_LETTER_QUEUE))
      throw conflict('queue_missing', 'That queue (or the dead-letter queue) does not exist yet');
    const output = { name: 'Error', message: 'e2e test control: the job gave up' };
    const inserted = await tx.execute<{ id: string }>(
      sql`insert into pgboss.job (name, data, retry_limit, retry_backoff, retry_delay, start_after,
            created_on, keep_until, deletion_seconds, expire_seconds, heartbeat_seconds,
            source_name, source_id, source_created_on, source_retry_count, source_output)
          select q.name, ${JSON.stringify({ __job: input.queue })}::jsonb, q.retry_limit,
            q.retry_backoff, q.retry_delay, now(), now(), now() + q.retention_seconds * interval '1s',
            q.deletion_seconds, q.expire_seconds, q.heartbeat_seconds, ${input.queue},
            gen_random_uuid(), now() - interval '1 hour', 2, ${JSON.stringify(output)}::jsonb
          from pgboss.queue q where q.name = ${DEAD_LETTER_QUEUE}
          returning id::text as id`,
    );
    return inserted.rows[0]!.id;
  });
}

/**
 * M11 review C6: a failed webhook for a real payment, so the e2e spec can watch a replay post it.
 * For an open invoice the caller names (the spec makes its own lease and invoice, as the links
 * specs do), it starts a MoMo charge on the invoice's pay link (a real pending intent, at the
 * company's provider), has the provider mark it paid without sending its webhook (as if the
 * webhook were lost), and stores that webhook as dead-lettered. Nothing is posted until a replay:
 * then the normal path verifies the charge and posts exactly one payment and one receipt; a
 * second replay finds it posted. Answers the inbox id and the charge reference.
 */
export async function storeFailedChargeWebhook(
  deps: {
    readonly database: Database;
    readonly links: PayLinksService;
    readonly page: PayPageService;
    readonly providers: PaymentProviders;
  },
  input: { readonly companyId: string; readonly invoiceId: string; readonly amountMinor?: number },
): Promise<{ id: string; reference: string }> {
  const { url } = await withCompany(
    deps.database,
    { companyId: input.companyId, actorKind: 'system' },
    async (tx) => deps.links.mint(tx, await deps.links.invoice(tx, input.invoiceId)),
  );
  const token = url.split('/p/')[1] ?? '';
  const client = { ip: '127.0.0.1', userAgent: 'e2e-test-control' };
  const page = await deps.page.open(token, client);
  const amountMinor = input.amountMinor ?? page.amounts.prefillMinor;
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 100)
    throw conflict('nothing_due', 'The invoice has nothing to pay');
  const intent = await deps.page.start(token, client, {
    amountMinor,
    method: 'momo',
    momo: { phone: '024 000 0003', network: 'mtn' },
    submissionId: randomUUID(),
  });
  const [row] = await withCompany(
    deps.database,
    { companyId: input.companyId, actorKind: 'system' },
    (tx) =>
      tx
        .select({
          reference: schema.paymentIntent.reference,
          provider: schema.paymentIntent.provider,
        })
        .from(schema.paymentIntent)
        .where(eq(schema.paymentIntent.id, intent.intentId)),
  );
  if (!row?.provider) throw conflict('charge_not_started', 'The provider did not take the charge');
  const port = deps.providers.get(row.provider) as unknown as Partial<{
    completeCharge(
      reference: string,
      outcome: { status: 'success'; webhook: false },
    ): Promise<unknown>;
  }>;
  if (typeof port.completeCharge !== 'function')
    throw conflict('no_test_provider', 'This provider has no test controls');
  await port.completeCharge(row.reference, { status: 'success', webhook: false });
  const body = JSON.stringify({
    event: 'charge.success',
    data: { reference: row.reference, status: 'success', amount: amountMinor, currency: 'GHS' },
  });
  const [stored] = await withSystem(deps.database, {}, (tx) =>
    tx
      .insert(schema.webhookInbox)
      .values({
        provider: row.provider!,
        eventId: `charge.success:e2e-${randomUUID()}`,
        eventType: 'charge.success',
        reference: row.reference,
        rawBody: body,
        bodyBytes: Buffer.byteLength(body),
        headers: { 'content-type': 'application/json', 'user-agent': 'e2e-test-control' },
        signatureValid: true,
        status: 'failed',
        outcome: 'dead_lettered',
        publishedAt: new Date(),
        processedAt: new Date(),
        lastError: 'ProviderError: provider unavailable (HTTP 503)',
      })
      .returning({ id: schema.webhookInbox.id }),
  );
  return { id: stored!.id, reference: row.reference };
}

/** M11 review C6: the payments and receipts a charge reference has, for the e2e spec's check. */
export async function paymentsByReference(
  database: Database,
  reference: string,
): Promise<{ payments: number; receipts: number }> {
  if (!/^[A-Za-z0-9.=_-]{1,120}$/.test(reference))
    throw invalid('bad_reference', 'Not a reference');
  const found = await withSystem(database, {}, (tx) =>
    tx.execute<{ company_id: string }>(
      sql`select company_id from app.payment_intent_by_reference(${reference})`,
    ),
  );
  const companyId = found.rows[0]?.company_id;
  if (!companyId) throw notFound('Charge reference');
  return withCompany(database, { companyId, actorKind: 'system' }, async (tx) => {
    const counts = await tx.execute<{ payments: number; receipts: number }>(
      sql`select count(distinct p.id)::int as payments, count(distinct r.id)::int as receipts
          from payment p
          left join receipt r on r.company_id = p.company_id and r.payment_id = p.id
          where p.provider_reference = ${reference}`,
    );
    return {
      payments: Number(counts.rows[0]?.payments ?? 0),
      receipts: Number(counts.rows[0]?.receipts ?? 0),
    };
  });
}
