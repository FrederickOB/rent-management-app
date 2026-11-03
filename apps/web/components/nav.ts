import type { Me } from '@rent/contracts';
import type { PolicyAction } from '@rent/domain/policy';
import { allowed } from '@/lib/policy';

export interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly description: string;
  /**
   * Shown only when the policy allows this action, or any of these actions; the API enforces it
   * again on every call.
   */
  readonly needs: PolicyAction | readonly PolicyAction[] | null;
}

const ITEMS: readonly NavItem[] = [
  { href: '/', label: 'Home', description: 'Your company at a glance.', needs: null },
  // M2: the property register (plan section 4.11).
  {
    href: '/portfolio',
    label: 'Portfolio',
    description: 'Every property and unit you look after, with their status.',
    needs: 'register.view',
  },
  {
    href: '/owners',
    label: 'Owners',
    description: 'The owners of the properties, and how to reach them.',
    needs: 'owner.view',
  },
  {
    href: '/portfolio/import',
    label: 'Import',
    description: 'Add or update properties and units from a spreadsheet.',
    needs: 'register.import',
  },
  // M3: tenants, leases, templates and approvals (plan section 4.16).
  {
    href: '/tenants',
    label: 'Tenants',
    description: 'Tenants and their contacts, consent, ID checks and tenancies.',
    needs: 'tenant.view',
  },
  {
    href: '/leases',
    label: 'Leases',
    description: 'Lease drafts, signed leases, renewals and leases ending soon.',
    needs: 'lease.view',
  },
  {
    href: '/lease-templates',
    label: 'Lease templates',
    description: 'The clauses your leases are built from, by version.',
    needs: 'lease.view_terms',
  },
  // M4a: invoices, payments, cash, receipts and arrears (plan section 4.19). A caretaker sees only
  // their own cash on hand and their cash records (cash.view_own), never invoices or balances.
  {
    href: '/invoices',
    label: 'Invoices',
    description: 'Rent, service-charge and deposit invoices: what is paid and what is overdue.',
    needs: 'billing.view',
  },
  {
    href: '/payments',
    label: 'Payments',
    description: 'Money received, what it paid for, its receipts, and recording transfers.',
    needs: 'billing.view',
  },
  {
    href: '/cash',
    label: 'Cash on hand',
    description: 'Cash and cheques collected and not yet banked; recording cash and banking.',
    needs: ['cash.view_own', 'billing.view'],
  },
  {
    href: '/payments/unmatched',
    label: 'Unmatched receipts',
    description: 'Transfers received before anyone knew which lease they pay for.',
    needs: 'billing.view',
  },
  {
    href: '/arrears',
    label: 'Arrears',
    description: 'Overdue invoices by age, for each tenant, property or owner.',
    needs: 'billing.view',
  },
  {
    href: '/receipts',
    label: 'Receipts',
    description: 'Every receipt issued, with its PDF.',
    needs: 'billing.view',
  },
  {
    href: '/approvals',
    label: 'Approvals',
    description:
      'Requests that need a second person, such as cash received or cancelling a signed lease.',
    needs: 'approval.view',
  },
  {
    href: '/settings/company',
    label: 'Company settings',
    description: 'Name, branding, logo and reminder settings.',
    needs: 'company.view',
  },
  {
    href: '/settings/users',
    label: 'Users and roles',
    description: 'Who works in this company, their roles and their access.',
    needs: 'membership.view',
  },
  {
    href: '/audit',
    label: 'Audit log',
    description: 'Who changed what, and when.',
    needs: 'audit.search',
  },
  // Everyone manages their own sessions (session.manage_own), with or without a company.
  {
    href: '/settings/security',
    label: 'My security',
    description: 'Your devices and your backup codes.',
    needs: null,
  },
];

function permitted(me: Me, needs: NavItem['needs']): boolean {
  if (needs === null) return true;
  return (typeof needs === 'string' ? [needs] : needs).some((action) => allowed(me, action));
}

/** The sections this session may open. Without a company, only home and personal security remain. */
export function navFor(me: Me): NavItem[] {
  return ITEMS.filter((item) => permitted(me, item.needs));
}
