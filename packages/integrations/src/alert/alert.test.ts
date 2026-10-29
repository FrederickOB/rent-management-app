import { describe, expect, it } from 'vitest';
import { InMemoryEmail } from '../email/email';
import { alertContract } from '../testing';
import { CallbackAlert, CompositeAlert, EmailAlert, InMemoryAlert, type Alert } from './alert';

alertContract('in-memory', () => {
  const port = new InMemoryAlert();
  return { port, delivered: async () => port.raised.map((a) => JSON.stringify(a)) };
});

alertContract('callback', () => {
  const seen: Alert[] = [];
  return {
    port: new CallbackAlert((alert) => void seen.push(alert)),
    delivered: async () => seen.map((a) => JSON.stringify(a)),
  };
});

alertContract('email', () => {
  const email = new InMemoryEmail();
  return {
    port: new EmailAlert(email, 'ops@rent.local'),
    delivered: async () => email.sent.map((m) => `${m.subject}\n${m.text}`),
  };
});

alertContract('log and email together', () => {
  const log = new InMemoryAlert();
  return {
    port: new CompositeAlert([log, new EmailAlert(new InMemoryEmail(), 'ops@rent.local')]),
    delivered: async () => log.raised.map((a) => JSON.stringify(a)),
  };
});

describe('PLATFORM alerts by email', () => {
  it('sends one email per alert to the ops address, with a one-line subject', async () => {
    const email = new InMemoryEmail();
    await new EmailAlert(email, 'ops@rent.local').raise({
      severity: 'critical',
      code: 'audit.chain_broken',
      message: 'Audit chain broken at seq 42\nSee the runbook.',
    });
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]).toMatchObject({
      to: 'ops@rent.local',
      subject: '[CRITICAL] audit.chain_broken: Audit chain broken at seq 42',
    });
    expect(email.sent[0]?.text).toContain('See the runbook.');
  });

  it('never puts personal data from the context into the email', async () => {
    const email = new InMemoryEmail();
    await new EmailAlert(email, 'ops@rent.local').raise({
      severity: 'warning',
      code: 'messaging.undeliverable',
      message: 'A receipt could not be delivered',
      context: {
        messageId: 'msg-1',
        phone: '+233200000123',
        recipient: { email: 'tenant@example.test', idNumber: 'GHA-123456789-0', name: 'kept' },
        otp: '123456',
        attempts: [{ token: 'abcdef' }],
      },
    });
    const text = email.sent[0]?.text ?? '';
    for (const secret of [
      '+233200000123',
      'tenant@example.test',
      'GHA-123456789-0',
      '123456',
      'abcdef',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('msg-1');
    expect(text).toContain('kept');
  });
});

describe('PLATFORM alerts to several targets', () => {
  it('still reaches the other targets when one fails, then reports the failure', async () => {
    const log = new InMemoryAlert();
    const failing = new CallbackAlert(() => Promise.reject(new Error('SMTP down')));
    const port = new CompositeAlert([failing, log]);
    await expect(
      port.raise({ severity: 'critical', code: 'jobs.dead_letter', message: 'gave up' }),
    ).rejects.toThrow(/1 of 2/);
    expect(log.byCode('jobs.dead_letter')).toHaveLength(1);
  });
});
