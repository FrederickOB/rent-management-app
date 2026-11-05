import { approvalsContract } from './approvals';
import { auditContract } from './audit';
import {
  advanceRentContract,
  arrearsContract,
  earlyTerminationContract,
  invoicesContract,
  paymentsContract,
} from './billing';
import { companyContract } from './company';
import { linksContract } from './links';
import { maintenanceContract } from './maintenance';
import {
  broadcastsContract,
  inboxContract,
  messagingConsentContract,
  messagingSettingsContract,
  platformMessagingContract,
  templatesContract,
  tenantGroupsContract,
  tenantMessagingContract,
  unsubscribeLinksContract,
} from './messaging';
import { meContract } from './me';
import {
  payLinksContract,
  paymentsQueueContract,
  receiptLinksContract,
  settlementContract,
  tenantMoneyContract,
} from './payments';
import { membershipsContract } from './memberships';
import {
  ownersContract,
  propertyFilesContract,
  registerContract,
  registerImportsContract,
} from './register';
import { rulesContract } from './rules';
import { rentTaxContract, vatContract, withholdingContract } from './tax';
import {
  leasesContract,
  leaseTemplatesContract,
  signingRequestsContract,
  tenantAppContract,
  tenantsContract,
} from './tenancy';

export * from './approvals';
export * from './audit';
export * from './billing';
export * from './company';
export * from './links';
export * from './maintenance';
export * from './messaging';
export * from './me';
export * from './payments';
export * from './memberships';
export * from './register';
export * from './rules';
export * from './tax';
export * from './tenancy';

/** The API contract (ADR-014). Routes are plain REST and JSON; amounts are integer `*Minor` fields. */
export const contract = {
  me: meContract,
  company: companyContract,
  memberships: membershipsContract,
  audit: auditContract,
  approvals: approvalsContract,
  rules: rulesContract,
  owners: ownersContract,
  register: registerContract,
  propertyFiles: propertyFilesContract,
  registerImports: registerImportsContract,
  tenants: tenantsContract,
  leaseTemplates: leaseTemplatesContract,
  leases: leasesContract,
  signingRequests: signingRequestsContract,
  tenantApp: tenantAppContract,
  links: linksContract,
  invoices: invoicesContract,
  payments: paymentsContract,
  arrears: arrearsContract,
  payLinks: payLinksContract,
  receiptLinks: receiptLinksContract,
  settlement: settlementContract,
  paymentsQueue: paymentsQueueContract,
  tenantMoney: tenantMoneyContract,
  // M5: rent tax, withholding and VAT; early termination; advance rent and paid-until.
  rentTax: rentTaxContract,
  withholding: withholdingContract,
  vat: vatContract,
  earlyTermination: earlyTerminationContract,
  advanceRent: advanceRentContract,
  // M6: the inbox, consent on every channel, broadcasts, groups, templates, messaging settings,
  // the platform admin's numbers and plans, the tenant app's messages and push, the unsubscribe
  // page, and the maintenance stub.
  inbox: inboxContract,
  messagingConsent: messagingConsentContract,
  broadcasts: broadcastsContract,
  tenantGroups: tenantGroupsContract,
  templates: templatesContract,
  messagingSettings: messagingSettingsContract,
  platformMessaging: platformMessagingContract,
  tenantMessaging: tenantMessagingContract,
  unsubscribeLinks: unsubscribeLinksContract,
  maintenance: maintenanceContract,
};

export type Contract = typeof contract;
