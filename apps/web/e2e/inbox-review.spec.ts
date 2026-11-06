import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PEOPLE, ready, signIn, unique } from './helpers';
import {
  grantConsent,
  letUnits,
  replyAsStaff,
  startConversation,
  tenantWritesOnWhatsApp,
  threadOf,
} from './messaging-helpers';
import { FAKE_PROVIDERS, fixture } from './register-helpers';
import {
  daysFromToday,
  newPropertyWithUnits,
  newTenant,
  recordPaperLease,
  today,
} from './tenancy-helpers';

/**
 * M6 review round (2026-11-04): new tests beside the first M6 specs, which stay as they were.
 * Each makes its own property, tenants and leases with fresh phones, and needs the stack running
 * with the demo seed and the fake providers (FAKE_WHATSAPP_WEBHOOK_URL set, the shared number on
 * the fake's phone number id), as inbox.spec.ts does.
 */

async function ok<T>(response: Awaited<ReturnType<Page['request']['get']>>, what: string) {
  expect(response.status(), `${what}: ${await response.text()}`).toBe(200);
  return (await response.json()) as T;
}

/** Waits until the tenant's WhatsApp message is in their conversation. */
async function waitForInbound(page: Page, tenantId: string, text: string): Promise<string> {
  let conversationId: string | null = null;
  await expect
    .poll(
      async () => {
        const found = await page.request.get(`/api/v1/tenants/${tenantId}/conversation`);
        if (found.status() !== 200) return false;
        conversationId =
          ((await found.json()) as { conversation: { id: string } | null }).conversation?.id ??
          null;
        if (!conversationId) return false;
        return (await threadOf(page, conversationId)).some((m) => m.body === text);
      },
      { message: 'the tenant’s WhatsApp message is in their conversation', timeout: 20_000 },
    )
    .toBe(true);
  return conversationId!;
}

test.describe('CM-05 the unit’s conversations start when the lease began', () => {
  test('a message written before the lease began is not in the unit’s view of it', async ({
    page,
  }) => {
    const tag = unique();
    const name = `Kofi Before ${tag} (e2e)`;
    await signIn(page, PEOPLE.managerOne.email);
    const { units } = await newPropertyWithUnits(page, 1);
    const tenant = await newTenant(page, name);
    // The tenant writes today; their lease on this unit begins tomorrow.
    const before = `Can I see the room before I move in? ${tag}`;
    await tenantWritesOnWhatsApp(page.request, tenant.phone, before);
    const conversationId = await waitForInbound(page, tenant.id, before);
    const start = daysFromToday(1);
    await recordPaperLease(page, {
      unitId: units[0]!.id,
      tenantId: tenant.id,
      tenantName: name,
      startDate: start,
      months: 12,
      monthlyRentMinor: 90_000,
      signedOn: today(),
    });

    // The API: the whole thread has it, the thread since the lease began does not.
    expect((await threadOf(page, conversationId)).some((m) => m.body === before)).toBe(true);
    const sinceStart = await ok<{ items: { body: string }[] }>(
      await page.request.get(
        `/api/v1/conversations/${conversationId}/messages?since=${start}&limit=100`,
      ),
      'read the thread since the lease began',
    );
    expect(sinceStart.items.some((m) => m.body === before)).toBe(false);

    // The unit page: the tenant's conversation is listed from the lease's start, without it.
    await page.goto(`/portfolio/units/${units[0]!.id}`);
    const row = page
      .getByTestId('unit-conversations')
      .getByTestId('unit-conversation')
      .filter({ hasText: name });
    await expect(row.getByTestId('unit-conversation-count')).toContainText('0 messages since');
    await ready(page, `Show messages with ${name}`);
    await row.getByRole('button', { name: `Show messages with ${name}` }).click();
    await expect(row.getByText('No messages since the lease began.')).toBeVisible();
    await expect(row.getByTestId('unit-message').filter({ hasText: before })).toHaveCount(0);
  });
});

test.describe('CM-05 and decision 9 messages on the tenant’s timeline', () => {
  test('each message shows once on Growth, and with its words for a Starter landlord', async ({
    page,
    browser,
    baseURL,
  }) => {
    const tag = unique();
    // Growth (the agency): the inbox has the conversation, and the timeline shows it once.
    const growthName = `Ama Timeline ${tag} (e2e)`;
    await signIn(page, PEOPLE.managerOne.email);
    const [rented] = await letUnits(page, [{ name: growthName }]);
    await startConversation(page, rented!.tenantId);
    const growthText = `Please send my statement ${tag}`;
    await tenantWritesOnWhatsApp(page.request, rented!.phone, growthText);
    await waitForInbound(page, rented!.tenantId, growthText);
    await page.goto(`/tenants/${rented!.tenantId}`);
    const timeline = page.getByTestId('timeline');
    const shown = timeline.getByTestId('timeline-message').filter({ hasText: growthText });
    await expect(shown).toHaveCount(1);
    await expect(shown).toContainText('WhatsApp message from the tenant');

    // Starter (the individual landlord): no inbox, but the words are on the tenant's record.
    const starter = await browser.newContext({ baseURL });
    try {
      const landlord = await starter.newPage();
      await signIn(landlord, 'landlord@demo.invalid');
      const starterName = `Yaw Starter ${tag} (e2e)`;
      const tenant = await newTenant(landlord, starterName);
      const starterText = `The kitchen tap is dripping ${tag}`;
      await tenantWritesOnWhatsApp(landlord.request, tenant.phone, starterText);
      await expect
        .poll(
          async () => {
            const events = await ok<{ action: string; data: { preview?: string } | null }[]>(
              await landlord.request.get(`/api/v1/tenants/${tenant.id}/timeline`),
              'read the timeline',
            );
            return events.some(
              (e) => e.action === 'message.inbound' && e.data?.preview?.includes(starterText),
            );
          },
          { message: 'the message is on the Starter tenant’s timeline', timeout: 20_000 },
        )
        .toBe(true);
      await landlord.goto(`/tenants/${tenant.id}`);
      const record = landlord
        .getByTestId('timeline')
        .getByTestId('timeline-message')
        .filter({ hasText: starterText });
      await expect(record).toHaveCount(1);
      await expect(record).toContainText('WhatsApp message from the tenant');
      // No inbox on Starter: no link to a conversation.
      await expect(
        landlord.getByTestId('timeline').getByRole('link', { name: 'Open the conversation' }),
      ).toHaveCount(0);
    } finally {
      await starter.close();
    }
  });
});

test.describe('CM-06 and C4 a resolved conversation takes no reply until it is reopened', () => {
  test('the composer is hidden on a resolved conversation, the API refuses a reply, and Reopen brings it back', async ({
    page,
  }) => {
    const tag = unique();
    const name = `Esi Resolved ${tag} (e2e)`;
    await signIn(page, PEOPLE.managerOne.email);
    const [rented] = await letUnits(page, [{ name }]);
    const conversationId = await startConversation(page, rented!.tenantId);
    const asked = `Is the gate fixed? ${tag}`;
    await tenantWritesOnWhatsApp(page.request, rented!.phone, asked);
    await waitForInbound(page, rented!.tenantId, asked);
    await replyAsStaff(page, conversationId, 'whatsapp', `Yes, fixed this morning. ${tag}`);

    await page.goto(`/inbox/${conversationId}`);
    await ready(page, 'Mark resolved');
    await page.getByTestId('resolve').getByRole('button', { name: 'Mark resolved' }).click();
    await expect(page.getByTestId('conversation-state').first()).toHaveText('Resolved');
    await expect(page.getByTestId('composer')).toHaveCount(0);
    await expect(page.getByText('This conversation is resolved')).toBeVisible();
    // Nobody can be assigned to it while it is resolved.
    await expect(page.getByTestId('assignment').getByLabel('Staff member')).toHaveCount(0);

    const refused = await page.request.post(`/api/v1/conversations/${conversationId}/replies`, {
      data: { clientMessageId: randomUUID(), channel: 'whatsapp', body: `One more thing ${tag}` },
    });
    expect(refused.status()).toBe(409);
    expect(((await refused.json()) as { code?: string }).code?.toUpperCase()).toBe(
      'CONVERSATION_RESOLVED',
    );

    await page.getByTestId('resolve').getByRole('button', { name: 'Reopen' }).click();
    await expect(page.getByTestId('composer')).toBeVisible();
  });
});

test.describe('BC-06 and plan 4.9 a receipt goes by WhatsApp', () => {
  test('a tenant who agreed to WhatsApp gets the receipt there, and the payment page says “Sent by WhatsApp”', async ({
    page,
    browser,
    baseURL,
  }) => {
    const tag = unique();
    const name = `Kwame Receipt ${tag} (e2e)`;
    await signIn(page, PEOPLE.managerOne.email);
    const [rented] = await letUnits(page, [{ name }]);
    // WhatsApp is the first channel they agreed to (no app on a phone), and they have written in
    // today, so the receipt can go inside the 24-hour window whatever the template's status.
    await grantConsent(page, rented!.tenantId, 'whatsapp');
    const hello = `I will pay cash today ${tag}`;
    await tenantWritesOnWhatsApp(page.request, rented!.phone, hello);
    await waitForInbound(page, rented!.tenantId, hello);

    // Kofi records the cash with a photo of the receipt-book page; Akosua approves it (BC-05).
    const photo = readFileSync(fixture('property-photo.jpg'));
    const slot = await ok<{ uploadId: string; url: string; fields: Record<string, string> }>(
      await page.request.post('/api/v1/payment-uploads', {
        data: { purpose: 'cash_photo', contentType: 'image/jpeg', sizeBytes: photo.length },
      }),
      'ask for a photo upload',
    );
    const form = new FormData();
    for (const [key, value] of Object.entries(slot.fields)) form.append(key, value);
    form.append('file', new Blob([photo], { type: 'image/jpeg' }), 'receipt-book.jpg');
    const stored = await fetch(slot.url, { method: 'POST', body: form });
    expect(stored.ok, `upload the photo: ${stored.status}`).toBe(true);
    const recorded = await ok<{ cashRecord: { id: string }; approval: { id: string } }>(
      await page.request.post('/api/v1/cash-records', {
        headers: { 'Idempotency-Key': randomUUID() },
        data: {
          leaseId: rented!.leaseId,
          method: 'cash',
          amountMinor: 90_000,
          receivedOn: today(),
          payerName: name,
          photoUploadId: slot.uploadId,
        },
      }),
      'record the cash',
    );
    const second = await browser.newContext({ baseURL });
    try {
      const approver = await second.newPage();
      await signIn(approver, PEOPLE.managerTwo.email);
      await ok(
        await approver.request.post(`/api/v1/approvals/${recorded.approval.id}/decisions`, {
          headers: { 'Idempotency-Key': randomUUID() },
          data: { decision: 'approve' },
        }),
        'approve the cash',
      );
    } finally {
      await second.close();
    }
    let paymentId: string | null = null;
    await expect
      .poll(
        async () => {
          const records = await ok<{ id: string; paymentId: string | null }[]>(
            await page.request.get(`/api/v1/cash-records?leaseId=${rented!.leaseId}`),
            'read the cash records',
          );
          paymentId = records.find((r) => r.id === recorded.cashRecord.id)?.paymentId ?? null;
          return paymentId;
        },
        { message: 'the approved cash has its payment', timeout: 20_000 },
      )
      .not.toBeNull();

    // The worker sends the receipt within a minute of the payment's confirmation.
    await expect(async () => {
      await page.goto(`/payments/${paymentId!}`);
      await expect(page.getByTestId('receipt-delivery-label').first()).toHaveText(
        'Sent by WhatsApp',
        { timeout: 1_000 },
      );
    }).toPass({ timeout: 90_000 });
    await expect(page.getByTestId('receipt-delivery-detail').first()).toContainText(
      'after the payment was confirmed',
    );
    const toTenant = await ok<{ id: string }[]>(
      await page.request.get(
        `${FAKE_PROVIDERS}/messages?channel=whatsapp&to=${encodeURIComponent(rented!.phone)}`,
      ),
      'read the fake WhatsApp outbox',
    );
    expect(toTenant.length, 'a WhatsApp message reached the tenant').toBeGreaterThan(0);
  });
});
