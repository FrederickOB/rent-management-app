import { instantFrom } from '@rent/domain/dates';
import {
  CONSENT_CHANNELS,
  NO_CONSENT,
  type ConsentChannel,
  type ConsentFacts,
  type MessageChannel,
} from '@rent/domain/messaging';
import type { EsignService } from '../esign/esign.service';
import type { TenantsService } from '../tenancy/tenants.service';
import type { MessagingService, Reach } from './messaging.service';

/**
 * Signers as message recipients, and their links (M3 plan 4.8 and 4.9). Messages go to the
 * name, phone and email snapshotted on the signer when the request opened. Consent follows who
 * the signer is: a tenant or tenant contact needs consent recorded on the channel (CM-09), the
 * company's own staff need none, and anyone else has none on record, so staff hand the link over
 * in person (decision 2). Links are made by the e-signing engine at send time, so the raw token
 * is never stored, and replace the signer's earlier link once the message carrying them is sent.
 */
export function registerSigningRecipients(
  messaging: MessagingService,
  esign: EsignService,
  tenants: TenantsService,
): void {
  messaging.useRecipients('signer', {
    async reach(tx, _companyId, recipient): Promise<Reach | null> {
      if (recipient.type !== 'signer') return null;
      const signer = await esign.signerContact(tx, recipient.signerId);
      if (!signer) return null;
      const addresses: Partial<Record<ConsentChannel, string>> = {
        ...(signer.phone ? { sms: signer.phone } : {}),
        ...(signer.email ? { email: signer.email } : {}),
      };
      let consented: ReadonlySet<ConsentChannel> = new Set();
      let consent: Partial<Record<ConsentChannel, ConsentFacts>> | undefined;
      let subject: Reach['subject'] = null;
      switch (signer.subject.type) {
        case 'staff':
          consented = new Set(Object.keys(addresses) as MessageChannel[]);
          break;
        case 'tenant':
        case 'tenant_contact': {
          if (!signer.tenantId) break;
          const contactId =
            signer.subject.type === 'tenant_contact' ? signer.subject.contactId : null;
          consented =
            (await tenants.reach(tx, { tenantId: signer.tenantId, contactId }))?.consented ??
            consented;
          // M6 (plan 4.9; review S7): the tenant's WhatsApp and the app too, where the signer is
          // the tenant or their contact and the phone is still the one on record (decision 8).
          const point = await tenants.messagingPoint(tx, { tenantId: signer.tenantId, contactId });
          if (point) {
            if (
              signer.phone &&
              (point.whatsappPhone === signer.phone || point.phone === signer.phone)
            )
              addresses.whatsapp = signer.phone;
            if (!contactId && point.personId) addresses.push = point.personId;
            consent = {};
            for (const channel of CONSENT_CHANNELS) {
              const latest = point.consent[channel];
              consent[channel] = latest
                ? { latest: { action: latest.action, at: instantFrom(latest.at) } }
                : NO_CONSENT;
            }
            consented = new Set([
              ...consented,
              ...CONSENT_CHANNELS.filter((c) => point.consent[c]?.action === 'grant'),
            ]);
          }
          // Emails to the tenant get their reply address and, outside a reply, the unsubscribe
          // link (decision 7; review L1).
          subject = { tenantId: signer.tenantId, contactId };
          break;
        }
        default:
          break;
      }
      return {
        name: signer.name,
        addresses,
        consented,
        ...(consent ? { consent } : {}),
        isTestContact: signer.isTestContact,
        tenantId: signer.tenantId,
        propertyId: signer.propertyId,
        subject,
      };
    },
  });
  // A message's link replaces the signer's earlier one only once the message is sent; a link
  // whose message was never sent is withdrawn instead (M3 review finding 10).
  for (const purpose of ['sign', 'signed_copy'] as const)
    messaging.useLinks(purpose, {
      url: (companyId, signerId, messageId) =>
        esign.messageLinkUrl(companyId, signerId, messageId, purpose),
      sent: (tx, _companyId, signerId, messageId) =>
        esign.messageLinkSent(tx, signerId, messageId, purpose),
      notSent: (tx, _companyId, signerId, messageId) =>
        esign.messageLinkNotSent(tx, signerId, messageId),
    });
}
