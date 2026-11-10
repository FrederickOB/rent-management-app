import { schema, sql, withCompany } from '@rent/db';
import { PdfRenderer } from '@rent/documents/render';
import { addDays, addMonths, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tokenHash } from '../src/esign/secrets';
import { asSuperuser, company, startServerTest, type ServerTestContext } from './support';
import { billingServices, type BillingServices } from './support/billing';
import { EsignWorker, PHONE, tokenIn } from './support/esign';
import { noticesServices, NoticesWorker, type NoticesServices } from './support/notices';
import {
  propertyWithUnits,
  staffIn,
  tenancyServices,
  uploadLeaseFile,
  type TenancyServices,
} from './support/tenancy';

/**
 * M11 security review R3 F9 for signing links: an expired or revoked link no longer tells the
 * links server who it was for or what the document is (the signer's name and times, the title,
 * reference and fingerprint). It keeps what its closed page shows and the passed links tests read:
 * the screen and reason, the landlord's contact, and for a notice its number, type and dates
 * (apps/links lib/notice.test.ts, e2e/signing.spec.ts).
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let n: NoticesServices;
let esign: EsignWorker;
let notices: NoticesWorker;
let renderer: PdfRenderer;
let agencyId: string;
let manager: Awaited<ReturnType<typeof staffIn>>;
let units: string[];
let phoneSeq = 0;
const MINUTE = 60_000;
/** Monday 9 November 2026, 10:00 in Accra: inside the sending window, as the notices tests. */
const START = new Date('2026-11-09T10:00:00Z');
const today = () => ctx.clock.now().toISOString().slice(0, 10);
const plus = (days: number) => toIsoDate(addDays(parseBusinessDate(today()), days));
const newPhone = () => `+2332007${String(9100 + (phoneSeq += 1)).padStart(5, '0')}`;
const nextUnit = () => units.shift()!;

/** What an expired or revoked page never carries. */
const CLOSED_BLANKS = {
  document: { title: '', reference: '', sha256: null, html: null, downloadable: false },
  signer: { name: '', signedAt: null, declinedAt: null },
  signers: [],
};

/** A lease out for signature to a tenant (with SMS consent) and a witness. */
async function issuedLease() {
  const tenantPhone = newPhone();
  const { tenant } = await s.tenants.create(manager, {
    kind: 'individual',
    displayName: 'Closed Link Tenant',
    phone: tenantPhone,
    consent: { sms: true },
  });
  const start = toIsoDate(addMonths(parseBusinessDate(today()), 2));
  const draft = await s.leases.createDraft(manager, {
    unitId: nextUnit(),
    tenantId: tenant.id,
    startDate: start,
    endDate: toIsoDate(addDays(addMonths(parseBusinessDate(start), 12), -1)),
    monthlyRentMinor: 150_000,
    cycle: 'monthly',
    noticeDays: 30,
  });
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
      { role: 'witness', name: 'Closed Link Witness', phone: newPhone() },
    ],
  });
  await s.leaseSigning.issue(manager, draft.id);
  await esign.run(agencyId);
  const progress = (await s.leaseSigning.progress(manager, draft.id))!;
  return {
    leaseId: draft.id,
    requestId: progress.requestId,
    tenantPhone,
    signers: Object.fromEntries(progress.signers.map((x) => [x.role, x.id])),
  };
}

/** The expiry of the link behind a token, from the database. */
async function expiryOf(companyId: string, token: string): Promise<Date> {
  const [link] = await withCompany(ctx.database, { companyId, actorKind: 'system' }, (tx) =>
    tx
      .select({ expiresAt: schema.secureLink.expiresAt })
      .from(schema.secureLink)
      .where(sql`${schema.secureLink.tokenHash} = ${tokenHash(token)}`),
  );
  return link!.expiresAt;
}

beforeAll(async () => {
  ctx = await startServerTest();
  ctx.clock.set(START);
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  n = noticesServices(ctx, s, b);
  renderer = await PdfRenderer.launch({ poolSize: 1 });
  esign = new EsignWorker(ctx, s, (html) => renderer.render(html));
  notices = new NoticesWorker(ctx, s, n, (html) => renderer.render(html));
  agencyId = await company(ctx, 'agency', 'Closed Links Agency');
  const admin = await staffIn(ctx, agencyId, 'agency', 'agency_admin', 'Admin');
  manager = await staffIn(ctx, agencyId, 'agency', 'property_manager', 'Esi Manager');
  const ownerId = (await s.owners.create(admin, { kind: 'individual', displayName: 'Owner' })).id;
  const property = await propertyWithUnits(s, manager, {
    areaCode: 'ACC',
    propertyPart: 'CLS',
    ownerId,
    units: [{ unitType: 'apartment', count: 4, bedrooms: 2 }],
  });
  units = Object.values(property.units);
}, 180_000);

afterAll(async () => {
  await renderer?.close();
  await ctx?.close();
});

describe('TL-07 NFR-SEC an expired or revoked signing link names no one and no document (M11 review R3 F9)', () => {
  it('★ blanks the signer and the document on a revoked or expired lease link, and keeps the landlord’s contact', async () => {
    const lease = await issuedLease();
    const token = tokenIn(s.sms.lastTo(lease.tenantPhone)?.body);
    const live = await s.signingPage.open(token, PHONE);
    expect(live).toMatchObject({ screen: 'sign', signer: { name: 'Closed Link Tenant' } });
    expect(live.document.title).not.toBe('');

    // Revoked: a newer hand-over link replaces the witness's first.
    const first = tokenIn(
      (await s.leaseSigning.handoverLink(manager, lease.requestId, lease.signers.witness!)).url,
    );
    await s.leaseSigning.handoverLink(manager, lease.requestId, lease.signers.witness!);
    const revoked = await s.signingPage.open(first, PHONE);
    expect(revoked).toMatchObject({ screen: 'revoked', reason: 'superseded', ...CLOSED_BLANKS });
    expect(revoked.landlord).toMatchObject({ name: 'Closed Links Agency' });
    expect(JSON.stringify(revoked)).not.toContain('Closed Link Witness');

    // Expired: 30 days on, the tenant's link says so and nothing more.
    ctx.clock.set(new Date((await expiryOf(agencyId, token)).getTime() + MINUTE));
    try {
      const expired = await s.signingPage.open(token, PHONE);
      expect(expired).toMatchObject({ screen: 'expired', ...CLOSED_BLANKS });
      expect(expired.landlord.name).toBe('Closed Links Agency');
      expect(JSON.stringify(expired)).not.toContain('Closed Link Tenant');
      expect(JSON.stringify(expired)).not.toContain(live.document.title);
    } finally {
      ctx.clock.set(START);
    }
  });

  it('keeps a notice’s number, type and dates on its expired link, as its closed page names them', async () => {
    const phone = newPhone();
    const { tenant } = await s.tenants.create(manager, {
      kind: 'individual',
      displayName: 'Closed Notice Tenant',
      phone,
      consent: { sms: true },
    });
    const start = plus(-60);
    const lease = await s.leases.recordPaper(manager, {
      unitId: nextUnit(),
      tenantId: tenant.id,
      startDate: start,
      endDate: toIsoDate(addDays(parseBusinessDate(start), 364)),
      monthlyRentMinor: 150_000,
      cycle: 'monthly',
      noticeDays: 30,
      parties: [{ role: 'tenant', name: tenant.displayName }],
      scanUploadId: await uploadLeaseFile(ctx, s, manager),
      signedOn: start,
    });
    // Billed from its start, so a rent demand has overdue invoices to name (as the notices tests).
    await asSuperuser(ctx, 'update lease set billing_start_date = start_date where id = $1', [
      lease.id,
    ]);
    await b.invoicing.onLeaseSigned(agencyId, lease.id);
    const check = await n.notices.compose(manager, { type: 'rent_demand', leaseId: lease.id });
    const draft = await n.notices.create(manager, {
      type: 'rent_demand',
      leaseId: lease.id,
      fields: check.prefill.suggestedFields,
    });
    await n.notices.issue(manager, draft.id);
    await notices.run(agencyId);
    const notice = await n.notices.get(manager, draft.id);
    const token = tokenIn(s.sms.lastTo(phone)?.body);
    const live = await s.signingPage.open(token, PHONE);
    expect(live).toMatchObject({ screen: 'sign', notice: { number: notice.number } });

    ctx.clock.set(new Date((await expiryOf(agencyId, token)).getTime() + MINUTE));
    try {
      const expired = await s.signingPage.open(token, PHONE);
      expect(expired).toMatchObject({
        screen: 'expired',
        subject: 'notice',
        ...CLOSED_BLANKS,
        notice: {
          number: notice.number,
          type: 'rent_demand',
          typeLabel: live.notice!.typeLabel,
          effectiveDate: live.notice!.effectiveDate,
        },
      });
      expect(expired.notice!.issuedAt).toEqual(live.notice!.issuedAt);
      expect(expired.landlord.name).toBe('Closed Links Agency');
      expect(JSON.stringify(expired)).not.toContain('Closed Notice Tenant');
    } finally {
      ctx.clock.set(START);
    }
  });
});
