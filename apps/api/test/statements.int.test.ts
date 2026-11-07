import { addMonths, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
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
 * The M9 owner statement routes over HTTP (AC-04): the contract's outputs as the service gives
 * them, an issue retried with the same Idempotency-Key answered from the first, a second issue
 * refused, a draft of a month not over refused, and a caretaker refused.
 */
const PASSWORD = 'correct horse battery staple';

let api: TestApi;
let admin: Device;
let caretaker: Device;
let lastMonth: string;
let thisMonth: string;

async function signedIn(email: string, role: 'agency_admin' | 'caretaker', companyId: string) {
  const { personId } = await createPerson(api, { name: email, email, password: PASSWORD });
  await addMembership(api, companyId, personId, role);
  return (await enrolStaff(api, email, PASSWORD)).device;
}

beforeAll(async () => {
  api = await startApi({ AUTH_RATE_LIMITS: 'off' });
  const agencyId = await createCompany(api, 'agency', 'Statements Agency');
  admin = await signedIn('admin@statements.invalid', 'agency_admin', agencyId);
  caretaker = await signedIn('caretaker@statements.invalid', 'caretaker', agencyId);
  thisMonth = new Date().toISOString().slice(0, 7);
  lastMonth = toIsoDate(addMonths(parseBusinessDate(`${thisMonth}-01`), -1)).slice(0, 7);
});

afterAll(async () => {
  await api?.close();
});

describe('AC-04 the owner statement routes (API)', () => {
  it('drafts, issues once with a retried key, and refuses a second issue and an open month', async () => {
    const owner = await admin.call('/owners', {
      body: { kind: 'individual', displayName: 'Route Owner' },
    });
    expect(owner.status).toBe(200);
    const ownerId = String(owner.json.id);
    const open = await admin.call('/owner-statements', { body: { ownerId, month: thisMonth } });
    expect(open.status).toBe(409);
    expect(open.json).toMatchObject({ code: 'MONTH_NOT_OVER' });
    const draft = await admin.call('/owner-statements', { body: { ownerId, month: lastMonth } });
    expect(draft.status).toBe(200);
    expect(draft.json).toMatchObject({
      status: 'draft',
      month: lastMonth,
      matchesIssued: null,
      figures: { ownerId, month: lastMonth, properties: [] },
      actions: { issue: true, regenerate: true },
    });
    const id = String(draft.json.id);
    const key = { 'idempotency-key': 'statement-issue-0001' };
    const issued = await admin.call(`/owner-statements/${id}/issue`, { body: {}, headers: key });
    expect(issued.status).toBe(200);
    expect(issued.json).toMatchObject({ id, status: 'issued', matchesIssued: true });
    const retried = await admin.call(`/owner-statements/${id}/issue`, { body: {}, headers: key });
    expect(retried.status).toBe(200);
    expect(retried.json).toMatchObject({ id, status: 'issued' });
    const again = await admin.call(`/owner-statements/${id}/issue`, { body: {} });
    expect(again.status).toBe(409);
    expect(again.json).toMatchObject({ code: 'STATEMENT_ISSUED' });
    const rendering = await admin.call(`/owner-statements/${id}/document`);
    expect(rendering.status).toBe(409);
    expect(rendering.json).toMatchObject({ code: 'STATEMENT_RENDERING' });
    const list = await admin.call(`/owner-statements?ownerId=${ownerId}`);
    expect(list.status).toBe(200);
    expect(list.json).toEqual([
      expect.objectContaining({ id, status: 'issued', issuedAt: expect.any(String) }),
    ]);
    for (const path of ['/owner-statements', `/owner-statements/${id}`])
      expect((await caretaker.call(path)).status, path).toBe(403);
  });
});
