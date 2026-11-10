'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { Empty, LoadFailed, Loading } from '@/components/load-state';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { CheckboxField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { useLoad } from '@/lib/use-load';
import { GrantList } from '../companies/[companyId]/company-detail';

export function SupportView() {
  const [activeOnly, setActiveOnly] = useState(true);
  const load = useCallback(() => api().platformAdmin.supportGrants({ activeOnly }), [activeOnly]);
  const { state, reload } = useLoad(load);

  const byCompany =
    state.status === 'ready'
      ? [...new Map(state.data.map((grant) => [grant.company.id, grant.company])).values()].map(
          (company) => ({
            company,
            grants: state.data.filter((grant) => grant.company.id === company.id),
          }),
        )
      : [];

  return (
    <>
      <CheckboxField
        label="Active access only"
        checked={activeOnly}
        onChange={(event) => setActiveOnly(event.target.checked)}
      />
      {state.status === 'loading' ? <Loading what="support access" /> : null}
      {state.status === 'error' ? (
        <LoadFailed message={state.problem.message} onRetry={reload} />
      ) : null}
      {state.status === 'ready' && byCompany.length === 0 ? (
        <Empty>
          {activeOnly ? 'No company has granted support access right now.' : 'No grants yet.'}
        </Empty>
      ) : null}
      {byCompany.map(({ company, grants }) => (
        <Card key={company.id} data-testid="support-company">
          <CardHeader
            title={company.name}
            actions={
              grants.some((grant) => grant.active) ? (
                <Link
                  href={`/platform/support/${company.id}`}
                  className="text-sm font-medium underline underline-offset-2"
                >
                  Open read-only
                </Link>
              ) : null
            }
          />
          <CardBody>
            <GrantList grants={grants} />
          </CardBody>
        </Card>
      ))}
    </>
  );
}
