'use client';

import type { LeaseDetailView } from '@rent/contracts';
import type { ApiClient } from '@rent/contracts/client';
import Link from 'next/link';
import { useCallback, useState } from 'react';
import { AdvanceFlagAlert } from '@/components/advance-flag';
import { useApp } from '@/components/app-context';
import { PageHeader } from '@/components/page-header';
import { LeaseStatusBadge, PaperBadge } from '@/components/tenancy-badges';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { formatBusinessDate } from '@/lib/business-dates';
import { formatDate, formatTime } from '@/lib/format';
import { COUNSEL_WARNING, wasSigned } from '@/lib/lease-view';
import {
  BREAK_PARTY_LABELS,
  cycleLabel,
  endedLabel,
  formatMinor,
  signerRoleLabel,
  termLabel,
} from '@/lib/tenancy-format';
import { LeaseActions } from './lease-actions';
import { LeaseDocuments, LeasePreview, LeaseSchedule } from './lease-panels';
import { SigningPanel } from './lease-signing';
import { LeaseTrackers } from './lease-trackers';

type LimitedLease = Extract<Awaited<ReturnType<ApiClient['leases']['get']>>, { access: 'limited' }>;

export interface LeasePermissions {
  readonly manage: boolean;
  readonly cancelSigned: boolean;
  readonly seeApprovals: boolean;
  readonly seeTenant: boolean;
}

const SAVED_NOTES: Record<string, string> = {
  draft:
    'Saved the draft. Add who signs and check the document below; the draft can be changed until it is issued.',
  '1': 'Saved the draft.',
  renewal:
    'This is the renewal: a draft that starts the day after the current lease ends, at the last rent. Set the new terms, then it is issued for the tenant to sign.',
  paper: 'Recorded the lease signed on paper.',
};

function Breadcrumb({ code }: { readonly code: string }) {
  return (
    <nav aria-label="Breadcrumb" className="text-sm">
      <Link href="/leases" className="underline underline-offset-2">
        Leases
      </Link>{' '}
      <span aria-hidden="true">›</span> <span className="font-mono">{code}</span>
    </nav>
  );
}

/** What a caretaker sees (plan 4.14): the unit and the dates. */
export function LeaseLimited({ lease }: { readonly lease: LimitedLease }) {
  return (
    <>
      <Breadcrumb code={lease.unit.code} />
      <PageHeader title={`Lease for ${lease.unit.code}`} />
      <Card data-testid="lease-limited">
        <CardBody>
          <LeaseStatusBadge status={lease.status} />
          <p className="text-sm">{termLabel(lease.startDate, lease.endDate)}</p>
          <p className="text-sm text-slate-600">
            You see a lease&rsquo;s unit and dates. Ask a manager for its terms.
          </p>
        </CardBody>
      </Card>
    </>
  );
}

function Fact({ label, value }: { readonly label: string; readonly value: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-slate-600">{label}</dt>
      <dd className="break-words">{value ?? <span className="text-slate-500">None</span>}</dd>
    </div>
  );
}

export function LeaseDetail({
  initial,
  saved,
  can,
}: {
  readonly initial: LeaseDetailView;
  readonly saved: string | null;
  readonly can: LeasePermissions;
}) {
  const { timeZone } = useApp();
  const [lease, setLease] = useState(initial);
  const [notice, setNotice] = useState<string | null>(saved ? (SAVED_NOTES[saved] ?? null) : null);
  const t = lease.terms;
  // Signed on paper or electronically, even if cancelled since: its trackers and schedule exist.
  const signed = wasSigned(lease);
  const draft = lease.status === 'draft';
  const life = lease.lifecycle;

  const changed = useCallback((next: LeaseDetailView, text: string) => {
    setLease(next);
    setNotice(text);
  }, []);

  return (
    <>
      <Breadcrumb code={lease.unit.code} />
      <div className="space-y-2">
        <PageHeader
          title={`Lease for ${lease.unit.code}`}
          description={`${lease.unit.propertyName} · ${lease.tenant.displayName}`}
        />
        <div className="flex flex-wrap items-center gap-2">
          <LeaseStatusBadge status={lease.status} />
          {lease.signing.signedOnPaper ? <PaperBadge /> : null}
          <Badge>{lease.use === 'commercial' ? 'Commercial' : 'Residential'}</Badge>
        </div>
      </div>

      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {lease.advanceFlag ? <AdvanceFlagAlert flag={lease.advanceFlag} /> : null}
      {/* A draft shows the warning once, with its document preview below. */}
      {lease.counselReviewWarning && !draft ? (
        <Alert tone="warning" title="Not reviewed by a lawyer">
          {COUNSEL_WARNING}
        </Alert>
      ) : null}

      <LeaseActions lease={lease} can={can} onChanged={changed} />

      <Card data-testid="lease-terms">
        <CardHeader title="Terms" />
        <CardBody>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Fact
              label="Term"
              value={`${termLabel(t.startDate, t.endDate)} (${t.periodCount} periods)`}
            />
            <Fact label="Tenant" value={lease.tenant.displayName} />
            <Fact label="Monthly rent" value={formatMinor(t.monthlyRentMinor)} />
            <Fact label="Billing cycle" value={cycleLabel(t.cycle)} />
            <Fact
              label="Initial advance"
              value={t.initialAdvanceMonths ? `${t.initialAdvanceMonths} months` : null}
            />
            <Fact
              label="Security deposit"
              value={t.depositMinor ? formatMinor(t.depositMinor) : null}
            />
            <Fact
              label="Service charge a month"
              value={t.serviceChargeMonthlyMinor ? formatMinor(t.serviceChargeMonthlyMinor) : null}
            />
            <Fact label="Notice period" value={`${t.noticeDays} days`} />
            <Fact
              label="Rent changes"
              value={
                t.steps.length
                  ? t.steps
                      .map(
                        (s) =>
                          `${formatMinor(s.monthlyRentMinor)} from ${formatBusinessDate(s.effectiveFrom)}`,
                      )
                      .join('; ')
                  : null
              }
            />
            <Fact
              label="Break clause"
              value={
                t.breakClause
                  ? `${BREAK_PARTY_LABELS[t.breakClause.party]} may break from ${formatBusinessDate(t.breakClause.fromDate)}, with ${t.breakClause.noticeDays} days’ notice${t.breakClause.creditUnusedDays ? '; unused days are credited' : ''}`
                  : null
              }
            />
            <Fact
              label="Template"
              value={
                lease.template
                  ? `${lease.template.name}, version ${lease.template.version}${lease.template.counselReviewed ? ' (reviewed by counsel)' : ''}`
                  : lease.signing.signedOnPaper
                    ? 'None: signed on paper'
                    : null
              }
            />
            <Fact
              label="Electronic service"
              value={[...lease.servicePhones, ...lease.serviceEmails].join(', ') || null}
            />
          </dl>
          {can.seeTenant ? (
            <Link
              href={`/tenants/${lease.tenant.id}`}
              className="inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-2"
            >
              Open {lease.tenant.displayName}
            </Link>
          ) : null}
        </CardBody>
      </Card>

      <LeaseSchedule lease={lease} signed={signed} />

      <Card data-testid="lease-parties">
        <CardHeader
          title="Who signs"
          description={
            lease.witnessRequired ? 'A witness signs this lease.' : 'No witness is needed.'
          }
        />
        <CardBody>
          {lease.parties.length === 0 ? (
            <p className="text-sm text-slate-600">Nobody yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {lease.parties.map((p) => (
                <li key={p.id} data-testid="party" className="space-y-1 py-2">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{p.name}</span>
                    <Badge>{signerRoleLabel(p.role)}</Badge>
                    {!p.required ? <Badge>Optional</Badge> : null}
                  </p>
                  <p className="text-slate-700">
                    {[p.phone, p.email].filter(Boolean).join(' · ') || 'No phone or email'}
                    {p.paperSignedOn
                      ? ` · signed on paper ${formatBusinessDate(p.paperSignedOn)}`
                      : ''}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {/* Leases built from a template can go out for e-signing; paper leases never do. */}
      {lease.template ? (
        <SigningPanel lease={lease} canManage={can.manage} onChanged={changed} />
      ) : null}
      {draft ? (
        <LeasePreview leaseId={lease.id} counselWarning={lease.counselReviewWarning} />
      ) : null}
      {signed ? <LeaseDocuments lease={lease} /> : null}
      {signed ? <LeaseTrackers lease={lease} canManage={can.manage} onChanged={changed} /> : null}

      <Card data-testid="lease-history">
        <CardHeader title="Lifecycle" />
        <CardBody>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Fact label="Drafted" value={formatTime(lease.createdAt, timeZone)} />
            <Fact
              label="Signed"
              value={
                lease.signing.signedAt
                  ? lease.signing.signedOnPaper
                    ? `${formatDate(lease.signing.signedAt, timeZone)}, on paper`
                    : formatTime(lease.signing.signedAt, timeZone)
                  : null
              }
            />
            {life.activatedOn ? (
              <Fact label="Started" value={formatBusinessDate(life.activatedOn)} />
            ) : null}
            {life.holdingOverSince ? (
              <Fact label="Holding over since" value={formatBusinessDate(life.holdingOverSince)} />
            ) : null}
            {life.endingReason ? (
              <Fact
                label="Ending"
                value={`${life.endingReason === 'notice' ? 'Notice given' : 'Not renewing'}${life.endingNote ? `: ${life.endingNote}` : ''}`}
              />
            ) : null}
            {life.moveOutDate ? (
              <Fact label="Moved out" value={formatBusinessDate(life.moveOutDate)} />
            ) : null}
            {life.endedOn ? (
              <Fact label="Ended" value={endedLabel(life.endedOn, life.endReason)} />
            ) : null}
            {life.cancelledAt ? (
              <Fact
                label="Cancelled"
                value={`${formatTime(life.cancelledAt, timeZone)}${life.cancelReason ? `: ${life.cancelReason}` : ''}`}
              />
            ) : null}
          </dl>
          {lease.renewsLeaseId ? (
            <Link
              href={`/leases/${lease.renewsLeaseId}`}
              className="inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-2"
            >
              The lease this one renews
            </Link>
          ) : null}
          {lease.renewal ? (
            <p className="text-sm">
              <Link
                href={`/leases/${lease.renewal.id}`}
                className="font-medium underline underline-offset-2"
              >
                Its renewal
              </Link>{' '}
              starts {formatBusinessDate(lease.renewal.startDate)}:{' '}
              <LeaseStatusBadge status={lease.renewal.status} />
            </p>
          ) : null}
        </CardBody>
      </Card>
    </>
  );
}
