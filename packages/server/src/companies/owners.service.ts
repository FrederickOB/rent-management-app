import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, schema, withCompany, type Database, type Tx } from '@rent/db';
import { isValidTimeZone } from '@rent/domain/dates';
import { normalisePhone } from '@rent/domain/phone';
import type { Actor } from '@rent/domain/policy';
import { checkOwnerReference, type OwnerKind } from '@rent/domain/portfolio';
import { isUniqueViolation } from '../core/db-errors';
import { conflict, invalid, notFound } from '../core/errors';
import { DATABASE } from '../core/tokens';
import { PolicyService, staffContext } from '../policy/policy.service';
import { staffActor } from './companies.service';

export interface OwnerView {
  readonly id: string;
  readonly reference: string;
  readonly kind: OwnerKind;
  readonly displayName: string;
  readonly legalName: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly residenceCountry: string | null;
  readonly timeZone: string;
  readonly notes: string | null;
  readonly archived: boolean;
  readonly createdAt: Date;
}

export interface OwnerInput {
  readonly reference?: string | null;
  readonly kind: OwnerKind;
  readonly displayName: string;
  readonly legalName?: string | null;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly residenceCountry?: string | null;
  readonly timeZone?: string | null;
  readonly notes?: string | null;
}

type OwnerRow = typeof schema.owner.$inferSelect;

const view = (r: OwnerRow): OwnerView => ({
  id: r.id,
  reference: r.reference,
  kind: r.kind as OwnerKind,
  displayName: r.displayName,
  legalName: r.legalName,
  phone: r.phone,
  email: r.email,
  residenceCountry: r.residenceCountry,
  timeZone: r.timeZone,
  notes: r.notes,
  archived: r.archivedAt !== null,
  createdAt: r.createdAt,
});

function checked(input: Partial<OwnerInput>) {
  const out: Partial<typeof schema.owner.$inferInsert> = {};
  if (input.reference) out.reference = checkOwnerReference(input.reference);
  if (input.kind) out.kind = input.kind;
  if (input.displayName !== undefined) {
    const name = input.displayName.trim();
    if (name.length < 2) throw invalid('owner_name', 'Enter the owner’s name');
    out.displayName = name;
  }
  if (input.legalName !== undefined) out.legalName = input.legalName?.trim() || null;
  if (input.phone !== undefined) out.phone = input.phone ? normalisePhone(input.phone) : null;
  if (input.email !== undefined) out.email = input.email?.trim().toLowerCase() || null;
  if (input.residenceCountry !== undefined) {
    const country = input.residenceCountry?.trim().toUpperCase() || null;
    if (country && !/^[A-Z]{2}$/.test(country))
      throw invalid('owner_country', 'Use a two-letter country code, such as GB');
    out.residenceCountry = country;
  }
  if (input.timeZone) {
    if (!isValidTimeZone(input.timeZone))
      throw invalid('owner_time_zone', 'Use a time zone such as Europe/London');
    out.timeZone = input.timeZone;
  }
  if (input.notes !== undefined) out.notes = input.notes?.trim() || null;
  return out;
}

/**
 * Owners (AD-02): an agency's clients, or the landlord in their own company. A scoped person
 * sees only their own owners; the database enforces it as well (owner_scope policy).
 */
@Injectable()
export class OwnersService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
  ) {}

  async list(
    actor: Actor | null,
    options: { includeArchived?: boolean } = {},
  ): Promise<OwnerView[]> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'owner.view');
    const rows = await withCompany(this.database, staffContext(staff), (tx) =>
      tx
        .select()
        .from(schema.owner)
        .where(options.includeArchived ? undefined : isNull(schema.owner.archivedAt))
        .orderBy(asc(schema.owner.displayName)),
    );
    return rows.map(view);
  }

  async get(actor: Actor | null, ownerId: string): Promise<OwnerView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'owner.view');
    const [row] = await withCompany(this.database, staffContext(staff), (tx) =>
      tx.select().from(schema.owner).where(eq(schema.owner.id, ownerId)),
    );
    if (!row) throw notFound('Owner');
    return view(row);
  }

  async create(actor: Actor | null, input: OwnerInput): Promise<OwnerView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'owner.manage');
    const values = checked(input);
    try {
      const [row] = await withCompany(this.database, staffContext(staff), async (tx) =>
        tx
          .insert(schema.owner)
          .values({
            companyId: staff.companyId,
            reference: values.reference ?? (await this.nextReference(tx)),
            kind: input.kind,
            displayName: values.displayName!,
            legalName: values.legalName ?? null,
            phone: values.phone ?? null,
            email: values.email ?? null,
            residenceCountry: values.residenceCountry ?? null,
            timeZone: values.timeZone ?? 'Africa/Accra',
            notes: values.notes ?? null,
          })
          .returning(),
      );
      return view(row!);
    } catch (error) {
      if (isUniqueViolation(error, 'owner_reference_key'))
        throw conflict('owner_reference_taken', 'Another owner already has that reference');
      throw error;
    }
  }

  async update(
    actor: Actor | null,
    ownerId: string,
    patch: Partial<OwnerInput>,
  ): Promise<OwnerView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'owner.manage');
    const values = checked(patch);
    try {
      const [row] = await withCompany(this.database, staffContext(staff), (tx) =>
        tx
          .update(schema.owner)
          .set({ ...values, updatedAt: new Date() })
          .where(and(eq(schema.owner.id, ownerId), isNull(schema.owner.archivedAt)))
          .returning(),
      );
      if (!row) throw notFound('Owner');
      return view(row);
    } catch (error) {
      if (isUniqueViolation(error, 'owner_reference_key'))
        throw conflict('owner_reference_taken', 'Another owner already has that reference');
      throw error;
    }
  }

  /** Archives an owner. The register checks first that they no longer own a property. */
  async archive(actor: Actor | null, ownerId: string, tx: Tx): Promise<void> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'owner.manage');
    const rows = await tx
      .update(schema.owner)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(schema.owner.id, ownerId), isNull(schema.owner.archivedAt)))
      .returning({ id: schema.owner.id });
    if (rows.length === 0) throw notFound('Owner');
  }

  /**
   * A landlord's own owner record, made from the company profile the first time a property is
   * added. Runs inside the caller's transaction. Null when the company has several owners.
   */
  async landlordOwner(tx: Tx, companyId: string): Promise<string | null> {
    const owners = await tx
      .select({ id: schema.owner.id })
      .from(schema.owner)
      .where(isNull(schema.owner.archivedAt))
      .limit(2);
    if (owners.length === 1) return owners[0]!.id;
    if (owners.length > 1) return null;
    const [company] = await tx
      .select({ legalName: schema.company.legalName, displayName: schema.company.displayName })
      .from(schema.company)
      .where(eq(schema.company.id, companyId));
    const [row] = await tx
      .insert(schema.owner)
      .values({
        companyId,
        reference: 'OWN-01',
        kind: 'individual',
        displayName: company?.displayName ?? 'Landlord',
        legalName: company?.legalName ?? null,
      })
      .returning({ id: schema.owner.id });
    return row!.id;
  }

  /** The next free OWN-nn reference. */
  private async nextReference(tx: Tx): Promise<string> {
    const rows = await tx.select({ reference: schema.owner.reference }).from(schema.owner);
    let highest = 0;
    for (const { reference } of rows) {
      const match = /^OWN-(\d+)$/.exec(reference);
      if (match) highest = Math.max(highest, Number(match[1]));
    }
    return `OWN-${String(highest + 1).padStart(2, '0')}`;
  }
}
