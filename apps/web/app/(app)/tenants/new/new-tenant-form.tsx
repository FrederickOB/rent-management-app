'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { CONTACT_KIND_LABELS, CONTACT_KINDS_FOR, TENANT_KIND_LABELS } from '@/lib/tenancy-format';
import {
  emptyContact,
  emptyTenantDraft,
  hasErrors,
  tenantCreateInput,
  tenantErrors,
  type TenantDraft,
} from '@/lib/tenant-form';
import { ConsentFields, ContactFields, TenantDetailsFields } from '../tenant-fields';

type Duplicate = Awaited<ReturnType<ReturnType<typeof api>['tenants']['duplicates']>>[number];

const MATCHED_ON: Record<Duplicate['matchedOn'], string> = {
  phone: 'the same phone number',
  id_number: 'the same ID number',
  tin: 'the same TIN',
};

/**
 * The new-tenant form (TL-01 to TL-04; decision 2). Before saving it checks for tenants with the
 * same phone, ID number or TIN: a warning with a link, never a block (plan 4.3).
 */
export function NewTenantForm() {
  const router = useRouter();
  const [draft, setDraft] = useState<TenantDraft>(() => emptyTenantDraft('individual'));
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<readonly Duplicate[] | null>(null);
  const errors = tried ? tenantErrors(draft) : {};
  const kinds = CONTACT_KINDS_FOR[draft.kind];

  const change = (next: TenantDraft) => {
    setDraft(next);
    setDuplicates(null);
  };

  async function save(confirmed: boolean) {
    setTried(true);
    setProblem(null);
    if (hasErrors(tenantErrors(draft))) return;
    setPending(true);
    try {
      const input = tenantCreateInput(draft);
      if (!confirmed && (input.phone || input.idNumber || input.tin)) {
        const found = await api().tenants.duplicates({
          phone: input.phone ?? null,
          idType: input.idType ?? null,
          idNumber: input.idNumber ?? null,
          idCountry: input.idCountry ?? null,
          tin: input.tin ?? null,
        });
        if (found.length > 0) {
          setDuplicates(found);
          setPending(false);
          return;
        }
      }
      const { tenant } = await api().tenants.create(input);
      router.push(`/tenants/${tenant.id}?created=1`);
    } catch (failure) {
      setProblem(toProblem(failure).message);
      setPending(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void save(false);
  }

  return (
    <form onSubmit={submit} noValidate aria-label="New tenant" className="space-y-6">
      {problem ? <Alert tone="error">{problem}</Alert> : null}
      <Card>
        <CardHeader title="Who rents" />
        <CardBody>
          <fieldset className="flex flex-wrap gap-4">
            <legend className="mb-2 text-sm font-medium text-slate-800">The tenant is</legend>
            {(['individual', 'company'] as const).map((kind) => (
              <label key={kind} className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="tenant-kind"
                  className="size-5"
                  checked={draft.kind === kind}
                  onChange={() =>
                    change({
                      ...emptyTenantDraft(kind),
                      displayName: draft.displayName,
                      phone: draft.phone,
                      email: draft.email,
                      consent: draft.consent,
                    })
                  }
                />
                {kind === 'individual'
                  ? 'A person'
                  : `A ${TENANT_KIND_LABELS.company.toLowerCase()}`}
              </label>
            ))}
          </fieldset>
          <TenantDetailsFields draft={draft} errors={errors} onChange={change} />
          <ConsentFields
            who="the tenant"
            consent={draft.consent}
            onChange={(consent) => change({ ...draft, consent })}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Contacts"
          description={
            draft.kind === 'company'
              ? 'Authorised signatories sign the lease; the finance contact gets invoices from M4.'
              : 'A guarantor signs the lease too. Next of kin and employer references are for your records.'
          }
        />
        <CardBody>
          {draft.contacts.length === 0 ? (
            <p className="text-sm text-slate-600">No contacts yet.</p>
          ) : null}
          <ol className="space-y-4">
            {draft.contacts.map((contact, index) => (
              <li
                key={contact.key}
                className="space-y-3 rounded-md border border-slate-200 p-3"
                aria-label={`Contact ${index + 1}`}
              >
                <ContactFields
                  contact={contact}
                  errors={errors.contacts?.[contact.key]}
                  kinds={kinds}
                  onChange={(next) =>
                    change({
                      ...draft,
                      contacts: draft.contacts.map((c) => (c.key === contact.key ? next : c)),
                    })
                  }
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    change({
                      ...draft,
                      contacts: draft.contacts.filter((c) => c.key !== contact.key),
                    })
                  }
                >
                  Remove this contact
                </Button>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-2">
            {kinds.map((kind) => (
              <Button
                key={kind}
                variant="secondary"
                size="sm"
                onClick={() =>
                  change({ ...draft, contacts: [...draft.contacts, emptyContact(kind)] })
                }
              >
                Add {CONTACT_KIND_LABELS[kind].toLowerCase()}
              </Button>
            ))}
          </div>
        </CardBody>
      </Card>

      {duplicates?.length ? (
        <Alert tone="warning" title="This may be a tenant you already have">
          <ul className="list-disc space-y-1 pl-5">
            {duplicates.map((d) => (
              <li key={`${d.tenantId}-${d.matchedOn}`}>
                <Link
                  href={`/tenants/${d.tenantId}`}
                  className="font-medium underline underline-offset-2"
                >
                  {d.displayName}
                </Link>{' '}
                has {MATCHED_ON[d.matchedOn]}.
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" pending={pending} onClick={() => void save(true)}>
              Add as a new tenant anyway
            </Button>
          </div>
        </Alert>
      ) : null}

      {tried && hasErrors(errors) ? (
        <Alert tone="error">Some details need attention. They are marked above.</Alert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={pending}>
          Add tenant
        </Button>
        <Link
          href="/tenants"
          className="inline-flex min-h-11 items-center px-3 text-sm font-medium underline underline-offset-2"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
