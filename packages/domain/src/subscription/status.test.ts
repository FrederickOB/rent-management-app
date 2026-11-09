import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addDays, parseBusinessDate, toIsoDate } from '../dates';
import { SUBSCRIPTION_STATUSES, type SubscriptionStatus } from './constants';
import {
  assertTransition,
  billingStartsOn,
  canTransition,
  cancelEffectiveOn,
  readOnlyUntil,
  subscriptionAccess,
  subscriptionStatus,
  trialEndsOn,
  type SubscriptionFacts,
} from './status';

const facts = (over: Partial<SubscriptionFacts> = {}): SubscriptionFacts => ({
  today: '2026-11-20',
  trialEndsOn: null,
  cancelsOn: null,
  oldestUnpaidDueOn: null,
  graceDays: 14,
  readOnlyEnabled: true,
  ...over,
});

const plus = (date: string, days: number): string =>
  toIsoDate(addDays(parseBusinessDate(date), days));

const errorCode = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'no code';
  }
};

describe('PB-08 trial (decision 5)', () => {
  it('counts the creation day in a 30-day trial, and billing starts the day after it', () => {
    expect(trialEndsOn('2026-11-01', 30)).toBe('2026-11-30');
    expect(trialEndsOn('2026-10-15', 30)).toBe('2026-11-13');
    expect(billingStartsOn('2026-11-13')).toBe('2026-11-14');
    // No trial: the last trial day is the day before creation, so billing starts at once.
    expect(trialEndsOn('2026-11-01', 0)).toBe('2026-10-31');
    expect(billingStartsOn(null)).toBeNull();
    expect(() => trialEndsOn('2026-11-01', -1)).toThrow(/whole number/);
  });

  it('is trialing through the trial’s last day, then active with nothing owed (no Expired state)', () => {
    expect(subscriptionStatus(facts({ today: '2026-11-13', trialEndsOn: '2026-11-13' }))).toBe(
      'trialing',
    );
    expect(subscriptionStatus(facts({ today: '2026-11-14', trialEndsOn: '2026-11-13' }))).toBe(
      'active',
    );
    expect(SUBSCRIPTION_STATUSES).not.toContain('expired');
  });
});

describe('PB-11 past due and read-only (decision 11)', () => {
  const due = '2026-11-08';

  it('is past due the day after the due date and read-only from due + grace, with the switch on', () => {
    const at = (today: string, over: Partial<SubscriptionFacts> = {}) =>
      subscriptionStatus(facts({ today, oldestUnpaidDueOn: due, ...over }));
    expect(at('2026-11-08')).toBe('active');
    expect(at('2026-11-09')).toBe('past_due');
    expect(at('2026-11-21')).toBe('past_due');
    expect(at('2026-11-22')).toBe('read_only');
    expect(at('2026-11-22', { readOnlyEnabled: false })).toBe('past_due');
    expect(at('2026-12-31', { readOnlyEnabled: false })).toBe('past_due');
  });

  it('gives full access until then, read-only after, and says from when', () => {
    const access = (today: string, over: Partial<SubscriptionFacts> = {}) =>
      subscriptionAccess(facts({ today, oldestUnpaidDueOn: due, ...over }));
    expect(access('2026-11-08')).toEqual({ access: 'full', readOnlyFrom: null });
    expect(access('2026-11-09')).toEqual({ access: 'full', readOnlyFrom: '2026-11-22' });
    expect(access('2026-11-22')).toEqual({ access: 'read_only', readOnlyFrom: '2026-11-22' });
    expect(access('2026-11-22', { readOnlyEnabled: false })).toEqual({
      access: 'full',
      readOnlyFrom: null,
    });
    // Paid: full access at once.
    expect(access('2026-11-22', { oldestUnpaidDueOn: null })).toEqual({
      access: 'full',
      readOnlyFrom: null,
    });
  });

  it('never makes an invoice read-only on its due date, even with no grace', () => {
    expect(subscriptionStatus(facts({ today: due, oldestUnpaidDueOn: due, graceDays: 0 }))).toBe(
      'active',
    );
    expect(
      subscriptionStatus(facts({ today: plus(due, 1), oldestUnpaidDueOn: due, graceDays: 0 })),
    ).toBe('read_only');
    expect(() => subscriptionStatus(facts({ graceDays: -1 }))).toThrow(/whole number/);
  });

  it('keeps read-only through a scheduled cancellation: only paying lifts it', () => {
    const f = facts({ today: '2026-11-25', oldestUnpaidDueOn: due, cancelsOn: '2026-11-30' });
    expect(subscriptionStatus(f)).toBe('cancel_scheduled');
    expect(subscriptionAccess(f).access).toBe('read_only');
  });
});

describe('PB-10 cancelling (decision 12)', () => {
  it('ends service at the end of this month, or at the trial’s end if sooner', () => {
    expect(cancelEffectiveOn({ today: '2026-11-07', status: 'active', trialEndsOn: null })).toBe(
      '2026-11-30',
    );
    expect(cancelEffectiveOn({ today: '2026-11-30', status: 'read_only', trialEndsOn: null })).toBe(
      '2026-11-30',
    );
    expect(
      cancelEffectiveOn({ today: '2026-11-07', status: 'trialing', trialEndsOn: '2026-11-20' }),
    ).toBe('2026-11-20');
    expect(
      cancelEffectiveOn({ today: '2026-11-07', status: 'trialing', trialEndsOn: '2026-12-06' }),
    ).toBe('2026-11-30');
    expect(
      cancelEffectiveOn({ today: '2026-11-07', status: 'trialing', trialEndsOn: '2026-11-07' }),
    ).toBe('2026-11-07');
  });

  it('refuses a second cancellation and one after the end', () => {
    expect(
      errorCode(() =>
        cancelEffectiveOn({ today: '2026-11-07', status: 'cancel_scheduled', trialEndsOn: null }),
      ),
    ).toBe('subscription.already_cancelling');
    expect(
      errorCode(() =>
        cancelEffectiveOn({ today: '2026-11-07', status: 'cancelled', trialEndsOn: null }),
      ),
    ).toBe('subscription.cancelled');
  });

  it('is scheduled through the last day of service, then cancelled and read-only', () => {
    const f = (today: string) => facts({ today, cancelsOn: '2026-11-30' });
    expect(subscriptionStatus(f('2026-11-30'))).toBe('cancel_scheduled');
    expect(subscriptionAccess(f('2026-11-30')).access).toBe('full');
    expect(subscriptionStatus(f('2026-12-01'))).toBe('cancelled');
    expect(subscriptionAccess(f('2026-12-01')).access).toBe('read_only');
    // A cancellation outranks a trial.
    expect(
      subscriptionStatus(
        facts({ today: '2026-11-10', trialEndsOn: '2026-11-20', cancelsOn: '2026-11-20' }),
      ),
    ).toBe('cancel_scheduled');
  });

  it('keeps staff read-only for the retention period after it', () => {
    expect(readOnlyUntil('2026-11-30', 90)).toBe('2027-02-28');
    expect(readOnlyUntil('2026-11-30', 0)).toBe('2026-11-30');
  });
});

describe('PB-07 the subscription state machine', () => {
  /** Rows: from; columns: to, in SUBSCRIPTION_STATUSES order. 1 = allowed. */
  const TABLE: Record<SubscriptionStatus, string> = {
    //                trialing active past_due read_only cancel_scheduled cancelled
    trialing: '011110',
    active: '101110',
    past_due: '110110',
    read_only: '111010',
    cancel_scheduled: '111101',
    cancelled: '000000',
  };

  it('allows exactly the transitions in the table', () => {
    for (const from of SUBSCRIPTION_STATUSES)
      SUBSCRIPTION_STATUSES.forEach((to, i) => {
        const allowed = TABLE[from][i] === '1';
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(allowed);
        expect(
          errorCode(() => assertTransition(from, to)),
          `${from} -> ${to}`,
        ).toBe(allowed ? null : 'subscription.bad_transition');
      });
  });

  it('refuses a status that does not exist', () => {
    expect(errorCode(() => assertTransition('expired' as never, 'active'))).toBe(
      'subscription.bad_transition',
    );
  });

  it('only ever moves along the table as days pass, invoices are paid and cancellations come and go', () => {
    const step = fc.record({
      days: fc.integer({ min: 1, max: 20 }),
      event: fc.constantFrom('none', 'invoice', 'pay', 'cancel', 'withdraw', 'switch'),
      dueIn: fc.integer({ min: 0, max: 10 }),
    });
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 60 }),
        fc.nat(30),
        fc.boolean(),
        fc.array(step, { minLength: 1, maxLength: 30 }),
        (trialDays, grace, readOnlyEnabled, steps) => {
          const created = '2026-01-10';
          let f: SubscriptionFacts = {
            today: created,
            trialEndsOn: trialEndsOn(created, trialDays),
            cancelsOn: null,
            oldestUnpaidDueOn: null,
            graceDays: grace,
            readOnlyEnabled,
          };
          let status = subscriptionStatus(f);
          for (const s of steps) {
            if (status === 'cancelled') break;
            const today = plus(f.today, s.days);
            f = { ...f, today };
            const current = subscriptionStatus(f);
            if (s.event === 'invoice' && f.oldestUnpaidDueOn === null)
              f = { ...f, oldestUnpaidDueOn: plus(today, s.dueIn) };
            if (s.event === 'pay') f = { ...f, oldestUnpaidDueOn: null };
            if (s.event === 'switch') f = { ...f, readOnlyEnabled: !f.readOnlyEnabled };
            if (s.event === 'cancel' && current !== 'cancel_scheduled' && current !== 'cancelled')
              f = {
                ...f,
                cancelsOn: cancelEffectiveOn({
                  today,
                  status: current,
                  trialEndsOn: f.trialEndsOn,
                }),
              };
            if (s.event === 'withdraw' && current === 'cancel_scheduled')
              f = { ...f, cancelsOn: null };
            for (const next of [current, subscriptionStatus(f)]) {
              if (next !== status)
                expect(canTransition(status, next), `${status} -> ${next}`).toBe(true);
              status = next;
            }
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
