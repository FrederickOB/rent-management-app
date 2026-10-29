'use client';

import type { TenantDetailView } from '@rent/contracts';
import { useState } from 'react';
import { useApp } from '@/components/app-context';
import { ReasonForm } from '@/components/reason-form';
import { IdStatusBadge } from '@/components/tenancy-badges';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { ID_TYPE_LABELS } from '@/lib/tenancy-format';
import { REVEAL_REASON_MIN } from '@/lib/tenant-form';
import type { TenantPermissions } from './tenant-profile';

const CHECK_LABELS: Record<TenantDetailView['idChecks'][number]['status'], string> = {
  pending: 'In progress',
  verified: 'Verified',
  not_matched: 'Did not match',
  cancelled: 'Cancelled',
};

interface Shown {
  readonly label: string;
  readonly value: string;
}

/**
 * The ID number and its check (TL-02; plan 4.4), or a company's TIN (TL-04). Numbers are masked;
 * showing one needs a reason and is recorded in the audit log, never the number itself. A Ghana
 * Card is checked biometrically through the identity provider; no card image is ever asked for.
 */
export function IdentityCard({
  tenant,
  can,
  onChanged,
}: {
  readonly tenant: TenantDetailView;
  readonly can: TenantPermissions;
  readonly onChanged: (text: string) => Promise<void>;
}) {
  const { timeZone } = useApp();
  const [revealing, setRevealing] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const company = tenant.kind === 'company';
  const masked = company ? tenant.tinMasked : tenant.identity.masked;
  const type = tenant.identity.type;
  const status = tenant.identity.status;
  const ghanaCard = !company && type === 'ghana_card';
  const live = !tenant.archived;

  async function reveal(reason: string) {
    if (company) {
      const { tin } = await api().tenants.revealTin({ tenantId: tenant.id, reason });
      setShown({ label: 'TIN', value: tin });
    } else {
      const found = await api().tenants.revealIdNumber({ tenantId: tenant.id, reason });
      setShown({
        label: `${ID_TYPE_LABELS[found.idType]}${found.idType === 'passport' ? ` (${found.country})` : ''}`,
        value: found.idNumber,
      });
    }
    setRevealing(false);
  }

  async function check(kind: 'start' | 'refresh') {
    setBusy(true);
    setError(null);
    try {
      if (kind === 'start') await api().tenants.startIdCheck({ tenantId: tenant.id });
      else await api().tenants.refreshIdCheck({ tenantId: tenant.id });
      await onChanged(
        kind === 'start'
          ? 'Check started. The tenant gets a link by SMS to take a selfie with the identity provider, if they agreed to SMS.'
          : 'Asked the identity provider for the result again.',
      );
    } catch (failure) {
      setError(toProblem(failure).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-testid="identity">
      <CardHeader
        title={company ? 'Tax number' : 'Identity'}
        description={
          company
            ? 'The company’s TIN, stored encrypted and shown masked.'
            : 'The ID number is stored encrypted and shown masked. Never photograph or upload an ID card.'
        }
      />
      <CardBody>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-slate-600">
              {company ? 'TIN' : type ? `${ID_TYPE_LABELS[type]} number` : 'ID number'}
            </dt>
            <dd className="font-mono" data-testid="id-masked">
              {masked ?? <span className="font-sans text-slate-500">Not recorded</span>}
            </dd>
          </div>
          {!company ? (
            <div>
              <dt className="text-slate-600">Check</dt>
              <dd className="space-y-1">
                <IdStatusBadge status={status} />
                {tenant.identity.verifiedAt ? (
                  <p className="text-slate-700">
                    Verified {formatTime(tenant.identity.verifiedAt, timeZone)}
                  </p>
                ) : null}
                {type === 'passport' ? (
                  <p className="text-slate-600">A passport is recorded, not verified.</p>
                ) : null}
              </dd>
            </div>
          ) : null}
        </dl>

        {shown ? (
          <div
            data-testid="revealed-number"
            className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
          >
            <p>
              {shown.label}: <strong className="font-mono text-base">{shown.value}</strong>
            </p>
            <p>
              Who saw it, when and why is in the audit log; the number itself is not. Hide it when
              you are done.
            </p>
            <Button size="sm" variant="secondary" onClick={() => setShown(null)}>
              Hide the number
            </Button>
          </div>
        ) : null}

        {revealing ? (
          <ReasonForm
            label={company ? 'Show the TIN' : 'Show the ID number'}
            intro="Say why you need to see the full number. Who saw it, when and why is kept in the audit log."
            minLength={REVEAL_REASON_MIN}
            maxLength={300}
            submitText="Show the number"
            onSubmit={reveal}
            onCancel={() => setRevealing(false)}
          />
        ) : null}

        <div className="flex flex-wrap gap-2">
          {can.reveal && masked && !shown && !revealing ? (
            <Button variant="secondary" onClick={() => setRevealing(true)}>
              {company ? 'Show the TIN' : 'Show the ID number'}
            </Button>
          ) : null}
          {can.verify &&
          live &&
          ghanaCard &&
          (status === 'not_started' || status === 'not_matched') ? (
            <Button pending={busy} onClick={() => void check('start')}>
              {status === 'not_matched' ? 'Start a new check' : 'Start a biometric check'}
            </Button>
          ) : null}
          {can.verify && live && ghanaCard && status === 'pending' ? (
            <Button variant="secondary" pending={busy} onClick={() => void check('refresh')}>
              Check again
            </Button>
          ) : null}
        </div>

        {!company && tenant.idChecks.length ? (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-900">Checks</h3>
            <ul className="divide-y divide-slate-100 text-sm" aria-label="Identity checks">
              {tenant.idChecks.map((c) => (
                <li key={c.id} className="space-y-1 py-2">
                  <p className="font-medium">{CHECK_LABELS[c.status]}</p>
                  <p className="text-slate-700">
                    Started {formatTime(c.createdAt, timeZone)}
                    {c.lastPolledAt
                      ? ` · last asked ${formatTime(c.lastPolledAt, timeZone)} (${c.polls} ${c.polls === 1 ? 'time' : 'times'})`
                      : ''}
                    {c.completedAt ? ` · closed ${formatTime(c.completedAt, timeZone)}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
