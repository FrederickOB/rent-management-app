'use client';

import type { OwnerRow, PropertyDetailView } from '@rent/contracts';
import {
  DISPLAY_STATUS_LABELS,
  DISPLAY_STATUSES,
  PROPERTY_TYPE_LABELS,
} from '@rent/domain/portfolio';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ConfirmBox } from '@/components/confirm-box';
import { PageHeader } from '@/components/page-header';
import { STATUS_TONES } from '@/components/status-badge';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { PROPERTY_USE_LABELS } from '@/lib/register-format';
import { BlocksSection } from './blocks-section';
import { EditPropertyForm } from './edit-property-form';
import { FilesSection } from './files-section';
import { MetersSection } from './meters-section';
import { OwnershipCard } from './ownership-card';
import type { Notice, PropertyPermissions, RegisterOptions } from './types';

export interface PropertyDetailProps {
  readonly initial: PropertyDetailView;
  readonly can: PropertyPermissions;
  readonly options: RegisterOptions | null;
  readonly owners: readonly OwnerRow[];
  /** Arrived straight from the new-property wizard. */
  readonly created: boolean;
}

const unitCount = (p: PropertyDetailView) => p.blocks.reduce((n, b) => n + b.units.length, 0);

/**
 * One property (PR-01 to PR-05): status counts, address and map link, owner and its history,
 * blocks with their units, photos and papers, meters. It works on a 5-inch phone screen, for
 * owners abroad (PRD section 5).
 */
export function PropertyDetail({ initial, can, options, owners, created }: PropertyDetailProps) {
  const router = useRouter();
  const [property, setProperty] = useState(initial);
  const [notice, setNotice] = useState<Notice>(
    created
      ? {
          tone: 'success',
          text: `Created ${initial.code} with ${unitCount(initial)} ${unitCount(initial) === 1 ? 'unit' : 'units'}.`,
        }
      : null,
  );
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [busy, setBusy] = useState(false);

  // The "created" notice is for arriving from the wizard; a reload should not repeat it.
  useEffect(() => {
    if (created) window.history.replaceState(null, '', window.location.pathname);
  }, [created]);

  const reload = useCallback(async () => {
    try {
      setProperty(await api().register.getProperty({ propertyId: initial.id }));
    } catch (failure) {
      setNotice({ tone: 'error', text: toProblem(failure).message });
    }
  }, [initial.id]);

  const changed = useCallback((next: PropertyDetailView, message: string) => {
    setProperty(next);
    setNotice({ tone: 'success', text: message });
  }, []);

  async function archive() {
    setBusy(true);
    try {
      await api().register.archiveProperty({ propertyId: property.id });
      router.push('/portfolio?tab=properties');
    } catch (failure) {
      setNotice({ tone: 'error', text: toProblem(failure).message });
      setBusy(false);
    }
  }

  const live = !property.archived;
  const current = property.ownership.filter((o) => o.current);
  const { address } = property;

  return (
    <>
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link href="/portfolio?tab=properties" className="underline underline-offset-2">
          Portfolio
        </Link>{' '}
        <span aria-hidden="true">›</span> <span className="font-mono">{property.code}</span>
      </nav>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title={property.name}
          description={
            <>
              <span className="font-mono font-semibold text-slate-800">{property.code}</span> ·{' '}
              {PROPERTY_TYPE_LABELS[property.propertyType]} · {PROPERTY_USE_LABELS[property.use]}
              {property.archived ? (
                <>
                  {' '}
                  <Badge tone="dark">Archived</Badge>
                </>
              ) : null}
            </>
          }
        />
        {can.manage && live && !editing ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Edit details
            </Button>
            <Button
              variant="secondary"
              aria-expanded={archiving}
              onClick={() => setArchiving((a) => !a)}
            >
              Archive
            </Button>
          </div>
        ) : null}
      </div>

      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}

      {archiving ? (
        <ConfirmBox
          label={`Confirm archiving ${property.code}`}
          confirmText="Archive property"
          pending={busy}
          onConfirm={() => void archive()}
          onCancel={() => setArchiving(false)}
        >
          Archive {property.code} and its {unitCount(property)} units? They leave the lists, and
          their codes stay taken, so they are never reused.
        </ConfirmBox>
      ) : null}

      {editing && options ? (
        <EditPropertyForm
          property={property}
          options={options}
          onSaved={(next) => {
            setEditing(false);
            changed(next, 'Saved the property details.');
          }}
          onCancel={() => setEditing(false)}
        />
      ) : null}

      <Card>
        <CardHeader
          title="At a glance"
          description={`${unitCount(property)} ${unitCount(property) === 1 ? 'unit' : 'units'} in ${property.blocks.length} ${property.blocks.length === 1 ? 'block' : 'blocks'}, in the ${property.portfolio.name}.`}
        />
        <CardBody>
          <ul className="flex flex-wrap gap-2" aria-label="Units by status">
            {DISPLAY_STATUSES.map((status) => (
              <li key={status} className="inline-flex items-center gap-1.5 text-sm">
                <Badge tone={STATUS_TONES[status]}>{DISPLAY_STATUS_LABELS[status]}</Badge>
                <span className="font-semibold tabular-nums">{property.counts[status]}</span>
              </li>
            ))}
          </ul>
          <p className="text-sm">
            <span className="text-slate-600">Owner: </span>
            {current.length
              ? current.map((o) => `${o.displayName} (${o.reference})`).join(', ')
              : 'No owner recorded'}
          </p>
          <Link
            href={`/portfolio?property=${property.id}`}
            className="inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-2"
          >
            See these units in the portfolio
          </Link>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Address" />
        <CardBody>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Detail label="GhanaPost GPS" value={address.ghanapostGps} mono />
            <Detail label="Street or landmark" value={address.street} />
            <Detail label="Town or locality" value={address.town} />
            <Detail label="District" value={address.district} />
            <Detail label="MMDA" value={address.mmda} />
            <Detail label="Region" value={address.region} />
            <Detail
              label="Map pin"
              value={address.pin ? `${address.pin.latitude}, ${address.pin.longitude}` : null}
            />
            <Detail
              label="Entered"
              value={address.source === 'lookup' ? 'From a GhanaPost lookup' : 'Typed by hand'}
            />
          </dl>
          {address.mapsLink && /^https:\/\//.test(address.mapsLink) ? (
            <a
              href={address.mapsLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-2"
            >
              Open in maps<span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : (
            <p className="text-sm text-slate-600">No map pin yet.</p>
          )}
        </CardBody>
      </Card>

      <OwnershipCard
        property={property}
        owners={owners}
        canChange={can.changeOwner && live}
        onChanged={changed}
      />

      <BlocksSection
        property={property}
        canManage={can.manage && live}
        onChanged={(message) => {
          setNotice({ tone: 'success', text: message });
          return reload();
        }}
        onReplaced={changed}
      />

      {can.seePhotos || can.seePapers ? (
        <FilesSection
          propertyId={property.id}
          canUpload={can.upload && live}
          canSeePhotos={can.seePhotos}
          canSeePapers={can.seePapers}
        />
      ) : null}

      <MetersSection
        property={property}
        canManage={can.manage && live}
        suppliers={options?.meterSuppliers ?? null}
        onChanged={(message) => {
          setNotice({ tone: 'success', text: message });
          return reload();
        }}
      />
    </>
  );
}

function Detail({
  label,
  value,
  mono = false,
}: {
  readonly label: string;
  readonly value: string | null;
  readonly mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-slate-600">{label}</dt>
      <dd className={mono && value ? 'font-mono break-words' : 'break-words'}>
        {value ?? <span className="text-slate-500">Not recorded</span>}
      </dd>
    </div>
  );
}
