'use client';

import type { ArtisanView } from '@rent/contracts';
import { MAINTENANCE_CATEGORIES, MAINTENANCE_CATEGORY_LABELS } from '@rent/domain/maintenance';
import { useCallback, useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { Empty, LoadFailed, Loading } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { CheckboxField, SelectField, TextField } from '@/components/ui/field';
import { api } from '@/lib/api';
import {
  artisanInput,
  artisanPatch,
  consentText,
  draftOfArtisan,
  emptyArtisan,
  tradesText,
  type ArtisanDraft,
  type ArtisanField,
} from '@/lib/artisans';
import { toProblem } from '@/lib/errors';
import { formatDate } from '@/lib/format';
import { categoryOf } from '@/lib/maintenance';
import { useLoad } from '@/lib/use-load';

/** The company's artisans: add, change trades and consent, archive (decision 6). */
export function ArtisansView() {
  const [archived, setArchived] = useState(false);
  const [trade, setTrade] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [archiving, setArchiving] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(
    () =>
      api().artisans.list({
        archived: archived ? 'true' : 'false',
        ...(categoryOf(trade) ? { trade: categoryOf(trade)! } : {}),
      }),
    [archived, trade],
  );
  const { state, reload } = useLoad(load);

  const done = (text: string) => {
    setNotice(text);
    setAdding(false);
    setEditing(null);
    setArchiving(null);
    reload();
  };

  return (
    <>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {adding ? (
        <Card>
          <CardHeader
            title="Add an artisan"
            description="Only their name, phone and trades, and the channels they agreed to. Ask them before you tick a channel."
          />
          <CardBody>
            <ArtisanForm
              onDone={(artisan) => done(`Added ${artisan.name}.`)}
              onCancel={() => setAdding(false)}
            />
          </CardBody>
        </Card>
      ) : null}
      <Card>
        <CardHeader
          title={archived ? 'Archived artisans' : 'Artisans'}
          actions={
            !adding ? (
              <Button
                onClick={() => {
                  setAdding(true);
                  setNotice(null);
                }}
              >
                Add an artisan
              </Button>
            ) : null
          }
        />
        <CardBody>
          <div className="flex flex-wrap items-end gap-4">
            <SelectField
              label="Trade"
              value={trade}
              options={[
                { value: '', label: 'Every trade' },
                ...MAINTENANCE_CATEGORIES.map((c) => ({
                  value: c,
                  label: MAINTENANCE_CATEGORY_LABELS[c],
                })),
              ]}
              onChange={(event) => setTrade(event.target.value)}
              className="min-w-48"
            />
            <CheckboxField
              label="Show archived artisans"
              checked={archived}
              onChange={(event) => setArchived(event.target.checked)}
              className="pb-2"
            />
          </div>
          {state.status === 'loading' ? <Loading what="the artisans" /> : null}
          {state.status === 'error' ? (
            <LoadFailed message={state.problem.message} onRetry={reload} />
          ) : null}
          {state.status === 'ready' && state.data.length === 0 ? (
            <Empty>{archived ? 'No artisan is archived.' : 'No artisan has been added yet.'}</Empty>
          ) : null}
          {state.status === 'ready' && state.data.length > 0 ? (
            <ul className="divide-y divide-slate-100">
              {state.data.map((artisan) => (
                <ArtisanRow
                  key={artisan.id}
                  artisan={artisan}
                  editing={editing === artisan.id}
                  archiving={archiving === artisan.id}
                  onEdit={() => {
                    setEditing(editing === artisan.id ? null : artisan.id);
                    setArchiving(null);
                    setNotice(null);
                  }}
                  onArchive={() => {
                    setArchiving(archiving === artisan.id ? null : artisan.id);
                    setEditing(null);
                    setNotice(null);
                  }}
                  onDone={done}
                />
              ))}
            </ul>
          ) : null}
        </CardBody>
      </Card>
    </>
  );
}

function ArtisanRow({
  artisan,
  editing,
  archiving,
  onEdit,
  onArchive,
  onDone,
}: {
  readonly artisan: ArtisanView;
  readonly editing: boolean;
  readonly archiving: boolean;
  readonly onEdit: () => void;
  readonly onArchive: () => void;
  readonly onDone: (text: string) => void;
}) {
  const { timeZone } = useApp();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = artisan.archivedAt === null;

  async function archive() {
    setPending(true);
    setError(null);
    try {
      await api().artisans.archive({ artisanId: artisan.id });
      onDone(`Archived ${artisan.name}. Open job sheets keep working until their jobs close.`);
    } catch (failure) {
      setError(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <li className="space-y-2 py-3 text-sm" data-testid="artisan-row">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <p className="flex flex-wrap items-center gap-2">
            <span className="text-base font-semibold text-slate-900">{artisan.name}</span>
            {!live ? <Badge tone="dark">Archived</Badge> : null}
            {artisan.openJobs > 0 ? (
              <Badge tone="blue">
                {artisan.openJobs} open {artisan.openJobs === 1 ? 'job' : 'jobs'}
              </Badge>
            ) : null}
          </p>
          <p className="text-slate-700">
            <span className="font-mono">{artisan.phoneMasked}</span> · {tradesText(artisan.trades)}
          </p>
          <p className="text-slate-600">
            Agreed to be contacted on: {consentText(artisan.consent)} · added{' '}
            {formatDate(artisan.createdAt, timeZone)}
          </p>
        </div>
        {live ? (
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" aria-expanded={editing} onClick={onEdit}>
              Change <span className="sr-only">{artisan.name}</span>
            </Button>
            <Button size="sm" variant="secondary" aria-expanded={archiving} onClick={onArchive}>
              Archive <span className="sr-only">{artisan.name}</span>
            </Button>
          </div>
        ) : null}
      </div>
      {editing ? (
        <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
          <ArtisanForm
            artisan={artisan}
            onDone={(next) => onDone(`Saved the changes for ${next.name}.`)}
            onCancel={onEdit}
          />
        </div>
      ) : null}
      {archiving ? (
        <div
          role="group"
          aria-label={`Confirm archiving ${artisan.name}`}
          className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-4"
        >
          <p>
            Archive {artisan.name}? No new work can be sent to them. Their history stays, and open
            job sheets keep working until those jobs close.
          </p>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <div className="flex gap-2">
            <Button size="sm" pending={pending} onClick={() => void archive()}>
              Archive
            </Button>
            <Button size="sm" variant="ghost" onClick={onArchive}>
              Keep them
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/** Add an artisan, or change one: name, trades and consent. The phone is set when added. */
function ArtisanForm({
  artisan,
  onDone,
  onCancel,
}: {
  readonly artisan?: ArtisanView;
  readonly onDone: (artisan: ArtisanView) => void;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState<ArtisanDraft>(() =>
    artisan ? draftOfArtisan(artisan) : emptyArtisan,
  );
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = artisanInput(draft, { needPhone: !artisan });
  const errors: Partial<Record<ArtisanField, string>> = tried ? parsed.errors : {};

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    const input = parsed.input;
    if (!input) return;
    setPending(true);
    try {
      if (artisan) {
        const patch = artisanPatch(artisan, draft);
        if (Object.keys(patch).length === 0) {
          onCancel();
          return;
        }
        onDone(await api().artisans.update({ artisanId: artisan.id, ...patch }));
      } else {
        onDone(await api().artisans.create(input));
      }
    } catch (failure) {
      setError(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  const toggleTrade = (trade: (typeof MAINTENANCE_CATEGORIES)[number], on: boolean) =>
    setDraft((d) => ({
      ...d,
      trades: on ? [...d.trades, trade] : d.trades.filter((t) => t !== trade),
    }));

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={artisan ? `Change ${artisan.name}` : 'Add an artisan'}
      className="space-y-4"
    >
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Name"
          autoComplete="off"
          maxLength={120}
          value={draft.name}
          error={errors.name}
          onChange={(event) => setDraft((d) => ({ ...d, name: event.target.value }))}
        />
        {artisan ? (
          <div className="space-y-1 text-sm">
            <p className="font-medium text-slate-800">Phone</p>
            <p className="font-mono">{artisan.phoneMasked}</p>
            <p className="text-slate-600">To change the number, archive them and add them again.</p>
          </div>
        ) : (
          <TextField
            label="Phone number"
            type="tel"
            autoComplete="off"
            hint="For example 024 412 3456 or +233 24 412 3456."
            maxLength={20}
            value={draft.phone}
            error={errors.phone}
            onChange={(event) => setDraft((d) => ({ ...d, phone: event.target.value }))}
          />
        )}
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-slate-800">Trades</legend>
        <div className="grid gap-1 sm:grid-cols-3">
          {MAINTENANCE_CATEGORIES.map((c) => (
            <CheckboxField
              key={c}
              label={MAINTENANCE_CATEGORY_LABELS[c]}
              checked={draft.trades.includes(c)}
              onChange={(event) => toggleTrade(c, event.target.checked)}
            />
          ))}
        </div>
        {errors.trades ? <p className="text-sm font-medium text-red-700">{errors.trades}</p> : null}
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-slate-800">
          Channels they agreed to be contacted on
        </legend>
        <p className="text-sm text-slate-600">
          Job sheets and reminders go only on these. Each change is kept as a consent record.
        </p>
        <CheckboxField
          label="WhatsApp"
          checked={draft.whatsapp}
          onChange={(event) => setDraft((d) => ({ ...d, whatsapp: event.target.checked }))}
        />
        <CheckboxField
          label="SMS"
          checked={draft.sms}
          onChange={(event) => setDraft((d) => ({ ...d, sms: event.target.checked }))}
        />
        {errors.consent ? (
          <p className="text-sm font-medium text-red-700">{errors.consent}</p>
        ) : null}
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={pending}>
          {artisan ? 'Save the changes' : 'Add the artisan'}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
