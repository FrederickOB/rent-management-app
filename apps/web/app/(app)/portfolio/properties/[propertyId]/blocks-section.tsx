'use client';

import type { PropertyDetailView } from '@rent/contracts';
import { checkBlockCode } from '@rent/domain/portfolio';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { StatusBadge } from '@/components/status-badge';
import { UnitBatches } from '@/components/unit-batches';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { TextField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import {
  batchesInvalid,
  codeInput,
  newBatch,
  nextBlockCode,
  toBatchInputs,
  unitTotal,
  type BatchDraft,
} from '@/lib/property-wizard';
import { domainProblem, unitTypeLabel } from '@/lib/register-format';

type Block = PropertyDetailView['blocks'][number];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Blocks with a grid of their units (PR-01): add a block, rename one, add units in bulk. */
export function BlocksSection({
  property,
  canManage,
  onChanged,
  onReplaced,
}: {
  readonly property: PropertyDetailView;
  readonly canManage: boolean;
  /** Something changed on the server; reload the property and say so. */
  readonly onChanged: (message: string) => Promise<void>;
  /** The API answered with the whole property already. */
  readonly onReplaced: (next: PropertyDetailView, message: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <section aria-labelledby="blocks-heading" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="blocks-heading" className="text-lg font-semibold text-slate-900">
          Blocks and units
        </h2>
        {canManage && !adding ? (
          <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
            Add a block
          </Button>
        ) : null}
      </div>
      {adding ? (
        <AddBlockForm
          property={property}
          onAdded={(next, message) => {
            setAdding(false);
            onReplaced(next, message);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : null}
      {property.blocks.length === 0 ? (
        <p className="text-sm text-slate-600">No blocks yet.</p>
      ) : null}
      {property.blocks.map((block) => (
        <BlockCard key={block.id} block={block} canManage={canManage} onChanged={onChanged} />
      ))}
    </section>
  );
}

function BlockCard({
  block,
  canManage,
  onChanged,
}: {
  readonly block: Block;
  readonly canManage: boolean;
  readonly onChanged: (message: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<'view' | 'rename' | 'add'>('view');
  const [name, setName] = useState(block.name ?? '');
  const [batches, setBatches] = useState<BatchDraft[]>([newBatch()]);
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = `Block ${block.code}${block.name ? ` · ${block.name}` : ''}`;

  function open(next: 'rename' | 'add') {
    setMode(next);
    setError(null);
    setTried(false);
    setName(block.name ?? '');
    setBatches([newBatch(block.units[block.units.length - 1]?.unitType ?? '')]);
  }

  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api().register.renameBlock({ blockId: block.id, name: name.trim() || null });
      setMode('view');
      await onChanged(`Renamed block ${block.code}.`);
    } catch (failure) {
      setError(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  async function addUnits(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    if (batches.length === 0 || batchesInvalid(batches)) return;
    setPending(true);
    try {
      const added = await api().register.addUnits({
        blockId: block.id,
        batches: toBatchInputs(batches),
      });
      setMode('view');
      await onChanged(
        `Added ${plural(added.unitIds.length, 'unit', 'units')} to block ${block.code}.`,
      );
    } catch (failure) {
      setError(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card data-testid="block">
      <CardHeader
        level={3}
        title={title}
        description={plural(block.units.length, 'unit', 'units')}
        actions={
          canManage && mode === 'view' ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                aria-label={`Rename block ${block.code}`}
                onClick={() => open('rename')}
              >
                Rename
              </Button>
              <Button
                variant="secondary"
                size="sm"
                aria-label={`Add units to block ${block.code}`}
                onClick={() => open('add')}
              >
                Add units
              </Button>
            </>
          ) : null
        }
      />
      <CardBody>
        {error ? <Alert tone="error">{error}</Alert> : null}
        {mode === 'rename' ? (
          <form
            onSubmit={rename}
            aria-label={`Rename block ${block.code}`}
            className="flex flex-wrap items-end gap-2 rounded-md border border-slate-200 bg-slate-50 p-3"
          >
            <TextField
              label="Block name"
              hint="Leave empty for no name. The code stays the same."
              className="min-w-0 flex-1"
              maxLength={60}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <div className="flex gap-2 pb-6">
              <Button type="submit" pending={pending}>
                Save
              </Button>
              <Button variant="ghost" onClick={() => setMode('view')}>
                Cancel
              </Button>
            </div>
          </form>
        ) : null}
        {mode === 'add' ? (
          <form
            onSubmit={addUnits}
            aria-label={`Add units to block ${block.code}`}
            className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3"
          >
            <p className="text-sm text-slate-700">
              New units are numbered after the highest number this block has ever used, so no code
              is handed out twice.
            </p>
            <UnitBatches batches={batches} onChange={setBatches} showErrors={tried} />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" pending={pending} disabled={batches.length === 0}>
                Add {plural(unitTotal(batches), 'unit', 'units')}
              </Button>
              <Button variant="ghost" onClick={() => setMode('view')}>
                Cancel
              </Button>
            </div>
          </form>
        ) : null}
        {block.units.length ? (
          <ul
            className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4"
            aria-label={`Units in block ${block.code}`}
          >
            {block.units.map((unit) => (
              <li key={unit.id}>
                <Link
                  href={`/portfolio/units/${unit.id}`}
                  data-testid="unit-tile"
                  className="block h-full space-y-1 rounded-md border border-slate-200 bg-white p-2 hover:border-slate-400 hover:bg-slate-50"
                >
                  <span className="block font-mono text-sm font-semibold break-all text-slate-900">
                    {unit.code}
                  </span>
                  <span className="block text-xs text-slate-600">
                    {unitTypeLabel(unit.unitType, unit.bedrooms)}
                  </span>
                  <StatusBadge status={unit.status} underRepair={unit.underRepair} />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-600">No units in this block yet.</p>
        )}
      </CardBody>
    </Card>
  );
}

function AddBlockForm({
  property,
  onAdded,
  onCancel,
}: {
  readonly property: PropertyDetailView;
  readonly onAdded: (next: PropertyDetailView, message: string) => void;
  readonly onCancel: () => void;
}) {
  const [code, setCode] = useState(() => nextBlockCode(property.blocks));
  const [name, setName] = useState('');
  const [batches, setBatches] = useState<BatchDraft[]>([]);
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeError =
    domainProblem(() => checkBlockCode(code)) ??
    (property.blocks.some((b) => b.code === code) ? `There is already a block ${code}` : null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    if (codeError || batchesInvalid(batches)) return;
    setPending(true);
    try {
      const next = await api().register.addBlock({
        propertyId: property.id,
        code,
        name: name.trim() || null,
        ...(batches.length ? { units: toBatchInputs(batches) } : {}),
      });
      onAdded(
        next,
        `Added block ${code}${batches.length ? ` with ${plural(unitTotal(batches), 'unit', 'units')}` : ''}.`,
      );
    } catch (failure) {
      setError(toProblem(failure).message);
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader level={3} title="Add a block" description="A building, a wing or a floor." />
      <CardBody>
        <form onSubmit={submit} noValidate aria-label="Add a block" className="space-y-4">
          {error ? <Alert tone="error">{error}</Alert> : null}
          <div className="grid gap-4 sm:grid-cols-[8rem_minmax(0,1fr)]">
            <TextField
              label="Block code"
              hint="1 to 3 letters or digits."
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              value={code}
              error={tried ? codeError : undefined}
              onChange={(event) => setCode(codeInput(event.target.value, 3))}
            />
            <TextField
              label="Block name (optional)"
              maxLength={60}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <UnitBatches batches={batches} onChange={setBatches} showErrors={tried} allowEmpty />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" pending={pending}>
              Add block
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
