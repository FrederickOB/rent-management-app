import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  addToOwnerScope,
  and,
  asc,
  eq,
  inArray,
  isNull,
  isScoped,
  schema,
  withCompany,
  type Database,
  type Tx,
} from '@rent/db';
import { isValidTimeZone } from '@rent/domain/dates';
import { normalisePhone } from '@rent/domain/phone';
import type { Actor } from '@rent/domain/policy';
import { checkOwnerReference, type OwnerKind } from '@rent/domain/portfolio';
import { checkTin, maskIdNumber } from '@rent/domain/tenancy';
import { v7 as uuidv7 } from 'uuid';
import { AuditService } from '../audit/audit.service';
import type { FieldCipher } from '../core/crypto/field-cipher';
import { isUniqueViolation } from '../core/db-errors';
import { conflict, invalid, notFound } from '../core/errors';
import { DATABASE, FIELD_CIPHER } from '../core/tokens';
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
  /** M3 tax fields (plan 4.13): a letting business pays income tax rather than final rent tax. */
  readonly lettingBusiness: boolean;
  readonly vatRegistered: boolean;
  /** Masked; revealing it needs owner.manage and a reason, and is audited. */
  readonly tinMasked: string | null;
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
  readonly lettingBusiness?: boolean;
  readonly vatRegistered?: boolean;
  /** Encrypted with the field cipher, blind-indexed and masked (M3 plan 4.4). Null removes it. */
  readonly tin?: string | null;
}

export const TIN_REVEAL_REASON_MIN_LENGTH = 10;

type OwnerRow = typeof schema.owner.$inferSelect;

/** `notes` are internal to the people who manage owners (owner.manage); others get null. */
const view = (r: OwnerRow, options: { readonly notes: boolean }): OwnerView => ({
  id: r.id,
  reference: r.reference,
  kind: r.kind as OwnerKind,
  displayName: r.displayName,
  legalName: r.legalName,
  phone: r.phone,
  email: r.email,
  residenceCountry: r.residenceCountry,
  timeZone: r.timeZone,
  notes: options.notes ? r.notes : null,
  lettingBusiness: r.lettingBusiness,
  vatRegistered: r.vatRegistered,
  tinMasked: r.tinMasked,
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
  if (input.lettingBusiness !== undefined) out.lettingBusiness = input.lettingBusiness;
  if (input.vatRegistered !== undefined) out.vatRegistered = input.vatRegistered;
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
    // Optional, so the register (M2) can use owners without the TIN features.
    @Optional() @Inject(FIELD_CIPHER) private readonly cipher?: FieldCipher,
    @Optional() @Inject(AuditService) private readonly audit?: AuditService,
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
    const notes = this.seesNotes(staff);
    return rows.map((r) => view(r, { notes }));
  }

  async get(actor: Actor | null, ownerId: string): Promise<OwnerView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'owner.view');
    const [row] = await withCompany(this.database, staffContext(staff), (tx) =>
      tx.select().from(schema.owner).where(eq(schema.owner.id, ownerId)),
    );
    if (!row) throw notFound('Owner');
    return view(row, { notes: this.seesNotes(staff) });
  }

  /** Owner notes are internal: only people who manage owners read them (N5). */
  private seesNotes(staff: ReturnType<typeof staffActor>): boolean {
    return this.policy.can(staff, 'owner.manage').allowed;
  }

  async create(actor: Actor | null, input: OwnerInput): Promise<OwnerView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'owner.manage');
    const values = checked(input);
    // One id for the row and for the TIN's encryption context, generated before the insert.
    const id = uuidv7();
    const tin = await this.sealTin(staff.companyId, id, input.tin);
    try {
      const [row] = await withCompany(this.database, staffContext(staff), async (tx) => {
        // An owner-scoped person sees only their owners (owner_scope policy); the new record
        // joins this transaction's scope so it can be written and returned.
        await addToOwnerScope(tx, id);
        return tx
          .insert(schema.owner)
          .values({
            id,
            companyId: staff.companyId,
            reference: values.reference ?? (await this.nextReference(tx, staff.companyId)),
            kind: input.kind,
            displayName: values.displayName!,
            legalName: values.legalName ?? null,
            phone: values.phone ?? null,
            email: values.email ?? null,
            residenceCountry: values.residenceCountry ?? null,
            timeZone: values.timeZone ?? 'Africa/Accra',
            notes: values.notes ?? null,
            lettingBusiness: values.lettingBusiness ?? false,
            vatRegistered: values.vatRegistered ?? false,
            ...tin,
          })
          .returning();
      });
      return view(row!, { notes: true });
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
    const tin =
      patch.tin !== undefined ? await this.sealTin(staff.companyId, ownerId, patch.tin) : {};
    try {
      const [row] = await withCompany(this.database, staffContext(staff), (tx) =>
        tx
          .update(schema.owner)
          .set({ ...values, ...tin, updatedAt: new Date() })
          .where(and(eq(schema.owner.id, ownerId), isNull(schema.owner.archivedAt)))
          .returning(),
      );
      if (!row) throw notFound('Owner');
      return view(row, { notes: true });
    } catch (error) {
      if (isUniqueViolation(error, 'owner_reference_key'))
        throw conflict('owner_reference_taken', 'Another owner already has that reference');
      throw error;
    }
  }

  /**
   * Shows an owner's TIN (plan 4.13): needs owner.manage and a reason, and writes the audit event
   * `tin.revealed` with who, when and why, never the number itself.
   */
  async revealTin(actor: Actor | null, ownerId: string, reason: string): Promise<{ tin: string }> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'owner.manage');
    const why = reason.trim();
    if (why.length < TIN_REVEAL_REASON_MIN_LENGTH)
      throw invalid(
        'reason_required',
        `Give a reason of at least ${TIN_REVEAL_REASON_MIN_LENGTH} characters`,
      );
    const { cipher, audit } = this.taxDependencies();
    const row = await withCompany(this.database, staffContext(staff), async (tx) => {
      const [found] = await tx.select().from(schema.owner).where(eq(schema.owner.id, ownerId));
      if (!found) throw notFound('Owner');
      if (!found.tinEncrypted) throw notFound('TIN');
      await audit.append(tx, {
        companyId: staff.companyId,
        action: 'tin.revealed',
        recordType: 'owner',
        recordId: ownerId,
        data: { reason: why.slice(0, 300) },
      });
      return found;
    });
    return {
      tin: await cipher.decrypt(
        { companyId: staff.companyId, table: 'owner', column: 'tin', rowId: ownerId },
        row.tinEncrypted!,
      ),
    };
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
   *
   * A scoped session sees only its own owners, so it never creates the record: it gets its one
   * owner, or null. Two first properties added at once both end up with the one OWN-01.
   */
  async landlordOwner(tx: Tx, companyId: string): Promise<string | null> {
    const owners = await this.liveOwners(tx);
    if (owners.length === 1) return owners[0]!.id;
    if (owners.length > 1 || (await isScoped(tx))) return null;
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
      .onConflictDoNothing({ target: [schema.owner.companyId, schema.owner.reference] })
      .returning({ id: schema.owner.id });
    if (row) return row.id;
    // Another request made it first (it waited for that one to commit); use theirs.
    const again = await this.liveOwners(tx);
    return again.length === 1 ? again[0]!.id : null;
  }

  private liveOwners(tx: Tx) {
    return tx
      .select({ id: schema.owner.id })
      .from(schema.owner)
      .where(isNull(schema.owner.archivedAt))
      .limit(2);
  }

  /**
   * M11 (onboarding step 1): the TIN columns the register import writes for an owner from its
   * Owners sheet, encrypted, indexed and masked as everywhere else. Undefined leaves them as they
   * are. Also the keyed hash an imported TIN is compared by, never the TIN itself.
   */
  importTin(companyId: string, ownerId: string, value: string | undefined) {
    return this.sealTin(companyId, ownerId, value);
  }

  /**
   * M11: makes sure the company's field key exists before a transaction that seals owners' TINs
   * in bulk (the register import's commit): creating the key is audited in its own transaction,
   * so it must never wait on the audit chain that transaction holds. Nothing without the cipher.
   */
  async ensureFieldKey(companyId: string): Promise<void> {
    if (!this.cipher) return;
    await this.cipher.encrypt(
      { companyId, table: 'owner', column: 'tin', rowId: companyId },
      'field-key-check',
    );
  }

  tinIndexFor(companyId: string, tin: string): string {
    return this.taxDependencies().cipher.blindIndex(companyId, `tin:${checkTin(tin)}`);
  }

  /** The TIN columns for a value: encrypted, indexed and masked, or all null to remove it. */
  private async sealTin(
    companyId: string,
    ownerId: string,
    value: string | null | undefined,
  ): Promise<Partial<OwnerRow>> {
    if (value === undefined) return {};
    if (value === null || !value.trim())
      return { tinEncrypted: null, tinIndex: null, tinMasked: null };
    const { cipher } = this.taxDependencies();
    const tin = checkTin(value);
    return {
      tinEncrypted: await cipher.encrypt(
        { companyId, table: 'owner', column: 'tin', rowId: ownerId },
        tin,
      ),
      tinIndex: cipher.blindIndex(companyId, `tin:${tin}`),
      tinMasked: maskIdNumber(tin),
    };
  }

  private taxDependencies(): { cipher: FieldCipher; audit: AuditService } {
    if (!this.cipher || !this.audit)
      throw new Error('Owner TINs need the field cipher and the audit log');
    return { cipher: this.cipher, audit: this.audit };
  }

  /** The next free OWN-nn reference. */
  private async nextReference(tx: Tx, companyId: string): Promise<string> {
    // References are unique across the company, but a scoped session sees only its owners.
    const all = (db: Tx) => db.select({ reference: schema.owner.reference }).from(schema.owner);
    const rows = (await isScoped(tx))
      ? await withCompany(this.database, { companyId, actorKind: 'system' }, all)
      : await all(tx);
    let highest = 0;
    for (const { reference } of rows) {
      const match = /^OWN-(\d+)$/.exec(reference);
      if (match) highest = Math.max(highest, Number(match[1]));
    }
    return `OWN-${String(highest + 1).padStart(2, '0')}`;
  }
}

/** What billing needs to know about owners (M4a): names, VAT registration and the masked TIN. */
export interface OwnerFacts {
  readonly id: string;
  /** The name invoices are issued from: the registered name, or the display name. */
  readonly name: string;
  readonly displayName: string;
  readonly vatRegistered: boolean;
  /** Masked (CLAUDE.md section 10). */
  readonly tinMasked: string | null;
  /** M5 decision 2: a letting business is taxed on income, not per receipt (OQ-18). */
  readonly lettingBusiness: boolean;
}

/** Owners by id, read in the caller's transaction (RLS applies). */
export async function ownerFacts(
  tx: Tx,
  ownerIds: readonly string[],
): Promise<Map<string, OwnerFacts>> {
  if (ownerIds.length === 0) return new Map();
  const rows = await tx
    .select({
      id: schema.owner.id,
      displayName: schema.owner.displayName,
      legalName: schema.owner.legalName,
      vatRegistered: schema.owner.vatRegistered,
      tinMasked: schema.owner.tinMasked,
      lettingBusiness: schema.owner.lettingBusiness,
    })
    .from(schema.owner)
    .where(inArray(schema.owner.id, [...new Set(ownerIds)]));
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        name: r.legalName ?? r.displayName,
        displayName: r.displayName,
        vatRegistered: r.vatRegistered,
        tinMasked: r.tinMasked,
        lettingBusiness: r.lettingBusiness,
      },
    ]),
  );
}
