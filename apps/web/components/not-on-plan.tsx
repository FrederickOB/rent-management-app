import type { InterimPlan, PlanFeature } from '@rent/domain/settings';
import { notOnPlanText } from '@/lib/plan';
import { Card, CardBody } from './ui/card';

/**
 * Shown when someone opens a page their company's plan leaves out (M6 decision 9). The navigation
 * already hides it, so this is for a bookmark or a typed address.
 */
export function NotOnPlan({
  feature,
  plan,
}: {
  readonly feature: PlanFeature;
  readonly plan: InterimPlan | undefined;
}) {
  return (
    <Card data-testid="not-on-plan">
      <CardBody>
        <p className="text-sm font-medium text-slate-900">{notOnPlanText(feature, plan)}</p>
        <p className="text-sm text-slate-700">
          On the Starter plan the WhatsApp assistant still answers balance, receipt and pay requests
          and sends reminders. Anything else a tenant writes is recorded on their timeline and
          forwarded to you by SMS or email. A platform administrator can move your company to the
          Growth plan, which adds the inbox, broadcasts, tenant groups, repairs and legal notices.
        </p>
      </CardBody>
    </Card>
  );
}
