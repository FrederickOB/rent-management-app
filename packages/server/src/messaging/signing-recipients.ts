import type { MessageChannel } from '@rent/domain/messaging';
import type { EsignService } from '../esign/esign.service';
import type { TenantsService } from '../tenancy/tenants.service';
import type { MessagingService, Reach } from './messaging.service';

/**
 * Signers as message recipients, and their links (M3 plan 4.8 and 4.9). Messages go to the
 * name, phone and email snapshotted on the signer when the request opened. Consent follows who
 * the signer is: a tenant or tenant contact needs consent recorded on the channel (CM-09), the
 * company's own staff need none, and anyone else has none on record, so staff hand the link over
 * in person (decision 2). Links are made by the e-signing engine at send time, so the raw token
 * is never stored.
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
      const addresses: Partial<Record<MessageChannel, string>> = {
        ...(signer.phone ? { sms: signer.phone } : {}),
        ...(signer.email ? { email: signer.email } : {}),
      };
      let consented: ReadonlySet<MessageChannel> = new Set();
      switch (signer.subject.type) {
        case 'staff':
          consented = new Set(Object.keys(addresses) as MessageChannel[]);
          break;
        case 'tenant':
          if (signer.tenantId)
            consented =
              (await tenants.reach(tx, { tenantId: signer.tenantId }))?.consented ?? consented;
          break;
        case 'tenant_contact':
          if (signer.tenantId)
            consented =
              (
                await tenants.reach(tx, {
                  tenantId: signer.tenantId,
                  contactId: signer.subject.contactId,
                })
              )?.consented ?? consented;
          break;
        default:
          break;
      }
      return {
        name: signer.name,
        addresses,
        consented,
        isTestContact: signer.isTestContact,
        tenantId: signer.tenantId,
        propertyId: signer.propertyId,
      };
    },
  });
  messaging.useLinks('sign', {
    url: (companyId, signerId, messageId) =>
      esign.messageLinkUrl(companyId, signerId, messageId, 'sign'),
  });
  messaging.useLinks('signed_copy', {
    url: (companyId, signerId, messageId) =>
      esign.messageLinkUrl(companyId, signerId, messageId, 'signed_copy'),
  });
}
