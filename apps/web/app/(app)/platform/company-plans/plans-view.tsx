'use client';

import type { CompanyPlan } from '@rent/contracts';
import { INTERIM_PLANS, type InterimPlan } from '@rent/domain/settings';
import { useCallback, useEffect, useState } from 'react';
import { Empty, LoadFailed, Loading } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { SelectField } from '@/components/ui/field';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { companyKindLabel, humanise } from '@/lib/format';
import { planLabel } from '@/lib/plan';

export function PlansView() {
  const [rows, setRows] = useState<readonly CompanyPlan[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await api().platformMessaging.companyPlans());
      setProblem(null);
    } catch (failure) {
      setProblem(toProblem(failure).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (problem && rows === null) return <LoadFailed message={problem} onRetry={() => void load()} />;
  if (rows === null) return <Loading what="companies" />;
  if (rows.length === 0) return <Empty>No company yet.</Empty>;

  return (
    <Card>
      <CardBody>
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        {problem ? <Alert tone="error">{problem}</Alert> : null}
        <Table caption="Company plans">
          <thead>
            <tr>
              <Th>Company</Th>
              <Th>Kind</Th>
              <Th>Status</Th>
              <Th>Plan</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => (
              <PlanRow
                key={row.companyId}
                row={row}
                onSaved={(next) => {
                  setRows((current) =>
                    (current ?? []).map((r) => (r.companyId === next.companyId ? next : r)),
                  );
                  setNotice(`${next.displayName} is now on ${planLabel(next.plan)}.`);
                  setProblem(null);
                }}
                onFailed={(text) => setProblem(text)}
              />
            ))}
          </tbody>
        </Table>
      </CardBody>
    </Card>
  );
}

function PlanRow({
  row,
  onSaved,
  onFailed,
}: {
  readonly row: CompanyPlan;
  readonly onSaved: (row: CompanyPlan) => void;
  readonly onFailed: (text: string) => void;
}) {
  const [plan, setPlan] = useState<InterimPlan>(row.plan);
  const [pending, setPending] = useState(false);

  async function save() {
    setPending(true);
    try {
      onSaved(await api().platformMessaging.setCompanyPlan({ companyId: row.companyId, plan }));
    } catch (failure) {
      onFailed(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <tr data-testid="plan-row">
      <Td className="font-medium">{row.displayName}</Td>
      <Td>{companyKindLabel(row.kind)}</Td>
      <Td>{humanise(row.status)}</Td>
      <Td>
        <div className="flex flex-wrap items-end gap-2">
          <SelectField
            label={`Plan for ${row.displayName}`}
            className="min-w-36"
            value={plan}
            options={INTERIM_PLANS.map((p) => ({ value: p, label: planLabel(p) }))}
            onChange={(event) => setPlan(event.target.value as InterimPlan)}
          />
          <Button
            size="sm"
            variant="secondary"
            pending={pending}
            disabled={plan === row.plan}
            onClick={() => void save()}
          >
            Save
          </Button>
        </div>
      </Td>
    </tr>
  );
}
