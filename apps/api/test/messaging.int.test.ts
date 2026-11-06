import { createHmac } from 'node:crypto';
import { DEV_WEBHOOK_SECRET, DEV_WHATSAPP_APP_SECRET } from '@rent/server/core';
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
 * M6 over HTTP: the messaging webhooks (plan 4.4), the live inbox stream (plan 4.6) and the
 * routes the web app relies on, with the plan rule (decision 9).
 */
const PASSWORD = 'correct horse battery staple';
let api: TestApi;
let manager: Device;
let starter: Device;

async function signedIn(
  email: string,
  role: 'property_manager' | 'owner' | 'platform_admin',
  companyId: string,
) {
  const { personId } = await createPerson(api, { name: email, email, password: PASSWORD });
  await addMembership(api, companyId, personId, role);
  return (await enrolStaff(api, email, PASSWORD)).device;
}

beforeAll(async () => {
  api = await startApi({ AUTH_RATE_LIMITS: 'off' });
  const agencyId = await createCompany(api, 'agency', 'Inbox Agency');
  const landlordId = await createCompany(api, 'landlord', 'Starter Landlord');
  const platformId = await createCompany(api, 'platform', 'Platform');
  const admin = await signedIn('admin@inbox.invalid', 'platform_admin', platformId);
  const plan = await admin.call(`/platform/companies/${landlordId}/plan`, {
    method: 'PUT',
    body: { plan: 'starter' },
  });
  expect(plan.json).toMatchObject({ companyId: landlordId, plan: 'starter' });
  manager = await signedIn('manager@inbox.invalid', 'property_manager', agencyId);
  starter = await signedIn('landlord@inbox.invalid', 'owner', landlordId);
});

afterAll(async () => {
  await api?.close();
});

const meta = (raw: string) =>
  `sha256=${createHmac('sha256', DEV_WHATSAPP_APP_SECRET).update(raw).digest('hex')}`;
const post = (path: string, raw: string, headers: Record<string, string> = {}) =>
  fetch(`${api.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: raw,
  });

describe('CM-01 CM-02 messaging webhooks (plan 4.4)', () => {
  it('answers Meta’s subscription check only for our verify token', async () => {
    const ok = await fetch(
      `${api.baseUrl}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=fake-providers-verify-token-dev-only&hub.challenge=1158201444`,
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('1158201444');
    const wrong = await fetch(
      `${api.baseUrl}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`,
    );
    expect(wrong.status).toBe(403);
  });

  it('takes a signed WhatsApp webhook and refuses a changed one; Hubtel and Postmark need our secret', async () => {
    const raw = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '100000000000001' },
                messages: [
                  {
                    from: '233200000001',
                    id: 'wamid.api-1',
                    timestamp: '1',
                    type: 'text',
                    text: { body: 'Hi' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(
      (await post('/webhooks/whatsapp', raw, { 'x-hub-signature-256': meta(raw) })).status,
    ).toBe(200);
    expect(
      (
        await post('/webhooks/whatsapp', raw.replace('Hi', 'Ho'), {
          'x-hub-signature-256': meta(raw),
        })
      ).status,
    ).toBe(401);
    const sms = JSON.stringify({
      from: '233200000001',
      to: '1440',
      content: 'Hello',
      messageId: 'api-sms-1',
    });
    expect((await post('/webhooks/sms/inbound', sms)).status).toBe(401);
    expect((await post(`/webhooks/sms/inbound?secret=${DEV_WEBHOOK_SECRET}`, sms)).status).toBe(
      200,
    );
    const basic = `Basic ${Buffer.from(`postmark:${DEV_WEBHOOK_SECRET}`).toString('base64')}`;
    const event = JSON.stringify({
      RecordType: 'Delivery',
      MessageID: 'pm-1',
      DeliveredAt: new Date().toISOString(),
    });
    expect((await post('/webhooks/email/events', event, { authorization: basic })).status).toBe(
      200,
    );
  });
});

describe('CM-05 CM-06 the live inbox stream (plan 4.6)', () => {
  it('opens with a comment, with headers that keep proxies from buffering it', async () => {
    const controller = new AbortController();
    const response = await fetch(`${api.baseUrl}/inbox/stream`, {
      headers: {
        cookie: manager.cookieHeader(),
        origin: 'http://localhost:3701',
        'user-agent': 'vitest-device',
      },
      signal: controller.signal,
    });
    try {
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
      expect(response.headers.get('x-accel-buffering')).toBe('no');
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe(': ok\n\n');
    } finally {
      controller.abort();
    }
  });

  it('refuses the stream to a Starter company (decision 9), as a JSON error', async () => {
    const response = await fetch(`${api.baseUrl}/inbox/stream`, {
      headers: {
        cookie: starter.cookieHeader(),
        origin: 'http://localhost:3701',
        'user-agent': 'vitest-device',
      },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'not_on_plan' });
  });
});

describe('CM-05 CM-06 inbox routes for the web app', () => {
  it('reads settings as a manager, opens a tenant’s conversation with an empty body, and lists groups', async () => {
    const settings = await manager.call('/messaging/settings');
    expect(settings.status).toBe(200);
    expect(settings.json).toMatchObject({ plan: 'growth', firstResponseMinutes: 240 });
    const created = await manager.call('/tenants', {
      body: { kind: 'individual', displayName: 'Inbox Tenant', phone: '+233200000301' },
    });
    expect(created.status).toBe(200);
    const tenantId = (created.json as { tenant: { id: string } }).tenant.id;
    const opened = await manager.call(`/tenants/${tenantId}/conversation`, {
      method: 'POST',
      body: {},
    });
    expect(opened.status).toBe(200);
    expect(opened.json).toMatchObject({ tenant: { id: tenantId } });
    const detail = await manager.call(`/conversations/${(opened.json as { id: string }).id}`);
    expect(detail.json).toMatchObject({
      can: { reply: true, assign: true, tag: true, resolve: true },
    });
    expect((await manager.call('/tenant-groups?archived=true')).json).toEqual([]);
    const blocked = await starter.call('/conversations');
    expect(blocked.status).toBe(403);
    expect(blocked.json).toMatchObject({ code: 'NOT_ON_PLAN' });
  });
});
