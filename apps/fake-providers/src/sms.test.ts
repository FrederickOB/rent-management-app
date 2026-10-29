import { describe, expect, it } from 'vitest';
import { buildServer, createStore } from './server';

describe('PLATFORM fake providers: SMS', () => {
  it('captures a message to an E.164 number and returns its id', async () => {
    const store = createStore();
    const app = buildServer(store);
    const response = await app.inject({
      method: 'POST',
      url: '/sms/messages',
      payload: { to: '+233200000001', body: 'Your code is 123456', reference: 'otp:1' },
    });
    expect(response.statusCode).toBe(201);
    const { id } = response.json<{ id: string }>();
    expect(store.messages[0]).toMatchObject({
      id,
      channel: 'sms',
      to: '+233200000001',
      body: 'Your code is 123456',
      meta: { reference: 'otp:1' },
    });
  });

  it('refuses a local number, an empty body and a long sender id', async () => {
    const app = buildServer();
    for (const payload of [
      { to: '0200000001', body: 'x' },
      { to: '+233200000001', body: '' },
      { to: '+233200000001', body: 'x', senderId: 'TwelveLetter' },
    ]) {
      expect((await app.inject({ method: 'POST', url: '/sms/messages', payload })).statusCode).toBe(
        400,
      );
    }
  });
});
