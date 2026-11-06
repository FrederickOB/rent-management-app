import type { Me } from '@rent/contracts';
import type { PolicyAction } from '@rent/domain/policy';
import type { PlanFeature } from '@rent/domain/settings';
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
  /**
   * Shown only when the company's plan includes this feature (M6 decision 9): a Starter company
   * sees no inbox, broadcasts or tenant groups. The API refuses them again (403 `not_on_plan`).
   */
  readonly feature?: PlanFeature;
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
    description:
      'Money that arrived without a pay link or a reference we could read: suggestions, matching and refunds.',
    needs: ['billing.view', 'payments.view'],
  },
  // M4b: provider payments (plan sections 4.2, 4.5 and 4.8).
  {
    href: '/payments/reconciliation',
    label: 'Reconciliation',
    description: 'Differences between the payment provider’s records, settlements and ours.',
    needs: 'payments.view',
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
  // M5: rent tax, VAT and the advance rent report (plan 5.8). People who see billing read them;
  // recording a GRA payment needs tax.manage, which the pages check.
  {
    href: '/tax/rent',
    label: 'Rent tax',
    description:
      'Rent tax on each receipt by owner and period, what is due to GRA with its alerts, and GRA payments.',
    needs: 'billing.view',
  },
  {
    href: '/tax/vat',
    label: 'VAT returns',
    description: 'VAT, NHIL and GETFund charged by owner and month, and VAT paid to GRA.',
    needs: 'billing.view',
  },
  {
    href: '/compliance/advance-rent',
    label: 'Advance rent report',
    description:
      'Leases paid further ahead than the advance rent limit, when your company checks it.',
    needs: 'billing.view',
  },
  // M6: the inbox, broadcasts, tenant groups, templates and reported repairs (plan 4.11).
  {
    href: '/inbox',
    label: 'Inbox',
    description:
      'Every conversation with tenants on WhatsApp, SMS, email and the app, with assignments and response times.',
    needs: 'messaging.inbox.read',
    feature: 'inbox',
  },
  {
    href: '/broadcasts',
    label: 'Broadcasts',
    description:
      'One message to every tenant of a property, some blocks or a group, with delivery.',
    needs: 'messaging.broadcast',
    feature: 'broadcasts',
  },
  {
    href: '/tenant-groups',
    label: 'Tenant groups',
    description: 'Named groups of tenants to send broadcasts to.',
    needs: 'tenant_group.manage',
    feature: 'tenant_groups',
  },
  {
    href: '/messaging/templates',
    label: 'Message templates',
    description: 'The text of each WhatsApp template, and whether Meta has approved it.',
    needs: 'messaging.templates.read',
  },
  {
    href: '/repairs',
    label: 'Reported repairs',
    description: 'Repairs tenants reported on WhatsApp, with their photos and ticket numbers.',
    needs: 'maintenance.view',
    feature: 'maintenance',
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
    href: '/settings/messaging',
    label: 'Messaging settings',
    description: 'The response target, the conversation tags and your WhatsApp number.',
    needs: ['company.update', 'messaging.templates.read'],
  },
  {
    href: '/settings/settlement',
    label: 'Settlement accounts',
    description: 'The bank accounts rent settles into, and where each owner’s rent goes.',
    needs: ['payments.view', 'settlement_account.change'],
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
  // M6: platform admins register WhatsApp numbers and set each company's interim plan
  // (decisions 3 and 9).
  {
    href: '/platform/whatsapp-numbers',
    label: 'WhatsApp numbers',
    description: 'The shared WhatsApp number and the numbers companies send from.',
    needs: 'whatsapp_account.manage',
  },
  {
    href: '/platform/company-plans',
    label: 'Company plans',
    description: 'Each company’s interim plan: Starter or Growth.',
    needs: 'company.plan.manage',
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

/**
 * The sections this session may open. Without a company, only home and personal security remain.
 * `features` is what the company's plan includes (lib/plan companyFeatures); sections that need a
 * feature are hidden when it is missing, and when it is not given at all.
 */
export function navFor(me: Me, features: readonly PlanFeature[] = []): NavItem[] {
  return ITEMS.filter(
    (item) =>
      permitted(me, item.needs) && (item.feature === undefined || features.includes(item.feature)),
  );
}
