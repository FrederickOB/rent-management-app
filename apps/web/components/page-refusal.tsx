import type { CompanyProfile, Me } from '@rent/contracts';
import type { PolicyAction } from '@rent/domain/policy';
import type { PlanFeature } from '@rent/domain/settings';
import type { ReactNode } from 'react';
import { hasFeature } from '@/lib/plan';
import { allowed } from '@/lib/policy';
import { NoAccess } from './no-access';
import { NotOnPlan } from './not-on-plan';
import { PageHeader } from './page-header';

/**
 * What a page shows instead of itself when this session may not open it: "no access" when the
 * policy refuses every action it needs, or "not on your plan" when the company's plan leaves the
 * feature out (M6 decision 9). Null when the page may show. The API refuses the calls again.
 */
export function pageRefusal(
  me: Me,
  company: CompanyProfile | null,
  page: {
    readonly title: string;
    readonly what: string;
    readonly needs: PolicyAction | readonly PolicyAction[];
    readonly feature?: PlanFeature;
  },
): ReactNode | null {
  const needs = typeof page.needs === 'string' ? [page.needs] : page.needs;
  if (!needs.some((action) => allowed(me, action))) {
    return (
      <>
        <PageHeader title={page.title} />
        <NoAccess what={page.what} />
      </>
    );
  }
  if (page.feature && !hasFeature(company, page.feature)) {
    return (
      <>
        <PageHeader title={page.title} />
        <NotOnPlan feature={page.feature} plan={company?.plan} />
      </>
    );
  }
  return null;
}
