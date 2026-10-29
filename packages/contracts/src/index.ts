import { approvalsContract } from './approvals';
import { auditContract } from './audit';
import { companyContract } from './company';
import { meContract } from './me';
import { membershipsContract } from './memberships';
import {
  ownersContract,
  propertyFilesContract,
  registerContract,
  registerImportsContract,
} from './register';
import { rulesContract } from './rules';
import {
  leasesContract,
  leaseTemplatesContract,
  tenantAppContract,
  tenantsContract,
} from './tenancy';

export * from './approvals';
export * from './audit';
export * from './company';
export * from './me';
export * from './memberships';
export * from './register';
export * from './rules';
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
  tenantApp: tenantAppContract,
};

export type Contract = typeof contract;
