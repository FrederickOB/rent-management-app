'use client';

import type { LeaseDetailView, TemplateRowView } from '@rent/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { LeasePartiesEditor } from '@/components/lease-parties-editor';
import { LeaseTermsFields } from '@/components/lease-terms-fields';
import { TenantPicker, UnitPicker } from '@/components/record-pickers';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { CheckboxField, SelectField, TextAreaField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { todayIn } from '@/lib/business-dates';
import type { PickedTenant, PickedUnit } from '@/lib/record-picks';
import { toProblem } from '@/lib/errors';
import {
  emptyTerms,
  partiesInput,
  partyDraftsOf,
  partyErrors,
  serviceContacts,
  signsAs,
  termsDraftOf,
  termsFromDraft,
  type PartyDraft,
  type TermsDraft,
} from '@/lib/lease-form';
import { ProjectedSchedule } from './projected-schedule';

export const COUNSEL_WARNING =
  'This template version has not been reviewed by your lawyer. Its legal clauses may still read “Wording to be supplied by your lawyer.” (OQ-53)';

/** The template a lease would use: the one chosen, or the starter for its use. */
function templateFor(
  templates: readonly TemplateRowView[],
  templateId: string,
  use: 'residential' | 'commercial',
): TemplateRowView | undefined {
  if (templateId) return templates.find((t) => t.id === templateId);
  return templates.find((t) => t.starterKind === use);
}

/**
 * The lease builder (TL-05, TL-06; plan 4.16): unit, tenant, template and terms, saved as a draft.
 * Editing a draft adds the signers and the electronic-service contacts. Issuing it for signing is
 * the e-signing step, which comes later.
 */
export function LeaseBuilder({
  lease,
  initialUnit = null,
  initialTenant = null,
  templates,
}: {
  /** The draft being edited; absent for a new lease. */
  readonly lease?: LeaseDetailView;
  readonly initialUnit?: PickedUnit | null;
  readonly initialTenant?: PickedTenant | null;
  readonly templates: readonly TemplateRowView[];
}) {
  const router = useRouter();
  const { timeZone } = useApp();
  const editing = lease !== undefined;
  const [unit, setUnit] = useState<PickedUnit | null>(initialUnit);
  const [tenant, setTenant] = useState<PickedTenant | null>(initialTenant);
  const [templateId, setTemplateId] = useState(lease?.template?.templateId ?? '');
  const [terms, setTerms] = useState<TermsDraft>(() =>
    lease ? termsDraftOf(lease) : emptyTerms(todayIn(timeZone)),
  );
  const [parties, setParties] = useState<PartyDraft[]>(() => (lease ? partyDraftsOf(lease) : []));
  const [phones, setPhones] = useState(lease?.servicePhones.join('\n') ?? '');
  const [emails, setEmails] = useState(lease?.serviceEmails.join('\n') ?? '');
  const [witnessRequired, setWitnessRequired] = useState(lease?.witnessRequired ?? true);
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const unitUse = unit?.commercial ? 'commercial' : 'residential';
  const fallbackUse = editing ? lease.use : unitUse;
  const checked = useMemo(() => termsFromDraft(terms, fallbackUse), [terms, fallbackUse]);
  const errors = tried ? checked.errors : {};
  const pErrors = tried && editing ? partyErrors(parties) : {};
  const service = serviceContacts(phones, emails);
  const use = terms.use || fallbackUse;
  const template = templateFor(templates, templateId, use);
  // A draft keeps its template version, so its own warning applies until the template changes.
  const keepsVersion = editing && templateId === (lease.template?.templateId ?? '');
  const unreviewed = keepsVersion
    ? lease.counselReviewWarning
    : template
      ? template.latest.counselReview === null
      : true;
  const live = templates.filter((t) => !t.archived);
  const noWitness = witnessRequired && editing && !signsAs(parties, 'witness');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setProblem(null);
    if (!checked.input) return;
    if (!editing && (!unit || !tenant)) return;
    if (editing && (Object.keys(partyErrors(parties)).length || service.problem)) return;
    setPending(true);
    try {
      if (editing) {
        await api().leases.update({
          leaseId: lease.id,
          ...checked.input,
          // Only a different template is sent: the draft keeps the version it was built from.
          ...(templateId && templateId !== lease.template?.templateId ? { templateId } : {}),
          parties: partiesInput(parties),
          servicePhones: service.phones,
          serviceEmails: service.emails,
          witnessRequired,
        });
        router.push(`/leases/${lease.id}?saved=1`);
      } else {
        const created = await api().leases.create({
          unitId: unit!.id,
          tenantId: tenant!.id,
          ...checked.input,
          templateId: templateId || null,
        });
        router.push(`/leases/${created.id}?saved=draft`);
      }
    } catch (failure) {
      setProblem(toProblem(failure).message);
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={editing ? 'Edit the draft' : 'New lease'}
      className="space-y-6"
    >
      {problem ? <Alert tone="error">{problem}</Alert> : null}
      {editing ? null : (
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
              onChange={setTenant}
              error={tried && !tenant ? 'Choose the tenant' : null}
            />
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Template"
          description="The clauses the lease document is built from. The lease keeps the version it was built from."
        />
        <CardBody>
          <SelectField
            label="Template"
            value={templateId}
            options={[
              ...(editing && lease.template
                ? []
                : [{ value: '', label: `The starter for a ${use} lease` }]),
              ...live.map((t) => ({
                value: t.id,
                label:
                  editing && t.id === lease.template?.templateId
                    ? `${t.name} (this draft keeps version ${lease.template.version})`
                    : `${t.name} (version ${t.latest.version}${t.latest.counselReview ? ', reviewed by counsel' : ''})`,
              })),
            ]}
            onChange={(event) => setTemplateId(event.target.value)}
          />
          {unreviewed ? (
            <Alert tone="warning" title="Not reviewed by a lawyer">
              {COUNSEL_WARNING}
            </Alert>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Terms"
          description="Rent periods are monthly from the first day; invoices bundle them by the billing cycle."
        />
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

      {editing ? (
        <>
          <Card>
            <CardHeader
              title="Who signs"
              description="Everyone marked as having to sign must sign before the lease takes effect."
            />
            <CardBody>
              <CheckboxField
                label="A witness signs this lease"
                hint="Your company signs every lease with a witness unless you turn this off."
                checked={witnessRequired}
                onChange={(event) => setWitnessRequired(event.target.checked)}
              />
              {noWitness ? (
                <Alert tone="info">Add the witness below before the lease is issued.</Alert>
              ) : null}
              <LeasePartiesEditor parties={parties} errors={pErrors} onChange={setParties} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader
              title="Electronic service"
              description="The phone numbers and emails the tenant agrees that notices can be served at. They fill in the electronic-service clause."
            />
            <CardBody className="grid gap-4 sm:grid-cols-2 sm:space-y-0">
              <TextAreaField
                label="Phones"
                hint="One per line, up to five."
                rows={3}
                value={phones}
                onChange={(event) => setPhones(event.target.value)}
                className="[&_textarea]:font-sans"
              />
              <TextAreaField
                label="Emails"
                hint="One per line, up to five."
                rows={3}
                value={emails}
                onChange={(event) => setEmails(event.target.value)}
                className="[&_textarea]:font-sans"
              />
              {tried && service.problem ? (
                <p className="text-sm font-medium text-red-700 sm:col-span-2">{service.problem}</p>
              ) : null}
            </CardBody>
          </Card>
        </>
      ) : null}

      {tried && (!checked.input || Object.keys(pErrors).length) ? (
        <Alert tone="error">Some details need attention. They are marked above.</Alert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={pending}>
          {editing ? 'Save the draft' : 'Save as a draft'}
        </Button>
        <Link
          href={editing ? `/leases/${lease.id}` : '/leases'}
          className="inline-flex min-h-11 items-center px-3 text-sm font-medium underline underline-offset-2"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
