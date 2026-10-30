'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { LeasePaperField } from '@/components/lease-paper-field';
import { LeasePartiesEditor } from '@/components/lease-parties-editor';
import { LeaseTermsFields } from '@/components/lease-terms-fields';
import { TenantPicker, UnitPicker } from '@/components/record-pickers';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { SelectField, TextField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { billingStartChoices, billingStartNote } from '@/lib/billing-start';
import { todayIn } from '@/lib/business-dates';
import { toProblem } from '@/lib/errors';
import {
  emptyParty,
  emptyTerms,
  partiesInput,
  partyProblems,
  termsFromDraft,
  type PartyDraft,
  type TermsDraft,
} from '@/lib/lease-form';
import { leasePaperProblems, uploadLeasePaper } from '@/lib/lease-upload';
import type { PickedTenant, PickedUnit } from '@/lib/record-picks';
import { StorageUploadError } from '@/lib/upload';
import { ProjectedSchedule } from '../projected-schedule';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The tenant's own signer row: the person, or a company's signatory to be named. */
function tenantParty(tenant: PickedTenant | null): PartyDraft {
  return tenant?.kind === 'company'
    ? emptyParty('signatory')
    : { ...emptyParty('tenant', tenant?.displayName ?? ''), phone: tenant?.phone ?? '' };
}

/**
 * The paper-lease form (decision 7): unit, tenant, terms, who signed and when, and the scan. The
 * scan goes straight to storage; the API stores it write-once and marks the lease signed on paper.
 */
export function PaperLeaseForm({
  initialUnit,
  initialTenant,
}: {
  readonly initialUnit: PickedUnit | null;
  readonly initialTenant: PickedTenant | null;
}) {
  const router = useRouter();
  const { timeZone } = useApp();
  const today = todayIn(timeZone);
  const scan = useRef<HTMLInputElement>(null);
  const [unit, setUnit] = useState<PickedUnit | null>(initialUnit);
  const [tenant, setTenant] = useState<PickedTenant | null>(initialTenant);
  const [terms, setTerms] = useState<TermsDraft>(() => emptyTerms(''));
  const [signedOn, setSignedOn] = useState(today);
  const [parties, setParties] = useState<PartyDraft[]>(() => [tenantParty(initialTenant)]);
  const [partiesTouched, setPartiesTouched] = useState(false);
  const [tried, setTried] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [noIdCopy, setNoIdCopy] = useState(false);
  const [tickError, setTickError] = useState<string | null>(null);
  /** The first rent period to bill (M4a decision 1); blank for the default. */
  const [billingStart, setBillingStart] = useState('');

  const fallbackUse = unit?.commercial ? 'commercial' : 'residential';
  const checked = useMemo(() => termsFromDraft(terms, fallbackUse), [terms, fallbackUse]);
  const billing = useMemo(
    () => (checked.terms ? billingStartChoices(checked.terms, today) : null),
    [checked.terms, today],
  );
  // A choice the terms no longer offer (the start date changed) falls back to the default.
  const chosenStart =
    billing && billing.choices.some((c) => c.value === billingStart)
      ? billingStart
      : (billing?.defaultStart ?? '');
  const startNote =
    billing && checked.terms
      ? billingStartNote({
          chosen: chosenStart,
          defaultStart: billing.defaultStart,
          leaseStart: checked.terms.startDate,
          hasDeposit: Boolean(checked.input?.depositMinor),
        })
      : null;
  const errors = tried ? checked.errors : {};
  const pProblems = tried ? partyProblems(parties, { paper: true, today }) : {};
  const signedProblem = !ISO_DATE.test(signedOn)
    ? 'Choose the date the lease was signed'
    : signedOn > today
      ? 'The signing date cannot be in the future'
      : null;

  function pickTenant(next: PickedTenant | null) {
    setTenant(next);
    // The first signer follows the tenant until someone edits the signers by hand.
    if (!partiesTouched) setParties([tenantParty(next)]);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setProblem(null);
    const file = scan.current?.files?.[0];
    const paper = leasePaperProblems(file, { noIdCopy, missing: 'Upload the signed lease.' });
    setScanError(paper.file);
    setTickError(paper.tick);
    if (
      !unit ||
      !tenant ||
      !checked.input ||
      signedProblem ||
      parties.length === 0 ||
      Object.keys(partyProblems(parties, { paper: true, today })).length ||
      paper.file ||
      paper.tick ||
      !file
    )
      return;
    try {
      setStatus('Uploading the signed copy…');
      const scanUploadId = await uploadLeasePaper(file, null);
      setStatus('Recording the lease…');
      const lease = await api().leases.recordPaper({
        unitId: unit.id,
        tenantId: tenant.id,
        ...checked.input,
        parties: partiesInput(parties, { paper: true }),
        scanUploadId,
        signedOn,
        // Always the start the form shows (decision 1), so the lease bills from what staff saw,
        // whatever day the API records it.
        ...(chosenStart ? { billingStartDate: chosenStart } : {}),
      });
      router.push(`/leases/${lease.id}?saved=paper`);
    } catch (failure) {
      setStatus(null);
      setProblem(
        failure instanceof StorageUploadError ? failure.message : toProblem(failure).message,
      );
    }
  }

  const working = status !== null;
  return (
    <form onSubmit={submit} noValidate aria-label="Record a paper lease" className="space-y-6">
      {problem ? <Alert tone="error">{problem}</Alert> : null}
      <Card>
        <CardHeader
          title="Unit and tenant"
          description={
            <>
              The tenant must be on record first.{' '}
              <Link href="/tenants/new" className="font-medium underline underline-offset-2">
                Add a new tenant
              </Link>
              .
            </>
          }
        />
        <CardBody className="grid gap-6 md:grid-cols-2 md:space-y-0">
          <UnitPicker
            value={unit}
            onChange={setUnit}
            error={tried && !unit ? 'Choose the unit' : null}
          />
          <TenantPicker
            value={tenant}
            onChange={pickTenant}
            error={tried && !tenant ? 'Choose the tenant' : null}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Terms" description="As written in the signed lease." />
        <CardBody>
          <LeaseTermsFields
            draft={terms}
            errors={errors}
            onChange={setTerms}
            useHint={fallbackUse}
          />
          <ProjectedSchedule terms={checked.terms} />
        </CardBody>
      </Card>

      {billing ? (
        <Card data-testid="billing-start">
          <CardHeader
            title="Billing"
            description="The tenancy may have started before you used the platform. Only rent from the billing start is invoiced here; anything earlier comes in with opening balances."
          />
          <CardBody>
            <SelectField
              label="Billing starts"
              hint="The first rent period to invoice. Choose an earlier one to bring recent arrears in, or a later one for months the tenant paid before."
              value={chosenStart}
              options={billing.choices}
              onChange={(event) => setBillingStart(event.target.value)}
              className="max-w-xl"
            />
            {startNote ? <Alert tone="info">{startNote}</Alert> : null}
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Signed on paper"
          description="Who signed, and when. The lease is labelled “signed on paper”; no electronic signature is claimed for it."
        />
        <CardBody>
          <TextField
            label="Date the lease was signed"
            type="date"
            max={today}
            value={signedOn}
            error={tried ? signedProblem : null}
            onChange={(event) => setSignedOn(event.target.value)}
            className="max-w-xs"
          />
          <LeasePartiesEditor
            paper
            parties={parties}
            problems={pProblems}
            onChange={(next) => {
              setPartiesTouched(true);
              setParties(next);
            }}
          />
          {tried && parties.length === 0 ? (
            <p className="text-sm font-medium text-red-700">Say who signed the lease.</p>
          ) : null}
          <LeasePaperField
            ref={scan}
            label="The signed lease (scan or photo)"
            disabled={working}
            error={scanError}
            required
            noIdCopy={noIdCopy}
            onNoIdCopy={(next) => {
              setNoIdCopy(next);
              setTickError(null);
            }}
            tickError={tickError}
          />
        </CardBody>
      </Card>

      {status ? <Alert tone="info">{status}</Alert> : null}
      {/* The refusal again by the button, so it is seen on a phone without scrolling back up. */}
      {problem ? (
        <Alert tone="error" live={false}>
          {problem}
        </Alert>
      ) : null}
      {tried && !working && !problem ? (
        <p className="text-sm text-slate-600">Check the fields marked above.</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={working}>
          Record the lease
        </Button>
        <Link
          href="/leases"
          className="inline-flex min-h-11 items-center px-3 text-sm font-medium underline underline-offset-2"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
