import type { TenantConversation, TenantMessage } from '@rent/contracts';
import { AGENCY, LANDLORD } from './fixtures';

// What the tenant messaging endpoints return (packages/contracts/src/messaging.ts), for the
// Messages and push tests. The same person rents from the agency and from a landlord (TL-12).

export function conversation(overrides: Partial<TenantConversation> = {}): TenantConversation {
  return {
    companyId: AGENCY.companyId,
    landlordName: AGENCY.name,
    conversationId: '0193a7c0-0000-7000-8000-00000000c001',
    lastMessageAt: '2026-11-04T09:15:00.000Z',
    lastMessagePreview: 'Your receipt RCT-2026-000057 is ready.',
    unreadCount: 2,
    ...overrides,
  };
}

export const CONVERSATIONS: TenantConversation[] = [
  conversation(),
  conversation({
    companyId: LANDLORD.companyId,
    landlordName: LANDLORD.name,
    conversationId: null,
    lastMessageAt: null,
    lastMessagePreview: null,
    unreadCount: 0,
  }),
];

let next = 0;
const id = () => `0193a7c0-0000-7000-8000-${String(0xd00 + (next += 1)).padStart(12, '0')}`;

export function message(overrides: Partial<TenantMessage> = {}): TenantMessage {
  return {
    id: id(),
    direction: 'outbound',
    fromLandlord: true,
    channel: 'in_app',
    body: 'Hello from the office.',
    attachments: [],
    attachmentCount: 0,
    createdAt: '2026-11-04T09:00:00.000Z',
    ...overrides,
  };
}

export const OLDEST = message({
  body: 'Welcome to your new flat. Write here any time.',
  createdAt: '2026-11-01T08:00:00.000Z',
});
export const RECEIPT = message({
  body: 'Your receipt is ready: https://links.example.test/r/[link]',
  channel: 'whatsapp',
  createdAt: '2026-11-03T10:30:00.000Z',
  attachments: [
    {
      id: '0193a7c0-0000-7000-8000-00000000a7a1',
      kind: 'image',
      contentType: 'image/jpeg',
      sizeBytes: 120_000,
      filename: 'receipt.jpg',
      caption: null,
      status: 'stored',
      rejectReason: null,
    },
  ],
  attachmentCount: 1,
});
export const OWN = message({
  direction: 'inbound',
  fromLandlord: false,
  body: 'Thank you. When is the next water bill due?',
  createdAt: '2026-11-04T09:15:00.000Z',
});

/** The thread as the API sends it: newest first. */
export const THREAD = { items: [OWN, RECEIPT, OLDEST], nextCursor: null };

export const STORAGE_URL = 'https://storage.example.test/rent-uploads';
export const UPLOAD_ID = '0193a7c0-0000-7000-8000-0000000a0001';

/** A UUID, version 4, as the app makes for `clientMessageId`. */
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
