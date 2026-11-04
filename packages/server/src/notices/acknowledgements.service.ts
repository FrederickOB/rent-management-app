import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { asc, desc, eq, inArray, schema, withCompany, type Database } from '@rent/db';
import { parseBusinessDate } from '@rent/domain/dates';
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
import { conflict, invalid, notFound } from '../core/errors';
import type { IdempotencyClaim } from '../core/idempotency';
import { CLOCK, DATABASE } from '../core/tokens';
import { DocumentsService, RENT_ASSESSMENT_UPLOAD } from '../documents/documents.service';
import { PolicyService, staffContext } from '../policy/policy.service';
import { RulesService } from '../rules/rules.service';
import { companyFacts } from './records';

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
      const rows = await tx
        .select()
        .from(schema.rentAssessment)
        .where(eq(schema.rentAssessment.unitId, unitId))
        .orderBy(desc(schema.rentAssessment.assessedOn), desc(schema.rentAssessment.recordedAt));
      const people = [...new Set(rows.map((r) => r.recordedBy))];
      const names = people.length
        ? await tx
            .select({ id: schema.person.id, name: schema.person.name })
            .from(schema.person)
            .where(inArray(schema.person.id, people))
        : [];
      let bar: {
        barredUntil: string;
        months: number;
        ruleStatus: 'verified' | 'from_prd' | 'unverified';
      } | null = null;
      if (rows.length) {
        const company = await companyFacts(tx, staff.companyId);
        try {
          const rule = await this.rules.resolveIn(
            tx,
            company.countryCode,
            ASSESSMENT_BAR_KEY,
            parseBusinessDate(rows[0]!.assessedOn),
          );
          const months = (rule.value as { months: number }).months;
          bar = {
            barredUntil: quitBarredUntil(
              rows.map((r) => ({ date: r.assessedOn })),
              months,
            )!,
            months,
            ruleStatus: rule.verificationStatus,
          };
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
        }
      }
      return {
        assessments: rows.map((r) => this.assessmentView(r, names)),
        bar,
      };
    });
  }

  async recordAssessment(
    actor: Actor | null,
    unitId: string,
    input: { assessedOn: string; reference: string; uploadId?: string | null },
    claim: IdempotencyClaim | null = null,
  ) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'rent_assessment.record');
    await this.entitlements.assert(staff.companyId, 'notices');
    try {
      parseBusinessDate(input.assessedOn);
    } catch {
      throw invalid('assessed_on_invalid', 'Give the date of the assessment');
    }
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
          recordedBy: staff.personId,
          recordedAt: this.clock.now(),
        })
        .returning();
      const [person] = await tx
        .select({ id: schema.person.id, name: schema.person.name })
        .from(schema.person)
        .where(eq(schema.person.id, staff.personId));
      const out = this.assessmentView(row!, person ? [person] : []);
      await claim?.done(tx, { ...out, recordedAt: out.recordedAt.toISOString() });
      return out;
    });
    if (staged) await this.documents.discardStagedUpload(staged);
    return view;
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
    const url = await this.documents.downloadUrl(staff.companyId, documentId, 'rent-assessment');
    if (!url) throw notFound('Document');
    return url;
  }

  private assessmentView(
    r: typeof schema.rentAssessment.$inferSelect,
    names: readonly { id: string; name: string }[],
  ) {
    return {
      id: r.id,
      unitId: r.unitId,
      assessedOn: r.assessedOn,
      reference: r.reference,
      hasDocument: r.documentId !== null,
      recordedByName: names.find((n) => n.id === r.recordedBy)?.name ?? null,
      recordedAt: r.recordedAt,
    };
  }
}
