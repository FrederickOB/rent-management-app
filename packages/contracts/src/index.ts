import { approvalsContract } from './approvals';
import { auditContract } from './audit';
import { companyContract } from './company';
import { meContract } from './me';
import { membershipsContract } from './memberships';
import { rulesContract } from './rules';

export * from './approvals';
export * from './audit';
export * from './company';
export * from './me';
export * from './memberships';
export * from './rules';

/** The API contract (ADR-014). Routes are plain REST and JSON; amounts are integer `*Minor` fields. */
export const contract = {
  me: meContract,
  company: companyContract,
  memberships: membershipsContract,
  audit: auditContract,
  approvals: approvalsContract,
  rules: rulesContract,
};

export type Contract = typeof contract;
