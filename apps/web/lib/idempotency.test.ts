import { describe, expect, it } from 'vitest';
import {
  IDEMPOTENCY_HEADER,
  idempotencyKeeper,
  keeperSet,
  keyedClient,
  newIdempotencyKey,
  moneyProblem,
  outcomeOf,
  sendOnce,
} from './idempotency';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LINE = '019a3000-0000-7000-8000-0000000000c1';

/** An API refusal as the typed client throws it. */
const refusal = (status: number, code = 'BAD_REQUEST') =>
  Object.assign(new Error('refused'), { status, code, data: { body: { code } } });

/** Counts keys handed out, so a test can tell a reused key from a new one. */
function counter() {
  let n = 0;
  return () => {
    n += 1;
    return `key-${n}`;
  };
}

describe('M2 S8 and plan 4.15 one Idempotency-Key per money submission', () => {
  it('makes random version-4 UUIDs, a new one each time', () => {
    const a = newIdempotencyKey();
    const b = newIdempotencyKey();
    expect(a).toMatch(UUID_V4);
    expect(b).toMatch(UUID_V4);
    expect(a).not.toBe(b);
    // The version and variant bits are set whatever the random bytes are.
    expect(newIdempotencyKey((bytes) => bytes.fill(0xff))).toMatch(UUID_V4);
    expect(newIdempotencyKey((bytes) => bytes.fill(0))).toBe(
      '00000000-0000-4000-8000-000000000000',
    );
  });

  it('reuses the key when a retry follows a dropped connection, so the payment is not recorded twice', async () => {
    const keeper = idempotencyKeeper(counter());
    const sent: string[] = [];
    // The first attempt reaches no answer (the phone lost its signal).
    await expect(
      sendOnce(keeper, async (key) => {
        sent.push(key);
        throw new TypeError('Failed to fetch');
      }),
    ).rejects.toThrow('Failed to fetch');
    // A server failure leaves it unknown as well.
    await expect(
      sendOnce(keeper, async (key) => {
        sent.push(key);
        throw refusal(502, 'BAD_GATEWAY');
      }),
    ).rejects.toMatchObject({ status: 502 });
    const result = await sendOnce(keeper, async (key) => {
      sent.push(key);
      return 'recorded';
    });
    expect(result).toBe('recorded');
    expect(sent).toEqual(['key-1', 'key-1', 'key-1']);
  });

  it('gives the next submission a new key once the last one is recorded', async () => {
    const keeper = idempotencyKeeper(counter());
    const first = await sendOnce(keeper, async (key) => key);
    const second = await sendOnce(keeper, async (key) => key);
    expect(first).toBe('key-1');
    expect(second).toBe('key-2');
  });

  it('gives a new key after a refusal, because the API recorded nothing and the details may change', async () => {
    const keeper = idempotencyKeeper(counter());
    await expect(
      sendOnce(keeper, async () => {
        throw refusal(400);
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(keeper.key()).toBe('key-2');
  });

  it('keeps the key while the outcome is unknown: no answer, a server failure, a timeout or a request still running', () => {
    expect(outcomeOf(new TypeError('Failed to fetch'))).toBe('unknown');
    expect(outcomeOf(refusal(500))).toBe('unknown');
    expect(outcomeOf(refusal(503))).toBe('unknown');
    expect(outcomeOf(refusal(408))).toBe('unknown');
    expect(outcomeOf(refusal(409, 'CONFLICT'))).toBe('unknown');
    expect(outcomeOf(refusal(422, 'IDEMPOTENCY_KEY_REUSED'))).toBe('unknown');
    expect(outcomeOf(refusal(400))).toBe('refused');
    expect(outcomeOf(refusal(403, 'FORBIDDEN'))).toBe('refused');
    expect(outcomeOf(refusal(422, 'BILLING.CREDIT_TOO_LARGE'))).toBe('refused');
    expect(outcomeOf(refusal(429, 'TOO_MANY_REQUESTS'))).toBe('refused');
  });

  it('treats a 409 that names its reason as a refusal, so the next attempt gets a new key', async () => {
    for (const code of [
      'CASH_SHORT',
      'LEASE_NOT_BILLABLE',
      'APPROVAL_OPEN',
      'PAYMENT_MATCHED',
      'PAYMENT_OTHER_OWNER',
      'PAYMENT_REVERSED',
      'CHANGED_MEANWHILE',
    ])
      expect(outcomeOf(refusal(409, code)), code).toBe('refused');
    // The API's filter sends the code in the body, in lower case.
    const body = Object.assign(new Error('refused'), {
      status: 409,
      data: { body: { code: 'cash_short' } },
    });
    expect(outcomeOf(body)).toBe('refused');
    const keeper = idempotencyKeeper(counter());
    await expect(
      sendOnce(keeper, async () => {
        throw refusal(409, 'CASH_SHORT');
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(keeper.key()).toBe('key-2');
  });

  it('keeps the key after a 409 that names no reason, or one still in progress', async () => {
    expect(outcomeOf({ status: 409 })).toBe('unknown');
    expect(outcomeOf(refusal(409, ''))).toBe('unknown');
    expect(outcomeOf(refusal(409, 'REQUEST_IN_PROGRESS'))).toBe('unknown');
    const keeper = idempotencyKeeper(counter());
    await expect(
      sendOnce(keeper, async () => {
        throw refusal(409, 'REQUEST_IN_PROGRESS');
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(keeper.key()).toBe('key-1');
  });

  it('says plainly when sending again is safe, and when it was already recorded', () => {
    expect(moneyProblem(new TypeError('Failed to fetch'))).toBe(
      'We could not reach the server. Check your connection and try again. Sending it again is safe: it will not be recorded twice.',
    );
    expect(moneyProblem(refusal(422, 'IDEMPOTENCY_KEY_REUSED'))).toBe(
      'An earlier attempt from this form may already have been recorded, so this one was not. Check the list before recording it again.',
    );
    expect(moneyProblem(refusal(409, 'REQUEST_IN_PROGRESS'))).toContain(
      'it will not be recorded twice',
    );
    // A refusal is the API's own message: nothing was recorded, so nothing is said about retries.
    expect(moneyProblem(refusal(400))).toBe('refused');
  });

  it('starts again when asked, for a person recording something new', () => {
    const keeper = idempotencyKeeper(counter());
    expect(keeper.key()).toBe('key-1');
    expect(keeper.key()).toBe('key-1');
    keeper.reset();
    expect(keeper.key()).toBe('key-2');
  });

  it('keeps one key per record on a page, so reopening a form after a dropped answer reuses it', () => {
    const keepers = keeperSet(counter());
    const creditLine1 = keepers('credit_note:line-1').key();
    const writeOffLine1 = keepers('write_off:line-1').key();
    expect(keepers('credit_note:line-1').key()).toBe(creditLine1);
    expect(writeOffLine1).not.toBe(creditLine1);
  });

  it('sends the key as the Idempotency-Key header on the money write', async () => {
    const seen: { url: string; method: string; key: string | null }[] = [];
    const fake = (async (input: RequestInfo | URL) => {
      const request = input as Request;
      seen.push({
        url: request.url,
        method: request.method,
        key: request.headers.get(IDEMPOTENCY_HEADER),
      });
      return Response.json({ approval: null });
    }) as typeof fetch;
    const client = keyedClient({ baseUrl: 'http://web.test/api/v1', key: 'key-77', fetch: fake });
    await client.invoices.creditNote({ lineId: LINE, amountMinor: 50_000, reason: 'Billed twice' });
    expect(seen).toEqual([
      {
        url: `http://web.test/api/v1/invoice-lines/${LINE}/credit-notes`,
        method: 'POST',
        key: 'key-77',
      },
    ]);
  });
});
