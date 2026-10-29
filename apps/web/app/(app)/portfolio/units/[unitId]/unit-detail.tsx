'use client';

import type { UnitDetailView } from '@rent/contracts';
import {
  AMENITIES,
  AMENITY_LABELS,
  AVAILABILITY_LABELS,
  BAND_REASON_MIN_LENGTH,
  BILLING_BAND_LABELS,
  defaultBandFor,
  METER_TYPE_LABELS,
  UNIT_TYPE_LABELS,
  UNIT_TYPES,
  type Amenity,
  type Availability,
  type BillingBand,
  type UnitType,
} from '@rent/domain/portfolio';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { UnitLeases } from './unit-leases';
import { useApp } from '@/components/app-context';
import { ConfirmBox } from '@/components/confirm-box';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { CheckboxField, SelectField, TextAreaField, TextField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { changedFields } from '@/lib/patch';
import {
  bedroomsRule,
  statusSourceLabel,
  statusValueLabel,
  unitTypeLabel,
  UTILITY_LABELS,
} from '@/lib/register-format';
import {
  availabilityChoices,
  availabilityHint,
  bandChoices,
  bandOverrideProblem,
  reasonProblem,
} from '@/lib/unit-status';

type Notice = { readonly tone: 'success' | 'error'; readonly text: string } | null;

export interface UnitPermissions {
  readonly manage: boolean;
  readonly overrideBand: boolean;
  /** lease.view and lease.manage (M3): the unit's leases, and drafting one. */
  readonly seeLeases?: boolean;
  readonly draftLease?: boolean;
}

/**
 * One unit (PR-02, PR-05, PR-06, PR-09, PB-01): what it is, whether it can be let, its billing
 * band and every status change with who made it, when and why.
 */
export function UnitDetail({
  initial,
  can,
}: {
  readonly initial: UnitDetailView;
  readonly can: UnitPermissions;
}) {
  const router = useRouter();
  const [unit, setUnit] = useState(initial);
  const [notice, setNotice] = useState<Notice>(null);
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [busy, setBusy] = useState(false);
  const live = !unit.archived;

  const saved = (next: UnitDetailView, text: string) => {
    setUnit(next);
    setNotice({ tone: 'success', text });
  };

  async function archive() {
    setBusy(true);
    try {
      await api().register.archiveUnit({ unitId: unit.id });
      router.push(`/portfolio/properties/${unit.propertyId}`);
    } catch (failure) {
      setNotice({ tone: 'error', text: toProblem(failure).message });
      setBusy(false);
    }
  }

  return (
    <>
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link href="/portfolio" className="underline underline-offset-2">
          Portfolio
        </Link>{' '}
        <span aria-hidden="true">›</span>{' '}
        <Link
          href={`/portfolio/properties/${unit.propertyId}`}
          className="font-mono underline underline-offset-2"
        >
          {unit.propertyCode}
        </Link>{' '}
        <span aria-hidden="true">›</span> <span className="font-mono">{unit.code}</span>
      </nav>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <PageHeader
            title={unit.code}
            description={`${unit.propertyName}, block ${unit.blockCode} · ${unitTypeLabel(unit.unitType, unit.bedrooms)}`}
          />
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={unit.status} underRepair={unit.underRepair} />
            {unit.archived ? <Badge tone="dark">Archived</Badge> : null}
          </div>
        </div>
        {can.manage && live && !editing ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Edit unit
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
          label={`Confirm archiving ${unit.code}`}
          confirmText="Archive unit"
          pending={busy}
          onConfirm={() => void archive()}
          onCancel={() => setArchiving(false)}
        >
          Archive {unit.code}? It leaves the lists; its code stays taken and is never reused.
        </ConfirmBox>
      ) : null}

      {editing ? (
        <EditUnitForm
          unit={unit}
          onSaved={(next) => {
            setEditing(false);
            saved(next, `Saved ${next.code}.`);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <Card data-testid="unit-details">
          <CardHeader title="Details" />
          <CardBody>
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <Item label="Type" value={UNIT_TYPE_LABELS[unit.unitType]} />
              {bedroomsRule(unit.unitType) !== 'none' ? (
                <Item
                  label="Bedrooms"
                  value={unit.bedrooms === null ? null : String(unit.bedrooms)}
                />
              ) : null}
              <Item label="Floor" value={unit.floor} />
              <Item label="Owner" value={unit.owner?.displayName ?? null} />
              <Item label="Description" value={unit.description} wide />
              <Item
                label="Amenities"
                value={
                  unit.amenities.length
                    ? unit.amenities.map((a) => AMENITY_LABELS[a]).join(', ')
                    : null
                }
                wide
              />
            </dl>
          </CardBody>
        </Card>
      )}

      {can.seeLeases ? <UnitLeases unit={unit} canDraft={Boolean(can.draftLease) && live} /> : null}

      <AvailabilityCard unit={unit} canChange={can.manage && live} onSaved={saved} />
      <BandCard unit={unit} canOverride={can.overrideBand && live} onSaved={saved} />

      <Card>
        <CardHeader title="Meters" />
        <CardBody>
          {unit.meters.length === 0 ? (
            <p className="text-sm text-slate-600">No meter serves this unit.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {unit.meters.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-2 py-2">
                  <span>
                    {UTILITY_LABELS[m.utility]} · {m.supplier} ·{' '}
                    <span className="font-mono">{m.meterNumber}</span>
                  </span>
                  <Badge>{METER_TYPE_LABELS[m.meterType]}</Badge>
                </li>
              ))}
            </ul>
          )}
          <Link
            href={`/portfolio/properties/${unit.propertyId}`}
            className="inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-2"
          >
            Manage meters on the property page
          </Link>
        </CardBody>
      </Card>

      <History unit={unit} />
    </>
  );
}

function Item({
  label,
  value,
  wide = false,
}: {
  readonly label: string;
  readonly value: string | null;
  readonly wide?: boolean;
}) {
  return (
    <div className={wide ? 'min-w-0 sm:col-span-2' : 'min-w-0'}>
      <dt className="text-slate-600">{label}</dt>
      <dd className="break-words">
        {value ?? <span className="text-slate-500">Not recorded</span>}
      </dd>
    </div>
  );
}

function EditUnitForm({
  unit,
  onSaved,
  onCancel,
}: {
  readonly unit: UnitDetailView;
  readonly onSaved: (next: UnitDetailView) => void;
  readonly onCancel: () => void;
}) {
  const [unitType, setUnitType] = useState<UnitType>(unit.unitType);
  const [bedrooms, setBedrooms] = useState(unit.bedrooms === null ? '' : String(unit.bedrooms));
  const [floor, setFloor] = useState(unit.floor ?? '');
  const [description, setDescription] = useState(unit.description ?? '');
  const [amenities, setAmenities] = useState<readonly Amenity[]>(unit.amenities);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rule = bedroomsRule(unitType);
  const typeChanged = unitType !== unit.unitType;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const rooms = rule === 'none' || bedrooms.trim() === '' ? null : Number.parseInt(bedrooms, 10);
    if (rule === 'required' && rooms === null) {
      setError('Enter the bedrooms.');
      return;
    }
    const patch = changedFields(
      {
        unitType: unit.unitType,
        bedrooms: unit.bedrooms,
        floor: unit.floor,
        description: unit.description,
        amenities: [...unit.amenities],
      },
      {
        unitType,
        bedrooms: rooms,
        floor: floor.trim() || null,
        description: description.trim() || null,
        amenities: AMENITIES.filter((a) => amenities.includes(a)),
      },
    );
    if (Object.keys(patch).length === 0) {
      onCancel();
      return;
    }
    setPending(true);
    try {
      // A new type always sends its bedrooms, so the API never keeps a stale count.
      const next = await api().register.updateUnit({
        unitId: unit.id,
        ...patch,
        ...(typeChanged ? { bedrooms: rooms } : {}),
      });
      onSaved(next);
    } catch (failure) {
      setError(toProblem(failure).message);
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader title={`Edit ${unit.code}`} description="The unit code stays as it is." />
      <CardBody>
        <form onSubmit={submit} noValidate aria-label={`Edit ${unit.code}`} className="space-y-4">
          {error ? <Alert tone="error">{error}</Alert> : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label="Unit type"
              value={unitType}
              options={UNIT_TYPES.map((t) => ({ value: t, label: UNIT_TYPE_LABELS[t] }))}
              onChange={(event) => {
                const next = UNIT_TYPES.find((t) => t === event.target.value);
                if (next) setUnitType(next);
              }}
            />
            {rule !== 'none' ? (
              <TextField
                label={rule === 'required' ? 'Bedrooms' : 'Bedrooms (optional)'}
                inputMode="numeric"
                value={bedrooms}
                onChange={(event) => setBedrooms(event.target.value.replace(/\D/g, '').slice(0, 2))}
              />
            ) : null}
            <TextField
              label="Floor (optional)"
              hint="Such as Ground, or 2."
              maxLength={20}
              value={floor}
              onChange={(event) => setFloor(event.target.value)}
            />
          </div>
          {typeChanged && unit.bandOverridden ? (
            <Alert tone="warning">
              A new type resets the billing band to that type&rsquo;s default; the band change made
              by hand would have to be made again.
            </Alert>
          ) : null}
          <TextAreaField
            label="Description (optional)"
            rows={3}
            maxLength={500}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            className="[&_textarea]:font-sans"
          />
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-slate-800">Amenities</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {AMENITIES.map((amenity) => (
                <CheckboxField
                  key={amenity}
                  label={AMENITY_LABELS[amenity]}
                  checked={amenities.includes(amenity)}
                  onChange={(event) =>
                    setAmenities((current) =>
                      event.target.checked
                        ? AMENITIES.filter((a) => a === amenity || current.includes(a))
                        : current.filter((a) => a !== amenity),
                    )
                  }
                />
              ))}
            </div>
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" pending={pending}>
              Save unit
            </Button>
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

function AvailabilityCard({
  unit,
  canChange,
  onSaved,
}: {
  readonly unit: UnitDetailView;
  readonly canChange: boolean;
  readonly onSaved: (next: UnitDetailView, text: string) => void;
}) {
  const choices = availabilityChoices(unit.availability, unit.status, unit.occupancy);
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState<Availability | ''>('');
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = reasonProblem(reason);

  function start() {
    setOpen(true);
    setTo(choices[0] ?? '');
    setReason('');
    setTried(false);
    setError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    if (!to || problem) return;
    setPending(true);
    try {
      const next = await api().register.setAvailability({
        unitId: unit.id,
        availability: to,
        reason: reason.trim(),
      });
      setOpen(false);
      onSaved(next, `${unit.code} is now ${AVAILABILITY_LABELS[to].toLowerCase()}.`);
    } catch (failure) {
      setError(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Availability"
        description="Set by hand. Whether the unit is let comes from its lease."
        actions={
          canChange && !open && choices.length ? (
            <Button variant="secondary" size="sm" onClick={start}>
              Change availability
            </Button>
          ) : null
        }
      />
      <CardBody>
        <p className="text-sm">
          <span className="text-slate-600">Now: </span>
          <strong data-testid="availability">{AVAILABILITY_LABELS[unit.availability]}</strong>
        </p>
        {open ? (
          <form
            onSubmit={submit}
            noValidate
            aria-label="Change availability"
            className="space-y-4 rounded-md border border-slate-200 bg-slate-50 p-4"
          >
            {error ? <Alert tone="error">{error}</Alert> : null}
            <SelectField
              label="New availability"
              hint={availabilityHint(unit.availability, choices)}
              value={to}
              options={choices.map((c) => ({ value: c, label: AVAILABILITY_LABELS[c] }))}
              onChange={(event) => setTo(choices.find((c) => c === event.target.value) ?? '')}
              className="max-w-sm"
            />
            <TextAreaField
              label="Reason"
              hint="Required. It is kept in the unit's history."
              rows={2}
              maxLength={300}
              value={reason}
              error={tried ? problem : undefined}
              onChange={(event) => setReason(event.target.value)}
              className="[&_textarea]:font-sans"
            />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" pending={pending}>
                Save availability
              </Button>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : null}
      </CardBody>
    </Card>
  );
}

function BandCard({
  unit,
  canOverride,
  onSaved,
}: {
  readonly unit: UnitDetailView;
  readonly canOverride: boolean;
  readonly onSaved: (next: UnitDetailView, text: string) => void;
}) {
  const fallback = defaultBandFor(unit.unitType);
  const choices = bandChoices(unit.billingBand);
  const [open, setOpen] = useState(false);
  const [band, setBand] = useState<BillingBand>(choices[0] ?? fallback);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = bandOverrideProblem(unit.unitType, band, reason);

  async function save(next: BillingBand, why: string | null, message: string) {
    setPending(true);
    setError(null);
    try {
      const updated = await api().register.setBand({ unitId: unit.id, band: next, reason: why });
      setOpen(false);
      onSaved(updated, message);
    } catch (failure) {
      setError(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    if (problem) return;
    void save(
      band,
      band === fallback ? null : reason.trim(),
      `The billing band of ${unit.code} is now ${BILLING_BAND_LABELS[band].toLowerCase()}.`,
    );
  }

  return (
    <Card>
      <CardHeader
        title="Billing band"
        description="The band sets the subscription rate for this unit."
        actions={
          canOverride && !open ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setOpen(true);
                  setBand(choices[0] ?? fallback);
                  setReason('');
                  setTried(false);
                }}
              >
                Change band
              </Button>
              {unit.bandOverridden ? (
                <Button
                  variant="ghost"
                  size="sm"
                  pending={pending}
                  onClick={() =>
                    void save(
                      fallback,
                      null,
                      `The billing band of ${unit.code} is back to the default for its type.`,
                    )
                  }
                >
                  Restore the default
                </Button>
              ) : null}
            </div>
          ) : null
        }
      />
      <CardBody>
        <p className="text-sm">
          <strong data-testid="billing-band">{BILLING_BAND_LABELS[unit.billingBand]}</strong>{' '}
          <span className="text-slate-600">
            {unit.bandOverridden
              ? `(changed by hand; the default for a ${UNIT_TYPE_LABELS[unit.unitType].toLowerCase()} is ${BILLING_BAND_LABELS[fallback].toLowerCase()})`
              : '(the default for this type)'}
          </span>
        </p>
        {unit.bandOverridden && unit.bandOverrideReason ? (
          <p className="text-sm break-words">
            <span className="text-slate-600">Reason: </span>
            {unit.bandOverrideReason}
          </p>
        ) : null}
        {error && !open ? <Alert tone="error">{error}</Alert> : null}
        {open ? (
          <form
            onSubmit={submit}
            noValidate
            aria-label="Change band"
            className="space-y-4 rounded-md border border-slate-200 bg-slate-50 p-4"
          >
            {error ? <Alert tone="error">{error}</Alert> : null}
            <SelectField
              label="New band"
              value={band}
              options={choices.map((b) => ({
                value: b,
                label: `${BILLING_BAND_LABELS[b]}${b === fallback ? ' (the default for this type)' : ''}`,
              }))}
              onChange={(event) => {
                const next = choices.find((b) => b === event.target.value);
                if (next) setBand(next);
              }}
              className="max-w-sm"
            />
            {band !== fallback ? (
              <TextAreaField
                label="Reason"
                hint={`At least ${BAND_REASON_MIN_LENGTH} characters, such as "a kiosk let as a room to live in". The audit log keeps it.`}
                rows={2}
                maxLength={300}
                value={reason}
                error={tried ? problem : undefined}
                onChange={(event) => setReason(event.target.value)}
                className="[&_textarea]:font-sans"
              />
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" pending={pending}>
                Save band
              </Button>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : null}
      </CardBody>
    </Card>
  );
}

function History({ unit }: { readonly unit: UnitDetailView }) {
  const { timeZone } = useApp();
  return (
    <Card>
      <CardHeader
        title="Status history"
        description="Every change, newest first. It cannot be edited."
      />
      <CardBody>
        {unit.history.length === 0 ? (
          <p className="text-sm text-slate-600">No changes yet.</p>
        ) : (
          <ol className="divide-y divide-slate-100" aria-label="Status history">
            {unit.history.map((event) => (
              <li key={event.id} data-testid="history-event" className="space-y-1 py-3 text-sm">
                <p className="font-medium text-slate-900">
                  {event.fromValue === null
                    ? `${event.kind === 'occupancy' ? 'Occupancy' : 'Availability'} set to ${statusValueLabel(event.toValue)}`
                    : `${statusValueLabel(event.fromValue)} → ${statusValueLabel(event.toValue)}`}
                </p>
                <p className="text-slate-700">
                  <time dateTime={event.occurredAt}>{formatTime(event.occurredAt, timeZone)}</time>
                  {' · '}
                  {event.actorName ?? 'The system'} · {statusSourceLabel(event.source)}
                </p>
                {event.reason ? (
                  <p className="break-words text-slate-700">
                    <span className="text-slate-600">Reason: </span>
                    {event.reason}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </CardBody>
    </Card>
  );
}
