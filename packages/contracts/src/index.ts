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
};

export type Contract = typeof contract;
