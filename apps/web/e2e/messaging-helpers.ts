import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { FAKE_PROVIDERS } from './register-helpers';
import {
  daysFromToday,
  newPropertyWithUnits,
  newTenant,
  recordPaperLease,
} from './tenancy-helpers';

/**
 * Helpers for the M6 specs (messaging and the inbox). Each run makes its own property, tenants
 * and leases with fresh phone numbers, so the shared-number routing (decision 4) finds exactly one
 * company for the phone, and nothing a run makes is reused by the next. Tenants write in through
 * the fake WhatsApp provider's inbound simulation, which signs the webhook as Meta would and
 * delivers it to the API (FAKE_WHATSAPP_WEBHOOK_URL).
 */

async function ok<T>(response: Awaited<ReturnType<Page['request']['get']>>, what: string) {
  expect(response.status(), `${what}: ${await response.text()}`).toBe(200);
  return (await response.json()) as T;
}

export interface LetUnit {
  readonly propertyId: string;
  readonly unitId: string;
  readonly unitCode: string;
  readonly tenantId: string;
  readonly phone: string;
  readonly leaseId: string;
  readonly leaseStart: string;
}

/**
 * A new unit let to a new tenant on a paper lease that began 30 days ago, all through the API as
 * the person signed in on this page (Owner A's portfolio in the agency).
 */
export async function letUnits(
  page: Page,
  tenants: readonly { readonly name: string; readonly extra?: Record<string, unknown> }[],
): Promise<LetUnit[]> {
  const { propertyId, units } = await newPropertyWithUnits(page, tenants.length);
  const leaseStart = daysFromToday(-30);
  const rows: LetUnit[] = [];
  for (const [index, tenant] of tenants.entries()) {
    const unit = units[index]!;
    const made = await newTenant(page, tenant.name, tenant.extra ?? {});
    const leaseId = await recordPaperLease(page, {
      unitId: unit.id,
      tenantId: made.id,
      tenantName: tenant.name,
      startDate: leaseStart,
      months: 12,
      monthlyRentMinor: 90_000,
      signedOn: leaseStart,
    });
    rows.push({
      propertyId,
      unitId: unit.id,
      unitCode: unit.code,
      tenantId: made.id,
      phone: made.phone,
      leaseId,
      leaseStart,
    });
  }
  return rows;
}

/** Opens the tenant's conversation for staff (POST /tenants/{id}/conversation), so it is in the inbox. */
export async function startConversation(page: Page, tenantId: string): Promise<string> {
  const conversation = await ok<{ id: string }>(
    await page.request.post(`/api/v1/tenants/${tenantId}/conversation`, { data: {} }),
    'open the tenant’s conversation',
  );
  return conversation.id;
}

/**
 * The tenant writes to the shared WhatsApp number from their phone, through the fake provider.
 * Fails clearly when the fake could not hand the webhook to the API.
 */
export async function tenantWritesOnWhatsApp(
  request: APIRequestContext,
  phone: string,
  text: string,
): Promise<string> {
  const response = await request.post(`${FAKE_PROVIDERS}/whatsapp/_test/inbound`, {
    data: { from: phone, text },
  });
  expect(response.status(), `fake WhatsApp inbound: ${await response.text()}`).toBe(200);
  const body = (await response.json()) as {
    messageId: string;
    delivery: { status?: number; error?: string } | null;
  };
  expect(
    body.delivery,
    'the fake WhatsApp provider has a webhook URL for the API (FAKE_WHATSAPP_WEBHOOK_URL)',
  ).not.toBeNull();
  expect(body.delivery?.status, `the API took the webhook: ${body.delivery?.error ?? ''}`).toBe(
    200,
  );
  return body.messageId;
}

export interface ThreadRow {
  readonly id: string;
  readonly direction: 'inbound' | 'outbound';
  readonly channel: string | null;
  readonly body: string;
  readonly status: string;
}

/** Every message in a conversation, as the API returns it (newest first). */
export async function threadOf(page: Page, conversationId: string): Promise<ThreadRow[]> {
  const page1 = await ok<{ items: ThreadRow[] }>(
    await page.request.get(`/api/v1/conversations/${conversationId}/messages?limit=100`),
    'read the thread',
  );
  return page1.items;
}

/** Records consent on a channel for the tenant, through the M6 route (CM-09). */
export async function grantConsent(
  page: Page,
  tenantId: string,
  channel: 'push' | 'whatsapp' | 'sms' | 'email',
): Promise<void> {
  await ok(
    await page.request.post(`/api/v1/tenants/${tenantId}/messaging-consent`, {
      data: { channel, action: 'grant' },
    }),
    `record ${channel} consent`,
  );
}

/** A staff reply through the API, with its own clientMessageId. */
export async function replyAsStaff(
  page: Page,
  conversationId: string,
  channel: 'whatsapp' | 'sms' | 'email' | 'in_app',
  body: string,
): Promise<{ id: string }> {
  return ok<{ id: string }>(
    await page.request.post(`/api/v1/conversations/${conversationId}/replies`, {
      data: { clientMessageId: randomUUID(), channel, body },
    }),
    `reply on ${channel}`,
  );
}
