import type { Me } from '@rent/contracts';
import { featuresOf } from '@rent/domain/settings';
import { describe, expect, it } from 'vitest';
import { navFor } from '../components/nav';
import { activeNavHref } from './nav-match';
import { companyFeatures, hasFeature, isNotOnPlan, notOnPlanText } from './plan';

const AGENCY = '019a3000-0000-7000-8000-000000000001';
const LANDLORD = '019a3000-0000-7000-8000-000000000002';
const PLATFORM = '019a3000-0000-7000-8000-000000000003';
const LEGON = '019a3000-0000-7000-8000-0000000000c1';

function member(
  role: string,
  options: {
    readonly kind?: 'agency' | 'landlord' | 'platform';
    readonly actorKind?: Me['actorKind'];
    readonly phone?: boolean;
    readonly scope?: { properties?: string[] };
  } = {},
): Me {
  const kind = options.kind ?? 'agency';
  const companyId = kind === 'landlord' ? LANDLORD : kind === 'platform' ? PLATFORM : AGENCY;
  return {
    personId: '019a3000-0000-7000-8000-0000000000aa',
    name: 'Someone (demo)',
    state: 'ready',
    authMethod: options.phone ? 'phone_otp' : 'password_totp',
    sessionExpiresAt: '2026-11-04T13:00:00.000Z',
    actorKind: options.actorKind ?? 'staff',
    activeCompanyId: companyId,
    role,
    memberships: [
      {
        membershipId: '019a3000-0000-7000-8000-0000000000bb',
        companyId,
        companyName: 'Demo company',
        companyKind: kind,
        role,
        nominatedApprover: false,
        ...(options.scope ? { scope: options.scope } : {}),
      },
    ],
  };
}

const M6 = [
  'Inbox',
  'Broadcasts',
  'Tenant groups',
  'Message templates',
  'Reported repairs',
  'Messaging settings',
  'WhatsApp numbers',
  'Company plans',
];
const GROWTH = featuresOf('growth');
const STARTER = featuresOf('starter');
const labels = (me: Me, features: readonly (typeof GROWTH)[number][] = GROWTH) =>
  navFor(me, features)
    .map((item) => item.label)
    .filter((label) => M6.includes(label));

describe('CM-05, CM-08 and decision 9 messaging navigation follows the policy and the plan', () => {
  it('shows a manager on Growth the inbox, broadcasts, groups, templates and repairs', () => {
    expect(labels(member('property_manager'))).toEqual([
      'Inbox',
      'Broadcasts',
      'Tenant groups',
      'Message templates',
      'Reported repairs',
      'Messaging settings',
    ]);
  });

  it('shows a Starter landlord no inbox, broadcast, group or repairs section', () => {
    const landlord = member('owner', { kind: 'landlord' });
    expect(labels(landlord, STARTER)).toEqual(['Message templates', 'Messaging settings']);
    // The same landlord on Growth gets them all.
    expect(labels(landlord, GROWTH)).toEqual(expect.arrayContaining(['Inbox', 'Broadcasts']));
  });

  it('hides plan features when the plan is not known', () => {
    expect(navFor(member('agency_admin')).map((item) => item.label)).not.toContain('Inbox');
  });

  it('lets an accountant read the inbox but not broadcast (plan 4.12)', () => {
    expect(labels(member('accountant'))).toEqual(['Inbox']);
  });

  it('shows a caretaker the inbox and repairs for their properties, nothing more', () => {
    const caretaker = member('caretaker', { phone: true, scope: { properties: [LEGON] } });
    expect(labels(caretaker)).toEqual(['Inbox', 'Reported repairs']);
  });

  it('keeps an agency’s client owner out of tenant conversations', () => {
    expect(labels(member('owner'))).toEqual([]);
  });

  it('gives a platform admin the numbers and plans, and no company inbox', () => {
    const admin = member('platform_admin', { kind: 'platform', actorKind: 'platform_admin' });
    expect(labels(admin, [])).toEqual(['WhatsApp numbers', 'Company plans']);
  });

  it('marks the right section on each new page', () => {
    const hrefs = navFor(member('agency_admin'), GROWTH).map((item) => item.href);
    expect(activeNavHref('/inbox/019a3000-0000-7000-8000-0000000000e1', hrefs)).toBe('/inbox');
    expect(activeNavHref('/broadcasts/new', hrefs)).toBe('/broadcasts');
    expect(activeNavHref('/tenant-groups/019a3000-0000-7000-8000-0000000000e2', hrefs)).toBe(
      '/tenant-groups',
    );
    expect(activeNavHref('/settings/messaging', hrefs)).toBe('/settings/messaging');
    expect(activeNavHref('/settings/settlement', hrefs)).toBe('/settings/settlement');
  });
});

describe('decision 9 plan features from the company profile', () => {
  it('reads the features the API sent', () => {
    expect(companyFeatures({ plan: 'starter', features: [] })).toEqual([]);
    expect(hasFeature({ plan: 'growth', features: ['inbox'] }, 'inbox')).toBe(true);
    expect(hasFeature({ plan: 'growth', features: ['inbox'] }, 'broadcasts')).toBe(false);
  });

  it('gives a profile from before M6 what it had, and no company nothing', () => {
    expect(companyFeatures({})).toEqual(GROWTH);
    expect(companyFeatures({ plan: 'starter' })).toEqual(STARTER);
    expect(companyFeatures(null)).toEqual([]);
  });

  it('says plainly why a page is missing', () => {
    expect(notOnPlanText('inbox', 'starter')).toBe('The inbox is not on the Starter plan.');
    expect(notOnPlanText('broadcasts', 'starter')).toBe('Broadcasts are not on the Starter plan.');
  });

  it('recognises the API’s not_on_plan refusal', () => {
    expect(isNotOnPlan({ status: 403, data: { body: { code: 'not_on_plan' } } })).toBe(true);
    expect(isNotOnPlan({ status: 403, data: { body: { code: 'forbidden' } } })).toBe(false);
    expect(isNotOnPlan({ status: 404, code: 'NOT_ON_PLAN' })).toBe(false);
  });
});
