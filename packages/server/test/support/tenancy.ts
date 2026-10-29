import { schema, sql, withCompany } from '@rent/db';
import {
  InMemoryEmail,
  InMemoryIdentityVerification,
  InMemorySms,
  LocalKms,
  type IdentityVerificationPort,
} from '@rent/integrations';
import { ApprovalsService } from '../../src/approvals/approvals.service';
import { OwnersService } from '../../src/companies/owners.service';
import { DbKeyStore } from '../../src/core/crypto/db-key-store';
import { FieldCipher } from '../../src/core/crypto/field-cipher';
import { MESSAGE_SEND_JOB, messageRequestSchema } from '../../src/core/messages';
import { DocumentsService } from '../../src/documents/documents.service';
import { StepUpVerifier } from '../../src/identity/step-up';
import { MessagingService } from '../../src/messaging/messaging.service';
import { PolicyService } from '../../src/policy/policy.service';
import { RegisterReadService } from '../../src/portfolio/register-read.service';
import { RegisterService } from '../../src/portfolio/register.service';
import { RulesService } from '../../src/rules/rules.service';
import { IDENTITY_VERIFY_JOB, IdChecksService } from '../../src/tenancy/id-checks.service';
import { LeaseDocumentsService } from '../../src/tenancy/lease-documents.service';
import { LeaseLifecycleService } from '../../src/tenancy/lease-lifecycle.service';
import { LeaseTemplatesService } from '../../src/tenancy/lease-templates.service';
import { LeasesService } from '../../src/tenancy/leases.service';
import { TenancyRemindersService } from '../../src/tenancy/tenancy-reminders.service';
import { TenantAppService } from '../../src/tenancy/tenant-app.service';
import { TenantsService } from '../../src/tenancy/tenants.service';
import { member, person, staff, type ServerTestContext } from './index';

/** The M3 services wired as Nest wires them, on the test database (CLAUDE.md section 12). */
export function tenancyServices(
  ctx: ServerTestContext,
  options: { identity?: IdentityVerificationPort | null } = {},
) {
  const policy = new PolicyService();
  const rules = new RulesService(ctx.database);
  const cipher = new FieldCipher(
    new LocalKms(ctx.config.LOCAL_KMS_MASTER_KEY!),
    new DbKeyStore(ctx.database),
    Buffer.from(ctx.config.BLIND_INDEX_MASTER_KEY!, 'base64'),
  );
  const documents = new DocumentsService(
    ctx.database,
    ctx.storage,
    ctx.config,
    ctx.clock,
    ctx.audit,
    rules,
  );
  const approvals = new ApprovalsService(
    ctx.database,
    policy,
    ctx.audit,
    new StepUpVerifier(ctx.database, ctx.config),
    ctx.clock,
  );
  const identity =
    options.identity === undefined ? new InMemoryIdentityVerification() : options.identity;
  const tenants = new TenantsService(ctx.database, policy, cipher, ctx.audit);
  const idChecks = new IdChecksService(ctx.database, policy, tenants, identity, ctx.clock);
  const templates = new LeaseTemplatesService(ctx.database, policy);
  const leaseDocuments = new LeaseDocumentsService(ctx.database, policy, documents, templates);
  const lifecycle = new LeaseLifecycleService(ctx.database, policy, rules, ctx.audit, ctx.clock);
  const leases = new LeasesService(
    ctx.database,
    policy,
    rules,
    approvals,
    documents,
    templates,
    lifecycle,
    ctx.audit,
    ctx.clock,
  );
  leases.registerApprovals();
  const sms = new InMemorySms();
  const email = new InMemoryEmail();
  const messaging = new MessagingService(ctx.database, sms, email, ctx.config, tenants, idChecks);
  const owners = new OwnersService(ctx.database, policy, cipher, ctx.audit);
  return {
    policy,
    rules,
    cipher,
    documents,
    approvals,
    identity,
    tenants,
    idChecks,
    templates,
    leaseDocuments,
    lifecycle,
    leases,
    reminders: new TenancyRemindersService(ctx.database, policy, ctx.clock),
    tenantApp: new TenantAppService(ctx.database, policy, documents),
    sms,
    email,
    messaging,
    owners,
    register: new RegisterService(ctx.database, policy, owners, ctx.clock, null),
    read: new RegisterReadService(ctx.database, policy),
    stepUp: new StepUpVerifier(ctx.database, ctx.config),
  };
}

export type TenancyServices = ReturnType<typeof tenancyServices>;

/** A staff member of a company, with a membership in the role. */
export async function staffIn(
  ctx: ServerTestContext,
  companyId: string,
  kind: 'agency' | 'landlord',
  role: Parameters<typeof staff>[4],
  name: string,
  scope: { owners?: string[]; properties?: string[] } = {},
) {
  const personId = await person(ctx, name);
  const membershipId = await member(ctx, companyId, personId, role);
  if (scope.owners || scope.properties)
    await withCompany(ctx.database, { companyId, actorKind: 'system' }, (tx) =>
      tx
        .update(schema.membership)
        .set({ scope })
        .where(sql`${schema.membership.id} = ${membershipId}`),
    );
  return { ...staff(companyId, kind, personId, membershipId, role), scope };
}

/** A property with units, created through the register (M2). Returns the unit ids by code. */
export async function propertyWithUnits(
  s: TenancyServices,
  actor: Parameters<RegisterService['createProperty']>[0],
  input: {
    areaCode: string;
    propertyPart: string;
    ownerId?: string;
    use?: 'residential' | 'commercial' | 'mixed';
    units: {
      unitType: 'single_room' | 'apartment' | 'shop' | 'office';
      count: number;
      bedrooms?: number;
    }[];
  },
): Promise<{ propertyId: string; units: Record<string, string> }> {
  const propertyId = await s.register.createProperty(actor, {
    areaCode: input.areaCode,
    propertyPart: input.propertyPart,
    name: `${input.areaCode}-${input.propertyPart} property`,
    propertyType: input.use === 'commercial' ? 'shop' : 'apartment_block',
    use: input.use ?? 'residential',
    ownerId: input.ownerId,
    address: { region: 'Greater Accra', town: 'Accra' },
    units: input.units,
  });
  const detail = await s.read.getProperty(actor, propertyId);
  return {
    propertyId,
    units: Object.fromEntries(detail.blocks.flatMap((b) => b.units.map((u) => [u.code, u.id]))),
  };
}

/** Uploads bytes where a presigned upload would put them, as the browser does. */
export async function uploadLeaseFile(
  ctx: ServerTestContext,
  s: TenancyServices,
  actor: Parameters<LeasesService['createUpload']>[0],
  bytes: Buffer = SAMPLE_PDF,
  contentType: 'application/pdf' | 'image/png' | 'image/jpeg' = 'application/pdf',
): Promise<string> {
  const upload = await s.leases.createUpload(actor, { contentType, sizeBytes: bytes.length });
  await ctx.storage.put({
    bucket: ctx.config.S3_BUCKET_FILES,
    key: upload.fields.key!,
    body: bytes,
    contentType,
  });
  return upload.uploadId;
}

export const SAMPLE_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1',
);

/** Runs the outbox's queued messages through the send job, as the worker would. */
export async function deliverMessages(
  ctx: ServerTestContext,
  s: TenancyServices,
  companyId: string,
): Promise<number> {
  const events = await withCompany(ctx.database, { companyId, actorKind: 'system' }, (tx) =>
    tx
      .select({ payload: schema.outboxEvent.payload })
      .from(schema.outboxEvent)
      .where(sql`${schema.outboxEvent.type} = ${MESSAGE_SEND_JOB}`)
      .orderBy(schema.outboxEvent.createdAt),
  );
  for (const e of events)
    await s.messaging.deliver(companyId, messageRequestSchema.parse(e.payload));
  return events.length;
}

/** Runs the identity check's queued start, as the worker would, returning the scheduled polls. */
export async function runIdentityStarts(
  ctx: ServerTestContext,
  s: TenancyServices,
  companyId: string,
): Promise<{ checkId: string; attempt: number; at: Date }[]> {
  const events = await withCompany(ctx.database, { companyId, actorKind: 'system' }, (tx) =>
    tx
      .select({ payload: schema.outboxEvent.payload })
      .from(schema.outboxEvent)
      .where(sql`${schema.outboxEvent.type} = ${IDENTITY_VERIFY_JOB}`),
  );
  const scheduled: { checkId: string; attempt: number; at: Date }[] = [];
  for (const e of events) {
    const payload = e.payload as { checkId: string; attempt: number | null };
    await s.idChecks.run(companyId, payload.checkId, payload.attempt, async (attempt, at) => {
      scheduled.push({ checkId: payload.checkId, attempt, at });
    });
  }
  return scheduled;
}

/** Messages of a company with their latest status, as recorded by the send job. */
export async function messagesOf(ctx: ServerTestContext, companyId: string) {
  return withCompany(ctx.database, { companyId, actorKind: 'system' }, async (tx) => {
    const result = await tx.execute<{
      id: string;
      purpose: string;
      recipient_type: string;
      body: string;
      status: string;
      channel: string | null;
      reason: string | null;
      events: string[];
    }>(
      sql`select m.id, m.purpose, m.recipient_type, m.body,
            (select e.status from message_event e where e.message_id = m.id order by e.occurred_at desc, e.id desc limit 1) as status,
            (select e.channel from message_event e where e.message_id = m.id order by e.occurred_at desc, e.id desc limit 1) as channel,
            (select e.reason from message_event e where e.message_id = m.id order by e.occurred_at desc, e.id desc limit 1) as reason,
            array(select e.status from message_event e where e.message_id = m.id order by e.occurred_at, e.id) as events
          from message m order by m.created_at`,
    );
    return result.rows;
  });
}
