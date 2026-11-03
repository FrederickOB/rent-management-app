import type { SettlementAccountView } from '@rent/contracts';
import { describe, expect, it } from 'vitest';
import {
  agreementChanges,
  destinationProblem,
  holderLabel,
  mayRetire,
  nameCheck,
  SETTLEMENT_LIMITS,
  settlementForm,
  settlementStatusNote,
  sortAccounts,
  emptySettlementDraft,
  openRequestOf,
  REVEAL_REASON,
  type SettlementDraft,
} from './settlement';

const OWNER = '019a3000-0000-7000-8000-0000000000a1';
const OTHER_OWNER = '019a3000-0000-7000-8000-0000000000a2';
const ACCRA = 'Africa/Accra';

let n = 0;
function account(overrides: Partial<SettlementAccountView> = {}): SettlementAccountView {
  n += 1;
  return {
    id: `019a3000-0000-7000-8000-${String(n).padStart(12, '0')}`,
    holder: 'owner',
    ownerId: OWNER,
    ownerName: 'Nana Owner-Accra (demo)',
    bankCode: 'GCB',
    bankName: 'GCB Bank',
    branch: 'Legon',
    accountNameChecked: 'NANA OWNER-ACCRA',
    accountName: 'Nana Owner-Accra',
    numberMasked: '•••• 4821',
    status: 'active',
    usableFrom: '2026-10-01T09:00:00.000Z',
    providerReady: true,
    createdAt: '2026-09-30T09:00:00.000Z',
    approvalId: null,
    ...overrides,
  };
}

const draft = (overrides: Partial<SettlementDraft> = {}): SettlementDraft => ({
  ...emptySettlementDraft('owner'),
  ownerId: OWNER,
  bankCode: 'GCB',
  accountNumber: '1234 5678 9012',
  accountName: '  Nana Owner-Accra ',
  ...overrides,
});

describe('ADR-008 settlement accounts on screen', () => {
  it('says from when an approved account takes rent, in the company’s time zone', () => {
    const now = new Date('2026-11-03T10:00:00.000Z');
    expect(
      settlementStatusNote(
        { status: 'cooling_off', usableFrom: '2026-11-04T09:30:00.000Z', providerReady: false },
        ACCRA,
        now,
      ),
    ).toBe('It takes rent from 4 Nov 2026, 09:30 GMT (Africa/Accra).');
    expect(
      settlementStatusNote(
        { status: 'cooling_off', usableFrom: '2026-11-03T09:30:00.000Z', providerReady: false },
        ACCRA,
        now,
      ),
    ).toMatch(/24 hours have passed/);
  });

  it('says an account in use cannot take rent until the provider has it', () => {
    expect(settlementStatusNote(account({ providerReady: false }), ACCRA)).toMatch(
      /Not set up with the payment provider yet/,
    );
    expect(settlementStatusNote(account(), ACCRA)).toBeNull();
    expect(settlementStatusNote(account({ status: 'awaiting_approval' }), ACCRA)).toMatch(
      /until a second person approves it/,
    );
  });

  it('names whose account it is', () => {
    expect(holderLabel(account(), 'agency')).toBe('Nana Owner-Accra (demo)’s account');
    expect(holderLabel(account({ holder: 'agency', ownerName: null }), 'agency')).toBe(
      'The agency’s client account',
    );
    expect(holderLabel(account({ holder: 'agency', ownerName: null }), 'landlord')).toBe(
      'Your company’s account',
    );
  });

  it('shows the bank’s name for the account, and warns when it differs from the one typed', () => {
    expect(nameCheck(account()).kind).toBe('matches');
    expect(nameCheck(account({ accountNameChecked: 'nana  owner accra' })).kind).toBe('matches');
    const differs = nameCheck(account({ accountNameChecked: 'KWAME MENSAH' }));
    expect(differs.kind).toBe('differs');
    expect(differs.text).toContain('“KWAME MENSAH”');
    expect(differs.text).toContain('before approving');
    expect(nameCheck(account({ accountNameChecked: null })).kind).toBe('unchecked');
  });

  it('lists what is waiting first, then what is in use, then the rest, newest first', () => {
    const old = account({ status: 'active', createdAt: '2026-01-01T00:00:00.000Z' });
    const newer = account({ status: 'active', createdAt: '2026-06-01T00:00:00.000Z' });
    const waiting = account({ status: 'awaiting_approval' });
    const retired = account({ status: 'retired' });
    expect(sortAccounts([retired, old, waiting, newer]).map((a) => a.id)).toEqual([
      waiting.id,
      newer.id,
      old.id,
      retired.id,
    ]);
  });

  it('offers retiring only an account that takes, or is about to take, rent', () => {
    const added = '019a3000-0000-7000-8000-0000000000f1';
    // Its approvalId is the request that added it, long since decided.
    expect(mayRetire(account({ approvalId: added }))).toBe(true);
    expect(mayRetire(account({ status: 'cooling_off' }))).toBe(true);
    expect(mayRetire(account({ status: 'retired' }))).toBe(false);
    expect(mayRetire(account({ status: 'rejected' }))).toBe(false);
    expect(mayRetire(account({ status: 'awaiting_approval' }))).toBe(false);
  });

  it('shows the request still waiting on an account, and offers no second one', () => {
    const waiting = '019a3000-0000-7000-8000-0000000000f5';
    const retiring = account({ openRequest: { kind: 'retire', approvalId: waiting } });
    expect(mayRetire(retiring)).toBe(false);
    expect(openRequestOf(retiring)).toEqual({
      approvalId: waiting,
      text: 'Retiring it is waiting for a second person. Rent still settles into it until the request is approved.',
    });
    expect(
      openRequestOf(
        account({ status: 'awaiting_approval', openRequest: { kind: 'add', approvalId: waiting } }),
      )?.text,
    ).toBe('Adding it is waiting for a second person.');
    expect(openRequestOf(account({ openRequest: null }))).toBeNull();
    expect(openRequestOf(account())).toBeNull();
  });

  it('CLAUDE.md section 10 takes the reveal reason limits from the API’s contract', () => {
    expect(REVEAL_REASON).toEqual({ min: 5, max: 500 });
  });
});

describe('ADR-008 asking to add a settlement account', () => {
  it('sends the digits only, the name trimmed and no branch when none is given', () => {
    const { input, errors } = settlementForm(draft(), { agency: true });
    expect(errors).toEqual({});
    expect(input).toEqual({
      holder: 'owner',
      ownerId: OWNER,
      bankCode: 'GCB',
      branch: null,
      accountNumber: '123456789012',
      accountName: 'Nana Owner-Accra',
    });
  });

  it('sends no owner for the agency’s own client account', () => {
    const { input } = settlementForm(draft({ holder: 'agency', ownerId: OTHER_OWNER }), {
      agency: true,
    });
    expect(input?.holder).toBe('agency');
    expect(input?.ownerId).toBeNull();
  });

  it('refuses what the API would refuse, field by field', () => {
    const { input, errors } = settlementForm(
      draft({ holder: '', bankCode: '', accountNumber: '12AB', accountName: 'N' }),
      { agency: true },
    );
    expect(input).toBeNull();
    expect(Object.keys(errors).sort()).toEqual(
      ['accountName', 'accountNumber', 'bankCode', 'holder'].sort(),
    );
    expect(settlementForm(draft({ ownerId: '' }), { agency: true }).errors.ownerId).toBe(
      'Choose the owner',
    );
    expect(settlementForm(draft({ accountNumber: '12345' }), { agency: true }).errors).toEqual({
      accountNumber: 'Enter the account number: 6 to 20 digits, nothing else',
    });
  });

  it('takes the name and branch limits from the API’s contract', () => {
    expect(SETTLEMENT_LIMITS).toEqual({ nameMin: 2, nameMax: 160, branchMax: 120 });
    const long = 'x'.repeat(SETTLEMENT_LIMITS.nameMax + 1);
    expect(settlementForm(draft({ accountName: long }), { agency: true }).errors.accountName).toBe(
      'Use at most 160 characters',
    );
  });

  it('never offers a landlord company an agency account', () => {
    expect(settlementForm(draft({ holder: 'agency' }), { agency: false }).errors.holder).toBe(
      'Choose the owner whose account it is',
    );
  });
});

describe('decision 6 where each agency owner’s rent goes', () => {
  const agreement = (destination: 'owner_account' | 'agency_client_account' | null) => ({
    ownerId: OWNER,
    destination,
  });

  it('has no default: pay links wait until the agency chooses', () => {
    expect(destinationProblem(agreement(null), [account()])).toBe('no_agreement');
  });

  it('needs an account in use at the chosen destination, set up with the provider', () => {
    expect(destinationProblem(agreement('owner_account'), [account()])).toBeNull();
    expect(
      destinationProblem(agreement('owner_account'), [account({ ownerId: OTHER_OWNER })]),
    ).toBe('no_active_account');
    expect(
      destinationProblem(agreement('owner_account'), [account({ status: 'cooling_off' })]),
    ).toBe('no_active_account');
    expect(
      destinationProblem(agreement('owner_account'), [account({ providerReady: false })]),
    ).toBe('no_subaccount');
    expect(destinationProblem(agreement('agency_client_account'), [account()])).toBe(
      'no_active_account',
    );
    expect(
      destinationProblem(agreement('agency_client_account'), [
        account({ holder: 'agency', ownerId: null, ownerName: null }),
      ]),
    ).toBeNull();
  });
});

describe('M4b review a change to where rent goes waits for approval', () => {
  const approval = '019a3000-0000-7000-8000-0000000000f8';

  it('shows an approved change still to start, and one waiting for a second person', () => {
    expect(
      agreementChanges({
        next: { destination: 'agency_client_account', effectiveFrom: '2026-11-05' },
        openRequest: null,
      }),
    ).toEqual({
      next: 'Approved: the agency’s client account from 5 Nov 2026.',
      waiting: null,
    });
    expect(
      agreementChanges({
        next: null,
        openRequest: {
          approvalId: approval,
          destination: 'owner_account',
          effectiveFrom: '2026-11-03',
        },
      }).waiting,
    ).toBe(
      'Waiting for a second person: the owner’s own account from 3 Nov 2026, or 24 hours after approval if that is later.',
    );
    expect(agreementChanges({})).toEqual({ next: null, waiting: null });
  });
});
