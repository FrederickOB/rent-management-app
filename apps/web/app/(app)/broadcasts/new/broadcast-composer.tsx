'use client';

import type { BroadcastPreview } from '@rent/contracts';
import { CHANNEL_LABELS } from '@rent/domain/messaging';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { CheckboxField, Field, SelectField, TextField, controlClass } from '@/components/ui/field';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import {
  audienceOf,
  BODY_MAX,
  broadcastErrors,
  draftKey,
  EMPTY_BROADCAST,
  isAudienceChanged,
  PREVIEW_CHANNELS,
  reachText,
  sendLabel,
  TOPIC_MAX,
  UNREACHABLE_REASON_TEXT,
  type AudienceKind,
  type BroadcastDraft,
} from '@/lib/broadcasts';
import { outcomeOf } from '@/lib/idempotency';
import { toProblem } from '@/lib/errors';

type Option = { readonly id: string; readonly label: string };
type Preview = { readonly key: string; readonly result: BroadcastPreview };

const AUDIENCE_KINDS: readonly { readonly value: AudienceKind; readonly label: string }[] = [
  { value: 'property', label: 'Every tenant of a property' },
  { value: 'blocks', label: 'Tenants in some blocks of a property' },
  { value: 'group', label: 'A tenant group' },
];

/**
 * The broadcast composer (CM-08; plan 4.7). Nothing is sent until a preview has shown who can be
 * reached, on which channel, and who cannot and why. Sending carries the preview's token; if the
 * audience changed meanwhile the API refuses (409) and a fresh preview is shown to confirm again.
 */
export function BroadcastComposer() {
  const router = useRouter();
  const [draft, setDraft] = useState<BroadcastDraft>(EMPTY_BROADCAST);
  const [tried, setTried] = useState(false);
  const [properties, setProperties] = useState<readonly Option[]>([]);
  const [blocks, setBlocks] = useState<readonly Option[]>([]);
  const [groups, setGroups] = useState<readonly Option[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [changedNote, setChangedNote] = useState<string | null>(null);
  const inFlight = useRef(false);
  const errors = tried ? broadcastErrors(draft) : {};
  const key = draftKey(draft);
  const fresh = preview !== null && preview.key === key;

  const set = <K extends keyof BroadcastDraft>(field: K, value: BroadcastDraft[K]) =>
    setDraft((current) => ({ ...current, [field]: value }));

  useEffect(() => {
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
        (failure: unknown) => {
          if (current) setProblem(toProblem(failure).message);
        },
      );
    api()
      .tenantGroups.list({})
      .then(
        (list) => {
          if (current)
            setGroups(
              list
                .filter((g) => !g.archivedAt)
                .map((g) => ({ id: g.id, label: `${g.name} (${g.memberCount})` })),
            );
        },
        () => undefined,
      );
    return () => {
      current = false;
    };
  }, []);

  // A property's blocks, for a broadcast to some of them.
  const propertyId = draft.propertyId;
  useEffect(() => {
    setBlocks([]);
    if (!propertyId) return undefined;
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
  }, [propertyId]);

  async function runPreview(): Promise<BroadcastPreview | null> {
    setTried(true);
    setProblem(null);
    const audience = audienceOf(draft);
    if (Object.keys(broadcastErrors(draft)).length || !audience) return null;
    setPreviewing(true);
    try {
      const result = await api().broadcasts.preview({
        audience,
        topic: draft.topic.trim(),
        body: draft.body.trim(),
      });
      setPreview({ key, result });
      return result;
    } catch (failure) {
      setProblem(toProblem(failure).message);
      return null;
    } finally {
      setPreviewing(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setChangedNote(null);
    void runPreview();
  }

  async function send() {
    const audience = audienceOf(draft);
    if (!preview || !fresh || !audience || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setProblem(null);
    setChangedNote(null);
    try {
      const sent = await api().broadcasts.create({
        audience,
        topic: draft.topic.trim(),
        body: draft.body.trim(),
        previewToken: preview.result.previewToken,
      });
      router.push(`/broadcasts/${sent.id}?sent=1`);
    } catch (failure) {
      if (isAudienceChanged(failure)) {
        // Someone moved in or out, or consent changed, since the preview: show it again.
        setPreview(null);
        const again = await runPreview();
        setChangedNote(
          again
            ? 'The audience changed since the preview, so nothing was sent. Check the new preview below and send again.'
            : 'The audience changed since the preview, so nothing was sent. Preview it again.',
        );
      } else {
        setProblem(
          outcomeOf(failure) === 'unknown'
            ? `${toProblem(failure).message} It may have been sent: check the broadcast list before sending again.`
            : toProblem(failure).message,
        );
      }
      inFlight.current = false;
      setSending(false);
    }
  }

  return (
    <>
      <Card>
        <CardHeader title="Message" />
        <CardBody>
          <form onSubmit={submit} noValidate aria-label="Broadcast" className="space-y-4">
            <fieldset className="space-y-3">
              <legend className="text-sm font-medium text-slate-800">Who it goes to</legend>
              <SelectField
                label="Audience"
                value={draft.kind}
                options={AUDIENCE_KINDS.map((k) => ({ value: k.value, label: k.label }))}
                onChange={(event) => {
                  set('kind', event.target.value as AudienceKind);
                  set('blockIds', []);
                }}
              />
              {draft.kind === 'group' ? (
                <SelectField
                  label="Tenant group"
                  value={draft.groupId}
                  error={errors.audience}
                  options={[
                    { value: '', label: groups.length ? 'Choose a group' : 'No group yet' },
                    ...groups.map((g) => ({ value: g.id, label: g.label })),
                  ]}
                  onChange={(event) => set('groupId', event.target.value)}
                />
              ) : (
                <SelectField
                  label="Property"
                  value={draft.propertyId}
                  error={draft.kind === 'property' || !draft.propertyId ? errors.audience : null}
                  options={[
                    { value: '', label: 'Choose a property' },
                    ...properties.map((p) => ({ value: p.id, label: p.label })),
                  ]}
                  onChange={(event) => {
                    set('propertyId', event.target.value);
                    set('blockIds', []);
                  }}
                />
              )}
              {draft.kind === 'blocks' && draft.propertyId ? (
                <fieldset className="space-y-2" aria-describedby="blocks-problem">
                  <legend className="text-sm font-medium text-slate-800">Blocks</legend>
                  {blocks.map((block) => (
                    <CheckboxField
                      key={block.id}
                      label={block.label}
                      checked={draft.blockIds.includes(block.id)}
                      onChange={(event) =>
                        set(
                          'blockIds',
                          event.target.checked
                            ? [...draft.blockIds, block.id]
                            : draft.blockIds.filter((id) => id !== block.id),
                        )
                      }
                    />
                  ))}
                  {errors.audience ? (
                    <p id="blocks-problem" className="text-sm font-medium text-red-700">
                      {errors.audience}
                    </p>
                  ) : null}
                </fieldset>
              ) : null}
            </fieldset>
            <TextField
              label="Topic"
              hint="A few words for the WhatsApp building-notice template, such as “water supply” or “fumigation”."
              maxLength={TOPIC_MAX}
              value={draft.topic}
              error={errors.topic}
              onChange={(event) => set('topic', event.target.value)}
            />
            <Field
              label="Message"
              hint={`Up to ${BODY_MAX.toLocaleString('en-GB')} characters. Once sent it cannot be edited or recalled.`}
              error={errors.body}
            >
              {(control) => (
                <textarea
                  {...control}
                  rows={5}
                  maxLength={BODY_MAX}
                  value={draft.body}
                  onChange={(event) => set('body', event.target.value)}
                  className={controlClass}
                />
              )}
            </Field>
            <Button type="submit" variant={fresh ? 'secondary' : 'primary'} pending={previewing}>
              {preview && !fresh ? 'Preview again' : 'Preview who it reaches'}
            </Button>
            {preview && !fresh ? (
              <Alert tone="warning">
                You changed the message or its audience since the preview. Preview it again before
                sending.
              </Alert>
            ) : null}
            {problem ? <Alert tone="error">{problem}</Alert> : null}
          </form>
        </CardBody>
      </Card>

      {changedNote ? <Alert tone="warning">{changedNote}</Alert> : null}

      {preview && fresh ? (
        <PreviewCard preview={preview.result} sending={sending} onSend={() => void send()} />
      ) : null}
    </>
  );
}

function PreviewCard({
  preview,
  sending,
  onSend,
}: {
  readonly preview: BroadcastPreview;
  readonly sending: boolean;
  readonly onSend: () => void;
}) {
  return (
    <Card data-testid="broadcast-preview">
      <CardHeader
        title="Who it reaches"
        description="Each tenant gets it on the first channel they agreed to; if that fails it falls back to the next."
      />
      <CardBody>
        <p className="text-base font-medium text-slate-900" data-testid="preview-reach">
          {reachText(preview)}
        </p>
        <Table caption="Tenants reached, by first channel">
          <thead>
            <tr>
              {PREVIEW_CHANNELS.map((channel) => (
                <Th key={channel} className="text-right">
                  {CHANNEL_LABELS[channel]}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr data-testid="preview-channels">
              {PREVIEW_CHANNELS.map((channel) => (
                <Td key={channel} className="text-right tabular-nums">
                  {preview.byChannel[channel]}
                </Td>
              ))}
            </tr>
          </tbody>
        </Table>
        {preview.unreachable.length ? (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-900">
              Who it cannot reach ({preview.unreachable.length})
            </h3>
            <ul className="divide-y divide-slate-100 text-sm" aria-label="Cannot be reached">
              {preview.unreachable.map((tenant) => (
                <li key={tenant.tenantId} data-testid="preview-unreachable" className="py-2">
                  <span className="font-medium">{tenant.name}</span>
                  {tenant.unitCode ? (
                    <span className="ml-2 font-mono text-xs text-slate-600">{tenant.unitCode}</span>
                  ) : null}
                  <span className="ml-2 text-slate-700">
                    {UNREACHABLE_REASON_TEXT[tenant.reason]}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-sm text-slate-700">Every tenant in the audience can be reached.</p>
        )}
        {preview.reachableCount > 0 ? (
          <Button pending={sending} onClick={onSend}>
            {sendLabel(preview.reachableCount)}
          </Button>
        ) : (
          <Alert tone="info">
            Nobody in this audience can be reached, so there is nothing to send.
          </Alert>
        )}
      </CardBody>
    </Card>
  );
}
