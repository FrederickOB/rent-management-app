'use client';

import type { OwnerRow } from '@rent/contracts';
import type { ApiClient } from '@rent/contracts/client';
import {
  checkGhanaPostGps,
  PROPERTY_TYPE_LABELS,
  PROPERTY_TYPES,
  PROPERTY_USES,
  UNIT_TYPE_LABELS,
} from '@rent/domain/portfolio';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { UnitBatches } from '@/components/unit-batches';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { SelectField, TextField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { toProblem } from '@/lib/errors';
import {
  addressErrors,
  codeRange,
  detailsErrors,
  MAX_BLOCKS,
  newBlock,
  nextBlockCode,
  placeOfProblem,
  previewCodes,
  setAreaCode,
  setLayout,
  setName,
  setPropertyPart,
  setPropertyType,
  setTown,
  STEP_LABELS,
  suggestedPropertyCode,
  suggestedUnitType,
  toCreateInput,
  unitsErrors,
  WIZARD_STEPS,
  newDraft,
  codeInput,
  type ProblemPlace,
  type WizardDraft,
  type WizardStep,
} from '@/lib/property-wizard';
import {
  domainProblem,
  locationLabel,
  PROPERTY_USE_LABELS,
  unitTypeLabel,
} from '@/lib/register-format';

type RegisterOptions = Awaited<ReturnType<ApiClient['register']['options']>>;

export interface PropertyWizardProps {
  readonly options: RegisterOptions;
  readonly owners: readonly OwnerRow[];
  /** In an agency every property needs its owner; a landlord's default to the landlord. */
  readonly agency: boolean;
}

interface ApiProblem {
  readonly message: string;
  readonly place: ProblemPlace | null;
  /** A free property code the API offers when the chosen one is taken. */
  readonly suggestion: { readonly area: string; readonly part: string } | null;
}

type Lookup =
  | { readonly status: 'idle' | 'working' }
  | { readonly status: 'done' | 'unavailable' | 'error'; readonly message: string };

/** The region from a lookup, matched to the country's list ("Greater Accra (…)" is Greater Accra). */
function matchRegion(found: string, regions: readonly string[]): string | null {
  const text = found.toLowerCase();
  return (
    [...regions]
      .sort((a, b) => b.length - a.length)
      .find((r) => text === r.toLowerCase() || text.startsWith(`${r.toLowerCase()} `)) ?? null
  );
}

/**
 * New property in four steps (PR-01, PR-03; PRD section 5: a compound house with 12 rooms in
 * under ten minutes). One API call creates the property, its blocks and its units at the end.
 */
export function PropertyWizard({ options, owners, agency }: PropertyWizardProps) {
  const router = useRouter();
  const live = owners.filter((o) => !o.archived);
  const ownerRequired = agency || live.length > 1;
  const [draft, setDraft] = useState<WizardDraft>(() =>
    newDraft({
      portfolioId:
        options.portfolios.find((p) => p.isDefault)?.id ?? options.portfolios[0]?.id ?? '',
      ownerId: agency ? '' : (live[0]?.id ?? ''),
    }),
  );
  const [step, setStep] = useState<WizardStep>('details');
  const [tried, setTried] = useState<ReadonlySet<WizardStep>>(new Set());
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const [pending, setPending] = useState(false);
  const [lookup, setLookup] = useState<Lookup>({ status: 'idle' });
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);

  // Each step announces itself, so keyboard and screen-reader users know where they are.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus();
  }, [step]);

  const update = (change: (d: WizardDraft) => WizardDraft) => {
    setDraft(change);
    setProblem(null);
  };

  const details = detailsErrors(draft, { ownerRequired });
  const address = addressErrors(draft, options.regions);
  const units = unitsErrors(draft);
  const valid: Record<WizardStep, boolean> = {
    details: Object.keys(details).length === 0,
    address: Object.keys(address).length === 0,
    units: units === null,
    review: true,
  };
  const index = WIZARD_STEPS.indexOf(step);
  const show = tried.has(step);
  const apiField = (field: string) =>
    problem?.place?.field === field ? problem.message : undefined;

  function go(to: WizardStep) {
    setStep(to);
    window.scrollTo({ top: 0 });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried((t) => new Set([...t, step]));
    if (step !== 'review') {
      if (valid[step]) go(WIZARD_STEPS[index + 1]!);
      return;
    }
    const broken = WIZARD_STEPS.find((s) => !valid[s]);
    if (broken) {
      setTried((t) => new Set([...t, broken]));
      go(broken);
      return;
    }
    setPending(true);
    setProblem(null);
    try {
      const created = await api().register.createProperty(toCreateInput(draft));
      router.push(`/portfolio/properties/${created.id}?created=1`);
    } catch (failure) {
      const found = toProblem(failure);
      const place = placeOfProblem(found.code);
      setProblem({ message: found.message, place, suggestion: suggestedPropertyCode(failure) });
      if (place) {
        setTried((t) => new Set([...t, place.step]));
        go(place.step);
      }
      setPending(false);
    }
  }

  async function lookUp() {
    const code = draft.ghanapostGps.trim();
    const formatProblem = domainProblem(() => checkGhanaPostGps(code));
    if (formatProblem) {
      setTried((t) => new Set([...t, 'address']));
      setLookup({ status: 'error', message: formatProblem });
      return;
    }
    setLookup({ status: 'working' });
    try {
      const result = await api().register.lookupAddress({ code });
      if (!result.available) {
        setLookup({
          status: 'unavailable',
          message: 'The address lookup is not available just now. Type the address below.',
        });
        return;
      }
      if (!result.address) {
        setLookup({
          status: 'error',
          message: 'No address was found for that code. Check it, or type the address below.',
        });
        return;
      }
      const found = result.address;
      const region = matchRegion(found.region, options.regions);
      setDraft((d) => ({
        ...d,
        ghanapostGps: found.code,
        region: region ?? d.region,
        district: found.district,
        latitude: String(found.latitude),
        longitude: String(found.longitude),
        addressSource: 'lookup',
      }));
      setLookup({
        status: 'done',
        message: region
          ? 'Found it. Check the region, district and pin below, and correct anything that is wrong.'
          : `Found it, in "${found.region}", which is not on the regions list: choose the region yourself.`,
      });
    } catch (failure) {
      setLookup({ status: 'error', message: toProblem(failure).message });
    }
  }

  const ownerOptions = agency
    ? [{ value: '', label: 'Choose the owner' }, ...live.map(ownerOption)]
    : live.length === 0
      ? [{ value: '', label: 'You, the landlord' }]
      : [
          ...(ownerRequired ? [{ value: '', label: 'Choose the owner' }] : []),
          ...live.map(ownerOption),
        ];

  const preview = previewCodes(draft);
  const codeTaken = problem?.suggestion ?? null;

  return (
    <div className="space-y-4">
      <ol aria-label="Steps" className="flex flex-wrap gap-2 text-sm">
        {WIZARD_STEPS.map((s, i) => (
          <li
            key={s}
            aria-current={s === step ? 'step' : undefined}
            className={cn(
              'rounded-full border px-3 py-1',
              s === step
                ? 'border-brand bg-brand text-brand-contrast'
                : i < index
                  ? 'border-slate-300 bg-white text-slate-800'
                  : 'border-slate-200 bg-slate-50 text-slate-500',
            )}
          >
            {i + 1}. {STEP_LABELS[s]}
          </li>
        ))}
      </ol>

      <Card>
        <CardBody>
          <h2
            ref={heading}
            tabIndex={-1}
            className="text-base font-semibold text-slate-900 focus:outline-none"
          >
            Step {index + 1} of {WIZARD_STEPS.length}: {STEP_LABELS[step]}
          </h2>
          <form onSubmit={submit} noValidate aria-label={STEP_LABELS[step]} className="space-y-5">
            {problem && (!problem.place?.field || problem.place.step !== step) ? (
              <Alert tone="error">{problem.message}</Alert>
            ) : null}
            {show && !valid[step] ? (
              <Alert tone="error">Some answers need attention. They are marked below.</Alert>
            ) : null}

            {step === 'details' ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  label="Property name"
                  hint="For example Legon compound house."
                  className="sm:col-span-2"
                  maxLength={120}
                  value={draft.name}
                  error={(show ? details.name : undefined) ?? apiField('name')}
                  onChange={(event) => update((d) => setName(d, event.target.value))}
                />
                <SelectField
                  label="Property type"
                  value={draft.propertyType}
                  error={show ? details.propertyType : undefined}
                  options={[
                    { value: '', label: 'Choose a type' },
                    ...PROPERTY_TYPES.map((t) => ({ value: t, label: PROPERTY_TYPE_LABELS[t] })),
                  ]}
                  onChange={(event) =>
                    update((d) =>
                      setPropertyType(
                        d,
                        PROPERTY_TYPES.find((t) => t === event.target.value) ?? '',
                      ),
                    )
                  }
                />
                <SelectField
                  label="Use"
                  value={draft.use}
                  error={show ? details.use : undefined}
                  options={[
                    { value: '', label: 'Choose' },
                    ...PROPERTY_USES.map((u) => ({ value: u, label: PROPERTY_USE_LABELS[u] })),
                  ]}
                  onChange={(event) =>
                    update((d) => ({
                      ...d,
                      use: PROPERTY_USES.find((u) => u === event.target.value) ?? '',
                      useEdited: true,
                    }))
                  }
                />
                <SelectField
                  label="Owner"
                  hint={agency ? 'The client who owns this property.' : undefined}
                  value={draft.ownerId}
                  error={(show ? details.ownerId : undefined) ?? apiField('ownerId')}
                  options={ownerOptions}
                  onChange={(event) => update((d) => ({ ...d, ownerId: event.target.value }))}
                />
                {options.portfolios.length > 1 ? (
                  <SelectField
                    label="Portfolio"
                    value={draft.portfolioId}
                    options={options.portfolios.map((p) => ({ value: p.id, label: p.name }))}
                    onChange={(event) => update((d) => ({ ...d, portfolioId: event.target.value }))}
                  />
                ) : null}
                <TextField
                  label="Town or locality"
                  hint="Part of the address; it suggests the area code."
                  maxLength={80}
                  value={draft.town}
                  onChange={(event) => update((d) => setTown(d, event.target.value))}
                />
                <fieldset className="space-y-3 sm:col-span-2">
                  <legend className="text-sm font-medium text-slate-800">Property code</legend>
                  <p className="text-sm text-slate-600">
                    Every unit code starts with it, such as{' '}
                    <span className="font-mono">
                      {draft.areaCode || 'ACC'}-{draft.propertyPart || 'LEG'}-B1-01
                    </span>
                    . It cannot change once the property has units.
                  </p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <TextField
                      label="Area code"
                      hint="2 to 4 letters, such as ACC for Accra."
                      autoCapitalize="characters"
                      autoComplete="off"
                      spellCheck={false}
                      value={draft.areaCode}
                      error={(show ? details.areaCode : undefined) ?? apiField('areaCode')}
                      onChange={(event) => update((d) => setAreaCode(d, event.target.value))}
                    />
                    <div className="space-y-2">
                      <TextField
                        label="Property part"
                        hint="2 to 4 letters or digits, such as LEG."
                        autoCapitalize="characters"
                        autoComplete="off"
                        spellCheck={false}
                        value={draft.propertyPart}
                        error={
                          (show ? details.propertyPart : undefined) ?? apiField('propertyPart')
                        }
                        onChange={(event) => update((d) => setPropertyPart(d, event.target.value))}
                      />
                      {codeTaken && apiField('propertyPart') ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() =>
                            update((d) =>
                              setPropertyPart(setAreaCode(d, codeTaken.area), codeTaken.part),
                            )
                          }
                        >
                          Use {codeTaken.area}-{codeTaken.part}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </fieldset>
              </div>
            ) : null}

            {step === 'address' ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2 sm:col-span-2">
                  <div>
                    <TextField
                      label="GhanaPost GPS address"
                      hint="Optional. The digital address, such as GA-183-8164."
                      autoCapitalize="characters"
                      autoComplete="off"
                      spellCheck={false}
                      maxLength={20}
                      value={draft.ghanapostGps}
                      error={(show ? address.ghanapostGps : undefined) ?? apiField('ghanapostGps')}
                      onChange={(event) => {
                        const value = event.target.value;
                        update((d) => ({ ...d, ghanapostGps: value, addressSource: 'manual' }));
                        setLookup({ status: 'idle' });
                      }}
                    />
                    {options.addressLookup ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="mt-2"
                        pending={lookup.status === 'working'}
                        disabled={!draft.ghanapostGps.trim()}
                        onClick={() => void lookUp()}
                      >
                        Look up
                      </Button>
                    ) : null}
                  </div>
                  {lookup.status === 'working' ? <Alert tone="info">Looking it up…</Alert> : null}
                  {lookup.status === 'done' ? <Alert tone="success">{lookup.message}</Alert> : null}
                  {lookup.status === 'unavailable' ? (
                    <Alert tone="warning">{lookup.message}</Alert>
                  ) : null}
                  {lookup.status === 'error' ? <Alert tone="error">{lookup.message}</Alert> : null}
                </div>
                <SelectField
                  label="Region"
                  value={draft.region}
                  error={(show ? address.region : undefined) ?? apiField('region')}
                  options={[
                    { value: '', label: 'Choose the region' },
                    ...options.regions.map((r) => ({ value: r, label: r })),
                  ]}
                  onChange={(event) => update((d) => ({ ...d, region: event.target.value }))}
                />
                <TextField
                  label="District"
                  maxLength={80}
                  value={draft.district}
                  onChange={(event) => update((d) => ({ ...d, district: event.target.value }))}
                />
                <TextField
                  label="MMDA"
                  hint="The metropolitan, municipal or district assembly."
                  maxLength={80}
                  value={draft.mmda}
                  onChange={(event) => update((d) => ({ ...d, mmda: event.target.value }))}
                />
                <TextField
                  label="Town or locality"
                  maxLength={80}
                  value={draft.town}
                  onChange={(event) => update((d) => setTown(d, event.target.value))}
                />
                <TextField
                  label="Street or landmark"
                  className="sm:col-span-2"
                  maxLength={160}
                  value={draft.street}
                  onChange={(event) => update((d) => ({ ...d, street: event.target.value }))}
                />
                <fieldset className="space-y-3 sm:col-span-2">
                  <legend className="text-sm font-medium text-slate-800">Map pin (optional)</legend>
                  <p className="text-sm text-slate-600">
                    Decimal degrees, such as 5.6505 and -0.1862. Copy them from a maps app, or use
                    the lookup.
                  </p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <TextField
                      label="Latitude"
                      inputMode="decimal"
                      autoComplete="off"
                      maxLength={12}
                      value={draft.latitude}
                      error={(show ? address.latitude : undefined) ?? apiField('latitude')}
                      onChange={(event) => update((d) => ({ ...d, latitude: event.target.value }))}
                    />
                    <TextField
                      label="Longitude"
                      inputMode="decimal"
                      autoComplete="off"
                      maxLength={12}
                      value={draft.longitude}
                      onChange={(event) => update((d) => ({ ...d, longitude: event.target.value }))}
                    />
                  </div>
                </fieldset>
              </div>
            ) : null}

            {step === 'units' ? <UnitsStep draft={draft} show={show} update={update} /> : null}

            {step === 'review' ? (
              <Review
                draft={draft}
                preview={preview}
                owner={
                  live.find((o) => o.id === draft.ownerId)?.displayName ??
                  (agency ? 'Not chosen' : 'You, the landlord')
                }
                portfolio={options.portfolios.find((p) => p.id === draft.portfolioId)?.name ?? null}
                onEdit={go}
              />
            ) : null}

            <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-4">
              {index > 0 ? (
                <Button variant="secondary" onClick={() => go(WIZARD_STEPS[index - 1]!)}>
                  Back
                </Button>
              ) : null}
              <Button type="submit" pending={pending}>
                {step === 'review' ? 'Create property' : 'Continue'}
              </Button>
              <Link
                href="/portfolio"
                className="inline-flex min-h-11 items-center px-3 text-sm font-medium underline underline-offset-2"
              >
                Cancel
              </Link>
            </div>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}

function ownerOption(owner: OwnerRow) {
  return { value: owner.id, label: `${owner.displayName} (${owner.reference})` };
}

function UnitsStep({
  draft,
  show,
  update,
}: {
  readonly draft: WizardDraft;
  readonly show: boolean;
  readonly update: (change: (d: WizardDraft) => WizardDraft) => void;
}) {
  const errors = show ? unitsErrors(draft) : null;
  const newType = suggestedUnitType(draft);
  return (
    <div className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-slate-800">How are the units arranged?</legend>
        {(
          [
            [
              'single',
              'All in one block',
              'Codes such as …-B1-01. Most compound houses and blocks of flats.',
            ],
            [
              'blocks',
              'In several blocks or floors',
              'For example a main house and back rooms, or shops on the ground floor and offices above.',
            ],
          ] as const
        ).map(([value, label, hint]) => (
          <label key={value} className="flex items-start gap-3 text-sm">
            <input
              type="radio"
              name="layout"
              className="mt-0.5 size-5 shrink-0"
              checked={draft.layout === value}
              onChange={() => update((d) => setLayout(d, value))}
            />
            <span>
              <span className="font-medium text-slate-800">{label}</span>
              <span className="block text-slate-600">{hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {draft.layout === 'single' ? (
        <section aria-label="Units in block B1" className="space-y-2">
          <h3 className="text-sm font-semibold text-slate-900">Units in block B1</h3>
          <UnitBatches
            batches={draft.batches}
            showErrors={show}
            newType={newType}
            allowEmpty
            onChange={(batches) => update((d) => ({ ...d, batches }))}
          />
        </section>
      ) : (
        <div className="space-y-4">
          {draft.blocks.map((block, i) => {
            const blockErrors = errors?.[i];
            const replace = (changed: typeof block) =>
              update((d) => ({ ...d, blocks: d.blocks.map((b, j) => (j === i ? changed : b)) }));
            return (
              <fieldset
                key={block.key}
                className="space-y-3 rounded-lg border border-slate-300 bg-slate-50 p-3 sm:p-4"
              >
                <legend className="px-1 text-sm font-semibold text-slate-900">Block {i + 1}</legend>
                <div className="grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
                  <TextField
                    label="Block code"
                    hint="1 to 3 letters or digits."
                    autoCapitalize="characters"
                    autoComplete="off"
                    spellCheck={false}
                    value={block.code}
                    error={blockErrors?.code}
                    onChange={(event) =>
                      replace({ ...block, code: codeInput(event.target.value, 3) })
                    }
                  />
                  <TextField
                    label="Block name (optional)"
                    hint="Such as Main house, or First floor offices."
                    maxLength={60}
                    value={block.name}
                    onChange={(event) => replace({ ...block, name: event.target.value })}
                  />
                </div>
                <UnitBatches
                  batches={block.batches}
                  showErrors={show}
                  newType={newType}
                  allowEmpty
                  onChange={(batches) => replace({ ...block, batches })}
                />
                {draft.blocks.length > 1 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      update((d) => ({ ...d, blocks: d.blocks.filter((_, j) => j !== i) }))
                    }
                  >
                    Remove block {i + 1}
                  </Button>
                ) : null}
              </fieldset>
            );
          })}
          {draft.blocks.length < MAX_BLOCKS ? (
            <Button
              variant="secondary"
              onClick={() =>
                update((d) => ({
                  ...d,
                  blocks: [...d.blocks, newBlock(nextBlockCode(d.blocks))],
                }))
              }
            >
              Add another block
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

function Review({
  draft,
  preview,
  owner,
  portfolio,
  onEdit,
}: {
  readonly draft: WizardDraft;
  readonly preview: ReturnType<typeof previewCodes>;
  readonly owner: string;
  readonly portfolio: string | null;
  readonly onEdit: (step: WizardStep) => void;
}) {
  const rows: [string, string, WizardStep][] = [
    ['Name', draft.name.trim(), 'details'],
    [
      'Type and use',
      `${draft.propertyType ? PROPERTY_TYPE_LABELS[draft.propertyType] : ''}, ${
        draft.use ? PROPERTY_USE_LABELS[draft.use].toLowerCase() : ''
      }`,
      'details',
    ],
    ['Owner', owner, 'details'],
    ...(portfolio ? [['Portfolio', portfolio, 'details'] as [string, string, WizardStep]] : []),
    [
      'Address',
      [draft.ghanapostGps.trim(), draft.street.trim(), locationLabel(draft)]
        .filter(Boolean)
        .join(', '),
      'address',
    ],
    [
      'Map pin',
      draft.latitude.trim() && draft.longitude.trim()
        ? `${draft.latitude.trim()}, ${draft.longitude.trim()}`
        : 'None',
      'address',
    ],
  ];
  return (
    <div className="space-y-5">
      <dl className="divide-y divide-slate-100 rounded-md border border-slate-200">
        {rows.map(([label, value, step]) => (
          <div key={label} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2">
            <div className="min-w-0">
              <dt className="text-sm text-slate-600">{label}</dt>
              <dd className="text-sm break-words text-slate-900">{value}</dd>
            </div>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Change ${label.toLowerCase()}`}
              onClick={() => onEdit(step)}
            >
              Change
            </Button>
          </div>
        ))}
      </dl>

      <section aria-labelledby="codes-heading" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id="codes-heading" className="text-sm font-semibold text-slate-900">
            Codes that will be created
          </h3>
          <Button variant="ghost" size="sm" onClick={() => onEdit('units')}>
            Change the units
          </Button>
        </div>
        {preview ? (
          <>
            <p className="text-sm text-slate-800">
              Property <span className="font-mono font-semibold">{preview.propertyCode}</span> with{' '}
              <strong data-testid="preview-total">{preview.total}</strong>{' '}
              {preview.total === 1 ? 'unit' : 'units'}.
            </p>
            <ul className="space-y-3">
              {preview.blocks.map((block) => (
                <li key={block.code} className="rounded-md border border-slate-200 p-3">
                  <p className="text-sm font-medium text-slate-900">
                    Block {block.code}
                    {block.name ? ` · ${block.name}` : ''}
                  </p>
                  <p
                    className="font-mono text-sm break-words text-slate-800"
                    data-testid="preview-range"
                  >
                    {codeRange(block.units.map((u) => u.code))}
                  </p>
                  {block.units.length ? (
                    <details className="mt-1 text-sm">
                      <summary className="cursor-pointer py-1 text-slate-700">
                        Every unit in block {block.code}
                      </summary>
                      <ul className="mt-1 grid gap-1 sm:grid-cols-2">
                        {block.units.map((u) => (
                          <li key={u.code}>
                            <span className="font-mono">{u.code}</span>{' '}
                            <span className="text-slate-600">
                              {unitTypeLabel(u.unitType, u.bedrooms)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
            {preview.total === 0 ? (
              <Alert tone="info">
                No units yet. You can add them later from the property page.
              </Alert>
            ) : null}
            <p className="text-sm text-slate-600">
              Codes are permanent: they are never changed or reused, even after a unit is archived.
              Types:{' '}
              {[...new Set(preview.blocks.flatMap((b) => b.units.map((u) => u.unitType)))]
                .map((t) => UNIT_TYPE_LABELS[t])
                .join(', ') || 'none'}
              .
            </p>
          </>
        ) : (
          <Alert tone="warning">Finish the earlier steps to see the codes.</Alert>
        )}
      </section>
    </div>
  );
}
