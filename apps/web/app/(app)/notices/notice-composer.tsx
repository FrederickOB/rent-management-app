'use client';

import type { NoticeCompose, NoticeDetail } from '@rent/contracts';
import {
  NOTICE_FIELD_LABELS,
  NOTICE_WITHHELD_REASON_LABELS,
  type NoticeSubtype,
  type NoticeType,
} from '@rent/domain/notices';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { LeasePicker } from '@/components/lease-picker';
import { LoadFailed, Loading } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { CheckboxField, Field, SelectField, TextField, controlClass } from '@/components/ui/field';
import { api, keyedApi } from '@/lib/api';
import { formatBusinessDate } from '@/lib/business-dates';
import { toProblem } from '@/lib/errors';
import { sendOnce, useIdempotencyKeeper } from '@/lib/idempotency';
import type { PickedLease } from '@/lib/lease-pick';
import {
  CHANNEL_MODE_LABELS,
  composerFields,
  draftFingerprint,
  draftOfFields,
  earliestText,
  effectiveProblem,
  fieldErrorsOf,
  fieldKind,
  fieldsOfDraft,
  noticeChannelName,
  noticeRefusal,
  orderedWarnings,
  quitBarText,
  warningTitle,
  type FieldDraft,
  type NoticeTypeInfo,
} from '@/lib/notices';
import { formatMinor } from '@/lib/tenancy-format';
import { NoticeWarnings } from './notice-warnings';

type Types = Awaited<ReturnType<ReturnType<typeof api>['notices']['types']>>;
type Option = { readonly id: string; readonly label: string };

const CHECK_DELAY_MS = 500;

export type ComposerStart =
  | {
      readonly kind: 'new';
      readonly type: NoticeType | null;
      readonly lease: PickedLease | null;
      readonly propertyId: string | null;
    }
  | { readonly kind: 'edit'; readonly notice: NoticeDetail };

/**
 * The notice composer (LN-01; plan 4.3 and 4.10). Each change asks the API to check the planned
 * notice (`POST /notices/compose`, which saves nothing): the facts it fills from the lease and the
 * ledger, the earliest lawful date, every warning and blocker, the s.23 bar, who receives it on
 * which channel, and problems field by field. Saving makes or changes a draft; issuing happens on
 * the draft's page, after its preview.
 */
export function NoticeComposer({ start }: { readonly start: ComposerStart }) {
  const router = useRouter();
  const editing = start.kind === 'edit' ? start.notice : null;
  const [types, setTypes] = useState<Types | null>(null);
  const [typesProblem, setTypesProblem] = useState<string | null>(null);
  const [type, setType] = useState<NoticeType | null>(
    editing ? editing.type : start.kind === 'new' ? start.type : null,
  );
  const [subtype, setSubtype] = useState<NoticeSubtype | null>(editing?.subtype ?? null);
  const [lease, setLease] = useState<PickedLease | null>(start.kind === 'new' ? start.lease : null);
  const [propertyId, setPropertyId] = useState<string>(
    editing ? editing.property.id : start.kind === 'new' ? (start.propertyId ?? '') : '',
  );
  const [blockIds, setBlockIds] = useState<readonly string[]>(editing?.blockIds ?? []);
  const [draft, setDraft] = useState<FieldDraft>(editing ? draftOfFields(editing.fields) : {});
  const [filled, setFilled] = useState(Boolean(editing));
  const [check, setCheck] = useState<NoticeCompose | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkProblem, setCheckProblem] = useState<string | null>(null);
  const [properties, setProperties] = useState<readonly Option[]>([]);
  const [blocks, setBlocks] = useState<readonly Option[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveProblem, setSaveProblem] = useState<string | null>(null);
  const keeper = useIdempotencyKeeper();
  const keyedFor = useRef<string | null>(null);
  const checks = useRef(0);

  const info: NoticeTypeInfo | null = types?.types.find((t) => t.type === type) ?? null;
  const leaseId = editing ? editing.leaseId : (lease?.id ?? null);
  const buildingWide = type === 'building_wide';
  const out = useMemo(
    () => fieldsOfDraft(draft, { propertyId, blockIds }, type ?? undefined),
    [draft, propertyId, blockIds, type],
  );
  const ready = info !== null && (buildingWide ? Boolean(propertyId) : Boolean(leaseId));

  const loadTypes = useCallback(async () => {
    try {
      setTypes(await api().notices.types());
      setTypesProblem(null);
    } catch (failure) {
      setTypesProblem(
        noticeRefusal(failure) === 'not_on_plan'
          ? 'Legal notices are not on your company’s plan.'
          : toProblem(failure).message,
      );
    }
  }, []);

  useEffect(() => {
    void loadTypes();
  }, [loadTypes]);

  // Properties and blocks, for a building-wide notice.
  useEffect(() => {
    if (!buildingWide) return undefined;
    let current = true;
    api()
      .register.listProperties({})
      .then(
        (result) => {
          if (current)
            setProperties(
              result.rows
                .filter((p) => !p.archived)
                .map((p) => ({ id: p.id, label: `${p.code} · ${p.name}` })),
            );
        },
        () => undefined,
      );
    return () => {
      current = false;
    };
  }, [buildingWide]);

  useEffect(() => {
    setBlocks([]);
    if (!buildingWide || !propertyId) return undefined;
    let current = true;
    api()
      .register.getProperty({ propertyId })
      .then(
        (property) => {
          if (current)
            setBlocks(
              property.blocks
                .filter((b) => !b.archived)
                .map((b) => ({ id: b.id, label: b.name ? `${b.code} · ${b.name}` : b.code })),
            );
        },
        () => undefined,
      );
    return () => {
      current = false;
    };
  }, [buildingWide, propertyId]);

  // Ask the API to check the planned notice after each pause in typing. The first answer for a
  // new target fills the fields it suggests (the arrears from the ledger, the lease's end…).
  useEffect(() => {
    if (!ready || !type) {
      setCheck(null);
      return undefined;
    }
    const mine = (checks.current += 1);
    const id = window.setTimeout(() => {
      setChecking(true);
      api()
        .notices.compose({
          type,
          subtype,
          ...(buildingWide ? { propertyId, blockIds: [...blockIds] } : { leaseId }),
          fields: out.fields,
        })
        .then(
          (answer) => {
            if (mine !== checks.current) return;
            setCheck(answer);
            setCheckProblem(null);
            if (!filled) {
              setDraft((current) => ({
                ...draftOfFields(answer.prefill.suggestedFields),
                ...current,
              }));
              setFilled(true);
            }
          },
          (failure: unknown) => {
            if (mine === checks.current) setCheckProblem(toProblem(failure).message);
          },
        )
        .finally(() => {
          if (mine === checks.current) setChecking(false);
        });
    }, CHECK_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [ready, type, subtype, buildingWide, propertyId, blockIds, leaseId, out.fields, filled]);

  function chooseTarget(next: () => void) {
    next();
    // A new type or target starts its fields again from the API's suggestions.
    setDraft({});
    setFilled(false);
    setCheck(null);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!type || !ready || saving) return;
    setSaveProblem(null);
    if (Object.keys(out.errors).length) {
      setSaveProblem('Some fields need correcting first.');
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        const saved = await api().notices.update({
          noticeId: editing.id,
          subtype,
          ...(buildingWide ? { blockIds: [...blockIds] } : {}),
          fields: out.fields,
        });
        router.push(`/notices/${saved.id}?saved=1`);
        return;
      }
      const content = draftFingerprint({
        type,
        subtype,
        leaseId,
        propertyId: buildingWide ? propertyId : null,
        blockIds,
        fields: out.fields,
      });
      // A changed draft is a new record with a new key (M6 lesson); a retry of the same one is not.
      if (keyedFor.current !== content) {
        keeper.reset();
        keyedFor.current = content;
      }
      const saved = await sendOnce(keeper, (key) =>
        keyedApi(key).notices.create({
          type,
          subtype,
          ...(buildingWide ? { propertyId, blockIds: [...blockIds] } : { leaseId }),
          fields: out.fields,
        }),
      );
      router.push(`/notices/${saved.id}?saved=1`);
    } catch (failure) {
      const refusal = noticeRefusal(failure);
      if (refusal === 'key_reused') {
        keeper.reset();
        keyedFor.current = null;
      }
      setSaveProblem(
        refusal === 'key_reused'
          ? 'An earlier attempt with other details was already saved. Check the notices list before saving again.'
          : refusal === 'not_editable'
            ? 'This notice can no longer be changed: it has been submitted or issued.'
            : toProblem(failure).message,
      );
      setSaving(false);
    }
  }

  if (typesProblem) return <LoadFailed message={typesProblem} onRetry={() => void loadTypes()} />;
  if (!types) return <Loading what="notice types" />;
  if (!types.onPlan)
    return (
      <Alert tone="info" title="Legal notices are not on your company’s plan">
        Notices are part of the Growth plan.
      </Alert>
    );

  const offered = types.types.filter((t) => t.issuable);
  const fieldErrors = { ...fieldErrorsOf(check?.fieldErrors ?? []), ...out.errors };
  const invoices = check?.prefill.arrears?.invoices ?? [];

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <form onSubmit={save} noValidate aria-label="Notice" className="min-w-0 space-y-6">
        <Card>
          <CardHeader title="What and to whom" />
          <CardBody>
            {editing ? (
              <p className="text-sm text-slate-700">
                {info?.label ?? editing.typeLabel}
                {editing.tenant ? ` to ${editing.tenant.name}` : ''}
                {editing.unitCode ? ` (${editing.unitCode})` : ''}. The type and the lease stay as
                they are; discard the draft to start another.
              </p>
            ) : (
              <>
                <SelectField
                  label="Type of notice"
                  value={type ?? ''}
                  options={[
                    { value: '', label: 'Choose a type' },
                    ...offered.map((t) => ({
                      value: t.type,
                      label:
                        t.type === 'notice_to_quit' && !types.quitEnabled
                          ? `${t.label} (turned off for your company)`
                          : t.label,
                    })),
                  ]}
                  onChange={(event) =>
                    chooseTarget(() => {
                      setType((event.target.value || null) as NoticeType | null);
                      setSubtype(null);
                    })
                  }
                />
                {type === 'notice_to_quit' && !types.quitEnabled ? (
                  <Alert tone="warning" title="Notices to quit are turned off for your company">
                    An administrator must first accept the risk statement in Notice settings
                    (OQ-16). Until then a notice to quit can be drafted but not issued.
                  </Alert>
                ) : null}
                {info && !info.needsLease ? (
                  <>
                    <SelectField
                      label="Property"
                      value={propertyId}
                      options={[
                        { value: '', label: 'Choose a property' },
                        ...properties.map((p) => ({ value: p.id, label: p.label })),
                      ]}
                      onChange={(event) =>
                        chooseTarget(() => {
                          setPropertyId(event.target.value);
                          setBlockIds([]);
                        })
                      }
                    />
                    {blocks.length > 1 ? (
                      <fieldset className="space-y-2">
                        <legend className="text-sm font-medium text-slate-800">
                          Blocks (none ticked: the whole property)
                        </legend>
                        {blocks.map((block) => (
                          <CheckboxField
                            key={block.id}
                            label={block.label}
                            checked={blockIds.includes(block.id)}
                            onChange={(event) =>
                              setBlockIds((current) =>
                                event.target.checked
                                  ? [...current, block.id]
                                  : current.filter((b) => b !== block.id),
                              )
                            }
                          />
                        ))}
                      </fieldset>
                    ) : null}
                  </>
                ) : info ? (
                  <LeasePicker
                    value={lease}
                    label="Lease the notice is served under"
                    onChange={(next) => chooseTarget(() => setLease(next))}
                  />
                ) : null}
              </>
            )}
            {info && info.subtypes.length ? (
              <SelectField
                label={info.subtypeFieldLabel ?? 'Kind'}
                value={subtype ?? ''}
                error={fieldErrors.subtype}
                options={[
                  { value: '', label: 'Choose one' },
                  ...info.subtypes.map((s) => ({ value: s.value, label: s.label })),
                ]}
                onChange={(event) => setSubtype((event.target.value || null) as NoticeSubtype)}
              />
            ) : null}
          </CardBody>
        </Card>

        {info && ready ? (
          <Card>
            <CardHeader
              title="The notice’s facts"
              description="Filled from the lease and the ledger where they can be; check each one."
            />
            <CardBody>
              {composerFields(info).map((field) => (
                <FieldInput
                  key={field}
                  field={field}
                  label={info.fieldLabels[field] ?? NOTICE_FIELD_LABELS[field] ?? field}
                  required={info.requiredFields.includes(field)}
                  value={draft[field]}
                  error={fieldErrors[field] ?? null}
                  invoices={invoices}
                  onChange={(value) => setDraft((current) => ({ ...current, [field]: value }))}
                />
              ))}
            </CardBody>
          </Card>
        ) : null}

        {saveProblem ? <Alert tone="error">{saveProblem}</Alert> : null}
        {info && ready ? (
          <div className="flex flex-wrap gap-2">
            <Button type="submit" pending={saving}>
              {editing ? 'Save the draft' : 'Save as a draft'}
            </Button>
            <p className="self-center text-sm text-slate-600">
              Nothing is sent yet. The draft’s page has the preview, then submitting or issuing.
            </p>
          </div>
        ) : null}
      </form>

      <aside className="space-y-4" aria-label="Checks">
        {checking ? (
          <p role="status" className="text-sm text-slate-600">
            Checking…
          </p>
        ) : null}
        {checkProblem ? <Alert tone="error">{checkProblem}</Alert> : null}
        {check ? <ComposeChecks check={check} /> : null}
        {!ready && info ? (
          <p className="text-sm text-slate-600">
            {info.needsLease ? 'Choose the lease to see the checks.' : 'Choose the property.'}
          </p>
        ) : null}
      </aside>
    </div>
  );
}

function FieldInput({
  field,
  label,
  required,
  value,
  error,
  invoices,
  onChange,
}: {
  readonly field: string;
  readonly label: string;
  readonly required: boolean;
  readonly value: string | readonly string[] | undefined;
  readonly error: string | null;
  readonly invoices: NonNullable<NoticeCompose['prefill']['arrears']>['invoices'];
  readonly onChange: (value: string | readonly string[]) => void;
}) {
  const kind = fieldKind(field);
  const shown = required ? label : `${label} (optional)`;
  const text = typeof value === 'string' ? value : '';
  if (kind === 'invoices') {
    const picked = Array.isArray(value) ? value : [];
    return (
      <fieldset className="space-y-2" data-testid={`field-${field}`}>
        <legend className="text-sm font-medium text-slate-800">{shown}</legend>
        {invoices.length === 0 ? (
          <p className="text-sm text-slate-600">No overdue invoice on the ledger for this lease.</p>
        ) : (
          invoices.map((invoice) => (
            <CheckboxField
              key={invoice.id}
              label={`${invoice.number ?? 'Invoice'} · due ${formatBusinessDate(invoice.dueDate)} · ${formatMinor(invoice.outstandingMinor)} outstanding`}
              checked={picked.includes(invoice.id)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...picked, invoice.id]
                    : picked.filter((id) => id !== invoice.id),
                )
              }
            />
          ))
        )}
        {error ? <p className="text-sm font-medium text-red-700">{error}</p> : null}
      </fieldset>
    );
  }
  if (kind === 'longText')
    return (
      <Field label={shown} error={error}>
        {(control) => (
          <textarea
            {...control}
            rows={field === 'details' ? 3 : 5}
            maxLength={4000}
            value={text}
            onChange={(event) => onChange(event.target.value)}
            className={controlClass}
          />
        )}
      </Field>
    );
  return (
    <TextField
      label={shown}
      type={kind === 'date' ? 'date' : kind === 'time' ? 'time' : 'text'}
      inputMode={kind === 'money' ? 'decimal' : undefined}
      hint={kind === 'money' ? 'In cedis, such as 1,500.00.' : undefined}
      value={text}
      error={error}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/** The API's answer for the planned notice, every warning shown prominently (plan 4.10). */
function ComposeChecks({ check }: { readonly check: NoticeCompose }) {
  const problem = effectiveProblem(check.effectiveCheck);
  const bar = quitBarText(check.quitBar);
  return (
    <>
      {check.blockers.length ? (
        <Alert tone="error" title="It cannot be issued as it stands">
          <ul className="list-disc space-y-1 pl-5" data-testid="notice-blockers">
            {check.blockers.map((b) => (
              <li key={b.code}>{b.message}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {problem ? (
        <Alert tone="error" title="The date is too early">
          <span data-testid="effective-problem">{problem}</span>
        </Alert>
      ) : null}
      {check.earliest ? (
        <Card>
          <CardBody>
            <p className="text-sm font-medium text-slate-900">Earliest lawful date</p>
            <p className="text-sm text-slate-700" data-testid="earliest-date">
              {earliestText(check.earliest)}
            </p>
          </CardBody>
        </Card>
      ) : null}
      {bar ? (
        <Alert
          tone={check.quitBar?.barred ? 'error' : 'info'}
          title="Rent Officer assessment (s.23)"
        >
          {bar}
        </Alert>
      ) : null}
      <NoticeWarnings warnings={orderedWarnings(check.warnings)} />
      {!check.template.counselReviewed &&
      !check.warnings.some((w) => w.code === 'counsel_wording_outstanding') ? (
        <Alert tone="warning" title={warningTitle({ code: 'counsel_wording_outstanding' })}>
          Template {check.template.key} version {check.template.version} has not been reviewed by
          counsel.
        </Alert>
      ) : null}
      <Card data-testid="compose-recipients">
        <CardHeader title="Who receives it" level={3} />
        <CardBody>
          {check.recipients.length === 0 ? (
            <p className="text-sm text-slate-600">Nobody yet.</p>
          ) : (
            <ul className="space-y-3 text-sm">
              {check.recipients.map((r) => (
                <li key={`${r.partyTenantId}-${r.name}`} className="space-y-1">
                  <p className="font-medium">
                    {r.name}
                    {r.unitCode ? (
                      <span className="ml-1 font-mono text-xs">{r.unitCode}</span>
                    ) : null}
                  </p>
                  <ul className="flex flex-wrap gap-1">
                    {r.channels.map((c) => (
                      <li key={c.channel}>
                        <Badge
                          tone={
                            c.mode === 'withheld'
                              ? 'amber'
                              : c.mode === 'service'
                                ? 'green'
                                : 'blue'
                          }
                        >
                          {noticeChannelName(c.channel)}: {CHANNEL_MODE_LABELS[c.mode]}
                          {c.reason ? ` (${NOTICE_WITHHELD_REASON_LABELS[c.reason]})` : ''}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                  {r.physicalServicePlanned ? (
                    <p className="text-amber-900">
                      Physical service is planned from the day it is issued.
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
      {check.prefill.arrears ? (
        <p className="text-sm text-slate-700">
          Arrears on the ledger: {formatMinor(check.prefill.arrears.amountMinor)} as of{' '}
          {formatBusinessDate(check.prefill.arrears.asOf)}.
        </p>
      ) : null}
    </>
  );
}
