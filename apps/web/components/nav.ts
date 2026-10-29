import type { Me } from '@rent/contracts';
import type { PolicyAction } from '@rent/domain/policy';
import { allowed } from '@/lib/policy';

export interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly description: string;
  /** Shown only when the policy allows this action; the API enforces it again on every call. */
  readonly needs: PolicyAction | null;
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

/** The sections this session may open. Without a company, only home and personal security remain. */
export function navFor(me: Me): NavItem[] {
  return ITEMS.filter((item) => (item.needs ? allowed(me, item.needs) : true));
}
