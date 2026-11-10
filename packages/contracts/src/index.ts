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
import {
  artisansContract,
  expensesContract,
  inspectionsContract,
  jobSheetContract,
  maintenanceContract,
  tenantRepairsContract,
} from './maintenance';
import { moveOutsContract } from './moveout';
import {
  complianceContract,
  dashboardContract,
  feeTermsContract,
  ownerMoneyContract,
  ownerStatementsContract,
  platformMetricsContract,
} from './reporting';
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
  noticesContract,
  quitAcknowledgementContract,
  rentAssessmentsContract,
  tasksContract,
} from './notices';
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
import { platformAdminContract, subscriptionContract, supportGrantsContract } from './subscription';
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
export * from './moveout';
export * from './messaging';
export * from './me';
export * from './notices';
export * from './payments';
export * from './memberships';
export * from './register';
export * from './reporting';
export * from './rules';
export * from './subscription';
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
  // M7: legal notices, the OQ-16 acknowledgement, Rent Officer assessments and staff tasks.
  notices: noticesContract,
  quitAcknowledgement: quitAcknowledgementContract,
  rentAssessments: rentAssessmentsContract,
  tasks: tasksContract,
  // M8: the maintenance board, artisans and their job sheets, inspections and the move-in report,
  // expenses, the tenant app's repairs, and move-out with its settlement.
  artisans: artisansContract,
  jobSheets: jobSheetContract,
  inspections: inspectionsContract,
  expenses: expensesContract,
  tenantRepairs: tenantRepairsContract,
  moveOuts: moveOutsContract,
  // M9: fee terms, owner statements, remittances, the dashboard, Gate 1 and the compliance list.
  feeTerms: feeTermsContract,
  ownerStatements: ownerStatementsContract,
  ownerMoney: ownerMoneyContract,
  dashboard: dashboardContract,
  platformMetrics: platformMetricsContract,
  compliance: complianceContract,
  // M10: the subscription, support grants and the platform admin console.
  subscription: subscriptionContract,
  supportGrants: supportGrantsContract,
  platformAdmin: platformAdminContract,
};

export type Contract = typeof contract;
