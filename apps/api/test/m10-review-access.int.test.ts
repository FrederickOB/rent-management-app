import { withSystem, sql } from '@rent/db';
import { InMemoryPayments } from '@rent/integrations';
import { PAYMENT_PROVIDERS, type PaymentProviders } from '@rent/server/core';
import { WebhooksService } from '@rent/server/payments';
import {
  SubscriptionBillingService,
  SubscriptionCoreService,
  withPlatform,
} from '@rent/server/subscription';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMembership,
  createCompany,
  createPerson,
  enrolStaff,
  startApi,
  type Device,
  type TestApi,
} from './support';

/**
 * M10 review over HTTP, with real sign-in (password and TOTP) on real PostgreSQL:
 * - the console's new routes (an invoice with its lines, its snapshot, crediting it, the credit
 *   note's PDF, reactivation, billing on or off) for platform admins only;
 * - BE-20 and BE-21: a retry under the same Idempotency-Key answers the first result and does
 *   nothing twice (onboarding takes a key when sent; extending a trial, crediting an invoice and
 *   turning billing on require one);
 * - BE-17: a signed-in staff member of a read-only company gets 403 SUBSCRIPTION_READ_ONLY, and the
 *   same session works again once the company pays;
 * - BE-18 and BE-24 while read-only: an admin removes a member (whose session loses the company),
 *   inviting stays paused, and refreshing the dashboard works.
 */
const PASSWORD = 'correct horse battery staple';
const running: TestApi[] = [];

afterAll(async () => {
  for (const api of running) await api.close();
});

/** The 1st of next month in Accra (UTC+0), as YYYY-MM-DD. */
function nextFirst(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    .toISOString()
    .slice(0, 10);
}

async function stack() {
  const api = await startApi({ AUTH_RATE_LIMITS: 'off' });
  running.push(api);
  const platformId = await createCompany(api, 'platform', 'Platform');
  const agencyId = await createCompany(api, 'agency', 'Review Agency');
  const signedIn = async (email: string, role: Parameters<typeof addMembership>[3], id: string) => {
    const { personId } = await createPerson(api, { name: email, email, password: PASSWORD });
    const membershipId = await addMembership(api, id, personId, role);
    return { device: (await enrolStaff(api, email, PASSWORD)).device, membershipId };
  };
  return {
    api,
    platformId,
    agencyId,
    platformAdmin: (await signedIn('platform@review.invalid', 'platform_admin', platformId)).device,
    agencyAdmin: (await signedIn('admin@review.invalid', 'agency_admin', agencyId)).device,
    signedIn,
  };
}

const keyed = (key: string) => ({ headers: { 'idempotency-key': key } });

describe('BE-5 BE-20 AD-10 turning billing on over HTTP (founder answer Q1)', () => {
  it('needs a key, refuses placeholder prices, and a retry turns it on once', async () => {
    const { platformAdmin, agencyAdmin } = await stack();
    const off = await platformAdmin.call('/platform/billing');
    expect(off.status).toBe(200);
    expect(off.json).toMatchObject({ on: false, startsOn: null });
    const startsOn = nextFirst();
    const body = { startsOn, note: 'Pilot pricing agreed' };
    const keyless = await platformAdmin.call('/platform/billing', { body });
    expect(keyless.status).toBe(400);
    expect(keyless.json.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const placeholders = await platformAdmin.call('/platform/billing', {
      body,
      ...keyed('billing-on-0001'),
    });
    expect(placeholders.status).toBe(409);
    expect(placeholders.json.code).toBe('PLACEHOLDER_PRICES');
    for (const tier of ['starter', 'growth', 'portfolio'])
      expect(
        (
          await platformAdmin.call('/platform/price-lists', {
            body: {
              tier,
              ratesMinor: { single_room: 600, self_contained: 1100, commercial: 2100 },
              minimumMinor: 6000,
              annualDiscountBps: 1000,
              effectiveFrom: startsOn,
            },
          })
        ).status,
        tier,
      ).toBe(200);
    expect(
      (await agencyAdmin.call('/platform/billing', { body, ...keyed('billing-on-0002') })).status,
    ).toBe(403);
    const on = await platformAdmin.call('/platform/billing', { body, ...keyed('billing-on-0003') });
    expect(on.status, JSON.stringify(on.json)).toBe(200);
    expect(on.json).toMatchObject({ startsOn, placeholderTiers: [] });
    const replay = await platformAdmin.call('/platform/billing', {
      body,
      ...keyed('billing-on-0003'),
    });
    expect(replay.status).toBe(200);
    expect(replay.json).toEqual(on.json);
    const again = await platformAdmin.call('/platform/billing', {
      body,
      ...keyed('billing-on-0004'),
    });
    expect(again.status).toBe(409);
    expect(again.json.code).toBe('BILLING_ALREADY_ON');
  });
});

describe('M10 review over HTTP: the console, keys, read-only and paying', () => {
  let s: Awaited<ReturnType<typeof stack>>;
  let manager: Device;
  let leaver: { device: Device; membershipId: string };
  let invoiceId: string;

  beforeAll(async () => {
    s = await stack();
    manager = (await s.signedIn('manager@review.invalid', 'property_manager', s.agencyId)).device;
    leaver = await s.signedIn('leaver@review.invalid', 'accountant', s.agencyId);
    // Billing on since January, the agency with no trial, and an invoice 20 days overdue (beyond
    // the 14 days' grace): the test control's path.
    await withSystem(s.api.database, {}, (tx) =>
      tx.execute(sql`select app.turn_on_billing('2026-01-01'::date, 'API review test')`),
    );
    const core = s.api.app.get(SubscriptionCoreService);
    await withPlatform(s.api.database, {}, async (tx, platformId) => {
      const company = await core.subscriberCompany(tx, s.agencyId);
      await core.ensure(tx, platformId, company!, { trialDays: 0 });
    });
    invoiceId = (
      await s.api.app.get(SubscriptionBillingService).forceOverdueInvoice(s.agencyId, 20)
    ).id;
  });

  it('BE-17 PB-11 refuses a signed-in staff member’s change with 403 SUBSCRIPTION_READ_ONLY', async () => {
    const view = await s.agencyAdmin.call('/subscription');
    expect(view.json).toMatchObject({ access: 'read_only' });
    const refused = await s.agencyAdmin.call('/owners', {
      body: { kind: 'individual', displayName: 'Refused Owner' },
    });
    expect(refused.status).toBe(403);
    expect(refused.json.code).toBe('SUBSCRIPTION_READ_ONLY');
    expect(String(refused.json.message)).toContain('past due');
  });

  it('BE-24 DA-01 refreshes the dashboard while read-only', async () => {
    const refresh = await manager.call('/dashboard/refresh', { method: 'POST', body: {} });
    expect(refresh.status).toBe(200);
    expect(refresh.json).toEqual({ queued: true });
  });

  it('BE-18 AD-03 removes a member while read-only; inviting stays paused', async () => {
    expect((await leaver.device.call('/owners')).status).toBe(200);
    const invite = await s.agencyAdmin.call('/memberships', {
      body: { name: 'New Hire', email: 'new.hire@review.invalid', role: 'accountant' },
    });
    expect(invite.status).toBe(403);
    expect(invite.json.code).toBe('SUBSCRIPTION_READ_ONLY');
    const removed = await s.agencyAdmin.call(`/memberships/${leaver.membershipId}/revoke`, {
      method: 'POST',
      body: {},
    });
    expect(removed.status, JSON.stringify(removed.json)).toBe(200);
    expect(removed.json).toMatchObject({ status: 'revoked' });
    // The removed person's session no longer reaches the company.
    expect([401, 403]).toContain((await leaver.device.call('/owners')).status);
  });

  it('AD-10 PB-02 serves an invoice, its snapshot and its credit notes to platform admins only', async () => {
    const path = `/platform/companies/${s.agencyId}/invoices/${invoiceId}`;
    const invoice = await s.platformAdmin.call(path);
    expect(invoice.status, JSON.stringify(invoice.json)).toBe(200);
    expect(invoice.json).toMatchObject({ id: invoiceId, creditNotes: [] });
    expect((invoice.json.lines as unknown[]).length).toBeGreaterThan(0);
    const snapshot = await s.platformAdmin.call(
      `/platform/companies/${s.agencyId}/snapshots/${String(invoice.json.snapshotId)}`,
    );
    expect(snapshot.status).toBe(200);
    expect(snapshot.json).toMatchObject({ id: invoice.json.snapshotId });
    expect((await s.agencyAdmin.call(path)).status).toBe(403);
    const reactivate = await s.platformAdmin.call(`/platform/companies/${s.agencyId}/reactivate`, {
      body: { tier: 'growth', reason: 'Not cancelled, so refused' },
    });
    expect(reactivate.status).toBe(409);
    expect(reactivate.json.code).toBe('NOT_CANCELLED');
    expect((await s.platformAdmin.call('/platform/billing')).json).toMatchObject({ on: true });
  });

  it('BE-6 BE-20 credits an invoice once under a key, however often it is retried', async () => {
    const path = `/platform/companies/${s.agencyId}/invoices/${invoiceId}/credit`;
    const body = { amountMinor: 100, reason: 'Goodwill for the outage' };
    const keyless = await s.platformAdmin.call(path, { body });
    expect(keyless.status).toBe(400);
    expect(keyless.json.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const credited = await s.platformAdmin.call(path, { body, ...keyed('credit-note-0001') });
    expect(credited.status, JSON.stringify(credited.json)).toBe(200);
    expect(credited.json).toMatchObject({
      invoiceId,
      amountMinor: 100,
      number: expect.stringMatching(/^SUBC-\d{4}-\d{6,}$/),
    });
    const replay = await s.platformAdmin.call(path, { body, ...keyed('credit-note-0001') });
    expect(replay.status).toBe(200);
    expect(replay.json.id).toBe(credited.json.id);
    const reused = await s.platformAdmin.call(path, {
      body: { ...body, amountMinor: 200 },
      ...keyed('credit-note-0001'),
    });
    expect(reused.status).toBe(422);
    const detail = await s.platformAdmin.call(
      `/platform/companies/${s.agencyId}/invoices/${invoiceId}`,
    );
    expect((detail.json.creditNotes as { id: string }[]).map((c) => c.id)).toEqual([
      credited.json.id,
    ]);
    const pdf = await s.platformAdmin.call(
      `/platform/companies/${s.agencyId}/credit-notes/${String(credited.json.id)}/document`,
    );
    // The PDF renders in the worker; until then the route says so.
    expect([200, 409]).toContain(pdf.status);
    if (pdf.status === 409) expect(pdf.json.code).toBe('DOCUMENT_RENDERING');
  });

  it('BE-17 PB-07 works again for the same session once the company pays', async () => {
    const paid = await s.agencyAdmin.call('/subscription/payments', {
      body: { purpose: 'invoices', channel: 'card' },
      ...keyed('pay-review-0001'),
    });
    expect(paid.status, JSON.stringify(paid.json)).toBe(200);
    const fake = s.api.app
      .get<PaymentProviders>(PAYMENT_PROVIDERS)
      .get('paystack') as InMemoryPayments;
    const webhook = await fake.completeCharge(String(paid.json.reference), { status: 'success' });
    const delivered = await fetch(`${s.api.baseUrl}/webhooks/paystack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...webhook!.headers },
      body: webhook!.rawBody,
    });
    expect(delivered.status).toBe(200);
    const inbox = await withSystem(s.api.database, {}, (tx) =>
      tx.execute<{ id: string }>(sql`select id from app.claim_webhook_inbox(10)`),
    );
    for (const row of inbox.rows) await s.api.app.get(WebhooksService).process(row.id);
    expect((await s.agencyAdmin.call('/subscription')).json).toMatchObject({ access: 'full' });
    const allowed = await s.agencyAdmin.call('/owners', {
      body: { kind: 'individual', displayName: 'Allowed Again' },
    });
    expect(allowed.status, JSON.stringify(allowed.json)).toBe(200);
  });

  it('BE-20 BE-21 onboarding and extending a trial: a retry under the same key does nothing twice', async () => {
    const onboarding = {
      kind: 'agency',
      name: 'Keyed Agency',
      tier: 'starter',
      trialDays: 30,
      adminName: 'Keyed Admin',
      adminEmail: 'keyed.admin@agency.invalid',
    };
    const first = await s.platformAdmin.call('/platform/companies', {
      body: onboarding,
      ...keyed('onboard-keyed-0001'),
    });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    const again = await s.platformAdmin.call('/platform/companies', {
      body: onboarding,
      ...keyed('onboard-keyed-0001'),
    });
    expect(again.status).toBe(200);
    const id = (first.json.company as { id: string }).id;
    expect((again.json.company as { id: string }).id).toBe(id);
    const list = (await s.platformAdmin.call('/platform/companies')).json as unknown as {
      company: { name: string };
    }[];
    expect(list.filter((c) => c.company.name === 'Keyed Agency')).toHaveLength(1);
    expect(s.api.email.sent.filter((m) => m.to === 'keyed.admin@agency.invalid')).toHaveLength(1);

    const trialEnd = String(first.json.trialEndsOn);
    const plusDays = (day: string, days: number) =>
      new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
    const trial = `/platform/companies/${id}/trial`;
    const body = { days: 10, reason: 'Onboarding took longer' };
    const keyless = await s.platformAdmin.call(trial, { body });
    expect(keyless.status).toBe(400);
    expect(keyless.json.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const extended = await s.platformAdmin.call(trial, { body, ...keyed('trial-keyed-0001') });
    expect(extended.status, JSON.stringify(extended.json)).toBe(200);
    expect(extended.json.trialEndsOn).toBe(plusDays(trialEnd, 10));
    const retried = await s.platformAdmin.call(trial, { body, ...keyed('trial-keyed-0001') });
    expect(retried.status).toBe(200);
    expect(retried.json.trialEndsOn).toBe(plusDays(trialEnd, 10));
    const more = await s.platformAdmin.call(trial, { body, ...keyed('trial-keyed-0002') });
    expect(more.json.trialEndsOn).toBe(plusDays(trialEnd, 20));
    expect((await s.agencyAdmin.call(trial, { body, ...keyed('trial-keyed-0003') })).status).toBe(
      403,
    );
  });
});
