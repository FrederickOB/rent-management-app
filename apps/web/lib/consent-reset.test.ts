import type { MessagingConsent } from '@rent/contracts';
import { describe, expect, it } from 'vitest';
import { channelsFor, m3Channels, orderedChannels } from './messaging-consent';
import { timelineDetail } from './tenancy-format';
import { consentResetNotes, consentWording } from './tenant-form';

const stored = {
  phone: '+233200000031',
  whatsappPhone: null,
  email: 'kwame@example.com',
};

describe('CM-09 and decision 8 a changed phone or email starts with no consent', () => {
  it('says a new phone starts with no SMS or WhatsApp consent when WhatsApp uses the phone', () => {
    expect(
      consentResetNotes(
        stored,
        { phone: '024 412 3456', whatsappPhone: '', email: 'kwame@example.com' },
        'the tenant',
      ),
    ).toEqual([
      'The new phone number starts with no SMS or WhatsApp consent. Once the tenant agrees to messages at it, record that below.',
    ]);
  });

  it('keeps SMS and WhatsApp apart when the tenant has a separate WhatsApp number', () => {
    expect(
      consentResetNotes(
        { ...stored, whatsappPhone: '+233200000099' },
        { phone: '024 412 3456', whatsappPhone: '020 000 0099', email: 'kwame@example.com' },
        'the tenant',
      ),
    ).toEqual([
      'The new phone number starts with no SMS consent. Once the tenant agrees to messages at it, record that below.',
    ]);
    expect(
      consentResetNotes(
        stored,
        { phone: '020 000 0031', whatsappPhone: '024 412 3456', email: 'kwame@example.com' },
        'the tenant',
      ),
    ).toEqual([
      'The new WhatsApp number starts with no WhatsApp consent. Once the tenant agrees to messages at it, record that below.',
    ]);
  });

  it('says a new email starts with no email consent, for a contact too', () => {
    expect(
      consentResetNotes(
        { phone: null, email: 'yaa@example.com' },
        { phone: '', email: 'yaa.new@example.com' },
        'Yaa Guarantor',
      ),
    ).toEqual([
      'The new email address starts with no email consent. Once Yaa Guarantor agrees to messages at it, record that below.',
    ]);
  });

  it('says nothing when the details are the same, typed differently, or removed', () => {
    expect(
      consentResetNotes(
        stored,
        { phone: '020 000 0031', whatsappPhone: '', email: 'KWAME@example.com ' },
        'x',
      ),
    ).toEqual([]);
    expect(consentResetNotes(stored, { phone: '', whatsappPhone: '', email: '' }, 'x')).toEqual([]);
  });
});

const consent: MessagingConsent = {
  tenantId: '019a3000-0000-7000-8000-0000000000f1',
  subjects: [
    {
      contactId: null,
      name: 'Kwame Monthly (demo)',
      kind: 'tenant',
      channels: [
        { channel: 'email', granted: false, source: null, recordedAt: null, reachable: false },
        {
          channel: 'whatsapp',
          granted: true,
          source: 'tenant_reply',
          recordedAt: '2026-11-04T09:00:00.000Z',
          reachable: true,
        },
        { channel: 'sms', granted: true, source: 'staff', recordedAt: null, reachable: true },
        { channel: 'push', granted: false, source: null, recordedAt: null, reachable: false },
      ],
    },
  ],
};

describe('CM-09 consent on every channel, in the order messages try them', () => {
  it('lists app notifications, WhatsApp, SMS, then email', () => {
    expect(orderedChannels(consent.subjects[0]!.channels).map((c) => c.channel)).toEqual([
      'push',
      'whatsapp',
      'sms',
      'email',
    ]);
    expect(channelsFor(consent, null)?.[1]).toMatchObject({ channel: 'whatsapp', granted: true });
    expect(channelsFor(consent, '019a3000-0000-7000-8000-0000000000f2')).toBeNull();
  });

  it('still shows SMS and email from the M3 record when the M6 read is not there', () => {
    expect(
      m3Channels({ sms: true, email: false }, { phone: '+233200000031', email: null }),
    ).toEqual([
      { channel: 'sms', granted: true, source: null, recordedAt: null, reachable: true },
      { channel: 'email', granted: false, source: null, recordedAt: null, reachable: false },
    ]);
  });

  it('shows staff the stored words for WhatsApp and app notifications too', () => {
    expect(consentWording('whatsapp')).toContain('by WhatsApp.');
    expect(consentWording('push')).toContain('by app notification.');
  });

  it('names WhatsApp and app notifications on the timeline', () => {
    expect(
      timelineDetail('consent_event.insert', { after: { channel: 'whatsapp', action: 'grant' } }),
    ).toBe('WhatsApp: agreed to messages');
    expect(
      timelineDetail('consent_event.insert', { after: { channel: 'push', action: 'withdraw' } }),
    ).toBe('App notification: withdrew consent');
  });
});
