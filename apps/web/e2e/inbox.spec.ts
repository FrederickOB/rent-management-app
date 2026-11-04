import { expect, test } from '@playwright/test';
import { nav, PEOPLE, ready, signIn, unique } from './helpers';
import {
  grantConsent,
  letUnits,
  replyAsStaff,
  startConversation,
  tenantWritesOnWhatsApp,
  threadOf,
} from './messaging-helpers';

/**
 * M6: the unified inbox (CM-02, CM-05, CM-06; plan section 6). Needs the stack running with the
 * demo seed and the fake providers, the fake WhatsApp provider delivering webhooks to the API
 * (FAKE_WHATSAPP_WEBHOOK_URL), and the seed's shared WhatsApp number on the fake's phone number id
 * (plan 4.14). Each test makes its own property, tenant and lease with a fresh phone.
 */

test.describe('CM-02 and CM-05 a tenant’s WhatsApp reply reaches the open inbox', () => {
  test('a tenant’s WhatsApp reply appears in the open thread within 10 seconds, and on their record', async ({
    page,
  }) => {
    const tag = unique();
    const name = `Kwame Live ${tag} (e2e)`;
    await signIn(page, PEOPLE.managerOne.email);
    const [rented] = await letUnits(page, [{ name }]);
    const conversationId = await startConversation(page, rented!.tenantId);

    await page.goto(`/inbox/${conversationId}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
    // The page is listening before the tenant writes, so the time measured is the live path:
    // webhook, inbound job, NOTIFY, server-sent event, then the page fetching the thread.
    await expect(page.getByTestId('stream-status')).toHaveAttribute('data-status', 'live');

    const text = `Is the water back on? ${tag}`;
    const started = Date.now();
    await tenantWritesOnWhatsApp(page.request, rented!.phone, text);
    const arrived = page.getByTestId('thread-message').filter({ hasText: text });
    await expect(arrived).toBeVisible({ timeout: 10_000 });
    const elapsed = Date.now() - started;
    test
      .info()
      .annotations.push({ type: 'CM-02 seconds to the inbox', description: `${elapsed / 1000}` });
    expect(elapsed, 'from the fake webhook to the open thread').toBeLessThanOrEqual(10_000);

    await expect(arrived).toHaveAttribute('data-direction', 'inbound');
    await expect(arrived.getByTestId('message-channel')).toHaveText('WhatsApp');
    await expect(arrived.getByTestId('message-status')).toHaveText('Received');
    await expect(arrived).toContainText('(Africa/Accra)');
    // The WhatsApp window is open now, so the composer offers free text on WhatsApp.
    await expect(page.getByTestId('whatsapp-window')).toContainText('open for');

    // The same message is on the tenant's record.
    await page.goto(`/tenants/${rented!.tenantId}`);
    const timeline = page.getByTestId('timeline');
    await expect(timeline.getByTestId('timeline-message').filter({ hasText: text })).toContainText(
      'WhatsApp message from the tenant',
    );
    await expect(timeline.getByRole('link', { name: 'Open the conversation' })).toHaveAttribute(
      'href',
      `/inbox/${conversationId}`,
    );
  });
});

test.describe('CM-05 every conversation for a unit since the lease began', () => {
  test('a manager sees the unit’s conversations since each lease began, across channels', async ({
    page,
  }) => {
    const tag = unique();
    const name = `Efua Unit ${tag} (e2e)`;
    await signIn(page, PEOPLE.managerOne.email);
    const [rented] = await letUnits(page, [{ name }]);
    const conversationId = await startConversation(page, rented!.tenantId);
    // The tenant writes on WhatsApp; staff answer by SMS, which the tenant agreed to.
    const asked = `When is the next rent due? ${tag}`;
    await tenantWritesOnWhatsApp(page.request, rented!.phone, asked);
    await expect
      .poll(async () => (await threadOf(page, conversationId)).some((m) => m.body === asked), {
        message: 'the WhatsApp message is in the thread',
        timeout: 15_000,
      })
      .toBe(true);
    await grantConsent(page, rented!.tenantId, 'sms');
    const answered = `On the 1st, as usual. ${tag}`;
    await replyAsStaff(page, conversationId, 'sms', answered);

    await page.goto(`/portfolio/units/${rented!.unitId}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(rented!.unitCode);
    const card = page.getByTestId('unit-conversations');
    const row = card.getByTestId('unit-conversation').filter({ hasText: name });
    await expect(row).toBeVisible();
    // At least the two above; the assistant may also have asked about WhatsApp consent (plan 4.8).
    await expect(row.getByTestId('unit-conversation-count')).toContainText(/\d+ messages since/);
    await ready(page, `Show messages with ${name}`);
    await row.getByRole('button', { name: `Show messages with ${name}` }).click();
    const shown = row.getByTestId('unit-message');
    await expect(shown.filter({ hasText: asked })).toContainText('WhatsApp');
    await expect(shown.filter({ hasText: answered })).toContainText('SMS');

    // The inbox opens the same thread limited to the lease's term.
    await row.getByRole('link', { name: 'Open in the inbox' }).click();
    await expect(page).toHaveURL(
      new RegExp(`/inbox/${conversationId}\\?since=${rented!.leaseStart}$`),
    );
    await expect(page.getByText('when the lease began')).toBeVisible();
    await expect(page.getByTestId('thread-message').filter({ hasText: asked })).toBeVisible();
    await expect(page.getByTestId('thread-message').filter({ hasText: answered })).toBeVisible();
  });
});

test.describe('CM-05 sent messages are kept as they were sent', () => {
  test('the composer starts on the tenant’s channel, a double click sends once, and no sent message can be edited or deleted', async ({
    page,
  }) => {
    const tag = unique();
    const name = `Yaw Composer ${tag} (e2e)`;
    await signIn(page, PEOPLE.managerOne.email);
    const [rented] = await letUnits(page, [{ name }]);
    const conversationId = await startConversation(page, rented!.tenantId);
    await tenantWritesOnWhatsApp(page.request, rented!.phone, `Hello, are you there? ${tag}`);

    await page.goto(`/inbox/${conversationId}`);
    await expect(
      page.getByTestId('thread-message').filter({ hasText: `Hello, are you there? ${tag}` }),
    ).toBeVisible();
    const composer = page.getByRole('form', { name: 'Reply' });
    // The tenant last wrote on WhatsApp, within the window: free text on WhatsApp (decision 6).
    await expect(composer.getByLabel('Channel')).toHaveValue('whatsapp');
    const reply = `Yes, we are here to help. ${tag}`;
    await composer.getByLabel('Message').fill(reply);
    await ready(page, 'Send reply');
    await composer.getByRole('button', { name: 'Send reply' }).dblclick();
    const sent = page.getByTestId('thread-message').filter({ hasText: reply });
    await expect(sent).toHaveCount(1);
    await expect(sent).toHaveAttribute('data-direction', 'outbound');
    await expect(sent).toContainText(PEOPLE.managerOne.name);

    // One clientMessageId per message: the API made one message for the double click.
    await page.waitForTimeout(2_000);
    expect((await threadOf(page, conversationId)).filter((m) => m.body === reply)).toHaveLength(1);

    // Nothing on a sent message edits or removes it.
    await expect(sent.getByRole('button')).toHaveCount(0);
    const messages = page.getByRole('list', { name: 'Messages' });
    await expect(messages.getByRole('button', { name: /edit|delete|remove|retract/i })).toHaveCount(
      0,
    );
    await expect(messages.getByRole('link', { name: /edit|delete|remove/i })).toHaveCount(0);
    // …and the API has no route that would.
    const messageId = (await threadOf(page, conversationId)).find((m) => m.body === reply)!.id;
    for (const method of ['PATCH', 'PUT', 'DELETE'] as const) {
      const response = await page.request.fetch(
        `/api/v1/conversations/${conversationId}/messages/${messageId}`,
        { method, data: method === 'DELETE' ? undefined : { body: 'changed' } },
      );
      expect([404, 405], `${method} on a sent message`).toContain(response.status());
    }
    expect((await threadOf(page, conversationId)).find((m) => m.id === messageId)?.body).toBe(
      reply,
    );
  });
});

test.describe('CM-06 assigning, tagging and resolving', () => {
  test('a manager finds an unassigned conversation, assigns it, tags it, resolves and reopens it', async ({
    page,
  }) => {
    const tag = unique();
    const name = `Akua Assign ${tag} (e2e)`;
    await signIn(page, PEOPLE.managerOne.email);
    const [rented] = await letUnits(page, [{ name }]);
    const conversationId = await startConversation(page, rented!.tenantId);
    await tenantWritesOnWhatsApp(page.request, rented!.phone, `The gate lock is broken ${tag}`);
    const settings = (await (await page.request.get('/api/v1/messaging/settings')).json()) as {
      tags: string[];
    };
    const label = settings.tags[0]!;

    // Unanswered and nobody has it: it is in the unassigned view, with the tenant's words.
    await page.goto('/inbox?view=unassigned');
    await expect(nav(page).getByRole('link', { name: 'Inbox' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const listed = page.getByTestId('conversation-row').filter({ hasText: name });
    await expect(listed).toBeVisible();
    await expect(listed).toContainText(`The gate lock is broken ${tag}`);
    await listed.getByRole('link', { name }).click();
    await expect(page).toHaveURL(new RegExp(`/inbox/${conversationId}$`));

    const assignment = page.getByTestId('assignment');
    await expect(assignment.getByLabel('Staff member')).toBeEnabled();
    await assignment.getByLabel('Staff member').selectOption({ label: PEOPLE.managerTwo.name });
    await assignment.getByRole('button', { name: 'Assign' }).click();
    await expect(assignment).toContainText(`Assigned to ${PEOPLE.managerTwo.name}.`);
    await expect(page.getByTestId('conversation-state').first()).toHaveText('Assigned');

    const tags = page.getByTestId('tags');
    await tags.getByLabel(label, { exact: true }).check();
    await tags.getByRole('button', { name: 'Save tags' }).click();
    await expect(tags.getByRole('button', { name: 'Save tags' })).toBeDisabled();

    await page.getByTestId('resolve').getByRole('button', { name: 'Mark resolved' }).click();
    await expect(page.getByTestId('conversation-state').first()).toHaveText('Resolved');
    const stored = (await (
      await page.request.get(`/api/v1/conversations/${conversationId}`)
    ).json()) as {
      state: string;
      assignee: { name: string } | null;
      tags: string[];
    };
    expect(stored).toMatchObject({
      state: 'resolved',
      assignee: { name: PEOPLE.managerTwo.name },
      tags: [label],
    });

    // The resolved view lists it; reopening puts it back with its assignee.
    await page.goto('/inbox?view=resolved');
    await expect(page.getByTestId('conversation-row').filter({ hasText: name })).toBeVisible();
    await page.goto(`/inbox/${conversationId}`);
    await page.getByTestId('resolve').getByRole('button', { name: 'Reopen' }).click();
    await expect(page.getByTestId('conversation-state').first()).not.toHaveText('Resolved');
  });
});

test.describe('decision 9 a Starter landlord has no inbox', () => {
  test('a landlord on the Starter plan sees no inbox, broadcasts or tenant groups', async ({
    page,
  }) => {
    await signIn(page, 'landlord@demo.invalid');
    const company = (await (await page.request.get('/api/v1/company')).json()) as {
      plan?: string;
    };
    expect(company.plan, 'the seed puts the individual landlord on Starter (plan 4.14)').toBe(
      'starter',
    );

    for (const section of ['Inbox', 'Broadcasts', 'Tenant groups', 'Reported repairs'])
      await expect(nav(page).getByRole('link', { name: section, exact: true })).toHaveCount(0);
    await expect(
      page.getByRole('main').getByRole('link', { name: 'Inbox', exact: true }),
    ).toHaveCount(0);

    for (const [path, text] of [
      ['/inbox', 'The inbox is not on the Starter plan.'],
      ['/broadcasts', 'Broadcasts are not on the Starter plan.'],
      ['/broadcasts/new', 'Broadcasts are not on the Starter plan.'],
      ['/tenant-groups', 'Tenant groups are not on the Starter plan.'],
    ] as const) {
      await page.goto(path);
      await expect(page.getByTestId('not-on-plan')).toContainText(text);
    }

    // The API refuses them as well.
    for (const path of ['/api/v1/conversations', '/api/v1/broadcasts', '/api/v1/tenant-groups']) {
      const refused = await page.request.get(path);
      expect(refused.status(), path).toBe(403);
      // oRPC routes send their codes upper-cased (NOT_ON_PLAN); the check is the reason.
      expect(((await refused.json()) as { code?: string }).code?.toUpperCase(), path).toBe(
        'NOT_ON_PLAN',
      );
    }
  });
});
