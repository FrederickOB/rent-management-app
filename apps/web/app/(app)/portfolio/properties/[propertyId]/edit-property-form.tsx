'use client';

import type { PropertyDetailView } from '@rent/contracts';
import {
  normaliseGhanaPostGps,
  PROPERTY_TYPE_LABELS,
  PROPERTY_TYPES,
  PROPERTY_USES,
  type PropertyType,
  type PropertyUse,
} from '@rent/domain/portfolio';
import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { SelectField, TextField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { changedFields } from '@/lib/patch';
import { addressErrors } from '@/lib/property-wizard';
import { PROPERTY_USE_LABELS } from '@/lib/register-format';
import type { RegisterOptions } from './types';

interface Fields {
  readonly name: string;
  readonly propertyType: PropertyType;
  readonly use: PropertyUse;
  readonly portfolioId: string;
  readonly ghanapostGps: string;
  readonly region: string;
  readonly district: string;
  readonly mmda: string;
  readonly town: string;
  readonly street: string;
  readonly latitude: string;
  readonly longitude: string;
}

function fieldsOf(p: PropertyDetailView): Fields {
  return {
    name: p.name,
    propertyType: p.propertyType,
    use: p.use,
    portfolioId: p.portfolio.id,
    ghanapostGps: p.address.ghanapostGps ?? '',
    region: p.address.region,
    district: p.address.district ?? '',
    mmda: p.address.mmda ?? '',
    town: p.address.town ?? '',
    street: p.address.street ?? '',
    latitude: p.address.pin?.latitude ?? '',
    longitude: p.address.pin?.longitude ?? '',
  };
}

const ADDRESS_KEYS = [
  'ghanapostGps',
  'region',
  'district',
  'mmda',
  'town',
  'street',
  'latitude',
  'longitude',
] as const;

const orNull = (value: string) => value.trim() || null;

/** Name, type, use, portfolio and address (PR-01, PR-03). Codes never change here. */
export function EditPropertyForm({
  property,
  options,
  onSaved,
  onCancel,
}: {
  readonly property: PropertyDetailView;
  readonly options: RegisterOptions;
  readonly onSaved: (next: PropertyDetailView) => void;
  readonly onCancel: () => void;
}) {
  const [fields, setFields] = useState<Fields>(() => fieldsOf(property));
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Fields>(key: K, value: Fields[K]) =>
    setFields((f) => ({ ...f, [key]: value }));

  const nameError =
    fields.name.trim().length < 2 ? 'Enter a name of 2 to 120 characters' : undefined;
  const address = addressErrors(fields, options.regions);
  const invalid = Boolean(nameError) || Object.keys(address).length > 0;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    if (invalid) return;
    const before = fieldsOf(property);
    const top = changedFields(
      {
        name: before.name,
        propertyType: before.propertyType,
        use: before.use,
        portfolioId: before.portfolioId,
      },
      {
        name: fields.name.trim(),
        propertyType: fields.propertyType,
        use: fields.use,
        portfolioId: fields.portfolioId,
      },
    );
    const addressChanged = ADDRESS_KEYS.some((k) => before[k].trim() !== fields[k].trim());
    if (Object.keys(top).length === 0 && !addressChanged) {
      onCancel();
      return;
    }
    setPending(true);
    try {
      const gps = fields.ghanapostGps.trim();
      const next = await api().register.updateProperty({
        propertyId: property.id,
        ...top,
        ...(addressChanged
          ? {
              address: {
                ghanapostGps: gps ? normaliseGhanaPostGps(gps) : null,
                region: fields.region,
                district: orNull(fields.district),
                mmda: orNull(fields.mmda),
                town: orNull(fields.town),
                street: orNull(fields.street),
                latitude: orNull(fields.latitude),
                longitude: orNull(fields.longitude),
                source: 'manual',
              },
            }
          : {}),
      });
      onSaved(next);
    } catch (failure) {
      setError(toProblem(failure).message);
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Edit details"
        description="The property code and unit codes stay as they are."
      />
      <CardBody>
        <form onSubmit={submit} noValidate aria-label="Edit details" className="space-y-4">
          {error ? <Alert tone="error">{error}</Alert> : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Property name"
              className="sm:col-span-2"
              maxLength={120}
              value={fields.name}
              error={tried ? nameError : undefined}
              onChange={(event) => set('name', event.target.value)}
            />
            <SelectField
              label="Property type"
              value={fields.propertyType}
              options={PROPERTY_TYPES.map((t) => ({ value: t, label: PROPERTY_TYPE_LABELS[t] }))}
              onChange={(event) => {
                const type = PROPERTY_TYPES.find((t) => t === event.target.value);
                if (type) set('propertyType', type);
              }}
            />
            <SelectField
              label="Use"
              value={fields.use}
              options={PROPERTY_USES.map((u) => ({ value: u, label: PROPERTY_USE_LABELS[u] }))}
              onChange={(event) => {
                const use = PROPERTY_USES.find((u) => u === event.target.value);
                if (use) set('use', use);
              }}
            />
            {options.portfolios.length > 1 ? (
              <SelectField
                label="Portfolio"
                value={fields.portfolioId}
                options={options.portfolios.map((p) => ({ value: p.id, label: p.name }))}
                onChange={(event) => set('portfolioId', event.target.value)}
              />
            ) : null}
            <TextField
              label="GhanaPost GPS address"
              hint="Such as GA-183-8164."
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              maxLength={20}
              value={fields.ghanapostGps}
              error={tried ? address.ghanapostGps : undefined}
              onChange={(event) => set('ghanapostGps', event.target.value)}
            />
            <SelectField
              label="Region"
              value={fields.region}
              error={tried ? address.region : undefined}
              options={[
                ...(options.regions.includes(fields.region)
                  ? []
                  : [{ value: fields.region, label: fields.region || 'Choose the region' }]),
                ...options.regions.map((r) => ({ value: r, label: r })),
              ]}
              onChange={(event) => set('region', event.target.value)}
            />
            <TextField
              label="District"
              maxLength={80}
              value={fields.district}
              onChange={(event) => set('district', event.target.value)}
            />
            <TextField
              label="MMDA"
              maxLength={80}
              value={fields.mmda}
              onChange={(event) => set('mmda', event.target.value)}
            />
            <TextField
              label="Town or locality"
              maxLength={80}
              value={fields.town}
              onChange={(event) => set('town', event.target.value)}
            />
            <TextField
              label="Street or landmark"
              maxLength={160}
              value={fields.street}
              onChange={(event) => set('street', event.target.value)}
            />
            <TextField
              label="Latitude"
              inputMode="decimal"
              maxLength={12}
              value={fields.latitude}
              error={tried ? address.latitude : undefined}
              onChange={(event) => set('latitude', event.target.value)}
            />
            <TextField
              label="Longitude"
              inputMode="decimal"
              maxLength={12}
              value={fields.longitude}
              onChange={(event) => set('longitude', event.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" pending={pending}>
              Save details
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
