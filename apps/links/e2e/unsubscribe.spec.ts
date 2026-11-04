import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { freshPhone, managerApi, ok } from './signing-support';
import { fakeToken, headerValues } from './support';

// The email unsubscribe page, /u/[token] (CM-09; M6 decision 7 and plan 4.8). The first two tests
// need only this app; the last drives the running stack (pnpm dev, with pnpm db:seed): the demo
// manager writes to a new tenant by email, Mailpit captures the email, and the tenant stops
// emails from the link it carries.
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const ONE_MB = 1_000_000;
const UNSUBSCRIBE_PATH = /\/u\/([A-Za-z0-9_-]{43})\b/;

interface MailpitSummary {
  readonly ID: string;
  readonly Created: string;
}

/** The unsubscribe token in the newest email to an address: its List-Unsubscribe header, or body. */
async function unsubscribeTokenEmailedTo(address: string, after: number): Promise<string> {
  let token = '';
  await expect
    .poll(
      async () => {
        const search = await fetch(
          `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}&limit=5`,
        );
        const { messages } = (await search.json()) as { messages: MailpitSummary[] };
        const newest = messages.find((m) => Date.parse(m.Created) >= after - 1_000);
        if (!newest) return false;
        const headers = (await (
          await fetch(`${MAILPIT}/api/v1/message/${newest.ID}/headers`)
        ).json()) as Record<string, string[]>;
        const listUnsubscribe = Object.entries(headers)
          .filter(([name]) => name.toLowerCase() === 'list-unsubscribe')
          .flatMap(([, values]) => values)
          .join(' ');
        const message = (await (await fetch(`${MAILPIT}/api/v1/message/${newest.ID}`)).json()) as {
          Text: string;
        };
        token =
          UNSUBSCRIBE_PATH.exec(listUnsubscribe)?.[1] ??
          UNSUBSCRIBE_PATH.exec(message.Text)?.[1] ??
          '';
        return token !== '';
      },
      { message: 'an email with an unsubscribe link reaches the tenant', timeout: 45_000 },
    )
    .toBe(true);
  return token;
}

/** A tenant with an email address and email consent, written to by staff on email. */
async function emailedTenant(api: APIRequestContext, address: string): Promise<string> {
  const saved = await ok<{ tenant: { id: string } }>(
    await api.post('/tenants', {
      data: {
        kind: 'individual',
        displayName: 'Esi Unsubscribes (e2e)',
        phone: freshPhone(),
        email: address,
        consent: { email: true },
      },
    }),
    'create a tenant with email consent',
  );
  const tenantId = saved.tenant.id;
  const conversation = await ok<{ id: string }>(
    await api.post(`/tenants/${tenantId}/conversation`, { data: {} }),
    'open the tenant’s conversation',
  );
  await ok(
    await api.post(`/conversations/${conversation.id}/replies`, {
      data: {
        clientMessageId: randomUUID(),
        channel: 'email',
        subject: 'Water off on Saturday',
        body: 'The water will be off on Saturday from 9 to 12 for repairs.',
      },
    }),
    'write to the tenant by email',
  );
  return tenantId;
}

test.describe('CM-09 email unsubscribe page', () => {
  test('an unknown link gets the standard screen: not found, never cached, no cookie', async ({
    page,
    request,
  }) => {
    const token = fakeToken();
    const response = await page.goto(`/u/${token}`);
    expect(response?.status()).toBe(404);
    expect(response?.headers()['cache-control']).toBe('no-store');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'This link is not valid or has expired',
    );
    expect(await page.locator('body').innerText()).not.toContain(token);
    expect(await page.title()).not.toContain(token);

    // A GET of the confirm route, as a link scanner sends, changes nothing: back to the page.
    const scanned = await request.get(`/u/${token}/confirm`, { maxRedirects: 0 });
    expect(scanned.status()).toBe(303);
    expect(scanned.headers()['location']).toBe(`/u/${token}`);
    for (const path of [`/u/${token}`, `/u/${token}/confirm`]) {
      const answer = await request.get(path, {
        headers: { cookie: 'session=from-another-site' },
        maxRedirects: 0,
      });
      expect(headerValues(answer.headersArray(), 'set-cookie'), path).toEqual([]);
    }
  });

  test('NFR-PERF the page transfers under 1 MB and fits a 5-inch screen', async ({
    page,
  }, testInfo) => {
    const path = `/u/${fakeToken()}`;
    const transfers: Promise<number>[] = [];
    page.on('requestfinished', (request) => {
      transfers.push(
        request.sizes().then((sizes) => sizes.responseHeadersSize + sizes.responseBodySize),
      );
    });
    await page.goto(path, { waitUntil: 'networkidle' });
    const all = await Promise.all(transfers);
    const transferred = all.reduce((total, bytes) => total + bytes, 0);
    testInfo.annotations.push({
      type: 'page weight',
      description: `/u/[token]: ${all.length} requests, ${transferred} bytes transferred`,
    });
    expect(transferred).toBeLessThan(ONE_MB);

    expect(page.viewportSize()).toEqual({ width: 360, height: 640 });
    await expect(page.getByRole('heading', { level: 1 })).toBeInViewport();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('a tenant stops emails from the link in an email, with one press', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const staff = await managerApi();
    const landlordName = (await ok<{ displayName: string }>(await staff.get('/company'), 'company'))
      .displayName;
    const address = `unsubscribe-${randomUUID()}@example.test`;
    const sentAfter = Date.now();
    const tenantId = await emailedTenant(staff, address);
    const token = await unsubscribeTokenEmailedTo(address, sentAfter);

    // Opening shows what would stop, and changes nothing.
    const opened = await page.goto(`/u/${token}`);
    expect(opened?.status()).toBe(200);
    expect(opened?.headers()['cache-control']).toBe('no-store');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      `Stop emails from ${landlordName}?`,
    );
    const body = await page.locator('body').innerText();
    expect(body).not.toContain(address);
    expect(body).not.toContain(token);
    await expect(page.getByText('This link stops emails only.')).toBeVisible();
    await expect(page.getByText(/reply STOP to one of their WhatsApp messages/)).toBeVisible();
    const consentOf = async () => {
      const consent = await ok<{
        subjects: {
          contactId: string | null;
          channels: { channel: string; granted: boolean; source: string | null }[];
        }[];
      }>(await staff.get(`/tenants/${tenantId}/messaging-consent`), 'the tenant’s consent');
      return consent.subjects
        .find((subject) => subject.contactId === null)
        ?.channels.find((channel) => channel.channel === 'email');
    };
    expect((await consentOf())?.granted).toBe(true);

    // One press withdraws email consent, recorded as coming from the unsubscribe link.
    await page.getByRole('button', { name: 'Stop emails' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      `You will no longer get emails from ${landlordName}`,
    );
    await expect(page.getByRole('status')).toBeVisible();
    expect(await consentOf()).toMatchObject({ granted: false, source: 'email_unsubscribe' });

    // Opening the link again, or a mail client's one-click post, says the same and changes nothing.
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      `You will no longer get emails from ${landlordName}`,
    );
    const oneClick = await request.post(`/u/${token}/confirm`, {
      form: { 'List-Unsubscribe': 'One-Click' },
      maxRedirects: 0,
    });
    expect(oneClick.status()).toBe(200);
    expect(await consentOf()).toMatchObject({ granted: false, source: 'email_unsubscribe' });
    expect((await page.context().cookies()).map((cookie) => cookie.name)).toEqual([]);
  });
  test('NFR-PERF the confirm and done screens transfer under 1 MB on a 5-inch screen', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const staff = await managerApi();
    const address = `unsubscribe-weight-${randomUUID()}@example.test`;
    const sentAfter = Date.now();
    await emailedTenant(staff, address);
    const token = await unsubscribeTokenEmailedTo(address, sentAfter);

    let transfers: Promise<number>[] = [];
    page.on('requestfinished', (request) => {
      transfers.push(
        request.sizes().then((sizes) => sizes.responseHeadersSize + sizes.responseBodySize),
      );
    });
    const weigh = async (screenName: string) => {
      const all = await Promise.all(transfers);
      transfers = [];
      const transferred = all.reduce((total, bytes) => total + bytes, 0);
      testInfo.annotations.push({
        type: 'page weight',
        description: `/u/[token] ${screenName}: ${all.length} requests, ${transferred} bytes transferred`,
      });
      expect(transferred, screenName).toBeLessThan(ONE_MB);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, screenName).toBeLessThanOrEqual(0);
    };

    await page.goto(`/u/${token}`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Stop emails from /);
    await weigh('confirm');
    await page.getByRole('button', { name: 'Stop emails' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      /^You will no longer get emails from /,
    );
    await page.waitForLoadState('networkidle');
    await weigh('done');
  });
});
