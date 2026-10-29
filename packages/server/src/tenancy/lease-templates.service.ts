import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, isNull, schema, withCompany, type Database, type Tx } from '@rent/db';
import type { Actor } from '@rent/domain/policy';
import {
  checkTemplateContent,
  checkTemplateVersion,
  STARTER_TEMPLATE_KINDS,
  STARTER_TEMPLATE_NAMES,
  STARTER_TEMPLATES,
  type StarterTemplateKind,
  type TemplateContent,
} from '@rent/domain/tenancy';
import { payloadHash } from '../approvals/approvals.service';
import { staffActor, type StaffActor } from '../companies/companies.service';
import { isUniqueViolation } from '../core/db-errors';
import { conflict, invalid, notFound } from '../core/errors';
import { DATABASE } from '../core/tokens';
import { PolicyService, staffContext } from '../policy/policy.service';
import type { TemplateVersionView, TemplateView } from './tenancy.types';

type TemplateRow = typeof schema.leaseTemplate.$inferSelect;
type VersionRow = typeof schema.leaseTemplateVersion.$inferSelect;
export type TemplateKind = 'residential' | 'commercial' | 'short_fixed_term' | 'custom';

export const REVIEW_NOTE_MIN_LENGTH = 10;

const versionView = (v: VersionRow): TemplateVersionView => ({
  id: v.id,
  version: v.version,
  content: v.content as TemplateContent,
  changeNote: v.changeNote,
  createdAt: v.createdAt,
  counselReview: v.counselReviewedAt
    ? {
        reviewedAt: v.counselReviewedAt,
        reviewedBy: v.counselReviewedBy,
        note: v.counselReviewNote!,
      }
    : null,
});

/**
 * Lease templates (TL-05; M3 plan 4.5, decision 3): structured clauses with placeholders from a
 * fixed list, never free HTML. Versions are immutable; publishing adds one, and a lease keeps the
 * version it was built from. Every version starts unreviewed, and the builder warns until a
 * company admin records that counsel has reviewed it.
 */
@Injectable()
export class LeaseTemplatesService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
  ) {}

  async list(
    actor: Actor | null,
    options: { includeArchived?: boolean } = {},
  ): Promise<TemplateView[]> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'lease.view');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      await this.ensureStarters(tx, staff.companyId, staff.personId);
      const templates = await tx
        .select()
        .from(schema.leaseTemplate)
        .where(options.includeArchived ? undefined : isNull(schema.leaseTemplate.archivedAt))
        .orderBy(asc(schema.leaseTemplate.name));
      // One query at a time: a transaction's client runs queries in turn.
      const views: TemplateView[] = [];
      for (const t of templates) views.push(await this.view(tx, t));
      return views;
    });
  }

  async get(actor: Actor | null, templateId: string): Promise<TemplateView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'lease.view');
    return withCompany(this.database, staffContext(staff), async (tx) =>
      this.view(tx, await this.template(tx, templateId)),
    );
  }

  /** A company's own template, from content it supplies (often a copy of a starter). */
  async create(
    actor: Actor | null,
    input: {
      name: string;
      kind: TemplateKind;
      content: TemplateContent;
      changeNote?: string | null;
    },
  ): Promise<TemplateView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'lease_template.manage');
    const content = checkTemplateContent(input.content);
    const name = checkName(input.name);
    try {
      return await withCompany(this.database, staffContext(staff), async (tx) => {
        const [template] = await tx
          .insert(schema.leaseTemplate)
          .values({ companyId: staff.companyId, name, kind: input.kind, createdBy: staff.personId })
          .returning();
        await this.insertVersion(tx, staff, template!.id, 1, content, input.changeNote ?? null);
        return this.view(tx, template!);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'lease_template_name_key'))
        throw conflict('template_name_taken', 'There is already a template with that name');
      throw error;
    }
  }

  /** Publishes a new version; earlier versions and the leases built from them do not change. */
  async publish(
    actor: Actor | null,
    templateId: string,
    input: { content: TemplateContent; changeNote?: string | null; baseVersion?: number },
  ): Promise<TemplateView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'lease_template.manage');
    const content = checkTemplateContent(input.content);
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const template = await this.template(tx, templateId, { lock: true });
      if (template.archivedAt) throw notFound('Template');
      const latest = await this.latestVersion(tx, templateId);
      // Edited from an older version: someone published in between (the template row is locked).
      if (input.baseVersion !== undefined && input.baseVersion !== (latest?.version ?? 0))
        throw conflict(
          'template_changed',
          `Version ${latest?.version ?? 0} of this template was published while you were editing version ${input.baseVersion}. Copy your changes, reload the template, then make them again.`,
          { latestVersion: String(latest?.version ?? 0) },
        );
      if (latest) checkTemplateVersion(latest.content as TemplateContent, content);
      await this.insertVersion(
        tx,
        staff,
        templateId,
        (latest?.version ?? 0) + 1,
        content,
        input.changeNote ?? null,
      );
      await tx
        .update(schema.leaseTemplate)
        .set({ updatedAt: new Date() })
        .where(eq(schema.leaseTemplate.id, templateId));
      return this.view(tx, template);
    });
  }

  /** Records, once, that the company's lawyer reviewed a version (decision 3). */
  async review(
    actor: Actor | null,
    versionId: string,
    input: { note: string },
  ): Promise<TemplateView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'lease_template.manage');
    const note = input.note.trim();
    if (note.length < REVIEW_NOTE_MIN_LENGTH)
      throw invalid(
        'review_note_required',
        `Say who reviewed it and when, in at least ${REVIEW_NOTE_MIN_LENGTH} characters`,
      );
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const [version] = await tx
        .select()
        .from(schema.leaseTemplateVersion)
        .where(eq(schema.leaseTemplateVersion.id, versionId))
        .for('update');
      if (!version) throw notFound('Template version');
      if (version.counselReviewedAt)
        throw conflict(
          'already_reviewed',
          'The counsel review of this version is already recorded',
        );
      await tx
        .update(schema.leaseTemplateVersion)
        .set({
          counselReviewedAt: new Date(),
          counselReviewedBy: staff.personId,
          counselReviewNote: note.slice(0, 1000),
        })
        .where(eq(schema.leaseTemplateVersion.id, versionId));
      return this.view(tx, await this.template(tx, version.templateId));
    });
  }

  /** The three starters, seeded into a company the first time templates are used (plan 4.5). */
  async ensureStarters(tx: Tx, companyId: string, personId: string | null): Promise<void> {
    for (const kind of STARTER_TEMPLATE_KINDS) {
      const [inserted] = await tx
        .insert(schema.leaseTemplate)
        .values({
          companyId,
          name: STARTER_TEMPLATE_NAMES[kind],
          kind,
          starterKind: kind,
          createdBy: personId,
        })
        .onConflictDoNothing()
        .returning({ id: schema.leaseTemplate.id });
      if (!inserted) continue;
      const content = STARTER_TEMPLATES[kind];
      await tx.insert(schema.leaseTemplateVersion).values({
        companyId,
        templateId: inserted.id,
        version: 1,
        content,
        contentSha256: payloadHash(content),
        changeNote: 'Starter template: legal clauses await your lawyer’s wording (OQ-53).',
        createdBy: personId,
      });
    }
  }

  /** The starter a new lease uses when staff choose none: commercial, or residential. */
  async starterFor(tx: Tx, companyId: string, kind: StarterTemplateKind): Promise<string> {
    const [row] = await tx
      .select({ id: schema.leaseTemplate.id })
      .from(schema.leaseTemplate)
      .where(
        and(
          eq(schema.leaseTemplate.companyId, companyId),
          eq(schema.leaseTemplate.starterKind, kind),
        ),
      );
    if (!row) throw notFound('Starter template');
    return row.id;
  }

  async latestVersion(tx: Tx, templateId: string): Promise<VersionRow | undefined> {
    const [row] = await tx
      .select()
      .from(schema.leaseTemplateVersion)
      .where(eq(schema.leaseTemplateVersion.templateId, templateId))
      .orderBy(desc(schema.leaseTemplateVersion.version))
      .limit(1);
    return row;
  }

  async version(
    tx: Tx,
    versionId: string,
  ): Promise<{ version: VersionRow; template: TemplateRow }> {
    const [version] = await tx
      .select()
      .from(schema.leaseTemplateVersion)
      .where(eq(schema.leaseTemplateVersion.id, versionId));
    if (!version) throw notFound('Template version');
    return { version, template: await this.template(tx, version.templateId) };
  }

  private async template(
    tx: Tx,
    templateId: string,
    options: { lock?: boolean } = {},
  ): Promise<TemplateRow> {
    const query = tx
      .select()
      .from(schema.leaseTemplate)
      .where(eq(schema.leaseTemplate.id, templateId));
    const [row] = options.lock ? await query.for('update') : await query;
    if (!row) throw notFound('Template');
    return row;
  }

  private async insertVersion(
    tx: Tx,
    staff: StaffActor,
    templateId: string,
    version: number,
    content: TemplateContent,
    changeNote: string | null,
  ): Promise<void> {
    await tx.insert(schema.leaseTemplateVersion).values({
      companyId: staff.companyId,
      templateId,
      version,
      content,
      contentSha256: payloadHash(content),
      changeNote: changeNote?.trim().slice(0, 500) || null,
      createdBy: staff.personId,
    });
  }

  private async view(tx: Tx, template: TemplateRow): Promise<TemplateView> {
    const versions = await tx
      .select()
      .from(schema.leaseTemplateVersion)
      .where(eq(schema.leaseTemplateVersion.templateId, template.id))
      .orderBy(desc(schema.leaseTemplateVersion.version));
    if (versions.length === 0) throw notFound('Template version');
    return {
      id: template.id,
      name: template.name,
      kind: template.kind as TemplateKind,
      starterKind: (template.starterKind as StarterTemplateKind | null) ?? null,
      archived: template.archivedAt !== null,
      latest: versionView(versions[0]!),
      versions: versions.map((v) => ({
        id: v.id,
        version: v.version,
        counselReviewed: v.counselReviewedAt !== null,
      })),
    };
  }
}

function checkName(name: string): string {
  const v = name.trim();
  if (v.length < 2 || v.length > 120) throw invalid('template_name', 'Name the template');
  return v;
}
