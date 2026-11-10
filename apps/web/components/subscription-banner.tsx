'use client';

import type { CompanyProfile } from '@rent/contracts';
import Link from 'next/link';
import { todayIn } from '@/lib/business-dates';
import { bannerFor } from '@/lib/subscription';
import { Alert } from './ui/alert';

/**
 * The subscription banner (PB-11; M10 decision 11): past due, read-only, ended, or a trial for
 * those who can pay, with the way to Settings, Subscription. Staff screens only: nothing tenants
 * use ever shows it or changes with it.
 */
export function SubscriptionBanner({
  company,
  timeZone,
}: {
  readonly company: CompanyProfile | null;
  readonly timeZone: string;
}) {
  const banner = bannerFor(company?.subscription, todayIn(timeZone));
  if (!banner) return null;
  return (
    <div data-testid="subscription-banner" data-tone={banner.tone}>
      <Alert tone={banner.tone} title={banner.title} live={false}>
        <p>{banner.body}</p>
        {banner.action ? (
          <p className="mt-2">
            <Link
              href="/settings/subscription"
              className="font-medium underline underline-offset-2"
              data-testid="subscription-banner-action"
            >
              {banner.action}
            </Link>
          </p>
        ) : null}
      </Alert>
    </div>
  );
}
