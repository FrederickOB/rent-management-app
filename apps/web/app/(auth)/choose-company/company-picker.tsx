'use client';

import type { Me } from '@rent/contracts';
import Link from 'next/link';
import { useState } from 'react';
import { SignOutButton } from '@/components/sign-out-button';
import { Alert } from '@/components/ui/alert';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { companyKindLabel, roleLabel } from '@/lib/format';

export function CompanyPicker({
  memberships,
  activeCompanyId,
}: {
  readonly memberships: Me['memberships'];
  readonly activeCompanyId: string | null;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(companyId: string) {
    setPending(companyId);
    setError(null);
    try {
      await api().me.setActiveCompany({ companyId });
      window.location.assign('/');
    } catch (failure) {
      setError(toProblem(failure).message);
      setPending(null);
    }
  }

  return (
    <Card>
      <CardHeader
        title={<span className="text-xl">Choose a company</span>}
        description="You work in more than one company. Choose the one to work in now; you can switch later."
      />
      <CardBody>
        {error ? <Alert tone="error">{error}</Alert> : null}
        {memberships.length === 0 ? (
          <Alert tone="info">
            You are not a member of any company yet. Ask the person who invited you to check your
            invitation.
          </Alert>
        ) : (
          <ul className="space-y-2">
            {memberships.map((m) => (
              <li key={m.membershipId}>
                <button
                  type="button"
                  onClick={() => void choose(m.companyId)}
                  disabled={pending !== null}
                  aria-busy={pending === m.companyId || undefined}
                  className="flex w-full flex-col items-start rounded-md border border-slate-300 bg-white px-4 py-3 text-left hover:border-slate-500 disabled:opacity-60"
                >
                  <span className="font-semibold text-slate-900">{m.companyName}</span>
                  <span className="text-sm text-slate-600">
                    {companyKindLabel(m.companyKind)}, {roleLabel(m.role)}
                    {m.companyId === activeCompanyId ? ' (current)' : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-4">
          {activeCompanyId ? (
            <Link href="/" className="text-sm font-medium underline underline-offset-2">
              Back to the app
            </Link>
          ) : (
            <span />
          )}
          <SignOutButton variant="ghost" />
        </div>
      </CardBody>
    </Card>
  );
}
