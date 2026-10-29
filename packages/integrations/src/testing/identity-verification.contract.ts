import { beforeEach, describe, expect, it } from 'vitest';
import { ProviderError } from '../http';
import type {
  IdentityVerificationPort,
  IdentityVerificationTestControls,
} from '../identity-verification/identity-verification';
import { uniqueReference } from './fixtures';

export interface IdentityVerificationHarness {
  readonly port: IdentityVerificationPort & IdentityVerificationTestControls;
  /** ID numbers whose checks end each way once the selfie is taken. */
  readonly idNumbers: {
    readonly verified: () => string;
    readonly notMatched: () => string;
    readonly failed: () => string;
    readonly neverCompletes: () => string;
  };
}

const refusedWith = async (promise: Promise<unknown>, status: number) => {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ProviderError);
  expect((error as ProviderError).retryable).toBe(false);
  expect((error as ProviderError).status).toBe(status);
};

/** What every identity verification adapter must do. */
export function identityVerificationContract(
  adapter: string,
  makeHarness: () => IdentityVerificationHarness | Promise<IdentityVerificationHarness>,
): void {
  describe(`PLATFORM integration contracts: identity verification (${adapter})`, () => {
    let h: IdentityVerificationHarness;
    beforeEach(async () => {
      h = await makeHarness();
    });

    const start = (idNumber: string, reference = uniqueReference('idv')) =>
      h.port.startCheck({ idType: 'ghana_card', idNumber, reference });

    it('starts a check with a link for the selfie, pending until the person takes it', async () => {
      const started = await start(h.idNumbers.verified());
      expect(started.checkId).not.toBe('');
      expect(URL.canParse(started.captureUrl)).toBe(true);
      expect(await h.port.getResult(started.checkId)).toEqual({ status: 'pending' });
    });

    it.each([
      ['verified', 'verified'],
      ['notMatched', 'not_matched'],
      ['failed', 'failed'],
    ] as const)(
      'reports %s after the selfie, with the time it was checked',
      async (kind, status) => {
        const started = await start(h.idNumbers[kind]());
        const webhook = await h.port.completeCapture(started.checkId);
        const result = await h.port.getResult(started.checkId);
        expect(result.status).toBe(status);
        expect(Number.isNaN(Date.parse(result.checkedAt ?? ''))).toBe(false);
        expect(h.port.parseResultWebhook(webhook)).toMatchObject({
          checkId: started.checkId,
          status,
          checkedAt: result.checkedAt,
        });
      },
    );

    it('keeps a check that never completes pending, and sends no result', async () => {
      const started = await start(h.idNumbers.neverCompletes());
      expect(await h.port.completeCapture(started.checkId)).toBeNull();
      expect(await h.port.getResult(started.checkId)).toEqual({ status: 'pending' });
    });

    it('returns the same check for a repeated reference, and refuses that reference for another ID', async () => {
      const reference = uniqueReference('idv');
      const idNumber = h.idNumbers.verified();
      const first = await start(idNumber, reference);
      expect(await start(idNumber, reference)).toEqual(first);
      await refusedWith(start(h.idNumbers.failed(), reference), 409);
    });

    it('refuses an ID number that does not match its type', async () => {
      await refusedWith(start('123456789'), 400);
      await refusedWith(
        h.port.startCheck({
          idType: 'passport',
          idNumber: 'short',
          reference: uniqueReference('idv'),
        }),
        400,
      );
    });

    it('treats an unknown check as a non-retryable 404', async () => {
      await refusedWith(h.port.getResult('no-such-check'), 404);
    });

    it('returns null for result webhooks it does not understand', () => {
      for (const body of [
        null,
        'verified',
        {},
        { event: 'identity.check.completed', check_id: 'x', status: 'maybe' },
      ]) {
        expect(h.port.parseResultWebhook(body)).toBeNull();
      }
    });

    it('refuses a second capture for the same check', async () => {
      const started = await start(h.idNumbers.verified());
      await h.port.completeCapture(started.checkId);
      await refusedWith(h.port.completeCapture(started.checkId), 409);
    });
  });
}
