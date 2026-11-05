import { DomainError } from '../errors';
import type { UnitType } from '../portfolio/unit-types';

/**
 * Inspections (MI-10; M8 decision 10): routine, move-in and move-out, room by room from a
 * checklist template per unit type. Each item records a condition, a note and photos (stamped with
 * the server's time). Once submitted an inspection is frozen; a correction is a new inspection that
 * references the old one.
 */
export const INSPECTION_KINDS = ['routine', 'move_in', 'move_out'] as const;
export type InspectionKind = (typeof INSPECTION_KINDS)[number];

export const INSPECTION_KIND_LABELS: Record<InspectionKind, string> = {
  routine: 'Routine inspection',
  move_in: 'Move-in inspection',
  move_out: 'Move-out inspection',
};

export const INSPECTION_STATUSES = ['in_progress', 'submitted'] as const;
export type InspectionStatus = (typeof INSPECTION_STATUSES)[number];

export const INSPECTION_CONDITIONS = [
  'good',
  'fair',
  'poor',
  'damaged',
  'missing',
  'not_applicable',
] as const;
export type InspectionCondition = (typeof INSPECTION_CONDITIONS)[number];

export const INSPECTION_CONDITION_LABELS: Record<InspectionCondition, string> = {
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
  damaged: 'Damaged',
  missing: 'Missing',
  not_applicable: 'Not applicable',
};

/** One room of a checklist, with its items. Keys are stable, so move-out matches move-in. */
export interface InspectionRoom {
  readonly key: string;
  readonly label: string;
  readonly items: readonly { readonly key: string; readonly label: string }[];
}

const room = (key: string, label: string, items: readonly string[]): InspectionRoom => ({
  key,
  label,
  items: items.map((label) => ({
    key: label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, ''),
    label,
  })),
});

const FINISHES = ['Walls', 'Ceiling', 'Floor', 'Doors', 'Windows', 'Lights and sockets'];

/** The rooms every home has, by bedroom count (decision 10's defaults). */
function homeRooms(bedrooms: number): InspectionRoom[] {
  const rooms = [room('living_room', 'Living room', FINISHES)];
  for (let i = 1; i <= Math.max(1, bedrooms); i += 1)
    rooms.push(
      room(`bedroom_${i}`, bedrooms > 1 ? `Bedroom ${i}` : 'Bedroom', [...FINISHES, 'Wardrobe']),
    );
  rooms.push(
    room('kitchen', 'Kitchen', [...FINISHES, 'Sink and taps', 'Cabinets', 'Worktop']),
    room('bathroom', 'Bathroom', [...FINISHES, 'Toilet', 'Shower or bath', 'Basin and taps']),
  );
  return rooms;
}

const COMMON = [
  room('compound', 'Compound', ['Gate', 'Walls and fence', 'Drains']),
  room('meters_and_keys', 'Meters and keys', [
    'Electricity meter',
    'Water meter',
    'Keys handed over',
  ]),
];

/**
 * The default checklist for a unit type (decision 10): living room, bedrooms by count, kitchen,
 * bathrooms, the compound, meters and keys. Rooms and commercial units get a shorter list. Each
 * company edits its own copy.
 */
export function defaultInspectionRooms(
  unitType: UnitType,
  bedrooms?: number | null,
): InspectionRoom[] {
  switch (unitType) {
    case 'single_room':
    case 'single_room_self_contained':
    case 'studio':
      return [
        room('room', 'Room', [...FINISHES, 'Wardrobe']),
        ...(unitType === 'single_room'
          ? []
          : [
              room('bathroom', 'Bathroom', [
                ...FINISHES,
                'Toilet',
                'Shower or bath',
                'Basin and taps',
              ]),
            ]),
        ...COMMON,
      ];
    case 'chamber_and_hall':
      return [
        room('hall', 'Hall', FINISHES),
        room('chamber', 'Chamber', [...FINISHES, 'Wardrobe']),
        ...COMMON,
      ];
    case 'shop':
    case 'store':
    case 'office':
    case 'warehouse':
    case 'kiosk':
      return [
        room('main_space', 'Main space', [...FINISHES, 'Shutters or security doors']),
        room('toilet', 'Toilet', ['Toilet', 'Basin and taps', 'Floor']),
        room('meters_and_keys', 'Meters and keys', [
          'Electricity meter',
          'Water meter',
          'Keys handed over',
        ]),
      ];
    default:
      return [...homeRooms(bedrooms ?? 2), ...COMMON];
  }
}

/** A checklist as a company edits it: 1 to 30 rooms of 1 to 40 items, keys unique. */
export function checkInspectionRooms(rooms: readonly InspectionRoom[]): InspectionRoom[] {
  if (rooms.length < 1 || rooms.length > 30)
    throw new DomainError('inspection.rooms', 'A checklist has 1 to 30 rooms');
  const roomKeys = new Set<string>();
  return rooms.map((r) => {
    const key = r.key.trim();
    if (!/^[a-z0-9_]{1,40}$/.test(key) || roomKeys.has(key))
      throw new DomainError('inspection.room_key', 'Each room needs its own short key');
    roomKeys.add(key);
    const label = r.label.trim();
    if (label.length < 1 || label.length > 80)
      throw new DomainError('inspection.room_label', 'Name each room (up to 80 characters)');
    if (r.items.length < 1 || r.items.length > 40)
      throw new DomainError('inspection.items', `${label} needs 1 to 40 items`);
    const itemKeys = new Set<string>();
    return {
      key,
      label,
      items: r.items.map((i) => {
        const k = i.key.trim();
        if (!/^[a-z0-9_]{1,40}$/.test(k) || itemKeys.has(k))
          throw new DomainError('inspection.item_key', `Each item in ${label} needs its own key`);
        itemKeys.add(k);
        const l = i.label.trim();
        if (l.length < 1 || l.length > 80)
          throw new DomainError('inspection.item_label', 'Name each item (up to 80 characters)');
        return { key: k, label: l };
      }),
    };
  });
}

/** An inspection is submitted once every item has a condition (decision 10). */
export function checkInspectionSubmittable(
  items: readonly {
    readonly roomKey: string;
    readonly itemKey: string;
    readonly condition: InspectionCondition | null;
  }[],
): void {
  const missing = items.filter((i) => i.condition === null);
  if (items.length === 0) throw new DomainError('inspection.empty', 'The inspection has no items');
  if (missing.length > 0)
    throw new DomainError(
      'inspection.incomplete',
      `Record a condition for every item: ${missing.length} still have none`,
    );
}

/** Once submitted, an inspection never changes (decision 10). */
export function checkInspectionEditable(status: InspectionStatus): void {
  if (status === 'submitted')
    throw new DomainError(
      'inspection.submitted',
      'This inspection has been submitted; record a correction as a new inspection',
    );
}

/** A condition worse at move-out than at move-in, for the deductions screen (MI-11). */
const RANK: Record<InspectionCondition, number> = {
  good: 0,
  fair: 1,
  poor: 2,
  damaged: 3,
  missing: 4,
  not_applicable: -1,
};

export function conditionWorsened(
  moveIn: InspectionCondition | null,
  moveOut: InspectionCondition | null,
): boolean {
  if (!moveOut || moveOut === 'not_applicable') return false;
  if (!moveIn || moveIn === 'not_applicable') return RANK[moveOut] >= RANK.poor;
  return RANK[moveOut] > RANK[moveIn];
}
