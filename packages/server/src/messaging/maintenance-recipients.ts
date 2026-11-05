import { instantFrom } from '@rent/domain/dates';
import { NO_CONSENT, type ConsentChannel, type ConsentFacts } from '@rent/domain/messaging';
import { personContact } from '../identity/person-directory';
import type { ArtisansService } from '../maintenance/artisans.service';
import type { JobSheetService } from '../maintenance/job-sheet.service';
import type { MessagingService, Reach } from './messaging.service';

/**
 * M8 recipients and links (decisions 5 and 6). Staff are reached by email and SMS, which they need
 * not consent to; WhatsApp only for an emergency alert, and only when they opted in (OQ-33,
 * contact_consent_event). Artisans are reached on the channels they agreed to. The job-sheet link
 * is made by the maintenance module at send time, so its raw token is never stored, and replaces
 * the artisan's earlier link once the message is sent.
 */
export function registerMaintenanceRecipients(
  messaging: MessagingService,
  artisans: ArtisansService,
  sheets: JobSheetService,
): void {
  messaging.useRecipients('staff', {
    async reach(tx, _companyId, recipient, purpose): Promise<Reach | null> {
      if (recipient.type !== 'staff') return null;
      const person = await personContact(tx, recipient.personId);
      if (!person) return null;
      const addresses: Partial<Record<ConsentChannel, string>> = {
        ...(person.email ? { email: person.email } : {}),
        ...(person.phone ? { sms: person.phone } : {}),
      };
      const consented = new Set<ConsentChannel>(Object.keys(addresses) as ConsentChannel[]);
      let consent: Partial<Record<ConsentChannel, ConsentFacts>> | undefined;
      if (purpose === 'maintenance_alert' && person.phone) {
        const { whatsapp } = await artisans.staffReach(tx, recipient.personId);
        consent = {
          whatsapp: whatsapp
            ? { latest: { action: whatsapp.action, at: instantFrom(whatsapp.at) } }
            : NO_CONSENT,
        };
        if (whatsapp?.action === 'grant') {
          addresses.whatsapp = person.phone;
          consented.add('whatsapp');
        }
      }
      return {
        name: person.name,
        addresses,
        consented,
        ...(consent ? { consent } : {}),
        isTestContact: person.isTestContact,
        tenantId: null,
        propertyId: null,
      };
    },
  });
  messaging.useRecipients('artisan', {
    async reach(tx, _companyId, recipient): Promise<Reach | null> {
      if (!('artisanId' in recipient)) return null;
      const artisan = await artisans.artisanReach(tx, recipient.artisanId);
      if (!artisan || !artisan.phone) return null;
      const consent: Partial<Record<ConsentChannel, ConsentFacts>> = {};
      for (const channel of ['sms', 'whatsapp'] as const) {
        const latest = artisan.consentAt[channel];
        consent[channel] = latest
          ? { latest: { action: latest.action, at: instantFrom(latest.at) } }
          : NO_CONSENT;
      }
      return {
        name: artisan.name,
        addresses: { sms: artisan.phone, whatsapp: artisan.phone },
        consented: new Set<ConsentChannel>([...artisan.consented]),
        consent,
        isTestContact: artisan.isTestContact,
        tenantId: null,
        propertyId: null,
      };
    },
  });
  messaging.useLinks('job_sheet', {
    url: (companyId, jobId, messageId) => sheets.messageLinkUrl(companyId, jobId, messageId),
    sent: (tx, _companyId, jobId, messageId) => sheets.messageLinkSent(tx, jobId, messageId),
    notSent: (tx, _companyId, jobId, messageId) => sheets.messageLinkNotSent(tx, jobId, messageId),
  });
}
