import type { Actor } from '@rent/domain/policy';
import { AppError, type IdempotencyClaim, type IdempotencyStore } from '@rent/server/core';
import { describe, expect, it } from 'vitest';
import { idempotent } from './idempotency';
import type { RequestContext } from './request-context';

/**
 * M10 review BE-20 and BE-21: the console's keyed writes (onboarding, extending a trial, crediting
 * an invoice, turning billing on) go through the same `idempotent()` as every other keyed write.
 * A platform admin's key is kept in the platform company under the admin's person; a tenant or a
 * job sending a key is still refused. The store is a stand-in that replays like the real one; the
 * real one is covered over HTTP in test/m10-review-access.int.test.ts.
 */
const PLATFORM = '00000000-0000-4000-8000-0000000000aa';
const ADMIN = '00000000-0000-4000-8000-0000000000bb';

const platformAdmin: Actor = {
  kind: 'platform_admin',
  personId: ADMIN,
  companyId: PLATFORM,
  membershipId: '00000000-0000-4000-8000-0000000000cc',
  authMethod: 'password_totp',
};

function ctxFor(actor: Actor | null, key?: string): RequestContext {
  const headers = new Headers();
  if (key) headers.set('idempotency-key', key);
  return { requestId: 'req-1', headers, session: null, actor };
}

/** Replays a stored answer for a key it has seen, as IdempotencyStore.run does. */
function replayingStore() {
  const answers = new Map<string, unknown>();
  const runs: { companyId: string; personId: string; key: string; operation: string }[] = [];
  const store = {
    async run<T, R = T>(
      input: { companyId: string; personId: string; key: string; operation: string; hash: string },
      write: (claim: IdempotencyClaim) => Promise<T>,
      render?: (stored: T) => Promise<R>,
    ): Promise<R> {
      runs.push({
        companyId: input.companyId,
        personId: input.personId,
        key: input.key,
        operation: input.operation,
      });
      const id = `${input.companyId}:${input.key}`;
      const answer = (v: T) => (render ? render(v) : Promise.resolve(v as unknown as R));
      if (answers.has(id)) return answer(answers.get(id) as T);
      const claim: IdempotencyClaim = { claim: async () => undefined, done: async () => undefined };
      const written = await write(claim);
      answers.set(id, written);
      return answer(written);
    },
  };
  return { store: store as unknown as IdempotencyStore, runs };
}

describe('BE-20 BE-21 AD-10 a platform admin’s Idempotency-Key', () => {
  it('is kept in the platform company under the admin, and a retry replays the first answer', async () => {
    const { store, runs } = replayingStore();
    let writes = 0;
    const write = async () => ({ companyId: `made-${(writes += 1)}` });
    const first = await idempotent(store, ctxFor(platformAdmin, 'onboard-0001'), 'op', {}, write);
    const again = await idempotent(store, ctxFor(platformAdmin, 'onboard-0001'), 'op', {}, write);
    expect(first).toEqual({ companyId: 'made-1' });
    expect(again).toEqual(first);
    expect(writes).toBe(1);
    expect(runs).toEqual([
      { companyId: PLATFORM, personId: ADMIN, key: 'onboard-0001', operation: 'op' },
      { companyId: PLATFORM, personId: ADMIN, key: 'onboard-0001', operation: 'op' },
    ]);
  });

  it('is still refused from a tenant or a job, and checked like any other key', async () => {
    const { store } = replayingStore();
    const write = async () => 'written';
    const tenant: Actor = { kind: 'tenant', personId: ADMIN, authMethod: 'phone_otp' };
    const job: Actor = { kind: 'system', companyId: PLATFORM, job: 'test' };
    for (const actor of [tenant, job, null])
      await expect(
        idempotent(store, ctxFor(actor, 'tenant-key-1'), 'op', {}, write),
      ).rejects.toMatchObject({ status: 403 });
    await expect(
      idempotent(store, ctxFor(platformAdmin, 'bad key!'), 'op', {}, write),
    ).rejects.toMatchObject({ code: 'idempotency_key_invalid' });
    const missing = await idempotent(store, ctxFor(platformAdmin), 'op', {}, write).catch(
      (error: unknown) => error,
    );
    expect(missing).toBeInstanceOf(AppError);
    expect(missing).toMatchObject({ status: 400, code: 'idempotency_key_required' });
    // Optional where the route says so: without a key the write runs once, as before.
    await expect(
      idempotent(store, ctxFor(platformAdmin), 'op', {}, write, undefined, { required: false }),
    ).resolves.toBe('written');
  });
});
