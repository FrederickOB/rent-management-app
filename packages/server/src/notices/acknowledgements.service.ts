import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, inArray, schema, withCompany, type Database, type Tx } from '@rent/db';
import { businessDateOf, instantFrom, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { DomainError } from '@rent/domain/errors';
import {
  ASSESSMENT_BAR_KEY,
  CURRENT_QUIT_ACK,
  QUIT_ACK_STATEMENTS,
  quitBarredUntil,
  quitNoticesEnabled,
} from '@rent/domain/notices';
import type { Actor } from '@rent/domain/policy';
import { AuditService } from '../audit/audit.service';
import { staffActor } from '../companies/companies.service';
import { EntitlementsService } from '../companies/entitlements.service';
import type { Clock } from '../core/clock';
import { isUniqueViolation, sqlStateOf } from '../core/db-errors';
import { conflict, invalid, notFound } from '../core/errors';
import type { IdempotencyClaim } from '../core/idempotency';
import { CLOCK, DATABASE } from '../core/tokens';
import { DocumentsService, RENT_ASSESSMENT_UPLOAD } from '../documents/documents.service';
import { PolicyService, staffContext } from '../policy/policy.service';
import { RulesService } from '../rules/rules.service';
import { assessmentRecordsOf, companyFacts, type AssessmentRecord } from './records';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * The OQ-16 acknowledgement (decision 9) and Rent Officer assessments (decision 3). Notices to quit
 * stay off until a company admin or landlord types their name to accept the versioned statement;
 * withdrawing turns them off again, and notices already issued carry on. Assessments are recorded
 * on the unit and drive the s.23 bar, from the rules table with its status shown.
 */
@Injectable()
export class NoticeAcknowledgementsService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(RulesService) private readonly rules: RulesService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async quitAcknowledgement(actor: Actor | null) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'notices.read');
    await this.entitlements.assert(staff.companyId, 'notices');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const rows = await tx
        .select({
          action: schema.noticeQuitAcknowledgement.action,
          personId: schema.noticeQuitAcknowledgement.personId,
          typedName: schema.noticeQuitAcknowledgement.typedName,
          statementVersion: schema.noticeQuitAcknowledgement.statementVersion,
          reason: schema.noticeQuitAcknowledgement.reason,
          at: schema.noticeQuitAcknowledgement.at,
          name: schema.person.name,
        })
        .from(schema.noticeQuitAcknowledgement)
        .innerJoin(schema.person, eq(schema.person.id, schema.noticeQuitAcknowledgement.personId))
        .orderBy(
          asc(schema.noticeQuitAcknowledgement.at),
          asc(schema.noticeQuitAcknowledgement.id),
        );
      const enabled = quitNoticesEnabled(
        rows.map((r) => ({ action: r.action as 'grant' | 'withdraw' })),
      );
      const last = rows.at(-1);
      const text = QUIT_ACK_STATEMENTS[CURRENT_QUIT_ACK]!;
      return {
        enabled,
        statement: { version: CURRENT_QUIT_ACK, text, sha256: sha256(text) },
        current:
          enabled && last
            ? {
                byName: last.name,
                typedName: last.typedName ?? '',
                at: last.at,
                statementVersion: last.statementVersion,
              }
            : null,
        history: [...rows].reverse().map((r) => ({
          action: r.action as 'grant' | 'withdraw',
          byName: r.name,
          at: r.at,
          statementVersion: r.statementVersion,
          reason: r.reason,
        })),
        mayChange: this.policy.can(staff, 'notices.quit.acknowledge').allowed,
      };
    });
  }

  async grantQuit(actor: Actor | null, input: { statementVersion: string; typedName: string }) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'notices.quit.acknowledge');
    await this.entitlements.assert(staff.companyId, 'notices');
    if (input.statementVersion !== CURRENT_QUIT_ACK)
      throw conflict(
        'quit_statement_outdated',
        'The statement has changed since you read it. Read the current one and accept it again',
      );
    const typedName = input.typedName.trim();
    if (typedName.length < 2) throw invalid('typed_name_required', 'Type your full name to accept');
    await withCompany(this.database, staffContext(staff), async (tx) => {
      const rows = await tx
        .select({ action: schema.noticeQuitAcknowledgement.action })
        .from(schema.noticeQuitAcknowledgement)
        .orderBy(
          asc(schema.noticeQuitAcknowledgement.at),
          asc(schema.noticeQuitAcknowledgement.id),
        );
      if (quitNoticesEnabled(rows.map((r) => ({ action: r.action as 'grant' | 'withdraw' }))))
        throw conflict('quit_already_enabled', 'Notices to quit are already enabled');
      const text = QUIT_ACK_STATEMENTS[CURRENT_QUIT_ACK]!;
      await tx.insert(schema.noticeQuitAcknowledgement).values({
        companyId: staff.companyId,
        action: 'grant',
        personId: staff.personId,
        membershipId: staff.membershipId,
        typedName,
        statementVersion: CURRENT_QUIT_ACK,
        statementSha256: sha256(text),
        at: this.clock.now(),
      });
      await this.audit.append(tx, {
        companyId: staff.companyId,
        action: 'notices.quit_enabled',
        recordType: 'company',
        recordId: staff.companyId,
        data: { statementVersion: CURRENT_QUIT_ACK, statementSha256: sha256(text) },
      });
    });
    return this.quitAcknowledgement(staff);
  }

  async withdrawQuit(actor: Actor | null, reason: string) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'notices.quit.acknowledge');
    await this.entitlements.assert(staff.companyId, 'notices');
    const why = reason.trim();
    if (why.length < 3)
      throw invalid('reason_required', 'Say why notices to quit are switched off');
    await withCompany(this.database, staffContext(staff), async (tx) => {
      const rows = await tx
        .select({ action: schema.noticeQuitAcknowledgement.action })
        .from(schema.noticeQuitAcknowledgement)
        .orderBy(
          asc(schema.noticeQuitAcknowledgement.at),
          asc(schema.noticeQuitAcknowledgement.id),
        );
      if (!quitNoticesEnabled(rows.map((r) => ({ action: r.action as 'grant' | 'withdraw' }))))
        throw conflict('quit_not_enabled', 'Notices to quit are already switched off');
      const text = QUIT_ACK_STATEMENTS[CURRENT_QUIT_ACK]!;
      await tx.insert(schema.noticeQuitAcknowledgement).values({
        companyId: staff.companyId,
        action: 'withdraw',
        personId: staff.personId,
        membershipId: staff.membershipId,
        statementVersion: CURRENT_QUIT_ACK,
        statementSha256: sha256(text),
        reason: why,
        at: this.clock.now(),
      });
      await this.audit.append(tx, {
        companyId: staff.companyId,
        action: 'notices.quit_disabled',
        recordType: 'company',
        recordId: staff.companyId,
        data: { reason: why },
      });
    });
    return this.quitAcknowledgement(staff);
  }

  // Rent Officer assessments (decision 3) ----------------------------------------------------------

  async assessments(actor: Actor | null, unitId: string) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'notices.read');
    await this.entitlements.assert(staff.companyId, 'notices');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const [unit] = await tx
        .select({ id: schema.unit.id })
        .from(schema.unit)
        .where(eq(schema.unit.id, unitId));
      if (!unit) throw notFound('Unit');
      const records = await assessmentRecordsOf(tx, unitId);
      const people = [
        ...new Set(
          records.flatMap((r) => [r.row.recordedBy, ...(r.void ? [r.void.voidedBy] : [])]),
        ),
      ];
      const names = people.length
        ? await tx
            .select({ id: schema.person.id, name: schema.person.name })
            .from(schema.person)
            .where(inArray(schema.person.id, people))
        : [];
      const active = records.filter((r) => r.status === 'active');
      const company = await companyFacts(tx, staff.companyId);
      let bar: {
        barredUntil: string;
        months: number;
        ruleStatus: 'verified' | 'from_prd' | 'unverified';
        active: boolean;
      } | null = null;
      let ruleMissing = false;
      if (active.length) {
        const latest = active.reduce((a, b) => (a.row.assessedOn >= b.row.assessedOn ? a : b));
        try {
          const rule = await this.rules.resolveIn(
            tx,
            company.countryCode,
            ASSESSMENT_BAR_KEY,
            parseBusinessDate(latest.row.assessedOn),
          );
          const months = (rule.value as { months: number }).months;
          const barredUntil = quitBarredUntil(
            active.map((r) => ({ date: r.row.assessedOn })),
            months,
          )!;
          bar = {
            barredUntil,
            months,
            ruleStatus: rule.verificationStatus,
            // The last barred day is inclusive (decision 3).
            active: this.today(company.timeZone) <= barredUntil,
          };
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
          ruleMissing = true;
        }
      }
      return {
        assessments: records.map((r) => this.assessmentView(r, names)),
        bar,
        ruleMissing,
      };
    });
  }

  async recordAssessment(
    actor: Actor | null,
    unitId: string,
    input: { assessedOn: string; reference: string; uploadId?: string | null },
    claim: IdempotencyClaim | null = null,
  ) {
    return this.writeAssessment(actor, unitId, input, null, claim);
  }

  /** Review C4: a new record that replaces an active one, with why; records are never edited. */
  async correctAssessment(
    actor: Actor | null,
    unitId: string,
    assessmentId: string,
    input: { assessedOn: string; reference: string; uploadId?: string | null; reason: string },
    claim: IdempotencyClaim | null = null,
  ) {
    return this.writeAssessment(
      actor,
      unitId,
      input,
      { id: assessmentId, reason: input.reason },
      claim,
    );
  }

  /** Review C4: voids an active assessment recorded in error, with why; it stays listed. */
  async voidAssessment(
    actor: Actor | null,
    unitId: string,
    assessmentId: string,
    reason: string,
    claim: IdempotencyClaim | null = null,
  ) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'rent_assessment.record');
    await this.entitlements.assert(staff.companyId, 'notices');
    const why = checkReason(reason);
    return withCompany(this.database, staffContext(staff), async (tx) => {
      await claim?.claim(tx);
      const target = await this.activeAssessment(tx, unitId, assessmentId);
      await tx
        .insert(schema.rentAssessmentVoid)
        .values({
          companyId: staff.companyId,
          propertyId: target.propertyId,
          unitId,
          assessmentId,
          reason: why,
          voidedBy: staff.personId,
          voidedAt: this.clock.now(),
        })
        .catch(changedMeanwhile);
      const record = (await assessmentRecordsOf(tx, unitId)).find(
        (r) => r.row.id === assessmentId,
      )!;
      const names = await tx
        .select({ id: schema.person.id, name: schema.person.name })
        .from(schema.person)
        .where(inArray(schema.person.id, [record.row.recordedBy, staff.personId]));
      const out = this.assessmentView(record, names);
      await claim?.done(tx, jsonView(out));
      return out;
    });
  }

  private async writeAssessment(
    actor: Actor | null,
    unitId: string,
    input: { assessedOn: string; reference: string; uploadId?: string | null },
    replaces: { readonly id: string; readonly reason: string } | null,
    claim: IdempotencyClaim | null,
  ) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'rent_assessment.record');
    await this.entitlements.assert(staff.companyId, 'notices');
    try {
      parseBusinessDate(input.assessedOn);
    } catch {
      throw invalid('assessed_on_invalid', 'Give the date of the assessment');
    }
    const why = replaces ? checkReason(replaces.reason) : null;
    const staged = input.uploadId
      ? await this.documents.stageEvidenceUpload(
          { companyId: staff.companyId, personId: staff.personId },
          input.uploadId,
          RENT_ASSESSMENT_UPLOAD,
        )
      : null;
    const view = await withCompany(this.database, staffContext(staff), async (tx) => {
      await claim?.claim(tx);
      const [unit] = await tx
        .select({ id: schema.unit.id, propertyId: schema.unit.propertyId })
        .from(schema.unit)
        .where(eq(schema.unit.id, unitId));
      if (!unit) throw notFound('Unit');
      // Review S10: an assessment has happened; a date in the future is a mistake.
      const company = await companyFacts(tx, staff.companyId);
      if (input.assessedOn > this.today(company.timeZone))
        throw invalid('assessed_on_future', 'An assessment cannot be dated in the future');
      if (replaces) await this.activeAssessment(tx, unitId, replaces.id);
      const documentId = staged
        ? await this.documents.recordStagedEvidence(tx, staged, 'rent_assessment')
        : null;
      const [row] = await tx
        .insert(schema.rentAssessment)
        .values({
          companyId: staff.companyId,
          propertyId: unit.propertyId,
          unitId,
          assessedOn: input.assessedOn,
          reference: input.reference.trim(),
          documentId,
          replacesId: replaces?.id ?? null,
          reason: why,
          recordedBy: staff.personId,
          recordedAt: this.clock.now(),
        })
        .returning()
        .catch(changedMeanwhile);
      const [person] = await tx
        .select({ id: schema.person.id, name: schema.person.name })
        .from(schema.person)
        .where(eq(schema.person.id, staff.personId));
      const out = this.assessmentView(
        { row: row!, status: 'active', replacedById: null, void: null },
        person ? [person] : [],
      );
      await claim?.done(tx, jsonView(out));
      return out;
    });
    if (staged) await this.documents.discardStagedUpload(staged);
    return view;
  }

  /**
   * An assessment of this unit that is neither corrected nor voided. Records are append-only, so
   * nothing locks them: the unique keys and RA075 refuse a second change made at the same moment.
   */
  private async activeAssessment(tx: Tx, unitId: string, assessmentId: string) {
    const [row] = await tx
      .select()
      .from(schema.rentAssessment)
      .where(eq(schema.rentAssessment.id, assessmentId));
    if (!row || row.unitId !== unitId) throw notFound('Assessment');
    const record = (await assessmentRecordsOf(tx, unitId)).find((r) => r.row.id === assessmentId);
    if (record?.status !== 'active')
      throw conflict(
        'assessment_changed',
        `This assessment has already been ${record?.status ?? 'changed'}. Reload the unit.`,
      );
    return row;
  }

  private today(timeZone: string): string {
    return toIsoDate(businessDateOf(instantFrom(this.clock.now()), timeZone));
  }

  async assessmentDocument(
    actor: Actor | null,
    unitId: string,
    assessmentId: string,
  ): Promise<string> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'notices.read');
    const documentId = await withCompany(this.database, staffContext(staff), async (tx) => {
      const [row] = await tx
        .select({
          documentId: schema.rentAssessment.documentId,
          unitId: schema.rentAssessment.unitId,
        })
        .from(schema.rentAssessment)
        .where(eq(schema.rentAssessment.id, assessmentId));
      return row && row.unitId === unitId ? row.documentId : null;
    });
    if (!documentId) throw notFound('Document');
    const url = await this.documents.downloadUrl(staff.companyId, documentId, 'rent-assessment', {
      viewer: staff.personId,
    });
    if (!url) throw notFound('Document');
    return url;
  }

  private assessmentView(r: AssessmentRecord, names: readonly { id: string; name: string }[]) {
    const name = (id: string) => names.find((n) => n.id === id)?.name ?? null;
    return {
      id: r.row.id,
      unitId: r.row.unitId,
      assessedOn: r.row.assessedOn,
      reference: r.row.reference,
      hasDocument: r.row.documentId !== null,
      recordedByName: name(r.row.recordedBy),
      recordedAt: r.row.recordedAt,
      status: r.status,
      replacesId: r.row.replacesId,
      reason: r.row.reason,
      replacedById: r.replacedById,
      voided: r.void
        ? { at: r.void.voidedAt, byName: name(r.void.voidedBy), reason: r.void.reason }
        : null,
    };
  }
}

function checkReason(reason: string): string {
  const why = reason.trim();
  if (why.length < 3 || why.length > 500)
    throw invalid('reason_required', 'Say why, in 3 to 500 characters');
  return why;
}

/** The unique keys and RA075 refuse a second correction or void made at the same moment. */
function changedMeanwhile(error: unknown): never {
  if (isUniqueViolation(error) || sqlStateOf(error) === 'RA075')
    throw conflict(
      'assessment_changed',
      'This assessment has already been corrected or voided. Reload the unit.',
    );
  throw error;
}

/** The view with its instants as strings, as an idempotent replay stores it. */
function jsonView(view: { recordedAt: Date; voided: { at: Date } | null }) {
  return JSON.parse(JSON.stringify(view)) as Record<string, unknown>;
}
