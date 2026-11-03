import { describe, expect, it } from 'vitest';
import { buildServer, createStore, DEFAULT_PAYMENTS_SECRET_KEY } from './server';

const auth = { authorization: `Bearer ${DEFAULT_PAYMENTS_SECRET_KEY}` };

/** Puts something in every store, through the endpoints. */
async function fillEveryStore(app: ReturnType<typeof buildServer>) {
  await app.inject({
    method: 'POST',
    url: '/sms/messages',
    payload: { to: '+233200000001', body: 'Your code is 123456' },
  });
  await app.inject({
    method: 'POST',
    url: '/whatsapp/messages',
    payload: {
      messaging_product: 'whatsapp',
      to: '+233200000002',
      type: 'text',
      text: { body: '<b>WhatsApp</b> hello' },
    },
  });
  const inbound = await app.inject({
    method: 'POST',
    url: '/whatsapp/_test/inbound',
    payload: {
      from: '+233200000002',
      media: { contentType: 'image/png', base64: Buffer.from('png').toString('base64') },
    },
  });
  const tickets = await app.inject({
    method: 'POST',
    url: '/push/send',
    payload: [{ to: 'ExponentPushToken[abc]', title: 'Push title', body: 'Push body' }],
  });
  const sub = await app.inject({
    method: 'POST',
    url: '/payments/subaccount',
    headers: auth,
    payload: {
      business_name: 'Test Landlord',
      settlement_bank: 'TEST',
      account_number: '0123456789',
    },
  });
  const subaccount = sub.json<{ data: { subaccount_code: string } }>().data.subaccount_code;
  await app.inject({
    method: 'POST',
    url: '/payments/transaction/initialize',
    headers: auth,
    payload: {
      reference: 'pay-1',
      amount: 150_000,
      currency: 'GHS',
      email: 'tenant@example.test',
      channels: ['card'],
      subaccount,
    },
  });
  await app.inject({
    method: 'POST',
    url: '/payments/_test/charges/pay-1',
    payload: { status: 'success' },
  });
  await app.inject({ method: 'POST', url: '/payments/_test/settle', payload: {} });
  const check = await app.inject({
    method: 'POST',
    url: '/identity/checks',
    payload: { id_type: 'ghana_card', id_number: 'GHA-123456789-1', reference: 'tenant-1' },
  });
  return {
    mediaId: inbound.json<{ mediaId: string }>().mediaId,
    ticketId: tickets.json<{ data: { id: string }[] }>().data[0]?.id ?? '',
    checkId: check.json<{ check_id: string }>().check_id,
  };
}

describe('PLATFORM fake providers: server', () => {
  it('answers the health check', async () => {
    expect((await buildServer().inject({ method: 'GET', url: '/health' })).json()).toEqual({
      ok: true,
    });
  });

  it('lists captured messages newest first, filtered by channel and recipient', async () => {
    const app = buildServer();
    await fillEveryStore(app);
    const all = (await app.inject({ method: 'GET', url: '/messages' })).json<
      { channel: string }[]
    >();
    expect(all.map((m) => m.channel)).toEqual(['push', 'whatsapp', 'sms']);
    expect((await app.inject({ method: 'GET', url: '/messages?channel=sms' })).json()).toHaveLength(
      1,
    );
    expect(
      (await app.inject({ method: 'GET', url: '/messages?to=%2B233200000002' })).json(),
    ).toHaveLength(1);
  });

  it('DELETE /_reset resets every store, not only messages', async () => {
    const store = createStore();
    const app = buildServer(store);
    const { mediaId, ticketId, checkId } = await fillEveryStore(app);
    expect((await app.inject({ method: 'DELETE', url: '/_reset' })).statusCode).toBe(204);
    expect(
      Object.values(store).every((s) =>
        Array.isArray(s) ? s.length === 0 : (s as Map<string, unknown>).size === 0,
      ),
    ).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/messages' })).json()).toEqual([]);
    expect(
      (await app.inject({ method: 'GET', url: `/whatsapp/media/${mediaId}` })).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({ method: 'POST', url: '/push/getReceipts', payload: { ids: [ticketId] } })
      ).json(),
    ).toEqual({ data: {} });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/payments/transaction/verify/pay-1',
          headers: auth,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: `/identity/checks/${checkId}` })).statusCode,
    ).toBe(404);
  });

  it('DELETE /messages clears captured messages only: subaccounts and charges stay (M4b e2e)', async () => {
    const store = createStore();
    const app = buildServer(store);
    await fillEveryStore(app);
    const subaccounts = store.subaccounts.size;
    const transactions = store.transactions.size;
    expect(subaccounts).toBeGreaterThan(0);
    expect(transactions).toBeGreaterThan(0);
    expect((await app.inject({ method: 'DELETE', url: '/messages' })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/messages' })).json()).toEqual([]);
    expect(store.subaccounts.size).toBe(subaccounts);
    expect(store.transactions.size).toBe(transactions);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/payments/transaction/verify/pay-1',
          headers: auth,
        })
      ).statusCode,
    ).toBe(200);
  });

  it('shows every channel and provider on the dev inbox, escaped and masked, under a strict CSP', async () => {
    const app = buildServer();
    await fillEveryStore(app);
    const page = await app.inject({ method: 'GET', url: '/' });
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['content-security-policy']).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    for (const text of [
      'Your code is 123456',
      '&lt;b&gt;WhatsApp&lt;/b&gt; hello',
      'Push title: Push body',
      'pay-1',
      'Test Landlord',
      '******6789',
      'GHA-*******89-1',
      'Mailpit',
    ]) {
      expect(page.body).toContain(text);
    }
    expect(page.body).not.toContain('<b>WhatsApp</b>');
    expect(page.body).not.toContain('0123456789');
    expect(page.body).not.toContain('GHA-123456789-1');
  });
});
