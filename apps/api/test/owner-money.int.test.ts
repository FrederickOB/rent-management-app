import { businessDateOf, instantFrom, toIsoDate } from '@rent/domain/dates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMembership,
  createCompany,
  createPerson,
  enrolStaff,
  startApi,
  type Device,
  type TestApi,
} from './support';

/**
 * The M9 fee terms and owner money routes over HTTP (AC-02, AC-05): fee terms asked for through
 * an approval, money writes that require an Idempotency-Key, a retry answered from the first, a
 * key reused for another body refused (422), named refusals, the proof link, and a caretaker
 * refused.
 */
const PASSWORD = 'correct horse battery staple';
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1',
);

let api: TestApi;
let admin: Device;
let accountant: Device;
let caretaker: Device;
let today: string;

async function signedIn(
  email: string,
  role: 'agency_admin' | 'accountant' | 'caretaker',
  companyId: string,
) {
  const { personId } = await createPerson(api, { name: email, email, password: PASSWORD });
  await addMembership(api, companyId, personId, role);
  return (await enrolStaff(api, email, PASSWORD)).device;
}

async function proof(device: Device): Promise<string> {
  const response = await device.call('/owner-money-uploads', {
    body: { contentType: 'application/pdf', sizeBytes: PDF.length },
  });
  expect(response.status, JSON.stringify(response.json)).toBe(200);
  const fields = response.json.fields as Record<string, string>;
  await api.storage.put({
    bucket: api.config.S3_BUCKET_FILES,
    key: fields.key!,
    body: PDF,
    contentType: 'application/pdf',
  });
  return String(response.json.uploadId);
}

beforeAll(async () => {
  api = await startApi({ AUTH_RATE_LIMITS: 'off' });
  const agencyId = await createCompany(api, 'agency', 'Owner Money Agency');
  admin = await signedIn('admin@owner-money.invalid', 'agency_admin', agencyId);
  accountant = await signedIn('accountant@owner-money.invalid', 'accountant', agencyId);
  caretaker = await signedIn('caretaker@owner-money.invalid', 'caretaker', agencyId);
  today = toIsoDate(businessDateOf(instantFrom(new Date()), 'Africa/Accra'));
});

afterAll(async () => {
  await api?.close();
});

describe('AC-02 and AC-05 the fee terms and owner money routes (API)', () => {
  it('asks for fee terms, records funding and a remittance under keys, and refuses what it should', async () => {
    const owner = await admin.call('/owners', {
      body: { kind: 'individual', displayName: 'Money Route Owner' },
    });
    expect(owner.status).toBe(200);
    const ownerId = String(owner.json.id);

    const terms = await admin.call(`/owners/${ownerId}/fee-terms`);
    expect(terms.status).toBe(200);
    expect(terms.json).toMatchObject({ current: null, upcoming: [], pending: null });
    const asked = await admin.call(`/owners/${ownerId}/fee-terms`, {
      body: {
        ownerId,
        kind: 'percentage',
        rateBps: 1000,
        graPaidBy: 'owner',
        effectiveFrom: today,
      },
    });
    expect(asked.status, JSON.stringify(asked.json)).toBe(200);
    expect(asked.json).toMatchObject({
      pending: { terms: { kind: 'percentage', rateBps: 1000, effectiveFrom: today } },
    });
    const past = await admin.call(`/owners/${ownerId}/fee-terms`, {
      body: { ownerId, kind: 'none', graPaidBy: 'owner', effectiveFrom: '2020-01-01' },
    });
    expect(past.status).toBe(400);
    expect(past.json).toMatchObject({ code: 'EFFECTIVE_FROM_PAST' });

    const funding = {
      ownerId,
      on: today,
      method: 'bank',
      reference: 'OWNER TOPUP 1',
      proofUploadId: await proof(accountant),
      amountMinor: 50_000,
    };
    const keyless = await accountant.call('/owner-funding', { body: funding });
    expect(keyless.status).toBe(400);
    expect(keyless.json).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    const key = { 'idempotency-key': 'owner-funding-0001' };
    const funded = await accountant.call('/owner-funding', { body: funding, headers: key });
    expect(funded.status, JSON.stringify(funded.json)).toBe(200);
    expect(funded.json).toMatchObject({
      kind: 'owner_funding',
      owner: { id: ownerId, name: 'Money Route Owner' },
      on: today,
      amountMinor: 50_000,
      feesRetainedMinor: 0,
      method: 'bank',
      hasProof: true,
    });
    const retried = await accountant.call('/owner-funding', { body: funding, headers: key });
    expect(retried.status).toBe(200);
    expect(retried.json.id).toBe(funded.json.id);
    const reused = await accountant.call('/owner-funding', {
      body: { ...funding, amountMinor: 60_000 },
      headers: key,
    });
    expect(reused.status).toBe(422);
    expect(reused.json).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });

    const suggestion = await accountant.call(`/owners/${ownerId}/remittance-suggestion`);
    expect(suggestion.status).toBe(200);
    expect(suggestion.json).toMatchObject({
      agentCashMinor: 50_000,
      feesDueMinor: 0,
      totalMinor: 50_000,
      feesRetainedMinor: 0,
      netMinor: 50_000,
    });
    const over = await accountant.call('/remittances', {
      body: {
        ownerId,
        on: today,
        method: 'momo',
        reference: 'MOMO 1',
        proofUploadId: await proof(accountant),
        netMinor: 50_001,
        feesRetainedMinor: 0,
      },
      headers: { 'idempotency-key': 'remittance-0001' },
    });
    expect(over.status).toBe(409);
    expect(over.json).toMatchObject({ code: 'OVER_AGENT_CASH' });
    const remitted = await accountant.call('/remittances', {
      body: {
        ownerId,
        on: today,
        method: 'momo',
        reference: 'MOMO 1',
        proofUploadId: await proof(accountant),
        netMinor: 50_000,
        feesRetainedMinor: 0,
      },
      headers: { 'idempotency-key': 'remittance-0002' },
    });
    expect(remitted.status, JSON.stringify(remitted.json)).toBe(200);
    expect(remitted.json).toMatchObject({ kind: 'remittance', amountMinor: 50_000 });
    const fees = await accountant.call('/fees-taken', {
      body: { ownerId, on: today, amountMinor: 1 },
      headers: { 'idempotency-key': 'fees-taken-0001' },
    });
    expect(fees.status).toBe(409);
    expect(fees.json).toMatchObject({ code: 'FEES_OVER_DUE' });

    const list = await accountant.call(`/owner-money?ownerId=${ownerId}`);
    expect(list.status).toBe(200);
    expect((list.json as unknown as { kind: string }[]).map((x) => x.kind).sort()).toEqual([
      'owner_funding',
      'remittance',
    ]);
    const link = await accountant.call(`/owner-money/${String(remitted.json.id)}/proof`);
    expect(link.status).toBe(200);
    expect(String(link.json.url)).toBeTruthy();

    expect((await caretaker.call('/owner-money')).status).toBe(403);
    expect((await caretaker.call(`/owners/${ownerId}/fee-terms`)).status).toBe(403);
  });
});
