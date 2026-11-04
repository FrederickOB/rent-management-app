import type { ThreadMessage } from '@rent/contracts';
import { describe, expect, it } from 'vitest';
import {
  FIRST_RESPONSE_MAX,
  firstResponseProblem,
  minutesOf,
  normaliseTag,
  tagProblem,
} from './messaging-settings';
import { EMPTY_NUMBER, numberErrors, numberInput } from './platform-messaging';
import { findGroup, groupErrors, groupPatch } from './tenant-groups';
import { namedBody, templateStatusText, usableOnSendingNumber } from './templates';
import { mergeTimeline, messageExcerpt, messageHeadline, type TimelineEvent } from './timeline';

const message = (extra: Partial<ThreadMessage>): ThreadMessage => ({
  id: '019a3000-0000-7000-8000-000000000001',
  conversationId: '019a3000-0000-7000-8000-00000000c001',
  direction: 'inbound',
  channel: 'whatsapp',
  authorType: 'tenant',
  authorName: 'Kwame Monthly (demo)',
  purpose: 'inbound',
  subject: null,
  body: 'The tap is leaking',
  templateKey: null,
  status: 'received',
  statusReason: null,
  statusAt: '2026-11-04T10:00:00.000Z',
  attachments: [],
  attachmentCount: 0,
  costMinor: null,
  currency: null,
  createdAt: '2026-11-04T10:00:00.000Z',
  ...extra,
});

const event = (at: string, action: string): TimelineEvent => ({
  at,
  action,
  recordType: null,
  recordId: null,
  actorName: null,
  data: null,
});

describe('CM-05 messages join the tenant’s timeline', () => {
  it('interleaves audit events and messages, newest first', () => {
    const entries = mergeTimeline(
      [
        event('2026-11-04T11:00:00.000Z', 'tenant.update'),
        event('2026-11-03T09:00:00.000Z', 'tenant.insert'),
      ],
      [
        message({
          id: '019a3000-0000-7000-8000-000000000001',
          createdAt: '2026-11-04T10:00:00.000Z',
        }),
        message({
          id: '019a3000-0000-7000-8000-000000000002',
          createdAt: '2026-11-04T12:00:00.000Z',
        }),
      ],
    );
    expect(entries.map((e) => (e.kind === 'event' ? e.event.action : e.message.id))).toEqual([
      '019a3000-0000-7000-8000-000000000002',
      'tenant.update',
      '019a3000-0000-7000-8000-000000000001',
      'tenant.insert',
    ]);
  });

  it('says who wrote and on which channel', () => {
    expect(messageHeadline(message({}))).toBe('WhatsApp message from the tenant');
    expect(
      messageHeadline(
        message({
          direction: 'outbound',
          authorType: 'staff',
          authorName: 'Kofi Manager (demo)',
          channel: 'sms',
        }),
      ),
    ).toBe('SMS message to the tenant from Kofi Manager (demo)');
    expect(messageHeadline(message({ direction: 'outbound', authorType: 'bot' }))).toBe(
      'WhatsApp reply from the assistant',
    );
    expect(
      messageHeadline(message({ authorType: 'contact', authorName: 'Finance Desk (demo)' })),
    ).toBe('WhatsApp message from Finance Desk (demo)');
  });

  it('shortens long messages for the timeline only', () => {
    expect(messageExcerpt('short')).toBe('short');
    const long = messageExcerpt('word '.repeat(100), 20);
    expect(long.length).toBeLessThanOrEqual(20);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('CM-06 and decision 10 the response target and tags', () => {
  it('reads hours and minutes as whole minutes', () => {
    expect(minutesOf('4', '0')).toBe(240);
    expect(minutesOf('', '45')).toBe(45);
    expect(minutesOf('1.5', '0')).toBeNull();
    expect(minutesOf('1', '60')).toBeNull();
  });

  it('keeps the target between 15 minutes and 7 days', () => {
    expect(firstResponseProblem(10)).toBe('Allow at least 15 minutes');
    expect(firstResponseProblem(FIRST_RESPONSE_MAX + 1)).toBe('Allow at most 7 days');
    expect(firstResponseProblem(240)).toBeNull();
    expect(firstResponseProblem(null)).toBe('Use whole hours, and minutes from 0 to 59');
  });

  it('stores tags in lower case with hyphens, once each', () => {
    expect(normaliseTag(' Rent Query ')).toBe('rent-query');
    expect(tagProblem('rent-query', ['repair'])).toBeNull();
    expect(tagProblem('repair', ['repair'])).toBe('That tag is already in the list');
    expect(tagProblem('-bad', [])).toMatch(/^Use lower case letters/);
    expect(tagProblem('', [])).toBe('Type a tag first');
  });
});

describe('CM-07 templates as staff read them', () => {
  const template = {
    body: 'Hello {{2}}, {{1}} has received your payment. Your receipt {{3}} is ready.',
    parameters: ['landlord', 'tenant', 'receipt_number'],
  };

  it('names each parameter', () => {
    expect(namedBody(template)).toBe(
      'Hello {tenant}, {landlord} has received your payment. Your receipt {receipt_number} is ready.',
    );
    expect(namedBody({ body: 'Hi {{4}}', parameters: [] })).toBe('Hi {{4}}');
  });

  it('can go only when approved on the sending number', () => {
    const number = { kind: 'shared' as const, displayPhone: '+233300000000', displayName: 'Rent' };
    const status = (sending: boolean, value: 'approved' | 'pending' | null) => ({
      number,
      sending,
      status: value,
      reason: null,
      checkedAt: null,
    });
    expect(usableOnSendingNumber({ statuses: [status(true, 'approved')] })).toBe(true);
    expect(
      usableOnSendingNumber({ statuses: [status(true, 'pending'), status(false, 'approved')] }),
    ).toBe(false);
    expect(templateStatusText(null)).toBe('Not submitted');
    expect(templateStatusText('rejected')).toBe('Refused');
  });
});

describe('decision 3 registering a WhatsApp number', () => {
  it('checks the Meta ids, the number and the company', () => {
    expect(Object.keys(numberErrors(EMPTY_NUMBER)).sort()).toEqual([
      'companyId',
      'displayName',
      'displayPhone',
      'phoneNumberId',
      'wabaId',
    ]);
    const shared = {
      ...EMPTY_NUMBER,
      kind: 'shared' as const,
      phoneNumberId: '1234567890',
      wabaId: '9876543210',
      displayPhone: '+233302000000',
      displayName: 'Rent Platform',
      companyId: '019a3000-0000-7000-8000-000000000001',
    };
    expect(numberErrors(shared)).toEqual({});
    // The shared number names no company, whatever was chosen before.
    expect(numberInput(shared).companyId).toBeNull();
  });
});

describe('CM-08 tenant groups', () => {
  const group = {
    id: '019a3000-0000-7000-8000-0000000000e1',
    name: 'Shop tenants',
    description: null,
    memberCount: 3,
    archivedAt: null,
    createdAt: '2026-11-01T09:00:00.000Z',
  };

  it('checks the name and sends only what changed', () => {
    expect(groupErrors({ name: 'x', description: '' })).toEqual({
      name: 'Give the group a name of 2 to 60 characters',
    });
    expect(groupPatch(group, { name: 'Shop tenants', description: '' })).toEqual({});
    expect(groupPatch(group, { name: 'Osu shops', description: ' Ground floor ' })).toEqual({
      name: 'Osu shops',
      description: 'Ground floor',
    });
  });

  it('finds a group in the current or the archived list', () => {
    const archived = {
      ...group,
      id: '019a3000-0000-7000-8000-0000000000e2',
      archivedAt: group.createdAt,
    };
    expect(findGroup([[group], [archived]], archived.id)).toBe(archived);
    expect(findGroup([[group]], archived.id)).toBeNull();
  });
});
