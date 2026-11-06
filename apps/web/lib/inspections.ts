import type { ApiClient } from '@rent/contracts/client';
import {
  INSPECTION_CONDITIONS,
  INSPECTION_CONDITION_LABELS,
  INSPECTION_KIND_LABELS,
  type InspectionCondition,
  type InspectionKind,
} from '@rent/domain/maintenance';
import { UNIT_TYPE_LABELS, type UnitType } from '@rent/domain/portfolio';

// Inspections (MI-10; M8 decision 10): room by room from the unit type's checklist, each item
// with a condition, a note and photos stamped with the server's time. Submitted ones are frozen;
// a correction is a new inspection that references the old one.

export type InspectionDetail = Awaited<ReturnType<ApiClient['inspections']['get']>>;
export type InspectionItem = InspectionDetail['items'][number];
export type InspectionRow = Awaited<ReturnType<ApiClient['inspections']['list']>>[number];
export type InspectionTemplate = Awaited<ReturnType<ApiClient['inspections']['templates']>>[number];
export type MoveInReport = Awaited<ReturnType<ApiClient['inspections']['moveInReport']>>;

export const conditionOf = (value: string): InspectionCondition | null =>
  INSPECTION_CONDITIONS.find((c) => c === value) ?? null;

export const CONDITION_OPTIONS = INSPECTION_CONDITIONS.map((c) => ({
  value: c,
  label: INSPECTION_CONDITION_LABELS[c],
}));

export const kindLabel = (kind: InspectionKind): string => INSPECTION_KIND_LABELS[kind];

export const conditionLabel = (condition: InspectionCondition | null): string =>
  condition ? INSPECTION_CONDITION_LABELS[condition] : 'Not recorded';

export interface InspectionRoomView<I> {
  readonly key: string;
  readonly label: string;
  readonly items: readonly I[];
  /** Items with a condition recorded. */
  readonly done: number;
  /** Items worse than at move-in (move-out only). */
  readonly worsened: number;
}

/** Items in their rooms, in the checklist's order, with each room's progress. */
export function roomsOf<
  I extends Pick<InspectionItem, 'roomKey' | 'roomLabel' | 'condition' | 'worsened'>,
>(items: readonly I[]): InspectionRoomView<I>[] {
  const rooms = new Map<string, { label: string; items: I[] }>();
  for (const item of items) {
    const room = rooms.get(item.roomKey) ?? { label: item.roomLabel, items: [] };
    room.items.push(item);
    rooms.set(item.roomKey, room);
  }
  return [...rooms].map(([key, room]) => ({
    key,
    label: room.label,
    items: room.items,
    done: room.items.filter((i) => i.condition !== null).length,
    worsened: room.items.filter((i) => i.worsened).length,
  }));
}

/** "12 of 30 items recorded". */
export function progressText(done: number, total: number): string {
  return `${done} of ${total} ${total === 1 ? 'item' : 'items'} recorded`;
}

/**
 * Whether it can be submitted (every item needs a condition, as the API checks), and if not, how
 * many are left: said beside the button so nobody wonders why it is off.
 */
export function submitReadiness(
  items: readonly Pick<InspectionItem, 'condition'>[],
  /**
   * Review WEB 2: photos chosen but not yet added, and items still saving, hold the submission
   * too, so nothing on the phone is lost when the inspection freezes.
   */
  pending?: { readonly unsentPhotos: number; readonly saving: number },
): {
  readonly ready: boolean;
  readonly left: number;
  readonly text: string;
} {
  const left = items.filter((i) => i.condition === null).length;
  const base =
    items.length === 0
      ? { ready: false, left: 0, text: 'This checklist has no items.' }
      : left === 0
        ? {
            ready: true,
            left,
            text: 'Every item has a condition. Once submitted, the inspection cannot change; a mistake is corrected by a new inspection.',
          }
        : {
            ready: false,
            left,
            text: `${left} ${left === 1 ? 'item still needs' : 'items still need'} a condition before it can be submitted.`,
          };
  if (!pending) return base;
  const held: string[] = [];
  if (pending.unsentPhotos > 0)
    held.push(
      `${pending.unsentPhotos} chosen ${pending.unsentPhotos === 1 ? 'photo has' : 'photos have'} not been added yet: add or remove ${pending.unsentPhotos === 1 ? 'it' : 'them'} first.`,
    );
  if (pending.saving > 0) held.push('Wait until everything is saved.');
  if (held.length === 0) return base;
  return {
    ready: false,
    left,
    text: base.ready ? held.join(' ') : `${base.text} ${held.join(' ')}`,
  };
}

/** The status for people: in progress, submitted, or submitted and corrected later. */
export function inspectionStatusText(
  inspection: Pick<InspectionRow, 'status' | 'correctedBy'>,
): string {
  if (inspection.status === 'in_progress') return 'In progress';
  return inspection.correctedBy ? 'Submitted, corrected later' : 'Submitted';
}

/** The move-in comparison on a move-out item, in words, for the side-by-side view (plan 4.6). */
export function moveInText(item: Pick<InspectionItem, 'moveIn'>): string | null {
  if (!item.moveIn) return null;
  const note = item.moveIn.note?.trim();
  return `At move-in: ${conditionLabel(item.moveIn.condition)}${note ? `. ${note}` : ''}`;
}

const NOTE_MAX = 1000;

export function itemNoteProblem(note: string): string | null {
  return note.trim().length > NOTE_MAX
    ? `Use at most ${NOTE_MAX.toLocaleString('en-GB')} characters`
    : null;
}

// Checklist templates (decision 10) --------------------------------------------------------------

export const unitTypeLabel = (type: UnitType): string => UNIT_TYPE_LABELS[type];

export interface TemplateDraftRoom {
  readonly key: string;
  readonly label: string;
  /** One item per line. */
  readonly items: string;
}

export const draftOfTemplate = (template: Pick<InspectionTemplate, 'rooms'>): TemplateDraftRoom[] =>
  template.rooms.map((room) => ({
    key: room.key,
    label: room.label,
    items: room.items.map((i) => i.label).join('\n'),
  }));

/** A stable key from a label, as the domain makes them: lower case, words joined by `_`. */
export function keyOf(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);
}

export type TemplateRoomsInput = {
  key: string;
  label: string;
  items: { key: string; label: string }[];
}[];

/**
 * The rooms as the API takes them, or why not. Keys stay stable for rooms and items that keep
 * their label, so a move-out still matches its move-in item by item; a new label gets a new key.
 */
export function templateInput(
  rooms: readonly TemplateDraftRoom[],
  before: Pick<InspectionTemplate, 'rooms'>,
): {
  readonly rooms: TemplateRoomsInput | null;
  readonly errors: Readonly<Record<number, string>>;
} {
  const errors: Record<number, string> = {};
  const out: TemplateRoomsInput = [];
  const roomKeys = new Set<string>();
  rooms.forEach((room, index) => {
    const label = room.label.trim();
    const lines = room.items
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const existing = before.rooms.find((r) => r.key === room.key);
    let key = room.key && existing && existing.label === label ? room.key : keyOf(label);
    if (!label || label.length > 80) {
      errors[index] = 'Give the room a name of up to 80 characters';
      return;
    }
    if (!key) {
      errors[index] = 'Use letters or numbers in the room’s name';
      return;
    }
    while (roomKeys.has(key)) key = `${key.slice(0, 37)}_${roomKeys.size + 1}`.slice(0, 40);
    roomKeys.add(key);
    if (lines.length === 0 || lines.length > 40) {
      errors[index] = 'List 1 to 40 items, one per line';
      return;
    }
    const itemKeys = new Set<string>();
    const items: { key: string; label: string }[] = [];
    for (const line of lines) {
      if (line.length > 80) {
        errors[index] = `“${line.slice(0, 30)}…” is longer than 80 characters`;
        return;
      }
      const kept = existing?.items.find((i) => i.label === line)?.key;
      let itemKey = kept ?? keyOf(line);
      if (!itemKey) {
        errors[index] = `Use letters or numbers in “${line}”`;
        return;
      }
      while (itemKeys.has(itemKey))
        itemKey = `${itemKey.slice(0, 37)}_${itemKeys.size + 1}`.slice(0, 40);
      itemKeys.add(itemKey);
      items.push({ key: itemKey, label: line });
    }
    out.push({ key, label, items });
  });
  if (rooms.length === 0) return { rooms: null, errors: { 0: 'Keep at least one room' } };
  if (rooms.length > 30) return { rooms: null, errors: { 0: 'Use at most 30 rooms' } };
  return Object.keys(errors).length > 0 ? { rooms: null, errors } : { rooms: out, errors: {} };
}

// The move-in report (TL-08; decision 11) ---------------------------------------------------------

export const MOVE_IN_REPORT_STATUS_LABELS: Record<MoveInReport['status'], string> = {
  rendering: 'Being prepared',
  pending: 'Out for signature',
  completed: 'Signed by everyone',
  cancelled: 'Withdrawn',
};

export const SIGNER_STATUS_LABELS: Record<MoveInReport['signers'][number]['status'], string> = {
  pending: 'Not signed yet',
  signed: 'Signed',
  declined: 'Declined',
};

/** "2 of 3 have signed". */
export function signedText(
  signers: readonly Pick<MoveInReport['signers'][number], 'status'>[],
): string {
  const signed = signers.filter((s) => s.status === 'signed').length;
  return `${signed} of ${signers.length} ${signers.length === 1 ? 'has' : 'have'} signed`;
}
