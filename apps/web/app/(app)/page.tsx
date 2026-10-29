import Link from 'next/link';
import { navFor } from '@/components/nav';
import { PageHeader } from '@/components/page-header';
import { Alert } from '@/components/ui/alert';
import { Card, CardBody } from '@/components/ui/card';
import { companyKindLabel, roleLabel } from '@/lib/format';
import { getCompany, getMe } from '@/lib/server/session';

export default async function HomePage() {
  // The layout has already checked the session; these calls are cached for this request.
  const [me, company] = await Promise.all([getMe(), getCompany()]);
  if (!me) return null;
  const membership = me.memberships.find((m) => m.companyId === me.activeCompanyId);
  const sections = navFor(me).filter((item) => item.href !== '/');

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
