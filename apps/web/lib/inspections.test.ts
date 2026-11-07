import type { ArtisanView, ExpenseRow } from '@rent/contracts';
import { describe, expect, it } from 'vitest';
import {
  artisanInput,
  artisanPatch,
  assignable,
  consentText,
  draftOfArtisan,
  emptyArtisan,
  tradesText,
} from './artisans';
import {
  DEFAULT_EXPENSE_FILTERS,
  emptyExpense,
  expenseInput,
  expenseQuery,
  expensesTotal,
  paidByOptions,
  payInput,
} from './expenses';
import {
  draftOfTemplate,
  inspectionStatusText,
  keyOf,
  moveInText,
  progressText,
  roomsOf,
  signedText,
  submitReadiness,
  templateInput,
} from './inspections';
import {
  hoursText,
  maintenanceSettingsDraftOf,
  maintenanceSettingsPatch,
} from './maintenance-settings';
import { artisanOptions, staffOptions } from './use-assignees';

const ID = '019a3000-0000-7000-8000-0000000000e1';
const ID2 = '019a3000-0000-7000-8000-0000000000e2';

const item = (
  roomKey: string,
  condition: 'good' | 'poor' | null,
  worsened = false,
): {
  roomKey: string;
  roomLabel: string;
  condition: 'good' | 'poor' | null;
  worsened: boolean;
} => ({
  roomKey,
  roomLabel: roomKey === 'kitchen' ? 'Kitchen' : 'Living room',
  condition,
  worsened,
});

describe('MI-10 inspections room by room', () => {
  it('groups items into rooms in order, with each room’s progress and items worse than at move-in', () => {
    const rooms = roomsOf([
      item('living_room', 'good'),
      item('kitchen', null),
      item('living_room', 'poor', true),
      item('kitchen', 'good'),
    ]);
    expect(rooms.map((r) => [r.key, r.label, r.items.length, r.done, r.worsened])).toEqual([
      ['living_room', 'Living room', 2, 2, 1],
      ['kitchen', 'Kitchen', 2, 1, 0],
    ]);
    expect(progressText(3, 4)).toBe('3 of 4 items recorded');
    expect(progressText(1, 1)).toBe('1 of 1 item recorded');
  });

  it('can be submitted only with a condition on every item, and says how many are left', () => {
    expect(
      submitReadiness([{ condition: 'good' }, { condition: null }, { condition: null }]),
    ).toEqual({
      ready: false,
      left: 2,
      text: '2 items still need a condition before it can be submitted.',
    });
    expect(submitReadiness([{ condition: 'good' }]).ready).toBe(true);
    expect(submitReadiness([]).ready).toBe(false);
  });

  it('shows the move-in result beside a move-out item, and that a later one corrects it', () => {
    expect(
      moveInText({ moveIn: { itemId: ID, condition: 'good', note: 'New paint', photos: [] } }),
    ).toBe('At move-in: Good. New paint');
    expect(moveInText({ moveIn: { itemId: ID, condition: null, note: null, photos: [] } })).toBe(
      'At move-in: Not recorded',
    );
    expect(moveInText({ moveIn: null })).toBeNull();
    expect(inspectionStatusText({ status: 'submitted', correctedBy: { id: ID } })).toBe(
      'Submitted, corrected later',
    );
    expect(inspectionStatusText({ status: 'in_progress', correctedBy: null })).toBe('In progress');
  });
});

describe('MI-10 decision 10 checklists keep their keys so move-out matches move-in', () => {
  const before = {
    rooms: [
      {
        key: 'kitchen',
        label: 'Kitchen',
        items: [
          { key: 'sink', label: 'Sink' },
          { key: 'walls', label: 'Walls' },
        ],
      },
    ],
  };

  it('edits rooms as one item per line', () => {
    expect(draftOfTemplate(before)).toEqual([
      { key: 'kitchen', label: 'Kitchen', items: 'Sink\nWalls' },
    ]);
  });

  it('keeps the keys of rooms and items whose label stayed, and makes keys for new ones', () => {
    const result = templateInput(
      [
        { key: 'kitchen', label: 'Kitchen', items: 'Sink\n\n Walls \nCooker hood' },
        { key: '', label: 'Boys’ quarters', items: 'Door' },
      ],
      before,
    );
    expect(result.rooms).toEqual([
      {
        key: 'kitchen',
        label: 'Kitchen',
        items: [
          { key: 'sink', label: 'Sink' },
          { key: 'walls', label: 'Walls' },
          { key: 'cooker_hood', label: 'Cooker hood' },
        ],
      },
      { key: 'boys_quarters', label: 'Boys’ quarters', items: [{ key: 'door', label: 'Door' }] },
    ]);
  });

  it('refuses a room without a name or items, and repeats of a key', () => {
    expect(templateInput([{ key: '', label: ' ', items: 'Door' }], before).errors).toEqual({
      0: 'Give the room a name of up to 80 characters',
    });
    expect(templateInput([{ key: '', label: 'Hall', items: '  ' }], before).errors).toEqual({
      0: 'List 1 to 40 items, one per line',
    });
    const twice = templateInput(
      [
        { key: '', label: 'Bedroom', items: 'Door\nDoor' },
        { key: '', label: 'Bedroom', items: 'Door' },
      ],
      before,
    ).rooms!;
    expect(twice.map((r) => r.key)).toEqual(['bedroom', 'bedroom_2']);
    expect(twice[0]!.items.map((i) => i.key)).toEqual(['door', 'door_2']);
    expect(keyOf('Meters & keys!')).toBe('meters_keys');
  });

  it('counts the move-in report’s signers', () => {
    expect(signedText([{ status: 'signed' }, { status: 'pending' }])).toBe('1 of 2 have signed');
  });
});

// Artisans (decision 6) -------------------------------------------------------------------------

const artisan: ArtisanView = {
  id: ID,
  name: 'Kwame Plumbing (demo)',
  phoneMasked: '+233 ** *** 4567',
  trades: ['plumbing'],
  consent: { whatsapp: true, sms: false },
  archivedAt: null,
  openJobs: 0,
  createdAt: '2026-11-05T09:00:00.000Z',
};

describe('MI-04 decision 6 artisans with their channel consent', () => {
  it('needs a name, a Ghana phone, a trade and at least one channel they agreed to', () => {
    expect(artisanInput(emptyArtisan).errors).toEqual({
      name: 'Enter their name',
      phone: 'Enter their phone number',
      trades: 'Choose at least one trade',
      consent:
        'Record at least one channel they agreed to. Without one, no job sheet can be sent to them.',
    });
    expect(
      artisanInput({
        name: 'Ama (demo)',
        phone: '024 412 3456',
        trades: ['electrical', 'plumbing'],
        whatsapp: false,
        sms: true,
      }).input,
    ).toEqual({
      name: 'Ama (demo)',
      phone: '024 412 3456',
      trades: ['plumbing', 'electrical'],
      consent: { whatsapp: false, sms: true },
    });
    expect(artisanInput({ ...emptyArtisan, phone: '12' }).errors.phone).toContain(
      'phone number such as',
    );
  });

  it('sends only what changed when editing, without asking for the phone again', () => {
    const draft = draftOfArtisan(artisan);
    expect(artisanInput(draft, { needPhone: false }).errors).toEqual({});
    expect(artisanPatch(artisan, draft)).toEqual({});
    expect(artisanPatch(artisan, { ...draft, sms: true, trades: ['plumbing', 'roofing'] })).toEqual(
      {
        trades: ['plumbing', 'roofing'],
        consent: { whatsapp: true, sms: true },
      },
    );
  });

  it('describes their consent and trades, and offers only reachable, live artisans', () => {
    expect(consentText({ whatsapp: true, sms: true })).toBe('WhatsApp and SMS');
    expect(consentText({ whatsapp: false, sms: false })).toBe('None: no job sheet can be sent');
    expect(tradesText(['plumbing', 'pest_control'])).toBe('Plumbing, Pest control');
    expect(assignable(artisan)).toBe(true);
    expect(assignable({ ...artisan, archivedAt: '2026-11-05T09:00:00.000Z' })).toBe(false);
    expect(assignable({ ...artisan, consent: { whatsapp: false, sms: false } })).toBe(false);
    expect(artisanOptions([artisan])).toEqual([
      {
        value: `artisan:${ID}`,
        label: 'Kwame Plumbing (demo), artisan (plumbing)',
        kind: 'artisan',
      },
    ]);
  });

  it('lists active staff to assign, and leaves whether they may attend to the API', () => {
    const row = {
      membershipId: ID,
      personId: ID2,
      name: 'Kojo (demo)',
      email: null,
      phoneMasked: '+233 ** *** 0011',
      role: 'caretaker' as const,
      status: 'active' as const,
      nominatedApprover: false,
      scope: {},
      createdAt: '2026-11-05T09:00:00.000Z',
    };
    expect(staffOptions([row, { ...row, personId: ID, status: 'revoked' }])).toEqual([
      { value: `staff:${ID2}`, label: 'Kojo (demo) (caretaker)', kind: 'staff' },
    ]);
  });
});

// Expenses (AC-03, decision 8) ----------------------------------------------------------------------

describe('AC-03 expenses with receipts, linked to repairs', () => {
  const today = '2026-11-05';

  it('records an expense as integer pesewas, owed until paid', () => {
    const draft = {
      ...emptyExpense(today, ID, ID2),
      supplierName: ' Kwame Plumbing ',
      amount: '450.50',
      paidBy: 'unpaid' as const,
    };
    expect(draft.category).toBe('repairs');
    expect(expenseInput(draft, today, false)).toEqual({
      input: {
        propertyId: ID2,
        unitId: null,
        category: 'repairs',
        supplierName: 'Kwame Plumbing',
        amountMinor: 450_50,
        expenseDate: today,
        paidBy: 'unpaid',
        jobId: ID,
        note: null,
      },
      errors: {},
    });
  });

  it('refuses a future date, a bad amount and the agency’s account for a landlord', () => {
    const errors = expenseInput(
      {
        ...emptyExpense(today),
        propertyId: ID,
        category: 'rates',
        supplierName: 'AMA',
        amount: '1.234',
        expenseDate: '2026-11-06',
        paidBy: 'agent',
      },
      today,
      false,
    ).errors;
    expect(errors).toEqual({
      amount: 'Enter an amount in cedis, such as 1500 or 1,500.50',
      expenseDate: 'The date cannot be in the future',
      paidBy: 'Only an agency pays from its own account',
    });
    expect(paidByOptions(false).map((o) => o.value)).toEqual(['owner', 'unpaid']);
    expect(paidByOptions(true).map((o) => o.value)).toEqual(['owner', 'agent', 'unpaid']);
  });

  it('pays a payable later, not before its date', () => {
    expect(
      payInput(
        { paidOn: today, paidFrom: 'owner_account', reference: '' },
        { expenseDate: '2026-11-01' },
        today,
      ),
    ).toEqual({
      input: { paidOn: today, paidFrom: 'owner_account', reference: null },
      errors: {},
    });
    expect(
      payInput(
        { paidOn: '2026-10-30', paidFrom: '', reference: '' },
        { expenseDate: '2026-11-01' },
        today,
      ).errors,
    ).toEqual({
      paidOn: 'It cannot be paid before the expense date',
      paidFrom: 'Choose the account it was paid from',
    });
  });

  it('counts a job’s cost without reversed expenses, and filters the list', () => {
    const rows = [
      { amountMinor: 100_00, status: 'paid' },
      { amountMinor: 50_00, status: 'reversed' },
      { amountMinor: 25_00, status: 'unpaid' },
    ] as Pick<ExpenseRow, 'amountMinor' | 'status'>[];
    expect(expensesTotal(rows)).toBe(125_00);
    expect(
      expenseQuery({ ...DEFAULT_EXPENSE_FILTERS, from: '2026-11-30', to: '2026-11-01', jobId: ID }),
    ).toEqual({
      from: '2026-11-01',
      to: '2026-11-30',
      jobId: ID,
    });
    expect(expenseQuery({ ...DEFAULT_EXPENSE_FILTERS, propertyId: 'x', status: 'unpaid' })).toEqual(
      { status: 'unpaid' },
    );
  });
});

// Settings (decisions 4 and 7) ----------------------------------------------------------------------

describe('MI-02 and MI-06 maintenance settings, with the domain’s defaults', () => {
  it('starts from the defaults where the company set none', () => {
    const draft = maintenanceSettingsDraftOf({} as never);
    expect(draft.targets.emergency).toEqual({ respondHours: '2', completeHours: '24' });
    expect(draft.targets.routine).toEqual({ respondHours: '72', completeHours: '336' });
    expect(draft.autoCloseDays).toBe('7');
  });

  it('saves whole hours, the response before the completion, and 1 to 60 days', () => {
    const draft = maintenanceSettingsDraftOf({} as never);
    expect(maintenanceSettingsPatch(draft)).toEqual({
      patch: {
        maintenanceTargets: {
          emergency: { respondHours: 2, completeHours: 24 },
          urgent: { respondHours: 24, completeHours: 72 },
          routine: { respondHours: 72, completeHours: 336 },
        },
        maintenanceAutoCloseDays: 7,
      },
    });
    const wrong = maintenanceSettingsPatch({
      targets: {
        ...draft.targets,
        urgent: { respondHours: '80', completeHours: '72' },
        routine: { respondHours: '0', completeHours: 'x' },
      },
      autoCloseDays: '61',
    });
    expect('errors' in wrong && wrong.errors).toEqual({
      'urgent.respond': 'The response target must come before the completion target',
      'routine.respond': 'Whole hours from 1 to 2,160 (90 days)',
      'routine.complete': 'Whole hours from 1 to 2,160 (90 days)',
      autoClose: 'Whole days from 1 to 60',
    });
  });

  it('says a number of hours in days and hours', () => {
    expect(hoursText(2)).toBe('2 hours');
    expect(hoursText(24)).toBe('1 day');
    expect(hoursText(336)).toBe('14 days');
    expect(hoursText(25)).toBe('1 day and 1 hour');
  });
});
