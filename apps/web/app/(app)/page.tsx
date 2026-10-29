import { DISPLAY_STATUS_LABELS, DISPLAY_STATUSES } from '@rent/domain/portfolio';
import Link from 'next/link';
import { navFor } from '@/components/nav';
import { PageHeader } from '@/components/page-header';
import { STATUS_TONES } from '@/components/status-badge';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { companyKindLabel, roleLabel } from '@/lib/format';
import { allowed } from '@/lib/policy';
import { totalOf } from '@/lib/register-format';
import { formatBusinessDate } from '@/lib/business-dates';
import {
  getCompany,
  getMe,
  loadExpiring,
  loadPropertyList,
  loadUnitCounts,
} from '@/lib/server/session';
import { daysLeftLabel, leaseStatusLabel } from '@/lib/tenancy-format';

export default async function HomePage() {
  // The layout has already checked the session; these calls are cached for this request.
  const [me, company] = await Promise.all([getMe(), getCompany()]);
  if (!me) return null;
  const membership = me.memberships.find((m) => m.companyId === me.activeCompanyId);
  const sections = navFor(me).filter((item) => item.href !== '/');
  // The start of the DA-01 dashboard (M9): what is in the register, by status (M2 plan 4.11).
  const [properties, units] = allowed(me, 'register.view')
    ? await Promise.all([loadPropertyList(), loadUnitCounts()])
    : [null, null];
  const register =
    properties?.ok && units?.ok
      ? { properties: properties.data.rows.length, counts: units.data.counts }
      : null;
  // TL-09: leases ending in the next 90 days, with their renewals (M3 plan 4.10).
  const expiring = allowed(me, 'lease.view') ? await loadExpiring(90) : null;
  const ending = expiring?.ok ? expiring.data : null;

  return (
    <>
      <PageHeader title={`Welcome, ${me.name}`} />
      {membership ? (
        <p className="text-sm text-slate-700">
          You are working in <strong>{company?.displayName ?? membership.companyName}</strong> (
          {companyKindLabel(membership.companyKind)}) as{' '}
          <strong>{roleLabel(membership.role)}</strong>.
        </p>
      ) : (
        <Alert tone="info">
          You are not a member of any company yet. Ask an administrator to invite you.
        </Alert>
      )}
      {register ? (
        <Card data-testid="register-summary">
          <CardHeader
            title="Portfolio at a glance"
            description="Live from the register; choose a status to see those units."
          />
          <CardBody>
            <dl className="grid grid-cols-2 gap-4 sm:max-w-sm">
              <div>
                <dt className="text-sm text-slate-600">Properties</dt>
                <dd className="text-2xl font-semibold tabular-nums" data-testid="property-count">
                  {register.properties}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-slate-600">Units</dt>
                <dd className="text-2xl font-semibold tabular-nums" data-testid="unit-count">
                  {totalOf(register.counts)}
                </dd>
              </div>
            </dl>
            <ul className="flex flex-wrap gap-2" aria-label="Units by status">
              {DISPLAY_STATUSES.map((status) => (
                <li key={status}>
                  <Link
                    href={`/portfolio?status=${status}`}
                    className="inline-flex min-h-11 items-center gap-2 rounded-md px-1 text-sm underline-offset-2 hover:underline"
                  >
                    <Badge tone={STATUS_TONES[status]}>{DISPLAY_STATUS_LABELS[status]}</Badge>
                    <span className="font-semibold tabular-nums">{register.counts[status]}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}
      {ending ? (
        <Card data-testid="expiring-summary">
          <CardHeader
            title="Leases ending in the next 90 days"
            description={
              ending.length === 0
                ? 'None. Renewal reminders go out before each lease ends.'
                : `${ending.length} ${ending.length === 1 ? 'lease ends' : 'leases end'} soon; ${ending.filter((l) => l.renewal).length} with a renewal.`
            }
          />
          {ending.length ? (
            <CardBody>
              <ul className="divide-y divide-slate-100 text-sm" aria-label="Leases ending soon">
                {ending.slice(0, 5).map((lease) => (
                  <li
                    key={lease.id}
                    data-testid="expiring-lease"
                    className="flex flex-wrap items-baseline justify-between gap-2 py-2"
                  >
                    <Link
                      href={`/leases/${lease.id}`}
                      className="font-medium underline underline-offset-2"
                    >
                      <span className="font-mono">{lease.unitCode}</span> {lease.tenantName}
                    </Link>
                    <span className="text-slate-700">
                      Ends {formatBusinessDate(lease.endDate)} ({daysLeftLabel(lease.daysLeft)})
                      {lease.renewal
                        ? ` · renewal ${leaseStatusLabel(lease.renewal.status).toLowerCase()}`
                        : ''}
                    </span>
                  </li>
                ))}
              </ul>
              <Link
                href="/leases/expiring"
                className="inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-2"
              >
                See every lease ending soon
              </Link>
            </CardBody>
          ) : null}
        </Card>
      ) : null}
      <ul className="grid gap-4 sm:grid-cols-2">
        {sections.map((item) => (
          <li key={item.href}>
            <Card className="h-full">
              <CardBody>
                <Link
                  href={item.href}
                  className="text-base font-semibold underline-offset-2 hover:underline"
                >
                  {item.label}
                </Link>
                <p className="text-sm text-slate-600">{item.description}</p>
              </CardBody>
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}
