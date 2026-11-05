import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { GLOBAL_TABLES } from './append-only';
import { createDatabase } from './client';
import { withCompany } from './context';
import { cloneTemplateDatabase, runSql, type TestDatabase } from './testing';
import {
  connect,
  createCompany,
  createMembership,
  createPerson,
  inContext,
  sqlState,
} from './testing/fixtures';

let db: TestDatabase;
let app: pg.Client;
let companyA: string;
let companyB: string;
const membershipOf: Record<string, string> = {};
const personOf: Record<string, string> = {};

/** One row in every company-scoped table, written through the application role. */
async function seedCompany(companyId: string) {
  const initiator = await createPerson(app, `initiator ${companyId}`);
  const approver = await createPerson(app, `approver ${companyId}`);
  const initiatorMembership = await createMembership(app, companyId, initiator);
  const approverMembership = await createMembership(app, companyId, approver);
  membershipOf[companyId] = initiatorMembership;
  personOf[companyId] = initiator;
  const zero = '0'.repeat(64);
  await inContext(app, { companyId, personId: initiator }, async () => {
    await app.query(
      "insert into company_key (company_id, purpose, version, wrapped_key, kms_key_id) values ($1, 'field_encryption', 1, '\\x00', 'test')",
      [companyId],
    );
    const { rows: docs } = await app.query<{ id: string }>(
      "insert into document (company_id, kind, content_type, size_bytes, sha256, bucket, storage_key, write_once) values ($1, 'test', 'application/pdf', 1, $2, 'b', 'k', true) returning id",
      [companyId, zero],
    );
    const { rows: requests } = await app.query<{ id: string }>(
      `insert into approval_request (company_id, action_type, subject_type, subject_id, payload, payload_hash, initiated_by,
         initiator_membership_id, mode, status, expires_at)
       values ($1, 'test.action', 'test', 's1', '{}', 'h', $2, $3, 'two_person', 'pending', now() + interval '1 day') returning id`,
      [companyId, initiator, initiatorMembership],
    );
    await app.query(
      "insert into approval_decision (company_id, request_id, decided_by, decided_by_membership_id, kind, payload_hash) values ($1, $2, $3, $4, 'approve', 'h')",
      [companyId, requests[0]!.id, approver, approverMembership],
    );
    await app.query(
      "insert into outbox_event (company_id, type, payload, idempotency_key) values ($1, 'test.event', '{}', 'k1')",
      [companyId],
    );
    await app.query(
      "insert into processed_job (company_id, key, job_name) values ($1, 'job-1', 'test')",
      [companyId],
    );
    await app.query(
      "insert into document_render_request (company_id, template_key, template_version, data, document_id) values ($1, 'system.sample', 1, '{}', $2)",
      [companyId, docs[0]!.id],
    );
    await app.query(
      "insert into upload_intent (company_id, purpose, storage_key, content_type, max_bytes, created_by, expires_at) values ($1, 'logo', 'k', 'image/png', 1000, $2, now() + interval '1 hour')",
      [companyId, initiator],
    );
    await app.query(
      "insert into audit_anchor (company_id, anchor_date, seq, hash, storage_key, object_sha256) values ($1, current_date, 1, '\\x00', 'k', $2)",
      [companyId, zero],
    );
    // The register (M2). The unit's status history row comes from its trigger.
    const { rows: owners } = await app.query<{ id: string }>(
      "insert into owner (company_id, reference, kind, display_name) values ($1, 'OWN-01', 'individual', 'Owner') returning id",
      [companyId],
    );
    const { rows: portfolios } = await app.query<{ id: string }>(
      "insert into portfolio (company_id, name, is_default) values ($1, 'Main portfolio', true) returning id",
      [companyId],
    );
    const { rows: properties } = await app.query<{ id: string }>(
      `insert into property (company_id, portfolio_id, code, area_code, name, property_type, use, region)
       values ($1, $2, 'ACC-LEG', 'ACC', 'Legon', 'compound_house', 'residential', 'Greater Accra') returning id`,
      [companyId, portfolios[0]!.id],
    );
    const propertyId = properties[0]!.id;
    // A same-day correction of the owner (M2 S5, M4a): the property was first filed under the
    // wrong owner, and that row is superseded by the owner's row below.
    const { rows: wrong } = await app.query<{ id: string }>(
      "insert into owner (company_id, reference, kind, display_name) values ($1, 'OWN-02', 'individual', 'Wrong Owner') returning id",
      [companyId],
    );
    const { rows: ownership } = await app.query<{ id: string }>(
      'insert into property_ownership (company_id, property_id, owner_id, share_bps, effective_from) values ($1, $2, $3, 10000, current_date) returning id',
      [companyId, propertyId, wrong[0]!.id],
    );
    await app.query(
      "insert into property_ownership_correction (company_id, property_id, ownership_id, reason) values ($1, $2, $3, 'Filed under the wrong owner')",
      [companyId, propertyId, ownership[0]!.id],
    );
    await app.query(
      'insert into property_ownership (company_id, property_id, owner_id, share_bps, effective_from) values ($1, $2, $3, 10000, current_date)',
      [companyId, propertyId, owners[0]!.id],
    );
    const { rows: blocks } = await app.query<{ id: string }>(
      "insert into block (company_id, property_id, code, is_default) values ($1, $2, 'B1', true) returning id",
      [companyId, propertyId],
    );
    const { rows: units } = await app.query<{ id: string }>(
      `insert into unit (company_id, property_id, block_id, code, label, unit_type, billing_band)
       values ($1, $2, $3, 'ACC-LEG-B1-01', '01', 'single_room', 'single_room') returning id`,
      [companyId, propertyId, blocks[0]!.id],
    );
    const { rows: meters } = await app.query<{ id: string }>(
      "insert into meter (company_id, property_id, utility, supplier, meter_number, meter_type) values ($1, $2, 'electricity', 'ECG', 'P-0001', 'prepaid') returning id",
      [companyId, propertyId],
    );
    await app.query(
      'insert into unit_meter (company_id, property_id, meter_id, unit_id) values ($1, $2, $3, $4)',
      [companyId, propertyId, meters[0]!.id, units[0]!.id],
    );
    await app.query(
      "insert into property_file (company_id, property_id, category, upload_intent_id, uploaded_by) values ($1, $2, 'photo', gen_random_uuid(), $3)",
      [companyId, propertyId, initiator],
    );
    await app.query(
      "insert into register_import (company_id, upload_intent_id, storage_key, created_by) values ($1, gen_random_uuid(), 'k', $2)",
      [companyId, initiator],
    );
    // Tenancy, e-signing and messaging (M3). The lease is drafted with its parties, then
    // recorded as signed on paper, so the schedule and the occupancy view have rows too.
    const { rows: tenants } = await app.query<{ id: string }>(
      "insert into tenant (company_id, kind, display_name, phone) values ($1, 'individual', 'Tenant', '+233200000099') returning id",
      [companyId],
    );
    const tenantId = tenants[0]!.id;
    await app.query(
      "insert into tenant_contact (company_id, tenant_id, kind, name) values ($1, $2, 'guarantor', 'Guarantor')",
      [companyId, tenantId],
    );
    await app.query(
      "insert into id_check (company_id, tenant_id, id_type, provider) values ($1, $2, 'ghana_card', 'memory')",
      [companyId, tenantId],
    );
    await app.query(
      "insert into consent_event (company_id, tenant_id, channel, action, text_version, text_sha256) values ($1, $2, 'sms', 'grant', 'messages.v1', $3)",
      [companyId, tenantId, zero],
    );
    const { rows: templates } = await app.query<{ id: string }>(
      "insert into lease_template (company_id, name, kind) values ($1, 'Residential', 'residential') returning id",
      [companyId],
    );
    const { rows: versions } = await app.query<{ id: string }>(
      "insert into lease_template_version (company_id, template_id, version, content, content_sha256) values ($1, $2, 1, '{}', $3) returning id",
      [companyId, templates[0]!.id, zero],
    );
    const { rows: leases } = await app.query<{ id: string }>(
      `insert into lease (company_id, property_id, unit_id, tenant_id, use, template_version_id, start_date, end_date,
         monthly_rent_minor, rent_cycle, notice_days)
       values ($1, $2, $3, $4, 'residential', $5, current_date, current_date + 364, 150000, 'monthly', 30) returning id`,
      [companyId, propertyId, units[0]!.id, tenantId, versions[0]!.id],
    );
    const leaseRef = [companyId, propertyId, tenantId, leases[0]!.id];
    await app.query(
      "insert into lease_party (company_id, property_id, tenant_id, lease_id, party_role, name, position) values ($1, $2, $3, $4, 'tenant', 'Tenant', 1)",
      leaseRef,
    );
    await app.query(
      'insert into rent_step (company_id, property_id, tenant_id, lease_id, effective_from, monthly_rent_minor) values ($1, $2, $3, $4, current_date + 182, 160000)',
      leaseRef,
    );
    await app.query(
      "insert into lease_charge (company_id, property_id, tenant_id, lease_id, charge_type, monthly_amount_minor) values ($1, $2, $3, $4, 'service_charge', 10000)",
      leaseRef,
    );
    await app.query(
      "update lease set status = 'signed', signed_at = now(), signing_method = 'paper', signed_document_id = $2 where id = $1",
      [leases[0]!.id, docs[0]!.id],
    );
    await app.query(
      "insert into charge_period (company_id, property_id, tenant_id, lease_id, sequence, charge_type, period_start, period_end, amount_minor) values ($1, $2, $3, $4, 0, 'rent', current_date, current_date + 29, 150000)",
      leaseRef,
    );
    const { rows: signing } = await app.query<{ id: string }>(
      "insert into signing_request (company_id, property_id, tenant_id, subject_type, lease_id) values ($1, $2, $3, 'lease', $4) returning id",
      leaseRef,
    );
    const signingRef = [companyId, propertyId, tenantId, signing[0]!.id];
    const { rows: signers } = await app.query<{ id: string }>(
      "insert into signer (company_id, property_id, tenant_id, signing_request_id, signer_role, subject_type, name, phone, position) values ($1, $2, $3, $4, 'tenant', 'tenant', 'Tenant', '+233200000099', 1) returning id",
      signingRef,
    );
    const { rows: links } = await app.query<{ id: string }>(
      "insert into secure_link (company_id, property_id, tenant_id, purpose, token_hash, signer_id, expires_at) values ($1, $2, $3, 'sign', $4, $5, now() + interval '30 days') returning id",
      [companyId, propertyId, tenantId, randomBytes(32).toString('hex'), signers[0]!.id],
    );
    const { rows: codes } = await app.query<{ id: string }>(
      `insert into otp_challenge (company_id, property_id, tenant_id, signer_id, secure_link_id, channel, destination_masked,
         destination_hash, code_hash, expires_at)
       values ($1, $2, $3, $4, $5, 'sms', '+233 ** *** 0099', 'h', 'c', now() + interval '10 minutes') returning id`,
      [companyId, propertyId, tenantId, signers[0]!.id, links[0]!.id],
    );
    await app.query(
      `insert into signature (company_id, property_id, tenant_id, signing_request_id, signer_id, method, typed_name,
         consent_version, consent_sha256, verified_channel, verified_destination_masked, ip_address, user_agent,
         document_sha256, otp_challenge_id)
       values ($1, $2, $3, $4, $5, 'typed', 'Tenant', 'consent.v1', $6, 'sms', '+233 ** *** 0099', '203.0.113.7', 'test', $6, $7)`,
      [...signingRef, signers[0]!.id, zero, codes[0]!.id],
    );
    await app.query(
      "insert into signing_event (company_id, property_id, tenant_id, signing_request_id, signer_id, kind) values ($1, $2, $3, $4, $5, 'link_opened')",
      [...signingRef, signers[0]!.id],
    );
    const { rows: messages } = await app.query<{ id: string }>(
      "insert into message (id, company_id, tenant_id, recipient_type, purpose, body, channels) values (gen_random_uuid(), $1, $2, 'tenant', 'signing_link', 'Sign here: [link]', '{sms}') returning id",
      [companyId, tenantId],
    );
    await app.query(
      "insert into message_event (company_id, message_id, status) values ($1, $2, 'queued')",
      [companyId, messages[0]!.id],
    );
    await seedMoney(companyId, {
      initiator,
      initiatorMembership,
      approver,
      approverMembership,
      requestId: requests[0]!.id,
      documentId: docs[0]!.id,
      ownerId: owners[0]!.id,
      propertyId,
      unitId: units[0]!.id,
      tenantId,
      leaseId: leases[0]!.id,
    });
    await seedMessaging(companyId, {
      initiator,
      documentId: docs[0]!.id,
      messageId: messages[0]!.id,
      propertyId,
      unitId: units[0]!.id,
      tenantId,
      leaseId: leases[0]!.id,
    });
    await seedNotices(companyId, {
      initiator,
      initiatorMembership,
      documentId: docs[0]!.id,
      propertyId,
      unitId: units[0]!.id,
      tenantId,
      leaseId: leases[0]!.id,
    });
    await seedMaintenance(companyId, {
      initiator,
      initiatorMembership,
      documentId: docs[0]!.id,
      ownerId: owners[0]!.id,
      propertyId,
      unitId: units[0]!.id,
      tenantId,
      leaseId: leases[0]!.id,
    });
  });
}

/**
 * Maintenance, inspections, expenses and move-out (M8): one row in each of their company tables,
 * around one job and one move-out under the fixture lease. The deposit the deduction comes from is
 * a fixture entry crediting 2100, written as ledger_writer.
 */
async function seedMaintenance(
  companyId: string,
  ids: {
    initiator: string;
    initiatorMembership: string;
    documentId: string;
    ownerId: string;
    propertyId: string;
    unitId: string;
    tenantId: string;
    leaseId: string;
  },
) {
  const lease = [companyId, ids.propertyId, ids.tenantId, ids.leaseId];
  const { rows: books } = await app.query<{ id: string }>(
    'select id from book where owner_id = $1',
    [ids.ownerId],
  );
  const bookId = books[0]!.id;
  const depositEntry = randomUUID();
  await app.query('set local role ledger_writer');
  await app.query(
    // eslint-disable-next-line rent/ledger-writes -- a fixture row, written as the posting service writes them
    `insert into journal_entry (id, company_id, rule, idempotency_key, value_date, accounting_date, record_type, record_id)
     values ($1, $2, 'P10', $3, current_date, current_date, 'fixture', $1)`,
    [depositEntry, companyId, `P10:${depositEntry}`],
  );
  await app.query(
    // eslint-disable-next-line rent/ledger-writes -- a fixture row, written as the posting service writes them
    `insert into journal_line (id, company_id, entry_id, line_no, book_id, account_code, amount_minor, property_id, unit_id,
       lease_id, tenant_id)
     values (gen_random_uuid(), $1, $2, 1, $3, '1010', 5000, $4, $5, $6, $7),
            (gen_random_uuid(), $1, $2, 2, $3, '2100', -5000, $4, $5, $6, $7)`,
    [companyId, depositEntry, bookId, ids.propertyId, ids.unitId, ids.leaseId, ids.tenantId],
  );
  await app.query('set local role none');
  const { rows: artisans } = await app.query<{ id: string }>(
    "insert into artisan (company_id, name, phone, trades, created_by) values ($1, 'Kofi Plumber', '+233200000077', '{plumbing}', $2) returning id",
    [companyId, ids.initiator],
  );
  const artisanId = artisans[0]!.id;
  await app.query(
    `insert into contact_consent_event (company_id, subject_type, membership_id, channel, action, text_version, text_sha256,
       source, recorded_by) values ($1, 'staff', $2, 'whatsapp', 'grant', 'staff_alerts.v1', $3, 'staff', $4)`,
    [companyId, ids.initiatorMembership, '0'.repeat(64), ids.initiator],
  );
  const { rows: jobs } = await app.query<{ id: string }>(
    `insert into maintenance_job (company_id, property_id, unit_id, lease_id, tenant_id, source, description, reported_by)
     values ($1, $2, $3, $4, $5, 'staff', 'The roof leaks', $6) returning id`,
    [companyId, ids.propertyId, ids.unitId, ids.leaseId, ids.tenantId, ids.initiator],
  );
  const jobId = jobs[0]!.id;
  await app.query(
    `insert into maintenance_job_event (company_id, property_id, job_id, kind, actor_kind, actor_person_id, data)
     values ($1, $2, $3, 'reported', 'staff', $4, '{"source":"staff"}')`,
    [companyId, ids.propertyId, jobId, ids.initiator],
  );
  const { rows: links } = await app.query<{ id: string }>(
    `insert into secure_link (company_id, property_id, purpose, token_hash, job_id, artisan_id, expires_at)
     values ($1, $2, 'job_sheet', $3, $4, $5, now() + interval '30 days') returning id`,
    [companyId, ids.propertyId, randomBytes(32).toString('hex'), jobId, artisanId],
  );
  await app.query(
    `insert into job_sheet_code (company_id, property_id, job_id, artisan_id, secure_link_id, channel, destination_masked,
       destination_hash, code_hash, expires_at)
     values ($1, $2, $3, $4, $5, 'sms', '+233 ** *** 0077', 'h', 'c', now() + interval '10 minutes')`,
    [companyId, ids.propertyId, jobId, artisanId, links[0]!.id],
  );
  await app.query(
    `insert into inspection_template (company_id, unit_type, rooms, updated_by)
     values ($1, 'single_room', '[{"key":"room","label":"Room","items":[{"key":"walls","label":"Walls"}]}]', $2)`,
    [companyId, ids.initiator],
  );
  const { rows: inspections } = await app.query<{ id: string }>(
    `insert into inspection (company_id, property_id, unit_id, lease_id, tenant_id, kind, unit_type, performed_by)
     values ($1, $2, $3, $4, $5, 'move_out', 'single_room', $6) returning id`,
    [companyId, ids.propertyId, ids.unitId, ids.leaseId, ids.tenantId, ids.initiator],
  );
  const inspectionId = inspections[0]!.id;
  const { rows: items } = await app.query<{ id: string }>(
    `insert into inspection_item (company_id, property_id, inspection_id, position, room_key, room_label, item_key,
       item_label, condition) values ($1, $2, $3, 1, 'room', 'Room', 'walls', 'Walls', 'damaged') returning id`,
    [companyId, ids.propertyId, inspectionId],
  );
  const { rows: photos } = await app.query<{ id: string }>(
    `insert into inspection_photo (company_id, property_id, inspection_id, item_id, document_id, added_by)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [companyId, ids.propertyId, inspectionId, items[0]!.id, ids.documentId, ids.initiator],
  );
  const { rows: entries } = await app.query<{ id: string }>(
    'select id from journal_entry order by posted_at limit 1',
  );
  const entryId = entries[0]!.id;
  const { rows: expenses } = await app.query<{ id: string }>(
    `insert into expense (company_id, property_id, unit_id, owner_id, book_id, category, supplier_name, amount_minor,
       expense_date, paid_by, receipt_document_id, job_id, entry_id, accounting_date, created_by)
     values ($1, $2, $3, $4, $5, 'repairs', 'Kofi Plumber', 12000, current_date, 'unpaid', $6, $7, $8, current_date, $9)
     returning id`,
    [
      companyId,
      ids.propertyId,
      ids.unitId,
      ids.ownerId,
      bookId,
      ids.documentId,
      jobId,
      entryId,
      ids.initiator,
    ],
  );
  await app.query(
    `insert into expense_payment (company_id, property_id, expense_id, paid_on, paid_from, entry_id, accounting_date)
     values ($1, $2, $3, current_date, 'owner_account', $4, current_date)`,
    [companyId, ids.propertyId, expenses[0]!.id, entryId],
  );
  await app.query(
    `insert into expense_reversal (company_id, property_id, expense_id, reason, entry_id, value_date, accounting_date)
     values ($1, $2, $3, 'A fixture', $4, current_date, current_date)`,
    [companyId, ids.propertyId, expenses[0]!.id, entryId],
  );
  const { rows: moves } = await app.query<{ id: string }>(
    `insert into move_out (company_id, property_id, tenant_id, lease_id, unit_id, owner_id, book_id, reason, planned_date,
       inspection_id, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, 'end_of_term', current_date, $8, $9) returning id`,
    [...lease, ids.unitId, ids.ownerId, bookId, inspectionId, ids.initiator],
  );
  const moveOutId = moves[0]!.id;
  const { rows: deductions } = await app.query<{ id: string }>(
    `insert into deposit_deduction (company_id, property_id, tenant_id, lease_id, move_out_id, kind, amount_minor, reason,
       inspection_item_ids, photo_ids, created_by)
     values ($1, $2, $3, $4, $5, 'damage', 1000, 'A hole in the wall', array[$6::uuid], array[$7::uuid], $8) returning id`,
    [...lease, moveOutId, items[0]!.id, photos[0]!.id, ids.initiator],
  );
  await app.query(
    `insert into deposit_deduction_withdrawal (company_id, property_id, move_out_id, deduction_id, created_by)
     values ($1, $2, $3, $4, $5)`,
    [companyId, ids.propertyId, moveOutId, deductions[0]!.id, ids.initiator],
  );
  const { rows: payments } = await app.query<{ id: string }>(
    'select id from payment where lease_id = $1 limit 1',
    [ids.leaseId],
  );
  await app.query(
    `insert into deposit_application (company_id, property_id, tenant_id, lease_id, move_out_id, kind, payment_id,
       amount_minor, entry_id, value_date, accounting_date)
     values ($1, $2, $3, $4, $5, 'refund', $6, 1000, $7, current_date, current_date)`,
    [...lease, moveOutId, payments[0]!.id, depositEntry],
  );
  await app.query(
    `insert into move_out_refund_part (company_id, move_out_id, property_id, tenant_id, lease_id, payment_id, amount_minor)
     values ($1, $5, $2, $3, $4, $6, 1000)`,
    [...lease, moveOutId, payments[0]!.id],
  );
}

/**
 * Legal notices and tasks (M7): one row in each of their company tables, around one notice of
 * entry issued under the fixture lease.
 */
async function seedNotices(
  companyId: string,
  ids: {
    initiator: string;
    initiatorMembership: string;
    documentId: string;
    propertyId: string;
    unitId: string;
    tenantId: string;
    leaseId: string;
  },
) {
  const zero = '0'.repeat(64);
  const { rows: notices } = await app.query<{ id: string }>(
    `insert into notice (company_id, number, type, subtype, status, property_id, unit_id, lease_id, tenant_id, fields,
       template_key, template_version, issue_date, issued_at, created_by)
     values ($1, 1, 'entry', 'inspection', 'sent', $2, $3, $4, $5, '{}', 'notices.notice', 1, current_date, now(), $6)
     returning id`,
    [companyId, ids.propertyId, ids.unitId, ids.leaseId, ids.tenantId, ids.initiator],
  );
  const noticeId = notices[0]!.id;
  const { rows: recipients } = await app.query<{ id: string }>(
    `insert into notice_recipient (company_id, property_id, notice_id, tenant_id, lease_id, unit_id, kind, name, phone,
       channels, physical_service_planned, position)
     values ($1, $2, $3, $4, $5, $6, 'tenant', 'Tenant', '+233200000099', '[]', false, 1) returning id`,
    [companyId, ids.propertyId, noticeId, ids.tenantId, ids.leaseId, ids.unitId],
  );
  await app.query(
    `insert into notice_event (company_id, property_id, notice_id, recipient_id, tenant_id, kind, dedupe_key)
     values ($1, $2, $3, $4, $5, 'sent', $6)`,
    [companyId, ids.propertyId, noticeId, recipients[0]!.id, ids.tenantId, `sent:${noticeId}`],
  );
  await app.query(
    `insert into service_record (company_id, property_id, notice_id, recipient_id, method, served_at, served_by_name,
       recorded_by)
     values ($1, $2, $3, $4, 'handed_to_tenant', now(), 'Caretaker', $5)`,
    [companyId, ids.propertyId, noticeId, recipients[0]!.id, ids.initiator],
  );
  await app.query(
    `insert into rent_assessment (company_id, property_id, unit_id, assessed_on, reference, document_id, recorded_by)
     values ($1, $2, $3, current_date - 30, 'RO/2026/001', $4, $5)`,
    [companyId, ids.propertyId, ids.unitId, ids.documentId, ids.initiator],
  );
  // M7 review C4: an assessment recorded in error, voided.
  const { rows: mistaken } = await app.query<{ id: string }>(
    `insert into rent_assessment (company_id, property_id, unit_id, assessed_on, reference, recorded_by)
     values ($1, $2, $3, current_date - 40, 'RO/2026/000', $4) returning id`,
    [companyId, ids.propertyId, ids.unitId, ids.initiator],
  );
  await app.query(
    `insert into rent_assessment_void (company_id, property_id, unit_id, assessment_id, reason, voided_by)
     values ($1, $2, $3, $4, 'Recorded on the wrong unit', $5)`,
    [companyId, ids.propertyId, ids.unitId, mistaken[0]!.id, ids.initiator],
  );
  await app.query(
    `insert into notice_quit_acknowledgement (company_id, action, person_id, membership_id, typed_name,
       statement_version, statement_sha256)
     values ($1, 'grant', $2, $3, 'Initiator', 'quit_ack.v1', $4)`,
    [companyId, ids.initiator, ids.initiatorMembership, zero],
  );
  await app.query(
    `insert into task (company_id, property_id, unit_id, tenant_id, kind, title, related_type, notice_id, recipient_id,
       due_at, dedupe_key)
     values ($1, $2, $3, $4, 'notice_in_person_reminder', 'Remind the tenant', 'notice', $5, $6, now() + interval '1 day',
       $7)`,
    [
      companyId,
      ids.propertyId,
      ids.unitId,
      ids.tenantId,
      noticeId,
      recipients[0]!.id,
      `task:${noticeId}`,
    ],
  );
}

/**
 * The ledger and billing (M4a): one row in each of their tables. Books come from the database
 * itself (with the company and the owner); journal rows are written as ledger_writer, the only
 * role that may.
 */
async function seedMoney(
  companyId: string,
  ids: {
    initiator: string;
    initiatorMembership: string;
    approver: string;
    approverMembership: string;
    requestId: string;
    documentId: string;
    ownerId: string;
    propertyId: string;
    unitId: string;
    tenantId: string;
    leaseId: string;
  },
) {
  const { rows: books } = await app.query<{ id: string }>(
    'select id from book where owner_id = $1',
    [ids.ownerId],
  );
  const bookId = books[0]!.id;
  const { rows: periods } = await app.query<{ id: string; period_start: string }>(
    "select id, period_start::text from charge_period where lease_id = $1 and charge_type = 'rent'",
    [ids.leaseId],
  );
  const period = periods[0]!;
  const lease = [companyId, ids.propertyId, ids.tenantId, ids.leaseId];
  const reference = `K${randomBytes(3)
    .toString('hex')
    .toUpperCase()
    .replace(/[ILOU]/g, '1')
    .slice(0, 6)}`.slice(0, 7);
  await app.query(
    'insert into payment_reference (company_id, property_id, tenant_id, lease_id, reference) values ($1, $2, $3, $4, $5)',
    [...lease, reference.padEnd(7, '0')],
  );
  const { rows: invoices } = await app.query<{ id: string }>(
    `insert into invoice (company_id, property_id, tenant_id, lease_id, number, kind, unit_id, owner_id, book_id, issue_date,
       due_date, cycle_start, payment_reference, unit_code, property_name, billed_to_name, billed_from_name)
     values ($1, $2, $3, $4, 1, 'cycle', $5, $6, $7, current_date, $8, $8, 'K000000', 'ACC-LEG-B1-01', 'Legon', 'Tenant', 'Owner')
     returning id`,
    [...lease, ids.unitId, ids.ownerId, bookId, period.period_start],
  );
  const { rows: lines } = await app.query<{ id: string }>(
    `insert into invoice_line (company_id, property_id, tenant_id, lease_id, invoice_id, position, kind, charge_period_id,
       period_start, period_end, due_date, amount_minor)
     values ($1, $2, $3, $4, $5, 1, 'rent', $6, $7, $7::date + 29, $7, 150000) returning id`,
    [...lease, invoices[0]!.id, period.id, period.period_start],
  );
  const lineId = lines[0]!.id;
  const paymentId = randomUUID();
  const cashRecordId = randomUUID();
  const accrual = randomUUID();
  const receiptEntry = randomUUID();
  await app.query('set local role ledger_writer');
  for (const [entryId, rule, key] of [
    [accrual, 'P02', `P02:${lineId}`],
    [receiptEntry, 'P06', `P06:${paymentId}`],
  ] as const)
    await app.query(
      // eslint-disable-next-line rent/ledger-writes -- a fixture row, written as the posting service writes them
      `insert into journal_entry (id, company_id, rule, idempotency_key, value_date, accounting_date, record_type, record_id)
       values ($1, $2, $3, $4, current_date, current_date, 'fixture', $1)`,
      [entryId, companyId, rule, key],
    );
  await app.query(
    // eslint-disable-next-line rent/ledger-writes -- a fixture row, written as the posting service writes them
    `insert into journal_line (id, company_id, entry_id, line_no, book_id, account_code, amount_minor, property_id, unit_id,
       lease_id, tenant_id, invoice_line_id, payment_id, collector_id)
     values (gen_random_uuid(), $1, $2, 1, $3, '1100', 150000, $4, $5, $6, $7, $8, null, null),
            (gen_random_uuid(), $1, $2, 2, $3, '4000', -150000, $4, $5, $6, $7, $8, null, null),
            (gen_random_uuid(), $1, $9, 1, $3, '1060', 150000, $4, $5, $6, $7, null, $10, $11),
            (gen_random_uuid(), $1, $9, 2, $3, '1100', -150000, $4, $5, $6, $7, $8, $10, null)`,
    [
      companyId,
      accrual,
      bookId,
      ids.propertyId,
      ids.unitId,
      ids.leaseId,
      ids.tenantId,
      lineId,
      receiptEntry,
      paymentId,
      ids.initiator,
    ],
  );
  await app.query('set local role none');
  await app.query(
    `insert into invoice_line_accrual (company_id, property_id, tenant_id, lease_id, invoice_line_id, amount_minor, value_date,
       accounting_date, entry_id) values ($1, $2, $3, $4, $5, 150000, current_date, current_date, $6)`,
    [...lease, lineId, accrual],
  );
  await app.query(
    `insert into cash_record (id, company_id, property_id, tenant_id, lease_id, unit_id, method, amount_minor, received_on,
       payer_name, collector_person_id, photo_document_id, approval_request_id, recorded_by)
     values ($5, $1, $2, $3, $4, $6, 'cash', 150000, current_date, 'Tenant', $7, $8, $9, $7)`,
    [...lease, cashRecordId, ids.unitId, ids.initiator, ids.documentId, ids.requestId],
  );
  await app.query(
    `insert into payment (id, company_id, property_id, tenant_id, lease_id, unit_id, method, amount_minor, received_on,
       accounting_date, owner_id, book_id, cash_account, collector_person_id, source_type, source_id, entry_id, recorded_by)
     values ($5, $1, $2, $3, $4, $6, 'cash', 150000, current_date, current_date, $7, $8, '1060', $9, 'cash_record', $10, $11, $9)`,
    [
      ...lease,
      paymentId,
      ids.unitId,
      ids.ownerId,
      bookId,
      ids.initiator,
      cashRecordId,
      receiptEntry,
    ],
  );
  await app.query(
    `insert into allocation (company_id, property_id, tenant_id, lease_id, invoice_line_id, source, payment_id, amount_minor,
       value_date, accounting_date, record_type, record_id, entry_id)
     values ($1, $2, $3, $4, $5, 'payment', $6, 150000, current_date, current_date, 'payment', $6, $7)`,
    [...lease, lineId, paymentId, receiptEntry],
  );
  const { rows: receipts } = await app.query<{ id: string }>(
    `insert into receipt (company_id, property_id, tenant_id, lease_id, number, kind, payment_id, amount_minor)
     values ($1, $2, $3, $4, 1, 'receipt', $5, 150000) returning id`,
    [...lease, paymentId],
  );
  await app.query(
    `insert into payment_match (company_id, property_id, tenant_id, lease_id, payment_id, unit_id, book_id, entry_id, value_date,
       accounting_date) values ($1, $2, $3, $4, $5, $6, $7, $8, current_date, current_date)`,
    [...lease, paymentId, ids.unitId, bookId, receiptEntry],
  );
  await app.query(
    `insert into payment_reversal (company_id, property_id, tenant_id, lease_id, payment_id, reason, note, money_now_in,
       approval_request_id, entry_id, value_date, accounting_date)
     values ($1, $2, $3, $4, $5, 'other', 'A fixture', 'collector', $6, $7, current_date, current_date)`,
    [...lease, paymentId, ids.requestId, receiptEntry],
  );
  await app.query(
    `insert into credit_carry_over (company_id, property_id, tenant_id, lease_id, from_lease_id, kind, amount_minor, entry_id,
       value_date, accounting_date) values ($1, $2, $3, $4, $4, 'deposit', 1000, $5, current_date, current_date)`,
    [...lease, receiptEntry],
  );
  await app.query(
    `insert into credit_note (company_id, property_id, tenant_id, lease_id, invoice_line_id, amount_minor, reason, kind,
       value_date, accounting_date) values ($1, $2, $3, $4, $5, 1000, 'A fixture', 'system', current_date, current_date)`,
    [...lease, lineId],
  );
  await app.query(
    `insert into write_off (company_id, property_id, tenant_id, lease_id, invoice_line_id, amount_minor, reason,
       approval_request_id, entry_id, value_date, accounting_date)
     values ($1, $2, $3, $4, $5, 1000, 'A fixture', $6, $7, current_date, current_date)`,
    [...lease, lineId, ids.requestId, receiptEntry],
  );
  await app.query(
    `insert into direct_receipt (id, company_id, received_into, owner_id, amount_minor, received_on, proof_document_id,
       approval_request_id, recorded_by)
     values (gen_random_uuid(), $1, 'owner_account', $2, 1000, current_date, $3, $4, $5)`,
    [companyId, ids.ownerId, ids.documentId, ids.requestId, ids.initiator],
  );
  await app.query(
    `insert into cash_banking (id, company_id, collector_person_id, owner_id, book_id, banked_into, amount_minor, banked_on,
       slip_document_id, approval_request_id, recorded_by)
     values (gen_random_uuid(), $1, $2, $3, $4, 'owner_account', 1000, current_date, $5, $6, $2)`,
    [companyId, ids.initiator, ids.ownerId, bookId, ids.documentId, ids.requestId],
  );
  await app.query(
    "insert into period_lock (company_id, book_id, month, source) values ($1, $2, '2099-01-01', 'manual')",
    [companyId, bookId],
  );
  await app.query(
    "insert into company_counter (company_id, name, value) values ($1, 'receipt', 1)",
    [companyId],
  );
  await app.query(
    "insert into idempotent_request (company_id, key, operation, person_id, request_hash) values ($1, 'fixture-key', 'fixture', $2, $3)",
    [companyId, ids.initiator, '0'.repeat(64)],
  );
  await seedPayments(companyId, {
    ...ids,
    bookId,
    invoiceId: invoices[0]!.id,
    paymentId,
    receiptId: receipts[0]!.id,
    entryId: receiptEntry,
  });
  await seedTax(companyId, {
    ...ids,
    bookId,
    paymentId,
    lineId,
    chargePeriodId: period.id,
    entryId: receiptEntry,
  });
}

/** Rent tax, withholding, advance rent and early termination (M5): one row in each table. */
async function seedTax(
  companyId: string,
  ids: {
    initiator: string;
    approver: string;
    requestId: string;
    documentId: string;
    ownerId: string;
    propertyId: string;
    unitId: string;
    tenantId: string;
    leaseId: string;
    bookId: string;
    paymentId: string;
    lineId: string;
    chargePeriodId: string;
    entryId: string;
  },
) {
  const lease = [companyId, ids.propertyId, ids.tenantId, ids.leaseId];
  const { rows: rules } = await app.query<{ id: string }>(
    "select id from rule where key = 'rent_tax.rate.residential' limit 1",
  );
  const ruleId = rules[0]!.id;
  const { rows: items } = await app.query<{ id: string }>(
    `insert into rent_tax_item (company_id, property_id, tenant_id, lease_id, unit_id, owner_id, book_id, kind, payment_id,
       value_date, accounting_date, due_date, base_minor, rate_bps, tax_minor, lease_use, unit_code, tenant_name,
       rate_rule_id, entry_id)
     values ($1, $2, $3, $4, $5, $6, $7, 'receipt', $8, current_date, current_date, current_date + 30, 120000, 800, 9600,
       'residential', 'ACC-LEG-B1-01', 'Tenant', $9, $10) returning id`,
    [...lease, ids.unitId, ids.ownerId, ids.bookId, ids.paymentId, ruleId, ids.entryId],
  );
  const itemId = items[0]!.id;
  await app.query(
    `insert into rent_tax_item_line (company_id, item_id, property_id, tenant_id, lease_id, charge_period_id, invoice_line_id,
       base_minor, tax_minor) values ($1, $5, $2, $3, $4, $6, $7, 120000, 9600)`,
    [...lease, itemId, ids.chargePeriodId, ids.lineId],
  );
  const { rows: withholdings } = await app.query<{ id: string }>(
    `insert into withholding (company_id, property_id, tenant_id, lease_id, unit_id, owner_id, book_id, payment_id,
       value_date, accounting_date, amount_minor, rate_bps, rate_rule_id, differs_from_rate, entry_id, recorded_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, current_date, current_date, 1000, 800, $9, true, $10, $11) returning id`,
    [
      ...lease,
      ids.unitId,
      ids.ownerId,
      ids.bookId,
      ids.paymentId,
      ruleId,
      ids.entryId,
      ids.initiator,
    ],
  );
  const withholdingId = withholdings[0]!.id;
  await app.query(
    `insert into withholding_certificate (company_id, withholding_id, property_id, tenant_id, lease_id, owner_id, document_id,
       amount_minor, uploaded_by) values ($1, $5, $2, $3, $4, $6, $7, 1000, $8)`,
    [...lease, withholdingId, ids.ownerId, ids.documentId, ids.initiator],
  );
  await app.query(
    `insert into withholding_write_off (company_id, withholding_id, property_id, tenant_id, lease_id, amount_minor, reason,
       approval_request_id, entry_id, value_date, accounting_date)
     values ($1, $5, $2, $3, $4, 1000, 'A fixture', $6, $7, current_date, current_date)`,
    [...lease, withholdingId, ids.requestId, ids.entryId],
  );
  const { rows: gra } = await app.query<{ id: string }>(
    `insert into gra_payment (company_id, owner_id, book_id, paid_on, accounting_date, amount_minor, gra_receipt_number,
       receipt_document_id, paid_from, entry_id, recorded_by)
     values ($1, $2, $3, current_date, current_date, 1000, 'GRA-1', $4, 'owner_account', $5, $6) returning id`,
    [companyId, ids.ownerId, ids.bookId, ids.documentId, ids.entryId, ids.initiator],
  );
  await app.query(
    'insert into gra_payment_item (company_id, gra_payment_id, item_id, amount_minor) values ($1, $2, $3, 1000)',
    [companyId, gra[0]!.id, itemId],
  );
  await app.query(
    `insert into vat_payment (company_id, owner_id, book_id, period_month, paid_on, accounting_date, amount_minor,
       gra_receipt_number, receipt_document_id, paid_from, entry_id, recorded_by)
     values ($1, $2, $3, date_trunc('month', current_date)::date, current_date, current_date, 1000, 'GRA-V1', $4,
       'owner_account', $5, $6)`,
    [companyId, ids.ownerId, ids.bookId, ids.documentId, ids.entryId, ids.initiator],
  );
  await app.query(
    `insert into rent_tax_alert (company_id, item_id, owner_id, property_id, alert_day, alert_date, recipients)
     values ($1, $2, $3, $4, 21, current_date, 1)`,
    [companyId, itemId, ids.ownerId, ids.propertyId],
  );
  await app.query(
    `insert into payment_advance (company_id, payment_id, property_id, tenant_id, lease_id, value_date, months_ahead, policy,
       over_limit, flagged) values ($1, $5, $2, $3, $4, current_date, 0, 'off', false, false)`,
    [...lease, ids.paymentId],
  );
  await app.query(
    `insert into paid_until_prompt (company_id, property_id, tenant_id, lease_id, paid_until, prompted_on, staff_messages)
     values ($1, $2, $3, $4, current_date + 90, current_date, 1)`,
    lease,
  );
  const { rows: terminations } = await app.query<{ id: string }>(
    `insert into early_termination (company_id, property_id, tenant_id, lease_id, unit_id, owner_id, book_id, last_day,
       charges, deductions, unused_days_credit_minor, applied_minor, refund_minor, approval_request_id, requested_by)
     values ($1, $2, $3, $4, $5, $6, $7, current_date, '[]', '[]', 0, 0, 1000, $8, $9) returning id`,
    [...lease, ids.unitId, ids.ownerId, ids.bookId, ids.requestId, ids.initiator],
  );
  await app.query(
    `insert into early_termination_refund_part (company_id, termination_id, property_id, tenant_id, lease_id, payment_id,
       amount_minor) values ($1, $5, $2, $3, $4, $6, 1000)`,
    [...lease, terminations[0]!.id, ids.paymentId],
  );
}

/**
 * Provider payments (M4b): one row in each of their company tables. The unmatched refund needs
 * money with no lease, so a direct transfer waiting for its lease is recorded too.
 */
async function seedPayments(
  companyId: string,
  ids: {
    initiator: string;
    initiatorMembership: string;
    approver: string;
    approverMembership: string;
    requestId: string;
    ownerId: string;
    propertyId: string;
    tenantId: string;
    leaseId: string;
    bookId: string;
    invoiceId: string;
    paymentId: string;
    receiptId: string;
    entryId: string;
  },
) {
  const accountId = randomUUID();
  await app.query(
    `insert into settlement_account (id, company_id, holder, owner_id, bank_code, bank_name, account_name, number_encrypted,
       number_index, number_masked, approval_request_id, created_by)
     values ($1, $2, 'owner', $3, 'GCB', 'GCB Bank', 'Owner', '\\x01', 'index', '•••• 6789', $4, $5)`,
    [accountId, companyId, ids.ownerId, ids.requestId, ids.initiator],
  );
  await app.query(
    "insert into provider_subaccount (company_id, settlement_account_id, provider, subaccount_code) values ($1, $2, 'paystack', $3)",
    [companyId, accountId, `ACCT_${randomBytes(6).toString('hex')}`],
  );
  // Where the owner's rent goes is set only through a request a second person approved (RA056).
  const { rows: agreementRequests } = await app.query<{ id: string }>(
    `insert into approval_request (company_id, action_type, subject_type, subject_id, payload, payload_hash, initiated_by,
       initiator_membership_id, mode, status, expires_at)
     values ($1, 'management_agreement.change', 'owner', $2, '{}', 'h', $3, $4, 'two_person', 'pending', now() + interval '1 day') returning id`,
    [companyId, ids.ownerId, ids.initiator, ids.initiatorMembership],
  );
  await app.query(
    "insert into approval_decision (company_id, request_id, decided_by, decided_by_membership_id, kind, payload_hash) values ($1, $2, $3, $4, 'approve', 'h')",
    [companyId, agreementRequests[0]!.id, ids.approver, ids.approverMembership],
  );
  await app.query(
    "insert into management_agreement (company_id, owner_id, destination, effective_from, approval_request_id) values ($1, $2, 'owner_account', current_date, $3)",
    [companyId, ids.ownerId, agreementRequests[0]!.id],
  );
  const { rows: links } = await app.query<{ id: string }>(
    `insert into secure_link (company_id, property_id, tenant_id, purpose, token_hash, invoice_id, expires_at)
     values ($1, $2, $3, 'pay', $4, $5, now() + interval '60 days') returning id`,
    [companyId, ids.propertyId, ids.tenantId, randomBytes(32).toString('hex'), ids.invoiceId],
  );
  await app.query(
    `insert into payment_intent (company_id, property_id, tenant_id, lease_id, invoice_id, secure_link_id, submission_id,
       amount_minor, method, reference, settlement_account_id)
     values ($1, $2, $3, $4, $5, $6, 'fixture-submission-0001', 150000, 'card', $7, $8)`,
    [
      companyId,
      ids.propertyId,
      ids.tenantId,
      ids.leaseId,
      ids.invoiceId,
      links[0]!.id,
      `pi_${randomBytes(12).toString('hex')}`,
      accountId,
    ],
  );
  await app.query(
    `insert into provider_settlement (company_id, provider, settlement_ref, settlement_account_id, subaccount_code, gross_minor,
       fees_minor, deductions_minor, net_minor, settled_at)
     values ($1, 'paystack', 'stl-1', $2, 'ACCT_x', 150000, 2925, 0, 147075, now())`,
    [companyId, accountId],
  );
  await app.query(
    `insert into reconciliation_exception (company_id, kind, provider, reference, detail, dedupe_key)
     values ($1, 'missing_here', 'paystack', 'ref-1', 'A fixture', 'fixture')`,
    [companyId],
  );
  await app.query(
    `insert into reminder_sent (company_id, property_id, tenant_id, lease_id, invoice_id, offset_days, status, step_date)
     values ($1, $2, $3, $4, $5, -7, 'skipped', current_date)`,
    [companyId, ids.propertyId, ids.tenantId, ids.leaseId, ids.invoiceId],
  );
  await app.query(
    `insert into receipt_delivery (company_id, property_id, tenant_id, lease_id, receipt_id, payment_id, message_id, confirmed_at)
     values ($1, $2, $3, $4, $5, $6, gen_random_uuid(), now())`,
    [companyId, ids.propertyId, ids.tenantId, ids.leaseId, ids.receiptId, ids.paymentId],
  );
  const unmatched = randomUUID();
  await app.query(
    `insert into payment (id, company_id, method, amount_minor, received_on, accounting_date, owner_id, book_id, cash_account,
       source_type, source_id, entry_id)
     values ($1, $2, 'bank_transfer', 1000, current_date, current_date, $3, $4, '1010', 'direct_receipt', gen_random_uuid(), $5)`,
    [unmatched, companyId, ids.ownerId, ids.bookId, ids.entryId],
  );
  await app.query(
    `insert into unmatched_refund (company_id, payment_id, owner_id, amount_minor, reason, approval_request_id, requested_by)
     values ($1, $2, $3, 1000, 'A fixture', $4, $5)`,
    [companyId, unmatched, ids.ownerId, ids.requestId, ids.initiator],
  );
}

/**
 * Messaging and the maintenance stub (M6): one row in each of their company tables, around one
 * conversation with an inbound SMS that carried a photo and became a repair ticket.
 */
async function seedMessaging(
  companyId: string,
  ids: {
    initiator: string;
    documentId: string;
    messageId: string;
    propertyId: string;
    unitId: string;
    tenantId: string;
    leaseId: string;
  },
) {
  const token = () => randomBytes(32).toString('hex');
  const { rows: conversations } = await app.query<{ id: string }>(
    "insert into conversation (company_id, tenant_id, state, last_message_at) values ($1, $2, 'open', now()) returning id",
    [companyId, ids.tenantId],
  );
  const conversationId = conversations[0]!.id;
  await app.query(
    "insert into conversation_channel (company_id, conversation_id, channel, address, last_inbound_at) values ($1, $2, 'sms', '+233200000099', now())",
    [companyId, conversationId],
  );
  const { rows: inbound } = await app.query<{ id: string }>(
    `insert into message (id, company_id, property_id, tenant_id, purpose, body, channels, direction, conversation_id,
       author_type, channel, provider, provider_message_id, attachment_count)
     values (gen_random_uuid(), $1, $2, $3, 'inbound', 'The tap leaks', '{sms}', 'inbound', $4, 'tenant', 'sms', 'memory', $5, 1)
     returning id`,
    [companyId, ids.propertyId, ids.tenantId, conversationId, randomUUID()],
  );
  await app.query(
    "insert into message_attachment (company_id, message_id, kind, content_type, size_bytes, document_id, status) values ($1, $2, 'image', 'image/jpeg', 1, $3, 'stored')",
    [companyId, inbound[0]!.id, ids.documentId],
  );
  await app.query(
    "insert into channel_identity (company_id, channel, address, tenant_id, linked_by) values ($1, 'whatsapp', '+233200000098', $2, $3)",
    [companyId, ids.tenantId, ids.initiator],
  );
  await app.query(
    "insert into bot_session (company_id, conversation_id, state, context, expires_at) values ($1, $2, 'menu', '{}', now() + interval '30 minutes')",
    [companyId, conversationId],
  );
  await app.query(
    'insert into reply_address (company_id, conversation_id, token_hash) values ($1, $2, $3)',
    [companyId, conversationId, token()],
  );
  await app.query(
    "insert into unsubscribe_token (company_id, tenant_id, token_hash, expires_at) values ($1, $2, $3, now() + interval '1 year')",
    [companyId, ids.tenantId, token()],
  );
  const { rows: groups } = await app.query<{ id: string }>(
    "insert into tenant_group (company_id, name, created_by) values ($1, 'Ground floor', $2) returning id",
    [companyId, ids.initiator],
  );
  await app.query(
    'insert into tenant_group_member (company_id, group_id, tenant_id, added_by) values ($1, $2, $3, $4)',
    [companyId, groups[0]!.id, ids.tenantId, ids.initiator],
  );
  const { rows: broadcasts } = await app.query<{ id: string }>(
    `insert into broadcast (company_id, audience_kind, property_id, topic, body, status, audience_count, queued_count,
       batches, created_by)
     values ($1, 'property', $2, 'water supply', 'No water on Saturday', 'sending', 1, 1, 1, $3) returning id`,
    [companyId, ids.propertyId, ids.initiator],
  );
  await app.query(
    `insert into broadcast_recipient (company_id, broadcast_id, property_id, tenant_id, message_id, planned_channel, outcome, batch)
     values ($1, $2, $3, $4, $5, 'sms', 'queued', 0)`,
    [companyId, broadcasts[0]!.id, ids.propertyId, ids.tenantId, ids.messageId],
  );
  const { rows: jobs } = await app.query<{ id: string }>(
    `insert into maintenance_job (company_id, property_id, unit_id, lease_id, tenant_id, source, description, conversation_id,
       source_message_id)
     values ($1, $2, $3, $4, $5, 'sms', 'The tap leaks', $6, $7) returning id`,
    [
      companyId,
      ids.propertyId,
      ids.unitId,
      ids.leaseId,
      ids.tenantId,
      conversationId,
      inbound[0]!.id,
    ],
  );
  await app.query(
    "insert into maintenance_job_attachment (company_id, property_id, job_id, document_id, kind) values ($1, $2, $3, $4, 'image')",
    [companyId, ids.propertyId, jobs[0]!.id, ids.documentId],
  );
}

async function companyScopedTables(): Promise<string[]> {
  const rows = await runSql<{ table_name: string }>(
    db.ownerUrl,
    `select table_name from information_schema.columns where table_schema = 'public' and column_name = 'company_id'
     union select 'company' order by 1`,
  );
  return rows.map((r) => r.table_name);
}

beforeAll(async () => {
  db = await cloneTemplateDatabase(inject('templateDatabase'));
  app = await connect(db.appUrl);
  companyA = await createCompany(app, 'Company A');
  companyB = await createCompany(app, 'Company B');
  await seedCompany(companyA);
  await seedCompany(companyB);
});

afterAll(async () => {
  await app?.end();
  await db?.drop();
});

describe('NFR-SEC RLS coverage', () => {
  it('forces RLS with a policy on every company-scoped table, and classifies every table', async () => {
    const tables = await runSql<{
      relname: string;
      rls: boolean;
      forced: boolean;
      policies: number;
      has_company_id: boolean;
    }>(
      db.ownerUrl,
      `select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
              (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies,
              exists (select 1 from information_schema.columns k where k.table_schema = 'public' and k.table_name = c.relname and k.column_name = 'company_id') as has_company_id
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1`,
    );
    expect(tables.length).toBeGreaterThan(10);
    for (const t of tables) {
      if ((GLOBAL_TABLES as readonly string[]).includes(t.relname)) {
        expect(t.has_company_id, `${t.relname} is global but has company_id`).toBe(false);
        continue;
      }
      expect(
        t.has_company_id || t.relname === 'company',
        `${t.relname} has no company_id and is not listed as global`,
      ).toBe(true);
      expect(t.rls, `${t.relname}: RLS enabled`).toBe(true);
      expect(t.forced, `${t.relname}: RLS forced`).toBe(true);
      expect(t.policies, `${t.relname}: has a policy`).toBeGreaterThan(0);
    }
  });

  it('runs the application as a role that owns nothing and cannot bypass RLS', async () => {
    const [role] = await runSql<{ rolbypassrls: boolean; rolsuper: boolean }>(
      db.ownerUrl,
      "select rolbypassrls, rolsuper from pg_roles where rolname = 'rent_app'",
    );
    expect(role).toEqual({ rolbypassrls: false, rolsuper: false });
    const owned = await runSql(
      db.ownerUrl,
      "select tablename from pg_tables where tableowner = 'rent_app'",
    );
    expect(owned).toEqual([]);
    const [system] = await runSql<{ rolcanlogin: boolean }>(
      db.ownerUrl,
      "select rolcanlogin from pg_roles where rolname = 'rent_system'",
    );
    expect(system!.rolcanlogin).toBe(false);
  });
});

describe('NFR-SEC RLS isolation', () => {
  it("reads zero rows of company B from every table with company A's context, using raw SQL", async () => {
    for (const table of await companyScopedTables()) {
      const column = table === 'company' ? 'id' : 'company_id';
      await inContext(app, { companyId: companyA }, async () => {
        const other = await app.query<{ n: number }>(
          `select count(*)::int as n from ${table} where ${column} = $1`,
          [companyB],
        );
        expect(other.rows[0]!.n, `${table} leaks company B`).toBe(0);
        const all = await app.query<{ n: number; foreign: number }>(
          `select count(*)::int as n, count(*) filter (where ${column} <> $1)::int as foreign from ${table}`,
          [companyA],
        );
        expect(
          all.rows[0]!.n,
          `${table} has no fixture row for company A; add one to seedCompany`,
        ).toBeGreaterThan(0);
        expect(all.rows[0]!.foreign, table).toBe(0);
      });
    }
  });

  it('returns nothing at all without a company context (RLS fails closed)', async () => {
    for (const table of await companyScopedTables()) {
      await inContext(app, {}, async () => {
        const { rows } = await app.query<{ n: number }>(`select count(*)::int as n from ${table}`);
        expect(rows[0]!.n, table).toBe(0);
      });
    }
  });

  it("refuses to write another company's id", async () => {
    const attempts = [
      [
        'membership',
        `insert into membership (company_id, person_id, role) values ($1, '${personOf[companyA]}', 'caretaker')`,
      ],
      [
        'outbox_event',
        "insert into outbox_event (company_id, type, payload, idempotency_key) values ($1, 'x', '{}', 'k-cross')",
      ],
      [
        'processed_job',
        "insert into processed_job (company_id, key, job_name) values ($1, 'cross', 'x')",
      ],
    ] as const;
    for (const [table, statement] of attempts) {
      const state = await sqlState(
        inContext(app, { companyId: companyA }, () => app.query(statement, [companyB])),
      );
      expect(state, table).toBe('42501');
    }
  });

  it("cannot point a foreign key at another company's row", async () => {
    const state = await sqlState(
      inContext(app, { companyId: companyA, personId: personOf[companyA] }, () =>
        app.query(
          `insert into approval_request (company_id, action_type, subject_type, subject_id, payload, payload_hash, initiated_by,
             initiator_membership_id, mode, status, expires_at)
           values ($1, 'test.action', 'test', 's2', '{}', 'h', $2, $3, 'two_person', 'pending', now() + interval '1 day')`,
          [companyA, personOf[companyA], membershipOf[companyB]],
        ),
      ),
    );
    expect(state).toBe('23503');
  });
});

describe('NFR-SEC company context', () => {
  it('does not survive the transaction on a pooled connection', async () => {
    const database = createDatabase(db.appUrl, { max: 1 });
    try {
      const inside = await withCompany(
        database,
        { companyId: companyA, actorKind: 'system' },
        async (tx) => {
          const result = await tx.execute<{ company: string }>(
            sql`select current_setting('app.company_id', true) as company`,
          );
          return result.rows[0]!.company;
        },
      );
      expect(inside).toBe(companyA);
      const after = await database.pool.query<{ company: string | null; n: number }>(
        "select current_setting('app.company_id', true) as company, (select count(*)::int from membership) as n",
      );
      expect(after.rows[0]!.company ?? '').toBe('');
      expect(after.rows[0]!.n).toBe(0);
    } finally {
      await database.close();
    }
  });

  it('refuses a context that is not a UUID', async () => {
    const database = createDatabase(db.appUrl, { max: 1 });
    try {
      await expect(
        withCompany(database, { companyId: "x' or '1'='1", actorKind: 'system' }, async () => 1),
      ).rejects.toThrow('UUID');
    } finally {
      await database.close();
    }
  });
});

describe('NFR-SEC tenant sessions', () => {
  it('limits every company-scoped table to the tenant’s own rows, or keeps it from tenant sessions', async () => {
    const policies = await runSql<{
      tablename: string;
      policyname: string;
      permissive: string;
      qual: string | null;
    }>(
      db.ownerUrl,
      "select tablename, policyname, permissive, qual from pg_policies where schemaname = 'public'",
    );
    // Tables only: the views are security invoker, so their tables' policies apply to them.
    const tables = (
      await runSql<{ relname: string }>(
        db.ownerUrl,
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind in ('r', 'p') and exists (
           select 1 from information_schema.columns k where k.table_schema = 'public'
             and k.table_name = c.relname and k.column_name = 'company_id')
         union select 'company' order by 1`,
      )
    ).map((r) => r.relname);
    expect(tables.length).toBeGreaterThan(40);
    for (const table of tables) {
      const restrictive = policies.filter(
        (p) => p.tablename === table && p.permissive === 'RESTRICTIVE',
      );
      const staffOnly = restrictive.some(
        (p) => p.policyname === 'no_tenant_session' && p.qual === '(app.tenant_scope() IS NULL)',
      );
      const tenantScoped = restrictive.some(
        (p) => p.policyname !== 'no_tenant_session' && /tenant_scope\(/.test(p.qual ?? ''),
      );
      // A tenant session is in its landlord's company: it reads that one company row.
      expect(
        staffOnly || tenantScoped || table === 'company',
        `${table} must be staff-only (no_tenant_session) or limited to the tenant's rows`,
      ).toBe(true);
    }
  });

  it('shows a tenant nothing of the staff-only tables, and the register only through its lease', async () => {
    const tenantId = (
      await runSql<{ id: string }>(db.superuserUrl, 'select id from tenant where company_id = $1', [
        companyA,
      ])
    )[0]!.id;
    // Another unit on the tenant's property, with no lease.
    await inContext(app, { companyId: companyA }, () =>
      app.query(
        `insert into unit (company_id, property_id, block_id, code, label, unit_type, billing_band)
         select company_id, property_id, id, 'ACC-LEG-B1-02', '02', 'single_room', 'single_room' from block where company_id = $1`,
        [companyA],
      ),
    );
    const staffOnly = (
      await runSql<{ tablename: string }>(
        db.ownerUrl,
        "select tablename from pg_policies where schemaname = 'public' and policyname = 'no_tenant_session' order by 1",
      )
    ).map((r) => r.tablename);
    expect(staffOnly).toEqual(
      expect.arrayContaining([
        'audit_event',
        'outbox_event',
        'membership',
        'approval_request',
        'approval_decision',
        'processed_job',
        'upload_intent',
        'company_key',
        'unit_status_event',
        'property_ownership',
        'meter',
        'property_file',
        'owner',
      ]),
    );
    const database = createDatabase(db.appUrl, { max: 1 });
    try {
      const seen = await withCompany(
        database,
        { companyId: companyA, actorKind: 'tenant', tenantScope: { tenantIds: [tenantId] } },
        async (tx) => {
          const count = async (table: string) =>
            (await tx.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table}`)))
              .rows[0]!.n;
          const counts: Record<string, number> = {};
          for (const table of staffOnly) counts[table] = await count(table);
          const codes = async (table: string) =>
            (
              await tx.execute<{ code: string }>(sql.raw(`select code from ${table} order by code`))
            ).rows.map((r) => r.code);
          const documents = await tx.execute<{ id: string }>(sql`select id from document`);
          const leases = await tx.execute<{ signed_document_id: string }>(
            sql`select signed_document_id from lease`,
          );
          return {
            counts,
            units: await codes('unit'),
            properties: await codes('property'),
            companies: (await tx.execute(sql`select id from company`)).rows.length,
            documents: documents.rows.map((r) => r.id),
            signedCopies: leases.rows.map((r) => r.signed_document_id),
            renders: await count('document_render_request'),
          };
        },
      );
      expect(staffOnly.length).toBeGreaterThan(10);
      expect(Object.entries(seen.counts).filter(([, n]) => n > 0)).toEqual([]);
      expect(seen.units).toEqual(['ACC-LEG-B1-01']);
      expect(seen.properties).toEqual(['ACC-LEG']);
      expect(seen.companies).toBe(1);
      // Only the documents of its own lease: here, the signed copy.
      expect(seen.documents).toEqual(seen.signedCopies);
      expect(seen.renders).toBe(0);
    } finally {
      await database.close();
    }
  });
});
