import { schema, sql, withCompany, withSystem } from '@rent/db';
import { SupportAccessService } from '@rent/server/admin';
import { MESSAGING_INBOUND_JOB } from '@rent/server/core';
import { InboundService } from '@rent/server/messaging';
import { QUEUE_AGE_JOB } from '@rent/server/ops';
import { PROCESS_WEBHOOK_JOB, WebhooksService } from '@rent/server/payments';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMembership,
  createCompany,
  createPerson,
  Device,
  enrolStaff,
  startApi,
  type TestApi,
} from './support';

/**
 * M11 decision 9 over HTTP: the worker heartbeat's public `/health/worker` (200 while healthy,
 * 503 when stale or missing, nothing about the data), the console's operations routes (platform
 * admins only) and the web e2e specs' test controls `POST /_test/webhooks/failed` and
 * `POST /_test/jobs/dead` (only with E2E_TEST_CONTROLS=on), whose webhook replays down the normal
 * path and ends `processed` with a defined outcome.
 */
const PASSWORD = 'correct horse battery staple';
let api: TestApi;
let platformId: string;
let platformAdmin: Device;
let agencyAdmin: Device;

beforeAll(async () => {
  api = await startApi({ AUTH_RATE_LIMITS: 'off', E2E_TEST_CONTROLS: 'on' });
  platformId = await createCompany(api, 'platform', 'Platform');
  const agencyId = await createCompany(api, 'agency', 'Ops Agency');
  const signedIn = async (email: string, role: 'agency_admin' | 'platform_admin', id: string) => {
    const { personId } = await createPerson(api, { name: 'Ops Admin', email, password: PASSWORD });
    await addMembership(api, id, personId, role);
    return (await enrolStaff(api, email, PASSWORD)).device;
  };
  platformAdmin = await signedIn('platform@ops.invalid', 'platform_admin', platformId);
  agencyAdmin = await signedIn('admin@ops.invalid', 'agency_admin', agencyId);
});

afterAll(async () => {
  await api?.close();
});

/** The platform outbox events already run, as the worker's relay would run each once. */
const ran = new Set<string>();

/** Runs the processing jobs replays queued in the platform outbox, as the worker would. */
async function runReplays(): Promise<string[]> {
  const events = await withCompany(
    api.database,
    { companyId: platformId, actorKind: 'system' },
    (tx) =>
      tx
        .select({
          id: schema.outboxEvent.id,
          type: schema.outboxEvent.type,
          payload: schema.outboxEvent.payload,
        })
        .from(schema.outboxEvent)
        .where(
          sql`${schema.outboxEvent.type} in (${PROCESS_WEBHOOK_JOB}, ${MESSAGING_INBOUND_JOB})`,
        )
        .orderBy(schema.outboxEvent.createdAt, schema.outboxEvent.id),
  );
  const outcomes: string[] = [];
  for (const e of events) {
    if (ran.has(e.id)) continue;
    ran.add(e.id);
    const { inboxId } = e.payload as { inboxId: string };
    outcomes.push(
      e.type === PROCESS_WEBHOOK_JOB
        ? await api.app.get(WebhooksService).process(inboxId)
        : await api.app.get(InboundService).process(inboxId),
    );
  }
  return outcomes;
}

describe('NFR-AVAIL /health/worker reports the worker heartbeat (M11 decision 9)', () => {
  it('is 503 with no beat, 200 while the beat is fresh and 503 once it is two minutes old; public, uncached, no instance names', async () => {
    const anonymous = new Device(api.baseUrl);
    const missing = await anonymous.call('/health/worker');
    expect(missing.status).toBe(503);
    expect(missing.json).toEqual({
      ok: false,
      status: 'missing',
      lastBeatAt: null,
      ageSeconds: null,
    });
    expect(missing.headers.get('cache-control')).toBe('no-store');

    await withSystem(api.database, {}, (tx) =>
      tx.execute(sql`insert into worker_heartbeat (instance, started_at, beat_at, beats)
                     values ('api-test-worker:1', now(), now(), 1)`),
    );
    const healthy = await anonymous.call('/health/worker');
    expect(healthy.status).toBe(200);
    expect(healthy.json).toMatchObject({ ok: true, status: 'ok', ageSeconds: expect.any(Number) });
    expect(JSON.stringify(healthy.json)).not.toContain('api-test-worker');

    await withSystem(api.database, {}, (tx) =>
      tx.execute(sql`update worker_heartbeat set beat_at = now() - interval '3 minutes'`),
    );
    const stale = await anonymous.call('/health/worker');
    expect(stale.status).toBe(503);
    expect(stale.json).toMatchObject({ ok: false, status: 'stale' });
    expect(Number(stale.json.ageSeconds)).toBeGreaterThanOrEqual(180);

    // The console shows the same, to platform admins only.
    expect((await platformAdmin.call('/platform/ops/heartbeat')).json).toMatchObject({
      healthy: false,
    });
    expect((await agencyAdmin.call('/platform/ops/heartbeat')).status).toBe(403);
    expect((await anonymous.call('/platform/ops/heartbeat')).status).toBe(401);
  });
});

describe('NFR-AVAIL a failed webhook from the test control replays down the normal path (M11 decision 9)', () => {
  it('stores a dead-lettered paystack webhook, lists it, replays it twice and processes it to `unknown`', async () => {
    const made = await platformAdmin.call('/_test/webhooks/failed', {
      body: { provider: 'paystack' },
    });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const id = String(made.json.id);
    expect(
      (await agencyAdmin.call('/_test/webhooks/failed', { body: { provider: 'paystack' } })).status,
    ).toBe(403);
    expect(
      (await platformAdmin.call('/_test/webhooks/failed', { body: { provider: 'nope' } })).status,
    ).toBe(400);

    const listed = await platformAdmin.call('/platform/ops/webhooks?status=dead_lettered');
    expect(listed.status).toBe(200);
    const hook = (listed.json as unknown as Record<string, unknown>[]).find((w) => w.id === id);
    expect(hook).toMatchObject({
      provider: 'paystack',
      eventType: 'charge.success',
      status: 'dead_lettered',
      lastError: 'ProviderError: provider unavailable (HTTP 503)',
      replayCount: 0,
    });
    expect((await agencyAdmin.call('/platform/ops/webhooks')).status).toBe(403);

    const reason = 'Provider recovered at 09:00, replaying';
    const short = await platformAdmin.call(`/platform/ops/webhooks/${id}/replay`, {
      body: { reason: 'ok' },
    });
    expect(short.status).toBe(400);
    expect(
      (await agencyAdmin.call(`/platform/ops/webhooks/${id}/replay`, { body: { reason } })).status,
    ).toBe(403);
    const first = await platformAdmin.call(`/platform/ops/webhooks/${id}/replay`, {
      body: { reason },
    });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json).toMatchObject({
      id,
      status: 'pending',
      replayCount: 1,
      lastReplayedByName: 'Ops Admin',
    });
    const again = await platformAdmin.call(`/platform/ops/webhooks/${id}/replay`, {
      body: { reason: 'Replaying again to check idempotence' },
    });
    expect(again.json).toMatchObject({ status: 'pending', replayCount: 2 });
    // Down the normal path: the provider does not know the reference, so nothing posts. Both
    // replays queued a job; the first processes the row and the second finds it done.
    expect(await runReplays()).toEqual(['unknown', 'skipped']);
    const [row] = await withSystem(api.database, {}, (tx) =>
      tx
        .select()
        .from(schema.webhookInbox)
        .where(sql`${schema.webhookInbox.id} = ${id}`),
    );
    expect(row).toMatchObject({ status: 'processed', outcome: 'unknown', replayCount: 2 });
  });

  it('stores a WhatsApp status the same way, which ends `unknown_message` on replay', async () => {
    const made = await platformAdmin.call('/_test/webhooks/failed', {
      body: { provider: 'messaging.whatsapp', status: 'failed' },
    });
    expect(made.status).toBe(200);
    const id = String(made.json.id);
    const listed = await platformAdmin.call('/platform/ops/webhooks?status=failed');
    expect(
      (listed.json as unknown as Record<string, unknown>[]).find((w) => w.id === id),
    ).toMatchObject({ provider: 'messaging.whatsapp', status: 'failed' });
    const replayed = await platformAdmin.call(`/platform/ops/webhooks/${id}/replay`, {
      body: { reason: 'Meta recovered, replaying the status' },
    });
    expect(replayed.status).toBe(200);
    expect(await runReplays()).toEqual(['unknown_message']);
  });
});

describe('NFR-AVAIL the dead-lettered job test control refuses without job queues (M11 decision 9)', () => {
  it('answers 409 queue_missing, and the console lists no jobs or queues, while pg-boss is not installed', async () => {
    // The api's test databases have no pg-boss schema (the worker's install makes it); the full
    // list-and-retry path is covered in packages/server/test/m11-ops-jobs.int.test.ts.
    const made = await platformAdmin.call('/_test/jobs/dead', { body: {} });
    expect(made.status).toBe(409);
    expect(made.json).toMatchObject({ code: 'queue_missing' });
    expect((await agencyAdmin.call('/_test/jobs/dead', { body: {} })).status).toBe(403);
    expect(
      (await platformAdmin.call('/_test/jobs/dead', { body: { queue: 'Bad Name' } })).status,
    ).toBe(400);
    const jobs = await platformAdmin.call(`/platform/ops/jobs?name=${QUEUE_AGE_JOB}`);
    expect(jobs.status).toBe(200);
    expect(jobs.json).toEqual([]);
    expect((await agencyAdmin.call('/platform/ops/jobs')).status).toBe(403);
    const queues = await platformAdmin.call('/platform/ops/queues');
    expect(queues.status).toBe(200);
    expect(queues.json).toEqual([]);
  });
});

describe('NFR-SEC the operations test controls do not exist without E2E_TEST_CONTROLS (M11)', () => {
  it('answers 404', async () => {
    const plain = await startApi({ AUTH_RATE_LIMITS: 'off' });
    try {
      const id = await createCompany(plain, 'platform', 'Platform');
      const { personId } = await createPerson(plain, {
        name: 'Plain Admin',
        email: 'plain@ops.invalid',
        password: PASSWORD,
      });
      await addMembership(plain, id, personId, 'platform_admin');
      const device = (await enrolStaff(plain, 'plain@ops.invalid', PASSWORD)).device;
      expect(
        (await device.call('/_test/webhooks/failed', { body: { provider: 'paystack' } })).status,
      ).toBe(404);
      expect((await device.call('/_test/jobs/dead', { body: {} })).status).toBe(404);
    } finally {
      await plain.close();
    }
  });
});

describe('AD-10 a platform admin ends a support grant early over HTTP (M11)', () => {
  it('ends the active grant with a reason; staff are refused, and a second end finds none', async () => {
    const landlordId = await createCompany(api, 'landlord', 'Support End Landlord');
    const { personId } = await createPerson(api, {
      name: 'Kofi Owner',
      email: 'owner@ops.invalid',
      password: PASSWORD,
    });
    const membershipId = await addMembership(api, landlordId, personId, 'owner');
    const grant = await api.app.get(SupportAccessService).grant(
      {
        kind: 'staff',
        personId,
        companyId: landlordId,
        companyKind: 'landlord',
        membershipId,
        role: 'owner',
        nominatedApprover: false,
        scope: {},
        authMethod: 'password_totp',
      },
      { reason: 'Help with the statement', hours: 2 },
    );
    const path = `/platform/support/${landlordId}/end`;
    const reason = 'Question answered, closing access';
    expect((await agencyAdmin.call(path, { body: { reason } })).status).toBe(403);
    expect((await platformAdmin.call(path, { body: { reason: 'no' } })).status).toBe(400);
    const ended = await platformAdmin.call(path, { body: { reason } });
    expect(ended.status, JSON.stringify(ended.json)).toBe(200);
    expect(ended.json).toMatchObject({
      id: grant.id,
      active: false,
      revokedByName: 'Ops Admin',
      revokedAt: expect.any(String),
    });
    const again = await platformAdmin.call(path, { body: { reason } });
    expect(again.status).toBe(403);
    // oRPC routes answer the code in capitals (the contract's SUPPORT_NO_GRANT).
    expect(again.json).toMatchObject({ code: 'SUPPORT_NO_GRANT' });
  });
});

describe('NFR-AVAIL the review-round operations routes and controls over HTTP (M11 review C6, C8)', () => {
  it('shows one stored webhook to platform admins, to follow a replay', async () => {
    const made = await platformAdmin.call('/_test/webhooks/failed', {
      body: { provider: 'paystack' },
    });
    const id = String(made.json.id);
    const one = await platformAdmin.call(`/platform/ops/webhooks/${id}`);
    expect(one.status, JSON.stringify(one.json)).toBe(200);
    expect(one.json).toMatchObject({ id, status: 'dead_lettered', replayCount: 0 });
    expect((await agencyAdmin.call(`/platform/ops/webhooks/${id}`)).status).toBe(403);
    expect(
      (await platformAdmin.call('/platform/ops/webhooks/01a1c56b-0000-7000-8000-000000000000'))
        .status,
    ).toBe(404);
  });

  it('the charge control asks for a company and an open invoice of it; the payments count needs a known reference', async () => {
    const noInvoice = await platformAdmin.call('/_test/webhooks/failed', {
      body: { provider: 'paystack', charge: true },
    });
    expect(noInvoice.status).toBe(400);
    const unknownInvoice = await platformAdmin.call('/_test/webhooks/failed', {
      body: {
        provider: 'paystack',
        charge: true,
        companyId: platformId,
        invoiceId: '01a1c56b-0000-7000-8000-000000000001',
      },
    });
    expect(unknownInvoice.status).toBe(404);
    expect((await platformAdmin.call('/_test/payments')).status).toBe(400);
    expect(
      (await platformAdmin.call(`/_test/payments?reference=pi-${'0'.repeat(32)}`)).status,
    ).toBe(404);
    expect((await agencyAdmin.call(`/_test/payments?reference=pi-${'0'.repeat(32)}`)).status).toBe(
      403,
    );
  });

  it('runs a company’s nightly ledger checks, read only: no differences for a fresh company', async () => {
    const companyId = await createCompany(api, 'landlord', 'Ledger Checks Landlord');
    const checked = await platformAdmin.call(`/_test/ledger-checks/${companyId}`, { body: {} });
    expect(checked.status, JSON.stringify(checked.json)).toBe(200);
    expect(checked.json).toEqual({ differences: [] });
    expect(
      (
        await platformAdmin.call('/_test/ledger-checks/01a1c56b-0000-7000-8000-000000000002', {
          body: {},
        })
      ).status,
    ).toBe(404);
    expect((await platformAdmin.call('/_test/ledger-checks/nope', { body: {} })).status).toBe(400);
    expect((await agencyAdmin.call(`/_test/ledger-checks/${companyId}`, { body: {} })).status).toBe(
      403,
    );
  });
});
