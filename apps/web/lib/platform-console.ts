import type { PolicyAction } from '@rent/domain/policy';

// The platform admin console's navigation (M10 plan 4.8, PRD section 16): its sections in the
// PRD's order, each with the platform actions that open it (plan 4.9) and the tabs inside it.
// components/nav builds the console's menu entries from this list, and each page its tabs.

/** The actions the console's sections need: platform actions only. */
export type ConsoleAction = Extract<
  PolicyAction,
  | 'company.manage'
  | 'company.create'
  | 'pricing.manage'
  | 'discount.manage'
  | 'support.use'
  | 'usage.read'
  | 'health.read'
  | 'rules.view'
  | 'whatsapp_account.manage'
  | 'metrics.platform.read'
>;

export interface ConsoleTab {
  readonly key: string;
  readonly label: string;
}

export interface ConsoleSection {
  readonly href: string;
  readonly label: string;
  readonly description: string;
  /** Shown when the platform admin may do any of these. */
  readonly needs: readonly ConsoleAction[];
  readonly tabs: readonly ConsoleTab[];
}

export const CONSOLE_SECTIONS: readonly ConsoleSection[] = [
  {
    // M9's company plans fold in here: a company's tier is set on its detail page.
    href: '/platform/companies',
    label: 'Companies',
    description:
      'Every company with its tier, status, billable units, monthly revenue and arrears; onboarding a new one.',
    needs: ['company.manage', 'company.create'],
    tabs: [],
  },
  {
    href: '/platform/billing',
    label: 'Plans and billing',
    description:
      'Price lists by tier with their effective dates, the subscription terms, discount codes and the WhatsApp rate table.',
    needs: ['pricing.manage', 'discount.manage'],
    tabs: [
      { key: 'prices', label: 'Price lists' },
      { key: 'terms', label: 'Terms' },
      { key: 'codes', label: 'Discount codes' },
      { key: 'whatsapp-rates', label: 'WhatsApp rates' },
    ],
  },
  {
    href: '/platform/support',
    label: 'Support access',
    description:
      'Access customers have granted, the sessions under each grant, and opening a company read-only.',
    needs: ['support.use'],
    tabs: [],
  },
  {
    href: '/platform/messaging-costs',
    label: 'Messaging costs',
    description:
      'Messages by channel for each company and month, SMS cost and estimated WhatsApp cost.',
    needs: ['usage.read'],
    tabs: [],
  },
  {
    href: '/platform/health',
    label: 'System health',
    description:
      'Queues and dead-lettered jobs, failed webhooks, the last run of each scheduled job, audit chain checks and recent alerts.',
    needs: ['health.read'],
    tabs: [],
  },
  {
    href: '/platform/rules',
    label: 'Rules',
    description:
      'Legal, tax and regulatory values with their source and status; unverified ones stand out. New values are added, never edited.',
    needs: ['rules.view'],
    tabs: [],
  },
  {
    href: '/platform/whatsapp-numbers',
    label: 'WhatsApp numbers',
    description: 'The shared WhatsApp number and the numbers companies send from.',
    needs: ['whatsapp_account.manage'],
    tabs: [],
  },
  {
    href: '/platform/gate1',
    label: 'Gate 1 metrics',
    description: 'The Gate 1 measures for each company and in total, month by month.',
    needs: ['metrics.platform.read'],
    tabs: [],
  },
];

/** A company's detail page in the console (plan 4.8): one tab for each part. */
export const COMPANY_DETAIL_TABS: readonly ConsoleTab[] = [
  { key: 'subscription', label: 'Subscription' },
  { key: 'invoices', label: 'Invoices' },
  { key: 'usage', label: 'Usage' },
  { key: 'support', label: 'Support access' },
];

/** The sections a platform admin may open, given what the policy allows. */
export function consoleSectionsFor(allowed: (action: ConsoleAction) => boolean): ConsoleSection[] {
  return CONSOLE_SECTIONS.filter((section) => section.needs.some(allowed));
}

/** The tab a `?tab=` value names, or the first. */
export function consoleTab(tabs: readonly ConsoleTab[], value: string | null): ConsoleTab | null {
  return tabs.find((tab) => tab.key === value) ?? tabs[0] ?? null;
}
