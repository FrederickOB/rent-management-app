import { describe, expect, it } from 'vitest';
import {
  amountFieldValue,
  cedis,
  checkoutHref,
  checksFrom,
  chooseView,
  cappedByAdvance,
  errorCode,
  failureText,
  isChargeReference,
  maximumReason,
  isIntentId,
  justPaid,
  newSubmissionId,
  payProblemText,
  readPayForm,
  recheckSeconds,
} from './pay';
import { backToPay, backToReceipt } from './redirect';

const LIMITS = { minMinor: 100, maxMinor: 1_980_000 };

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

const SUBMISSION = 'abcdefghijklmnop_-1234';

describe('BC-04 pay page amounts', () => {
  it('formats integer pesewas at the edge only, and pre-fills a value the form reads back exactly', () => {
    expect(cedis(150_000)).toBe('GH₵1,500.00');
    expect(cedis(7)).toBe('GH₵0.07');
    expect(amountFieldValue(150_050)).toBe('1,500.50');
    expect(amountFieldValue(0)).toBe('');
    for (const amountMinor of [100, 150_000, 150_050, 1_980_000, 123_456_789]) {
      const read = readPayForm(
        form({
          amount: amountFieldValue(amountMinor),
          method: 'card',
          submissionId: SUBMISSION,
        }),
      );
      expect(read.ok && read.request.amountMinor).toBe(amountMinor);
    }
  });

  it('reads the amounts tenants type, exactly, and refuses anything else', () => {
    const amount = (typed: string) => {
      const read = readPayForm(form({ amount: typed, method: 'card', submissionId: SUBMISSION }));
      return read.ok ? read.request.amountMinor : read.error;
    };
    expect(amount('1500')).toBe(150_000);
    expect(amount(' 1,500.5 ')).toBe(150_050);
    expect(amount('0.10')).toBe(10);
    expect(amount('1500.555')).toBe('AMOUNT_FORMAT');
    expect(amount('GH₵1500')).toBe('AMOUNT_FORMAT');
    expect(amount('1e3')).toBe('AMOUNT_FORMAT');
    expect(amount('')).toBe('AMOUNT_FORMAT');
    expect(amount('0')).toBe('AMOUNT_TOO_SMALL');
    expect(amount('-5')).toBe('AMOUNT_TOO_SMALL');
  });
});

describe('BC-04 pay page form', () => {
  it('charges a MoMo number on the network chosen, or goes to card checkout', () => {
    expect(
      readPayForm(
        form({
          amount: '800',
          method: 'momo-telecel',
          momoPhone: '020 123 4567',
          submissionId: SUBMISSION,
        }),
      ),
    ).toEqual({
      ok: true,
      methodValue: 'momo-telecel',
      request: {
        amountMinor: 80_000,
        method: 'momo',
        momo: { phone: '020 123 4567', network: 'telecel' },
        submissionId: SUBMISSION,
      },
    });
    const card = readPayForm(
      form({ amount: '800', method: 'card', momoPhone: '020 123 4567', submissionId: SUBMISSION }),
    );
    expect(card.ok && card.request).toEqual({
      amountMinor: 80_000,
      method: 'card',
      momo: null,
      submissionId: SUBMISSION,
    });
  });

  it('asks for a method, and for a MoMo number that looks like one', () => {
    const error = (fields: Record<string, string>) => {
      const read = readPayForm(form({ amount: '800', submissionId: SUBMISSION, ...fields }));
      return read.ok ? null : read;
    };
    expect(error({})).toMatchObject({ error: 'METHOD_REQUIRED', amountMinor: 80_000 });
    expect(error({ method: 'paypal' })).toMatchObject({ error: 'METHOD_REQUIRED' });
    expect(error({ method: 'momo-mtn' })).toMatchObject({
      error: 'PHONE_REQUIRED',
      methodValue: 'momo-mtn',
    });
    expect(error({ method: 'momo-at', momoPhone: 'call me' })).toMatchObject({
      error: 'PHONE_INVALID',
    });
    // What goes back on the form, in the page's address, never includes the number typed.
    const refused = error({ method: 'momo-at', momoPhone: '0201234567 ext' });
    expect(refused).toMatchObject({ error: 'PHONE_INVALID' });
    expect(JSON.stringify(refused)).not.toContain('0201234567');
  });

  it('keeps a double tap to one charge: the form’s id passes through, and a missing one is made', () => {
    const tapped = readPayForm(form({ amount: '1', method: 'card', submissionId: SUBMISSION }));
    expect(tapped.ok && tapped.request.submissionId).toBe(SUBMISSION);
    const handMade = readPayForm(form({ amount: '1', method: 'card', submissionId: 'short' }));
    expect(handMade.ok && handMade.request.submissionId).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    const ids = new Set(Array.from({ length: 50 }, () => newSubmissionId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });
});

describe('BC-04 pay page problems', () => {
  it('says what went wrong from the code alone, naming the limits', () => {
    expect(payProblemText(undefined, LIMITS)).toBeNull();
    expect(payProblemText('PAYMENT.AMOUNT_TOO_SMALL', LIMITS)).toBe('Pay at least GH₵1.00.');
    expect(payProblemText('PAYMENT.AMOUNT_TOO_LARGE', LIMITS)).toBe(
      'You can pay at most GH₵19,800.00: the rent left to the end of your lease.',
    );
    expect(payProblemText('PHONE_REQUIRED', LIMITS)).toBe('Enter the MoMo number to charge.');
    expect(payProblemText('PAYMENTS.PHONE_INVALID', LIMITS)).toMatch(/10 digits/);
    expect(payProblemText('RATE_LIMITED', LIMITS)).toMatch(/Too many attempts/);
    expect(payProblemText('LINK_NOT_USABLE', LIMITS)).toBe(
      'This link can no longer take payments.',
    );
    // Anything else, including text someone put in the address, gets fixed words.
    expect(payProblemText('Call 0241234567 to pay', LIMITS)).toBe(
      'We could not start the payment. Check the amount and the number, then try again.',
    );
    expect(payProblemText('constructor', LIMITS)).not.toContain('function');
  });

  it('carries only well-formed codes and ids in the page’s address', () => {
    expect(errorCode('PAYMENT.AMOUNT_TOO_LARGE')).toBe('PAYMENT.AMOUNT_TOO_LARGE');
    expect(errorCode('<script>')).toBe('ERROR');
    expect(isIntentId('0193a7c0-0000-7000-8000-000000000001')).toBe(true);
    expect(isIntentId('0193a7c0')).toBe(false);
    expect(isIntentId(undefined)).toBe(false);
    const token = 'c'.repeat(43);
    const back = backToPay(token, { error: 'PHONE_REQUIRED', amount: 80_000, method: null });
    expect(back.status).toBe(303);
    expect(back.headers.get('location')).toBe(`/p/${token}?error=PHONE_REQUIRED&amount=80000`);
    expect(back.headers.get('cache-control')).toBe('no-store');
    expect(back.headers.get('set-cookie')).toBeNull();
    // BC-06: a receipt link's download comes back to its own page.
    expect(backToReceipt(token, { download: 'unavailable' }).headers.get('location')).toBe(
      `/r/${token}?download=unavailable`,
    );
  });

  it('opens only a web page as the card checkout', () => {
    expect(checkoutHref('https://checkout.paystack.com/abc')).toBe(
      'https://checkout.paystack.com/abc',
    );
    expect(checkoutHref('javascript:alert(1)')).toBeNull();
    expect(checkoutHref(null)).toBeNull();
  });
});

describe('BC-04 pay page waiting step', () => {
  it('checks often at first, then less, staying within the link’s rate limit', () => {
    expect(recheckSeconds(0)).toBe(5);
    expect(recheckSeconds(6)).toBe(15);
    expect(recheckSeconds(16)).toBe(60);
    let elapsed = 0;
    let checks = 0;
    while (elapsed < 15 * 60) elapsed += recheckSeconds(checks++);
    expect(checks).toBeLessThanOrEqual(40);
    expect(checksFrom('3')).toBe(3);
    expect(checksFrom('-1')).toBe(0);
    expect(checksFrom('lots')).toBe(0);
  });
});

describe('BC-04 pay page screens', () => {
  const base = { methods: ['momo', 'card'], intentStatus: null, startAgain: false } as const;

  it('explains an expired, replaced or settled link, and takes no payment there', () => {
    for (const intentStatus of [null, 'pending', 'confirmed'] as const) {
      expect(chooseView({ ...base, screen: 'expired', intentStatus })).toBe('closed');
      expect(chooseView({ ...base, screen: 'revoked', intentStatus })).toBe('closed');
      expect(chooseView({ ...base, screen: 'settled', intentStatus })).toBe('settled');
    }
    expect(chooseView({ ...base, screen: 'paid' })).toBe('paid');
  });

  it('gives the landlord’s own instructions when online payment is not available', () => {
    expect(chooseView({ ...base, screen: 'unavailable' })).toBe('unavailable');
    expect(chooseView({ ...base, screen: 'pay', methods: [] })).toBe('unavailable');
  });

  it('waits on a payment the provider has not finished with, unless the tenant starts again', () => {
    expect(chooseView({ ...base, screen: 'pay', intentStatus: 'pending' })).toBe('waiting');
    expect(chooseView({ ...base, screen: 'pay', intentStatus: 'initiated' })).toBe('waiting');
    expect(chooseView({ ...base, screen: 'pay', intentStatus: 'pending', startAgain: true })).toBe(
      'pay',
    );
    for (const intentStatus of [null, 'confirmed', 'failed', 'abandoned'] as const)
      expect(chooseView({ ...base, screen: 'pay', intentStatus })).toBe('pay');
  });

  it('knows a payment was just made from the form’s redirect or the checkout’s return', () => {
    expect(justPaid({ intent: '0193a7c0-0000-7000-8000-000000000001' })).toBe(true);
    expect(justPaid({ trxref: 'pay_123', reference: 'pay_123' })).toBe(true);
    expect(justPaid({ intent: 'not-an-id' })).toBe(false);
    expect(justPaid({})).toBe(false);
  });
});

describe('BC-04 and AR-05 pay page: the most a tenant may pay', () => {
  const LANDLORD = 'Osu Ridge Property Managers';
  const block = {
    policy: 'block',
    limitMonths: 6,
    capMinor: 900_000,
    ruleUnverified: true,
  } as const;

  it('says the maximum is the rent left to the end of the lease when no advance limit binds', () => {
    expect(maximumReason(LANDLORD, LIMITS)).toBe('That is the rent left to the end of your lease.');
    // Under `warn`, more is accepted (and flagged for staff), so the end of the lease still sets it.
    const warn = { ...LIMITS, advance: { ...block, policy: 'warn' as const } };
    expect(cappedByAdvance(warn)).toBe(false);
    expect(maximumReason(LANDLORD, warn)).toBe('That is the rent left to the end of your lease.');
    // Under `block`, with the end of the lease nearer than the limit, the lease still sets it.
    expect(cappedByAdvance({ minMinor: 100, maxMinor: 400_000, advance: block })).toBe(false);
  });

  it('under `block`, says plainly that the landlord takes rent only so far ahead', () => {
    const capped = { minMinor: 100, maxMinor: 900_000, advance: block };
    expect(cappedByAdvance(capped)).toBe(true);
    expect(maximumReason(LANDLORD, capped)).toBe(
      'Osu Ridge Property Managers takes rent at most 6 months ahead, so the most you can pay now is what is due and up to 6 months more, less anything you have already paid ahead.',
    );
    expect(payProblemText('PAYMENT.AMOUNT_TOO_LARGE', capped)).toBe(
      'You can pay at most GH₵9,000.00: what is due now and up to 6 months of rent ahead, less anything already paid ahead.',
    );
    expect(maximumReason(LANDLORD, { ...capped, advance: { ...block, limitMonths: 1 } })).toMatch(
      /at most 1 month ahead/,
    );
    // Never a word on whether a payment is lawful or compliant.
    for (const text of [
      maximumReason(LANDLORD, capped),
      payProblemText('AMOUNT_TOO_LARGE', capped),
    ])
      expect(text).not.toMatch(/compliant|legal|lawful|law/i);
  });
});

describe('BC-04 pay page: why a payment failed', () => {
  it('words the provider’s failure codes plainly, and falls back to the API’s own message', () => {
    expect(failureText('PROVIDER_STEP_UNSUPPORTED', null, 'Kwabena Owusu')).toBe(
      'Your MoMo network asked for an extra step, such as a code sent to your phone, which this page cannot take yet. Pay by card or from another MoMo network, or pay Kwabena Owusu directly.',
    );
    expect(failureText('PROVIDER_STEP_UNSUPPORTED', null, null)).toMatch(
      /pay your landlord directly/,
    );
    expect(failureText('PROVIDER_CHARGE_FAILED', 'ignored', null)).toBe(
      'The payment did not go through. Check the number, the network and your balance, then try again.',
    );
    expect(failureText('PROVIDER_REFUSED', null, null)).toMatch(/refused this payment/);
    expect(failureText('PROVIDERS_UNAVAILABLE', null, null)).toMatch(/not available just now/);
    expect(failureText(null, 'Insufficient funds', null)).toBe('Insufficient funds');
    expect(failureText(undefined, null, null)).toBeNull();
  });
});

describe('BC-04 card return page', () => {
  it('takes only a charge reference, never a pay link’s token', () => {
    expect(isChargeReference(`pi-${'0a'.repeat(16)}`)).toBe(true);
    expect(isChargeReference(`pi-${'0A'.repeat(16)}`)).toBe(false);
    expect(isChargeReference('Tz8wzlGq2fz3T8ulnkmXH5m9vDkYB1dC0aCqfbnT2Xw')).toBe(false);
    expect(isChargeReference(undefined)).toBe(false);
  });
});

describe('BC-04 pay page after a part payment', () => {
  it('keeps the form under the thanks while something is still due', () => {
    const paid = { screen: 'paid', methods: ['momo', 'card'], startAgain: false } as const;
    expect(chooseView({ ...paid, intentStatus: 'confirmed', dueNowMinor: 50_000 })).toBe('pay');
    expect(chooseView({ ...paid, intentStatus: 'confirmed', dueNowMinor: 0 })).toBe('paid');
    expect(chooseView({ ...paid, intentStatus: 'pending', dueNowMinor: 50_000 })).toBe('waiting');
  });
});
