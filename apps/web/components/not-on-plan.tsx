import type { PlanFeature, SubscriptionTier } from '@rent/domain/settings';
import Link from 'next/link';
import { notOnPlanText, unlockSentence } from '@/lib/plan';
import { Card, CardBody } from './ui/card';

/** Features whose absence leaves tenants' messages with the WhatsApp assistant (M6 decision 9). */
const MESSAGING: readonly PlanFeature[] = ['inbox', 'broadcasts', 'tenant_groups', 'bot_full_menu'];

/**
 * Shown when someone opens a page their company's plan leaves out (M6 decision 9; M10 PB-04).
 * The navigation already hides it, so this is for a bookmark or a typed address. It names the plan
 * that includes the feature and leads to Settings, Subscription, where the plan is changed, for those who may change it.
 */
export function NotOnPlan({
  feature,
  plan,
  canChangePlan = false,
}: {
  readonly feature: PlanFeature;
  readonly plan: SubscriptionTier | undefined;
  /** May this person change the plan (`subscription.manage`; review WEB-14)? */
  readonly canChangePlan?: boolean;
}) {
  return (
    <Card data-testid="not-on-plan">
      <CardBody className="space-y-2">
        <p className="text-sm font-medium text-slate-900">
          {notOnPlanText(feature, plan)} {unlockSentence(feature)}
        </p>
        {MESSAGING.includes(feature) ? (
          <p className="text-sm text-slate-700">
            Without it, the WhatsApp assistant still answers balance, receipt and pay requests and
            sends reminders. Anything else a tenant writes is recorded on their timeline and
            forwarded to you by SMS or email.
          </p>
        ) : null}
        {canChangePlan ? (
          <p className="text-sm">
            <Link
              href="/settings/subscription"
              className="font-medium underline underline-offset-2"
              data-testid="not-on-plan-link"
            >
              See the plans and change yours
            </Link>
          </p>
        ) : (
          <p className="text-sm text-slate-700">
            Ask your agency admin or the landlord to change the plan in Settings, Subscription.
          </p>
        )}
      </CardBody>
    </Card>
  );
}
