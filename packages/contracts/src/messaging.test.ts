import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { contract } from './index';
import {
  broadcastsContract,
  inboxContract,
  platformMessagingContract,
  tenantMessagingContract,
} from './messaging';

const input = (procedure: { '~orpc': { inputSchema?: unknown } }) =>
  procedure['~orpc'].inputSchema as z.ZodType;
const route = (procedure: { '~orpc': { route: { method?: string; path?: string } } }) =>
  procedure['~orpc'].route;
const uuid = '01a1a679-055e-797c-a14f-ae5a9a0d8e49';

describe('CM-05 messages are never edited or deleted (API contract)', () => {
  it('has no route that edits or deletes a message', () => {
    const routes = Object.values(contract).flatMap((group) =>
      Object.values(group).map((p) => route(p as never)),
    );
    for (const r of routes) {
      if (!r.path?.includes('message')) continue;
      expect(['PATCH', 'DELETE'], `${r.method} ${r.path}`).not.toContain(r.method);
      if (r.method === 'PUT') expect(r.path).not.toMatch(/messages/);
    }
  });
});

describe('CM-07 replies outside the window (API contract)', () => {
  it('takes free text or the reopen template, nothing else', () => {
    const schema = input(inboxContract.reply);
    const base = { conversationId: uuid, clientMessageId: uuid, channel: 'whatsapp' };
    expect(schema.safeParse({ ...base, body: 'On our way' }).success).toBe(true);
    expect(schema.safeParse({ ...base, template: 'conversation_reopen' }).success).toBe(true);
    expect(schema.safeParse({ ...base, template: 'rent_reminder' }).success).toBe(false);
    expect(schema.safeParse({ ...base, channel: 'push', body: 'x' }).success).toBe(false);
  });
});

describe('CM-08 broadcasts (API contract)', () => {
  it('reaches a property, some of its blocks or a group, and nothing looser', () => {
    const schema = input(broadcastsContract.preview);
    const content = { topic: 'water supply', body: 'No water on Saturday' };
    expect(
      schema.safeParse({ audience: { kind: 'property', propertyId: uuid }, ...content }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ audience: { kind: 'blocks', propertyId: uuid, blockIds: [] }, ...content })
        .success,
    ).toBe(false);
    expect(schema.safeParse({ audience: { kind: 'everyone' }, ...content }).success).toBe(false);
  });
});

describe('CM-05 tenant app messages and decision 3 numbers (API contract)', () => {
  it('needs a message or a photo, and an Expo token to register a device', () => {
    const send = input(tenantMessagingContract.send);
    expect(send.safeParse({ companyId: uuid, clientMessageId: uuid, body: 'Hello' }).success).toBe(
      true,
    );
    expect(
      send.safeParse({ companyId: uuid, clientMessageId: uuid, uploadIds: [uuid] }).success,
    ).toBe(true);
    expect(send.safeParse({ companyId: uuid, clientMessageId: uuid }).success).toBe(false);
    const device = input(tenantMessagingContract.registerPushDevice);
    expect(device.safeParse({ token: 'ExponentPushToken[abc123]', platform: 'ios' }).success).toBe(
      true,
    );
    expect(device.safeParse({ token: 'not-a-token', platform: 'ios' }).success).toBe(false);
  });

  it('ties a company number to its company and the shared number to none', () => {
    const schema = input(platformMessagingContract.registerWhatsappNumber);
    const number = {
      phoneNumberId: '106540352242922',
      wabaId: '102290129340398',
      displayPhone: '+233302000000',
      displayName: 'Rent',
    };
    expect(schema.safeParse({ ...number, kind: 'shared', companyId: null }).success).toBe(true);
    expect(schema.safeParse({ ...number, kind: 'company', companyId: uuid }).success).toBe(true);
    expect(schema.safeParse({ ...number, kind: 'company', companyId: null }).success).toBe(false);
    expect(schema.safeParse({ ...number, kind: 'shared', companyId: uuid }).success).toBe(false);
  });
});
