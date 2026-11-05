import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { instantFrom } from '../dates';
import { consentFactsOf } from './consent';
import { MESSAGE_PURPOSES } from './messaging';
import { planOutbound, planReply } from './outbound';
import {
  chooseWhatsAppContent,
  renderTemplate,
  TEMPLATE_DEFINITIONS,
  TEMPLATE_FOR_PURPOSE,
  TEMPLATE_KEYS,
  TEMPLATE_STATUSES,
  templateForPurpose,
  whatsAppWindowClosesAt,
  whatsAppWindowOpen,
  type TemplateOnNumber,
} from './whatsapp';

const T0 = instantFrom('2026-11-04T08:00:00Z');
const at = (minutes: number) => T0.add({ minutes });
const granted = consentFactsOf([{ action: 'grant', at: T0 }]);

describe('CM-07 24-hour window', () => {
  it('outside the window, WhatsApp carries only the purpose’s approved template; with none it goes by the next channel (property)', () => {
    fc.assert(
      fc.property(
        // With consent granted, so only the window and the template decide (the STOP
        // confirmation goes only in the window, by its own rule).
        fc.constantFrom(
          ...MESSAGE_PURPOSES.filter((p) => p !== 'inbound' && p !== 'opt_out_confirmation'),
        ),
        fc.option(fc.integer({ min: -48 * 60, max: 0 }), { nil: null }),
        fc.option(fc.constantFrom(...TEMPLATE_STATUSES), { nil: null }),
        fc.option(fc.constantFrom(...TEMPLATE_KEYS), { nil: null }),
        fc.boolean(),
        (purpose, inboundOffset, status, key, smsToo) => {
          const now = at(0);
          const lastInbound = inboundOffset === null ? null : at(inboundOffset);
          const template: TemplateOnNumber | null = key ? { key, language: 'en', status } : null;
          const plan = planOutbound({
            purpose,
            channels: smsToo ? ['whatsapp', 'sms'] : ['whatsapp'],
            reach: {
              whatsapp: { address: true, consent: granted, lastInboundAt: lastInbound },
              sms: { address: true, consent: granted, lastInboundAt: null },
            },
            whatsappTemplate: template,
            exhausted: new Set(),
            now,
          });
          const open = whatsAppWindowOpen(lastInbound, now);
          const usable =
            open ||
            (template !== null &&
              template.status === 'approved' &&
              template.key === templateForPurpose(purpose));
          if (plan.send && plan.channel === 'whatsapp') {
            expect(usable).toBe(true);
            if (!open)
              expect(plan.whatsapp).toEqual({
                kind: 'template',
                templateKey: templateForPurpose(purpose),
                language: 'en',
              });
            else expect(plan.whatsapp).toEqual({ kind: 'free_text' });
          } else if (!usable) {
            // WhatsApp was skipped for the template; SMS carried it if it could.
            expect(plan.skipped).toContainEqual({
              channel: 'whatsapp',
              reason: 'no_approved_template',
            });
            if (smsToo) expect(plan).toMatchObject({ send: true, channel: 'sms' });
            else expect(plan).toMatchObject({ send: false, reason: 'no_approved_template' });
          }
        },
      ),
    );
  });

  it('opens for 24 hours from the tenant’s last WhatsApp message', () => {
    expect(whatsAppWindowOpen(null, at(0))).toBe(false);
    expect(whatsAppWindowOpen(at(0), at(24 * 60 - 1))).toBe(true);
    expect(whatsAppWindowOpen(at(0), at(24 * 60))).toBe(false);
    expect(whatsAppWindowClosesAt(at(0), at(60))?.toString()).toBe(at(24 * 60).toString());
    expect(whatsAppWindowClosesAt(at(0), at(24 * 60))).toBeNull();
  });

  it('sends free text in the window and refuses anything but an approved template outside it', () => {
    const t = (status: TemplateOnNumber['status']): TemplateOnNumber => ({
      key: 'rent_reminder',
      language: 'en',
      status,
    });
    expect(chooseWhatsAppContent({ windowOpen: true, template: null })).toEqual({
      kind: 'free_text',
    });
    expect(chooseWhatsAppContent({ windowOpen: false, template: t('approved') })).toEqual({
      kind: 'template',
      templateKey: 'rent_reminder',
      language: 'en',
    });
    for (const status of ['pending', 'rejected', 'paused', 'disabled', null] as const)
      expect(chooseWhatsAppContent({ windowOpen: false, template: t(status) })).toEqual({
        kind: 'skip',
        reason: 'no_approved_template',
      });
  });

  it('offers staff only the reopen template outside the window, and refuses it when not approved', () => {
    const reach = { address: true, consent: granted, lastInboundAt: at(-30 * 60) };
    expect(
      planReply({
        purpose: 'conversation_reply',
        channel: 'whatsapp',
        reach,
        whatsappTemplate: { key: 'conversation_reopen', language: 'en', status: 'approved' },
        now: at(0),
      }),
    ).toEqual({
      send: true,
      basis: 'consent',
      whatsapp: { kind: 'template', templateKey: 'conversation_reopen', language: 'en' },
    });
    expect(
      planReply({
        purpose: 'conversation_reply',
        channel: 'whatsapp',
        reach,
        whatsappTemplate: { key: 'conversation_reopen', language: 'en', status: 'pending' },
        now: at(0),
      }),
    ).toEqual({ send: false, reason: 'window_closed' });
    // The bot only ever answers inside the window.
    expect(
      planReply({
        purpose: 'bot_reply',
        channel: 'whatsapp',
        reach,
        whatsappTemplate: { key: 'conversation_reopen', language: 'en', status: 'approved' },
        now: at(0),
      }),
    ).toEqual({ send: false, reason: 'window_closed' });
  });

  it('has a template, with the landlord as the first parameter, for every purpose that names one', () => {
    for (const key of Object.values(TEMPLATE_FOR_PURPOSE)) {
      const definition = TEMPLATE_DEFINITIONS.find((d) => d.key === key);
      expect(definition, key).toBeDefined();
      expect(definition!.parameters[0]).toBe('landlord');
      // Meta refuses a template that starts or ends with a parameter.
      expect(definition!.body.trim().startsWith('{{')).toBe(false);
      expect(definition!.body.trim().endsWith('}}')).toBe(false);
      const used = [...definition!.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
      expect(Math.max(...used)).toBe(definition!.parameters.length);
    }
    expect(new Set(TEMPLATE_DEFINITIONS.map((d) => d.whatsappName)).size).toBe(
      TEMPLATE_DEFINITIONS.length,
    );
    for (const d of TEMPLATE_DEFINITIONS) expect(d.whatsappName).toMatch(/^[a-z0-9_]{1,512}$/);
  });

  it('fills a template in order and refuses a missing parameter', () => {
    const definition = TEMPLATE_DEFINITIONS.find((d) => d.key === 'receipt_ready')!;
    expect(
      renderTemplate(definition, {
        landlord: 'Osu Properties',
        tenant: 'Ama',
        link: 'https://l.test/r/x',
      }),
    ).toEqual({
      text: 'Hello Ama, Osu Properties has received your payment. Your receipt is at https://l.test/r/x and stays open for 30 days.',
      parameters: ['Osu Properties', 'Ama', 'https://l.test/r/x'],
    });
    expect(() =>
      renderTemplate(definition, { landlord: 'Osu Properties', tenant: 'Ama' }),
    ).toThrow();
  });
});
