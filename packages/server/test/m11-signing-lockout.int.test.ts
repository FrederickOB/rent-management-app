import { schema, sql, withCompany } from '@rent/db';
import { PdfRenderer } from '@rent/documents/render';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { CODE_LOCKOUTS_BEFORE_REVOKE, CURRENT_CONSENT, SIGNING_CODE } from '@rent/domain/esign';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MESSAGE_SEND_JOB } from '../src/core/messages';
import { company, startServerTest, type ServerTestContext } from './support';
import { EsignWorker, PHONE, tokenIn } from './support/esign';
import { outboxOf } from './support/maintenance';
import {
  propertyWithUnits,
  staffIn,
  tenancyServices,
  type TenancyServices,
} from './support/tenancy';

/**
 * M11 security review R3 F7 for signing links: the one-time code lockout (five wrong codes lock
 * signing for 30 minutes) used to lift and start again for ever. The failures are now counted on
 * the link, and the lockout that reaches CODE_LOCKOUTS_BEFORE_REVOKE withdraws the link, and
 * whoever sent it is told, so they can send a new one.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let worker: EsignWorker;
let renderer: PdfRenderer;
let agencyId: string;
let manager: Awaited<ReturnType<typeof staffIn>>;
let units: Record<string, string>;
let today: string;
const MINUTE = 60_000;
const month = (n: number) => toIsoDate(addMonths(parseBusinessDate(today), n));
const endAfter = (from: string, n: number) =>
  toIsoDate(addDays(addMonths(parseBusinessDate(from), n), -1));
const typed = (code: string) => ({
  code,
  method: 'typed' as const,
  typedName: 'Signer Name',
  consentVersion: CURRENT_CONSENT,
  consentAccepted: true,
});

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  renderer = await PdfRenderer.launch({ poolSize: 1 });
  worker = new EsignWorker(ctx, s, (html) => renderer.render(html));
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
  agencyId = await company(ctx, 'agency', 'Lockout Agency');
  const admin = await staffIn(ctx, agencyId, 'agency', 'agency_admin', 'Admin');
  manager = await staffIn(ctx, agencyId, 'agency', 'property_manager', 'Ama Manager');
  const ownerId = (await s.owners.create(admin, { kind: 'individual', displayName: 'Owner' })).id;
  ({ units } = await propertyWithUnits(s, manager, {
    areaCode: 'ACC',
    propertyPart: 'LCK',
    ownerId,
    units: [{ unitType: 'apartment', count: 2, bedrooms: 2 }],
  }));
}, 120_000);

afterAll(async () => {
  await renderer?.close();
  await ctx?.close();
});

describe('TL-07 NFR-SEC a signing link is revoked after three code lockouts (M11 review R3 F7)', () => {
  it('★ counts every wrong code on the link, revokes it at the third lockout, and tells whoever sent it', async () => {
    const tenantPhone = '+233200079001';
    const { tenant } = await s.tenants.create(manager, {
      kind: 'individual',
      displayName: 'Lockout Tenant',
      phone: tenantPhone,
      consent: { sms: true },
    });
    const draft = await s.leases.createDraft(manager, {
      unitId: units['ACC-LCK-B1-01']!,
      tenantId: tenant.id,
      startDate: month(2),
      endDate: endAfter(month(2), 12),
      monthlyRentMinor: 150_000,
      cycle: 'monthly',
      noticeDays: 30,
    });
    // The company asks for a witness on every lease (the default).
    await s.leases.updateDraft(manager, draft.id, {
      parties: [
        ...draft.parties.map((p) => ({
          role: p.role,
          name: p.name,
          phone: p.phone,
          email: p.email,
          tenantContactId: p.tenantContactId,
          staffPersonId: p.staffPersonId,
        })),
        { role: 'witness', name: 'Lockout Witness', phone: '+233200079002' },
      ],
    });
    await s.leaseSigning.issue(manager, draft.id);
    await worker.run(agencyId);
    const token = tokenIn(s.sms.lastTo(tenantPhone)?.body);
    const advanced: number[] = [];
    try {
      for (let lockout = 1; lockout <= CODE_LOCKOUTS_BEFORE_REVOKE; lockout += 1) {
        await s.signingPage.sendCode(token, PHONE);
        const right = /^(\d{6}) is your code/.exec(s.sms.lastTo(tenantPhone)!.body)![1]!;
        const wrong = right === '000000' ? '111111' : '000000';
        for (let i = 1; i < SIGNING_CODE.maxAttempts; i += 1)
          await expect(s.signingPage.sign(token, PHONE, typed(wrong))).rejects.toMatchObject({
            code: 'code_wrong',
          });
        if (lockout < CODE_LOCKOUTS_BEFORE_REVOKE) {
          await expect(s.signingPage.sign(token, PHONE, typed(wrong))).rejects.toMatchObject({
            status: 423,
            code: 'signing_locked',
          });
          // The lock lifts after 30 minutes, but the lockout is not forgotten.
          ctx.clock.advance((SIGNING_CODE.lockMinutes + 1) * MINUTE);
          advanced.push((SIGNING_CODE.lockMinutes + 1) * MINUTE);
        } else {
          await expect(s.signingPage.sign(token, PHONE, typed(wrong))).rejects.toMatchObject({
            status: 409,
            code: 'link_not_usable',
            details: { screen: 'revoked' },
          });
        }
      }
      // The link no longer signs or sends codes; nothing was signed.
      expect((await s.signingPage.open(token, PHONE)).screen).toBe('revoked');
      await expect(s.signingPage.sendCode(token, PHONE)).rejects.toMatchObject({
        code: 'link_not_usable',
      });
      const [link] = await withCompany(
        ctx.database,
        { companyId: agencyId, actorKind: 'system' },
        (tx) =>
          tx
            .select()
            .from(schema.secureLink)
            .where(
              sql`${schema.secureLink.tokenHash} is not null and ${schema.secureLink.revokeReason} = 'code_lockout'`,
            ),
      );
      expect(link).toBeTruthy();
      const events = await withCompany(
        ctx.database,
        { companyId: agencyId, actorKind: 'system' },
        (tx) =>
          tx
            .select({ kind: schema.signingEvent.kind, data: schema.signingEvent.data })
            .from(schema.signingEvent)
            .where(sql`${schema.signingEvent.kind} in ('signer.locked', 'link.revoked')`)
            .orderBy(schema.signingEvent.occurredAt),
      );
      expect(events.map((e) => e.kind)).toEqual([
        'signer.locked',
        'signer.locked',
        'signer.locked',
        'link.revoked',
      ]);
      expect(events.at(-1)!.data).toMatchObject({
        linkId: link!.id,
        reason: 'code_lockout',
        failures: CODE_LOCKOUTS_BEFORE_REVOKE * SIGNING_CODE.maxAttempts,
      });
      // The manager who sent it is told, so they can check with the tenant and send a new link.
      const notices = (await outboxOf(ctx, agencyId, MESSAGE_SEND_JOB))
        .map((e) => e.payload as { purpose: string; subject: string | null; recipient: unknown })
        .filter(
          (x) =>
            x.purpose === 'staff_notice' && x.subject?.startsWith('A signing link was withdrawn'),
        );
      expect(notices).toEqual([
        expect.objectContaining({ recipient: { type: 'staff', personId: manager.personId } }),
      ]);
    } finally {
      for (const ms of advanced) ctx.clock.advance(-ms);
    }
  });
});
