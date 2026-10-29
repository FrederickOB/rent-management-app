import { beforeEach, describe, expect, it } from 'vitest';
import { ProviderError } from '../http';
import type { ChargeRequest, PaymentsPort, PaymentsTestControls } from '../payments/payments';
import { fakeEmail, fakePhone, uniqueReference } from './fixtures';

export interface PaymentsHarness {
  readonly port: PaymentsPort & PaymentsTestControls;
}

const refusedWith = async (promise: Promise<unknown>, status?: number) => {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ProviderError);
  expect((error as ProviderError).retryable).toBe(false);
  if (status !== undefined) expect((error as ProviderError).status).toBe(status);
};

const around = (msBefore: number, msAfter: number) => ({
  from: new Date(Date.now() - msBefore).toISOString(),
  to: new Date(Date.now() + msAfter).toISOString(),
});

/** What every payments adapter must do. Amounts are integer pesewas throughout. */
export function paymentsContract(
  adapter: string,
  makeHarness: () => PaymentsHarness | Promise<PaymentsHarness>,
): void {
  describe(`PLATFORM integration contracts: payments (${adapter})`, () => {
    let h: PaymentsHarness;
    let subaccountCode: string;

    const charge = (overrides: Partial<ChargeRequest> = {}): ChargeRequest => ({
      reference: uniqueReference('pay'),
      amountMinor: 150_000,
      currency: 'GHS',
      channel: 'card',
      customer: { email: fakeEmail() },
      subaccountCode,
      metadata: { leaseId: 'lease-1', intentId: uniqueReference('intent') },
      ...overrides,
    });

    beforeEach(async () => {
      h = await makeHarness();
      ({ subaccountCode } = await h.port.createSubaccount({
        businessName: 'Test Landlord Ltd',
        settlementBank: 'TEST',
        accountNumber: '0123456789',
      }));
    });

    it('creates subaccounts, each with its own code', async () => {
      const other = await h.port.createSubaccount({
        businessName: 'Another',
        settlementBank: 'TEST',
        accountNumber: '9876543210',
      });
      expect(subaccountCode).not.toBe('');
      expect(other.subaccountCode).not.toBe(subaccountCode);
    });

    it('initialises a card charge with a page to pay on, and verify reports it pending, exactly as asked', async () => {
      const request = charge();
      const initialised = await h.port.initialiseCharge(request);
      expect(initialised).toMatchObject({ provider: h.port.provider, status: 'pending' });
      expect(initialised.providerReference).not.toBe('');
      expect(URL.canParse(initialised.authorizationUrl ?? '')).toBe(true);
      const verified = await h.port.verify(request.reference);
      expect(verified).toEqual({
        status: 'pending',
        amountMinor: 150_000,
        currency: 'GHS',
        reference: request.reference,
        channel: 'card',
        metadata: request.metadata,
      });
    });

    it('initialises a MoMo charge for a phone, which then waits for approval', async () => {
      const request = charge({
        channel: 'momo',
        customer: { email: fakeEmail(), phone: fakePhone() },
      });
      expect(await h.port.initialiseCharge(request)).toMatchObject({ status: 'pending' });
      expect(await h.port.verify(request.reference)).toMatchObject({
        status: 'pending',
        channel: 'momo',
      });
    });

    it('sends a signed charge.success webhook for a paid charge; verify then reports success and when', async () => {
      const request = charge({
        channel: 'momo',
        customer: { email: fakeEmail(), phone: fakePhone() },
      });
      await h.port.initialiseCharge(request);
      const webhook = await h.port.completeCharge(request.reference, { status: 'success' });
      expect(webhook).not.toBeNull();
      const { rawBody, headers } = webhook ?? { rawBody: '', headers: {} };
      expect(h.port.verifyWebhookSignature(rawBody, headers)).toBe(true);
      expect(h.port.verifyWebhookSignature(Buffer.from(rawBody), headers)).toBe(true);
      const event = h.port.parseWebhook(rawBody);
      expect(event).toMatchObject({ type: 'charge.success', reference: request.reference });
      expect(event?.eventId).toMatch(/^charge\.success:.+/);
      const verified = await h.port.verify(request.reference);
      expect(verified).toMatchObject({
        status: 'success',
        amountMinor: 150_000,
        currency: 'GHS',
        reference: request.reference,
      });
      expect(Number.isNaN(Date.parse(verified.paidAt ?? ''))).toBe(false);
    });

    it('rejects a webhook whose body or signature changed, or that has no signature', async () => {
      const request = charge();
      await h.port.initialiseCharge(request);
      const webhook = await h.port.completeCharge(request.reference, { status: 'success' });
      const { rawBody, headers } = webhook ?? { rawBody: '', headers: {} };
      const signature = Object.values(headers)[0] ?? '';
      expect(h.port.verifyWebhookSignature(rawBody.replace('150000', '1500000'), headers)).toBe(
        false,
      );
      expect(
        h.port.verifyWebhookSignature(rawBody, {
          'x-paystack-signature': `${signature.slice(0, -2)}00`,
        }),
      ).toBe(false);
      expect(h.port.verifyWebhookSignature(rawBody, {})).toBe(false);
      expect(h.port.verifyWebhookSignature(rawBody, { 'X-Paystack-Signature': signature })).toBe(
        true,
      );
    });

    it('sends no webhook for a failed or abandoned charge, which verify reports', async () => {
      const failed = charge();
      const abandoned = charge();
      await h.port.initialiseCharge(failed);
      await h.port.initialiseCharge(abandoned);
      expect(await h.port.completeCharge(failed.reference, { status: 'failed' })).toBeNull();
      expect(await h.port.completeCharge(abandoned.reference, { status: 'abandoned' })).toBeNull();
      expect((await h.port.verify(failed.reference)).status).toBe('failed');
      expect((await h.port.verify(abandoned.reference)).status).toBe('abandoned');
    });

    it('reports the amount actually paid, so a short payment cannot pass as the amount asked', async () => {
      const request = charge({ amountMinor: 150_000 });
      await h.port.initialiseCharge(request);
      await h.port.completeCharge(request.reference, { status: 'success', amountMinor: 149_999 });
      expect(await h.port.verify(request.reference)).toMatchObject({
        status: 'success',
        amountMinor: 149_999,
      });
    });

    it('refuses an amount that is not a positive whole number of pesewas', async () => {
      for (const amountMinor of [1500.5, 0, -100, 2 ** 53, Number.NaN]) {
        await refusedWith(h.port.initialiseCharge(charge({ amountMinor })), 400);
      }
    });

    it('refuses a charge to an unknown subaccount, a bad reference, or another currency', async () => {
      await refusedWith(h.port.initialiseCharge(charge({ subaccountCode: 'ACCT_unknown' })), 400);
      await refusedWith(
        h.port.initialiseCharge(charge({ reference: 'has spaces and /slashes' })),
        400,
      );
      await refusedWith(h.port.initialiseCharge(charge({ currency: 'NGN' as 'GHS' })), 400);
    });

    it('refuses a reference used before with 409, so a retry can fall back to verify', async () => {
      const request = charge();
      await h.port.initialiseCharge(request);
      await refusedWith(h.port.initialiseCharge(request), 409);
      expect((await h.port.verify(request.reference)).status).toBe('pending');
    });

    it('treats verify of an unknown reference as a non-retryable 404', async () => {
      await refusedWith(h.port.verify(uniqueReference('missing')), 404);
    });

    it('lists the charges created in a half-open window', async () => {
      const request = charge();
      await h.port.initialiseCharge(request);
      const listed = await h.port.listTransactions(around(60_000, 60_000));
      expect(listed.find((t) => t.reference === request.reference)).toMatchObject({
        status: 'pending',
        amountMinor: 150_000,
        currency: 'GHS',
        subaccountCode,
      });
      const earlier = await h.port.listTransactions({
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-02T00:00:00.000Z',
      });
      expect(earlier.find((t) => t.reference === request.reference)).toBeUndefined();
      await refusedWith(h.port.listTransactions({ from: 'yesterday', to: 'today' }), 400);
    });

    it('settles successful charges to their subaccount, with gross less fees equal to net', async () => {
      const first = charge({ amountMinor: 150_000 });
      const second = charge({ amountMinor: 80_050 });
      const unpaid = charge({ amountMinor: 99_999 });
      for (const request of [first, second, unpaid]) await h.port.initialiseCharge(request);
      await h.port.completeCharge(first.reference, { status: 'success', feesMinor: 2_925 });
      await h.port.completeCharge(second.reference, { status: 'success', feesMinor: 1_561 });
      await h.port.settle();
      const mine = (await h.port.listSettlements(around(60_000, 60_000))).filter(
        (s) => s.subaccountCode === subaccountCode,
      );
      expect(mine.flatMap((s) => s.references).sort()).toEqual(
        [first.reference, second.reference].sort(),
      );
      for (const s of mine) {
        expect(s).toMatchObject({ status: 'success', currency: 'GHS' });
        expect(s.netMinor).toBe(s.grossMinor - s.feesMinor);
      }
      expect(mine.reduce((sum, s) => sum + s.grossMinor, 0)).toBe(230_050);
      expect(mine.reduce((sum, s) => sum + s.feesMinor, 0)).toBe(4_486);
      expect(mine.reduce((sum, s) => sum + s.netMinor, 0)).toBe(225_564);
    });

    it('cannot complete a charge twice', async () => {
      const request = charge();
      await h.port.initialiseCharge(request);
      await h.port.completeCharge(request.reference, { status: 'success' });
      await refusedWith(h.port.completeCharge(request.reference, { status: 'failed' }), 409);
    });

    it('returns null for webhook bodies it does not understand', () => {
      for (const body of [
        '',
        'not json',
        '{}',
        '{"event":"charge.success"}',
        '{"event":"charge.success","data":{}}',
      ]) {
        expect(h.port.parseWebhook(body)).toBeNull();
      }
    });
  });
}
