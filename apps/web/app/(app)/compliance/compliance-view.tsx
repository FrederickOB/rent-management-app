'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Empty, LoadFailed, Loading } from '@/components/load-state';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody } from '@/components/ui/card';
import { SelectField } from '@/components/ui/field';
import { api } from '@/lib/api';
import {
  COMPLIANCE_KIND_LABELS,
  COMPLIANCE_LINK_TEXT,
  complianceHref,
  complianceKeys,
  dueText,
  sortCompliance,
} from '@/lib/compliance';
import { formatMinor } from '@/lib/tenancy-format';
import { useLoad } from '@/lib/use-load';

export function ComplianceView() {
  const [ownerId, setOwnerId] = useState('');
  const [propertyId, setPropertyId] = useState('');
  const [owners, setOwners] = useState<readonly { id: string; name: string }[]>([]);
  const [properties, setProperties] = useState<readonly { id: string; name: string }[]>([]);
  const load = useCallback(
    () =>
      api().compliance.list({
        ...(ownerId ? { ownerId } : {}),
        ...(propertyId ? { propertyId } : {}),
      }),
    [ownerId, propertyId],
  );
  const { state, reload } = useLoad(load);
  const sorted = state.status === 'ready' ? sortCompliance(state.data) : [];
  const keys = complianceKeys(sorted);

  useEffect(() => {
    let current = true;
    void Promise.all([
      api()
        .owners.list({})
        .catch(() => []),
      api()
        .register.listProperties({})
        .then((r) => r.rows)
        .catch(() => []),
    ]).then(([o, p]) => {
      if (!current) return;
      setOwners(o.filter((x) => !x.archived).map((x) => ({ id: x.id, name: x.displayName })));
      setProperties(p.map((x) => ({ id: x.id, name: `${x.code} · ${x.name}` })));
    });
    return () => {
      current = false;
    };
  }, []);

  return (
    <Card>
      <CardBody>
        <div className="grid gap-4 sm:grid-cols-2">
          {owners.length > 1 ? (
            <SelectField
              label="Owner"
              value={ownerId}
              options={[
                { value: '', label: 'Every owner' },
                ...owners.map((o) => ({ value: o.id, label: o.name })),
              ]}
              onChange={(event) => setOwnerId(event.target.value)}
            />
          ) : null}
          <SelectField
            label="Property"
            value={propertyId}
            options={[
              { value: '', label: 'Every property' },
              ...properties.map((p) => ({ value: p.id, label: p.name })),
            ]}
            onChange={(event) => setPropertyId(event.target.value)}
          />
        </div>
        {state.status === 'loading' ? <Loading what="the compliance list" /> : null}
        {state.status === 'error' ? (
          <LoadFailed message={state.problem.message} onRetry={reload} />
        ) : null}
        {state.status === 'ready' && state.data.length === 0 ? (
          <Empty>Nothing needs doing.</Empty>
        ) : null}
        {state.status === 'ready' && state.data.length > 0 ? (
          <ul className="divide-y divide-slate-100 text-sm">
            {sorted.map((item, index) => {
              const href = complianceHref(item);
              const due = dueText(item);
              return (
                <li
                  key={item.id || keys[index]}
                  className="space-y-1 py-3"
                  data-testid="compliance-item"
                  data-kind={item.kind}
                >
                  <p className="flex flex-wrap items-center gap-2">
                    <Badge tone={item.kind === 'rent_tax_overdue' ? 'red' : 'amber'}>
                      {COMPLIANCE_KIND_LABELS[item.kind]}
                    </Badge>
                    {due ? <span className="text-slate-700">{due}</span> : null}
                    {item.amountMinor !== null ? (
                      <span className="font-semibold tabular-nums">
                        {formatMinor(item.amountMinor)}
                      </span>
                    ) : null}
                  </p>
                  <p className="text-slate-900">{item.description}</p>
                  <p className="text-slate-600">
                    {[item.owner?.name, item.property?.name, item.lease?.unitCode]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  {href ? (
                    <Link
                      href={href}
                      className="inline-flex min-h-9 items-center font-medium underline underline-offset-2"
                    >
                      {COMPLIANCE_LINK_TEXT[item.link.screen]}
                    </Link>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </CardBody>
    </Card>
  );
}
