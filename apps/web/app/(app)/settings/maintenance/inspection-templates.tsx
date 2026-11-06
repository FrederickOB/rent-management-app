'use client';

import { useCallback, useState, type FormEvent } from 'react';
import { LoadFailed, Loading } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { SelectField, TextAreaField, TextField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import {
  draftOfTemplate,
  templateInput,
  unitTypeLabel,
  type InspectionTemplate,
  type TemplateDraftRoom,
} from '@/lib/inspections';
import { useLoad } from '@/lib/use-load';

/**
 * The checklist per unit type (MI-10, decision 10): rooms, and items within each, from the
 * defaults or the company's own copy. Inspections already started keep the checklist they began
 * with; keys stay stable so a move-out still matches its move-in item by item.
 */
export function InspectionTemplates() {
  const load = useCallback(() => api().inspections.templates(), []);
  const { state, reload } = useLoad(load);
  const [unitType, setUnitType] = useState<string>('');

  const templates = state.status === 'ready' ? state.data : [];
  const chosen = templates.find((t) => t.unitType === unitType) ?? templates[0] ?? null;

  return (
    <Card data-testid="inspection-templates">
      <CardHeader
        title="Inspection checklists"
        description="Each unit type has a checklist of rooms and items. Change your company’s copy, or go back to the default."
      />
      <CardBody>
        {state.status === 'loading' ? <Loading what="the checklists" /> : null}
        {state.status === 'error' ? (
          <LoadFailed message={state.problem.message} onRetry={reload} />
        ) : null}
        {templates.length > 0 && chosen ? (
          <>
            <SelectField
              label="Unit type"
              value={chosen.unitType}
              options={templates.map((t) => ({
                value: t.unitType,
                label: `${unitTypeLabel(t.unitType)}${t.customised ? ' (your own copy)' : ''}`,
              }))}
              onChange={(event) => setUnitType(event.target.value)}
              className="max-w-sm"
            />
            <TemplateEditor
              key={`${chosen.unitType}-${chosen.updatedAt ?? 'default'}`}
              template={chosen}
              onSaved={reload}
            />
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}

function TemplateEditor({
  template,
  onSaved,
}: {
  readonly template: InspectionTemplate;
  readonly onSaved: () => void;
}) {
  const [rooms, setRooms] = useState<TemplateDraftRoom[]>(() => draftOfTemplate(template));
  const [errors, setErrors] = useState<Readonly<Record<number, string>>>({});
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProblem(null);
    setNotice(null);
    const parsed = templateInput(rooms, template);
    setErrors(parsed.errors);
    if (!parsed.rooms) return;
    setPending(true);
    try {
      await api().inspections.updateTemplate({ unitType: template.unitType, rooms: parsed.rooms });
      setNotice(`Saved the checklist for ${unitTypeLabel(template.unitType).toLowerCase()} units.`);
      onSaved();
    } catch (failure) {
      setProblem(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  async function reset() {
    setPending(true);
    setProblem(null);
    try {
      await api().inspections.resetTemplate({ unitType: template.unitType });
      setResetting(false);
      onSaved();
    } catch (failure) {
      setProblem(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  const update = (index: number, next: Partial<TemplateDraftRoom>) =>
    setRooms((r) => r.map((room, i) => (i === index ? { ...room, ...next } : room)));

  return (
    <form onSubmit={save} noValidate aria-label="Inspection checklist" className="space-y-4">
      <p className="text-sm">
        <Badge tone={template.customised ? 'blue' : 'neutral'}>
          {template.customised ? 'Your own copy' : 'The default checklist'}
        </Badge>
      </p>
      {problem ? <Alert tone="error">{problem}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {rooms.map((room, index) => (
        <fieldset
          key={index}
          className="space-y-2 rounded-md border border-slate-200 p-3"
          data-testid="template-room"
        >
          <legend className="px-1 text-sm font-semibold text-slate-900">Room {index + 1}</legend>
          <TextField
            label="Room"
            maxLength={80}
            value={room.label}
            onChange={(event) => update(index, { label: event.target.value })}
          />
          <TextAreaField
            label="Items, one per line"
            rows={Math.min(10, Math.max(3, room.items.split('\n').length + 1))}
            value={room.items}
            onChange={(event) => update(index, { items: event.target.value })}
            className="[&_textarea]:font-sans"
          />
          {errors[index] ? (
            <p className="text-sm font-medium text-red-700">{errors[index]}</p>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            disabled={rooms.length <= 1}
            onClick={() => setRooms((r) => r.filter((_, i) => i !== index))}
          >
            Remove this room
          </Button>
        </fieldset>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={rooms.length >= 30}
          onClick={() => setRooms((r) => [...r, { key: '', label: '', items: '' }])}
        >
          Add a room
        </Button>
        <Button type="submit" pending={pending}>
          Save the checklist
        </Button>
        {template.customised && !resetting ? (
          <Button variant="ghost" onClick={() => setResetting(true)}>
            Go back to the default
          </Button>
        ) : null}
      </div>
      {resetting ? (
        <div
          role="group"
          aria-label="Confirm going back to the default"
          className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm"
        >
          <p>
            Go back to the default checklist? Your changes to it are replaced. Inspections already
            started keep theirs.
          </p>
          <div className="flex gap-2">
            <Button size="sm" pending={pending} onClick={() => void reset()}>
              Go back to the default
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setResetting(false)}>
              Keep my copy
            </Button>
          </div>
        </div>
      ) : null}
    </form>
  );
}
