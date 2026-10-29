import { afterEach, describe, expect, it } from 'vitest';
import { maskIdNumber } from './identity';
import { buildServer, createStore } from './server';
import { startReceiver } from './test-support';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

type App = ReturnType<typeof buildServer>;

const start = (app: App, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/identity/checks', payload });

async function started(app: App, idNumber: string, reference = `ref-${idNumber}`) {
  const response = await start(app, { id_type: 'ghana_card', id_number: idNumber, reference });
  return response.json<{ check_id: string; capture_url: string; status: string }>();
}

describe('PLATFORM fake providers: identity checks', () => {
  it('starts a pending check with a capture link, idempotent by reference', async () => {
    const app = buildServer();
    const first = await start(app, {
      id_type: 'ghana_card',
      id_number: 'GHA-123456789-1',
      reference: 'tenant-1',
    });
    expect(first.statusCode).toBe(201);
    const body = first.json<{ check_id: string; capture_url: string; status: string }>();
    expect(body.status).toBe('pending');
    expect(new URL(body.capture_url).pathname).toBe(`/identity/capture/${body.check_id}`);
    const again = await start(app, {
      id_type: 'ghana_card',
      id_number: 'gha-123456789-1',
      reference: 'tenant-1',
    });
    expect(again.statusCode).toBe(200);
    expect(again.json<{ check_id: string }>().check_id).toBe(body.check_id);
    expect(
      (
        await start(app, {
          id_type: 'ghana_card',
          id_number: 'GHA-123456789-2',
          reference: 'tenant-1',
        })
      ).statusCode,
    ).toBe(409);
  });

  it('never accepts an image or anything beyond the ID type, number and reference', async () => {
    const app = buildServer();
    const response = await start(app, {
      id_type: 'ghana_card',
      id_number: 'GHA-123456789-1',
      reference: 'tenant-2',
      card_image: 'aGVsbG8=',
    });
    expect(response.statusCode).toBe(400);
    expect(
      (await start(app, { id_type: 'ghana_card', id_number: '123456789', reference: 'tenant-3' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await start(app, { id_type: 'voter_id', id_number: '123456789', reference: 'tenant-4' }))
        .statusCode,
    ).toBe(400);
  });

  it.each([
    ['GHA-123456789-1', 'verified'],
    ['GHA-123456789-0', 'not_matched'],
    ['GHA-123456789-9', 'failed'],
  ])(
    'decides %s as %s once the selfie is taken, and posts the result webhook',
    async (idNumber, status) => {
      const receiver = await startReceiver();
      closers.push(receiver.close);
      const app = buildServer(createStore(), { identityWebhookUrl: receiver.url });
      const check = await started(app, idNumber);
      const completed = await app.inject({
        method: 'POST',
        url: `/identity/_test/checks/${check.check_id}/complete`,
        payload: {},
      });
      expect(completed.json()).toMatchObject({
        check_id: check.check_id,
        status,
        webhook: { event: 'identity.check.completed', status },
      });
      expect(JSON.parse(receiver.received[0]?.body ?? '{}')).toMatchObject({
        check_id: check.check_id,
        status,
      });
      const result = await app.inject({ method: 'GET', url: `/identity/checks/${check.check_id}` });
      expect(result.json()).toMatchObject({ check_id: check.check_id, status });
      expect(result.body).not.toContain(idNumber);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/identity/_test/checks/${check.check_id}/complete`,
            payload: {},
          })
        ).statusCode,
      ).toBe(409);
    },
  );

  it('keeps a number ending in 8 pending for good, with no webhook', async () => {
    const app = buildServer();
    const check = await started(app, 'GHA-123456789-8');
    const completed = await app.inject({
      method: 'POST',
      url: `/identity/_test/checks/${check.check_id}/complete`,
      payload: {},
    });
    expect(completed.json()).toMatchObject({ status: 'pending', webhook: null });
  });

  it('serves a capture page that takes no picture and never asks for the card', async () => {
    const app = buildServer();
    const check = await started(app, 'GHA-123456789-1');
    const page = await app.inject({ method: 'GET', url: new URL(check.capture_url).pathname });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('never asks for an image of the ID card');
    expect(page.body).not.toContain('<input type="file"');
    expect(page.body).not.toContain('GHA-123456789-1');
    expect(page.body).toContain('GHA-*******89-1');
    const posted = await app.inject({
      method: 'POST',
      url: new URL(check.capture_url).pathname,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });
    expect(posted.body).toContain('verified');
  });

  it('masks ID numbers wherever it shows them', () => {
    expect(maskIdNumber('GHA-123456789-0')).toBe('GHA-*******89-0');
    expect(maskIdNumber('G1234567')).toBe('*****567');
  });
});
