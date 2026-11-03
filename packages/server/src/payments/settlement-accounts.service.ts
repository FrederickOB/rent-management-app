import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, inArray, schema, sql, withCompany, type Database, type Tx } from '@rent/db';
import { businessDateOf, formatBusinessDate, instantFrom, toIsoDate } from '@rent/domain/dates';
import {
  maskAccountNumber,
  RENT_DESTINATIONS,
  SETTLEMENT_ACCOUNT_STATUSES,
  usableFrom,
  type RentDestination,
  type SettlementAccountStatus,
} from '@rent/domain/payments';
import type { Actor, StaffRole } from '@rent/domain/policy';
import { ProviderError } from '@rent/integrations';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { ApprovalsService, type ApprovalView } from '../approvals/approvals.service';
import { AuditService } from '../audit/audit.service';
import { companyRecord, staffActor, type StaffActor } from '../companies/companies.service';
import { ownerFacts } from '../companies/owners.service';
import { currentAgreement } from '../companies/settlement-destinations';
import type { Clock } from '../core/clock';
import type { FieldCipher } from '../core/crypto/field-cipher';
import { conflict, invalid, notFound } from '../core/errors';
import { queueMessage } from '../core/messages';
import { enqueueOutbox } from '../core/outbox';
import type { PaymentProviders } from '../core/payment-providers';
import { CLOCK, DATABASE, FIELD_CIPHER, PAYMENT_PROVIDERS } from '../core/tokens';
import { isoNow } from '../billing/records';
import { PolicyService, staffContext } from '../policy/policy.service';
import { membersWhoCan } from './members';

/** The approval action names the web uses (coordinator's list): adding, then retiring, an account. */
export const SETTLEMENT_ADD_ACTION = 'settlement_account.change';
export const SETTLEMENT_RETIRE_ACTION = 'settlement_account.retire';
export const SETTLEMENT_APPROVED_EVENT = 'settlement_account.approved';
/** The job that sets an approved account up with the providers and activates it after 24 hours. */
export const SETTLEMENT_READY_JOB = SETTLEMENT_APPROVED_EVENT;

/** Who approves a settlement account (plan 4.11): a second owner or agency admin. */
const APPROVERS: readonly StaffRole[] = ['owner', 'agency_admin'];

export interface SettlementAccountView {
  readonly id: string;
  readonly holder: 'owner' | 'agency';
  readonly ownerId: string | null;
  readonly ownerName: string | null;
  readonly bankCode: string;
  readonly bankName: string;
  readonly branch: string | null;
  readonly accountNameChecked: string | null;
  readonly accountName: string;
  readonly numberMasked: string;
  readonly status: SettlementAccountStatus;
  readonly usableFrom: Date | null;
  readonly providerReady: boolean;
  readonly createdAt: Date;
  readonly approvalId: string | null;
  readonly openRequest: { readonly kind: 'add' | 'retire'; readonly approvalId: string } | null;
}

export interface AgreementView {
  readonly ownerId: string;
  readonly ownerName: string;
  readonly destination: RentDestination | null;
  readonly effectiveFrom: string | null;
}

const uuid = z.string().uuid();
const accountPayload = z
  .object({
    accountId: uuid,
    holder: z.enum(['owner', 'agency']),
    ownerId: uuid.nullable(),
    ownerName: z.string().nullable(),
    bankName: z.string(),
    branch: z.string().nullable(),
    numberMasked: z.string(),
    accountName: z.string(),
    accountNameChecked: z.string().nullable(),
    /** Still waiting for this decision: false once approved, rejected or retired. */
    awaiting: z.boolean(),
  })
  .strict();
const retirePayload = z
  .object({
    accountId: uuid,
    holder: z.enum(['owner', 'agency']),
    ownerName: z.string().nullable(),
    bankName: z.string(),
    numberMasked: z.string(),
    reason: z.string().min(5).max(500),
    live: z.boolean(),
  })
  .strict();

type AccountRow = typeof schema.settlementAccount.$inferSelect;

/**
 * Settlement accounts and management agreements (ADR-008; M4b plan 4.2, decisions 2 and 6).
 * Redirecting rent is the likeliest fraud against this product, so an account is added only by a
 * request a second person approves, it receives rent only 24 hours after that, and the owner is
 * told by SMS and email at each step. Its number is encrypted, blind-indexed and masked; the
 * provider's subaccount is created outside any transaction by the ready job.
 */
@Injectable()
export class SettlementAccountsService {
  private registered = false;

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(PAYMENT_PROVIDERS) private readonly providers: PaymentProviders,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Banks the first provider settles to. Empty when no provider is configured. */
  async banks(actor: Actor | null): Promise<{ code: string; name: string }[]> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'payments.view');
    const [first] = this.providers.settlingProviders();
    return first ? this.providers.get(first).listBanks() : [];
  }

  async list(actor: Actor | null): Promise<SettlementAccountView[]> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'payments.view');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const rows = await tx
        .select()
        .from(schema.settlementAccount)
        .orderBy(desc(schema.settlementAccount.createdAt));
      return this.views(tx, rows);
    });
  }

  async view(actor: Actor | null, accountId: string): Promise<SettlementAccountView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'payments.view');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const rows = await tx
        .select()
        .from(schema.settlementAccount)
        .where(eq(schema.settlementAccount.id, accountId));
      const [view] = await this.views(tx, rows);
      if (!view) throw notFound('Settlement account');
      return view;
    });
  }

  /**
   * Asks to add a bank account rent settles to. The provider checks the account's name first,
   * where it can, outside any transaction; then the account and its approval request are
   * recorded together, and the owner is alerted.
   */
  async request(
    actor: Actor | null,
    input: {
      readonly holder: 'owner' | 'agency';
      readonly ownerId?: string | null;
      readonly bankCode: string;
      readonly branch?: string | null;
      readonly accountNumber: string;
      readonly accountName: string;
    },
  ): Promise<{ accountId: string; approvalId: string }> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'settlement_account.change');
    const number = input.accountNumber.replace(/\s/g, '');
    if (!/^\d{6,20}$/.test(number))
      throw invalid('account_number', 'Enter the account number, digits only');
    if (input.holder !== 'agency' && !input.ownerId)
      throw invalid('owner_required', 'Say whose account it is');
    if (input.holder === 'agency' && input.ownerId)
      throw invalid('owner', 'The company’s own account belongs to no owner; leave the owner out');
    const [first] = this.providers.settlingProviders();
    if (!first) throw conflict('no_provider', 'No payment provider is set up yet');
    const port = this.providers.get(first);
    const banks = await port.listBanks();
    const bank = banks.find((b) => b.code === input.bankCode);
    if (!bank) throw invalid('bank', 'Choose a bank from the list');
    // The name check is a read, made before the transaction opens (CLAUDE.md section 8).
    const checked = await port
      .resolveAccount({ bankCode: input.bankCode, accountNumber: number })
      .catch((error: unknown) => {
        if (error instanceof ProviderError && !error.retryable) return null;
        throw error;
      });
    const accountId = uuidv7();
    // Sealed before the transaction opens: the cipher may create the company's key in a
    // transaction of its own, which must not wait on this one's audit lock.
    const numberEncrypted = await this.cipher.encrypt(
      {
        companyId: staff.companyId,
        table: 'settlement_account',
        column: 'number_encrypted',
        rowId: accountId,
      },
      number,
    );
    const approvalId = await withCompany(this.database, staffContext(staff), async (tx) => {
      let ownerName: string | null = null;
      if (input.ownerId) {
        const owner = (await ownerFacts(tx, [input.ownerId])).get(input.ownerId);
        if (!owner) throw notFound('Owner');
        ownerName = owner.name.slice(0, 200);
      }
      const numberMasked = maskAccountNumber(number);
      const id = await this.approvals.createInTx(tx, staff, {
        actionType: SETTLEMENT_ADD_ACTION,
        subjectType: 'settlement_account',
        subjectId: accountId,
        propertyId: null,
        payload: {
          accountId,
          holder: input.holder,
          ownerId: input.ownerId ?? null,
          ownerName,
          bankName: bank.name.slice(0, 120),
          branch: input.branch?.trim().slice(0, 120) || null,
          numberMasked,
          accountName: input.accountName.trim().slice(0, 160),
          accountNameChecked: checked?.accountName.slice(0, 160) ?? null,
          awaiting: true,
        },
      });
      await tx.insert(schema.settlementAccount).values({
        id: accountId,
        companyId: staff.companyId,
        holder: input.holder,
        ownerId: input.ownerId ?? null,
        bankCode: input.bankCode,
        bankName: bank.name.slice(0, 120),
        branch: input.branch?.trim().slice(0, 120) || null,
        accountName: input.accountName.trim().slice(0, 160),
        accountNameChecked: checked?.accountName.slice(0, 160) ?? null,
        numberEncrypted,
        numberIndex: this.cipher.blindIndex(staff.companyId, `account:${input.bankCode}:${number}`),
        numberMasked,
        approvalRequestId: id,
        createdBy: staff.personId,
      });
      await this.alert(tx, staff.companyId, input.holder, input.ownerId ?? null, {
        subject: 'A new account for your rent was requested',
        body: `${this.label(input.holder, ownerName)}: someone asked to pay rent into a new account, ${bank.name} ${numberMasked}. It needs a second person's approval and is used only 24 hours after that. If you did not expect this, contact your agent or landlord at once.`,
        accountId,
      });
      return id;
    });
    return { accountId, approvalId };
  }

  /** Asks to stop settling to an account; a second person approves. */
  async retire(actor: Actor | null, accountId: string, reason: string): Promise<string> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'settlement_account.change');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const account = await this.row(tx, accountId);
      if (!['active', 'cooling_off'].includes(account.status))
        throw conflict('account_not_live', 'Only an approved account can be retired');
      return this.approvals.createInTx(tx, staff, {
        actionType: SETTLEMENT_RETIRE_ACTION,
        subjectType: 'settlement_account',
        subjectId: accountId,
        propertyId: null,
        payload: {
          accountId,
          holder: account.holder as 'owner' | 'agency',
          ownerName: await this.ownerName(tx, account.ownerId),
          bankName: account.bankName,
          numberMasked: account.numberMasked,
          reason: reason.trim().slice(0, 500),
          live: true,
        },
      });
    });
  }

  /**
   * Shows an account number in full (CLAUDE.md section 10): masked everywhere else, revealed only
   * with the permission and a reason, and the reveal is an audit event in the same transaction.
   */
  async reveal(actor: Actor | null, accountId: string, reason: string): Promise<string> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'settlement_account.reveal');
    const why = reason.trim();
    if (why.length < 5) throw invalid('reason', 'Say why you need to see the full number');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const account = await this.row(tx, accountId);
      const number = await this.cipher.decrypt(
        {
          companyId: staff.companyId,
          table: 'settlement_account',
          column: 'number_encrypted',
          rowId: accountId,
        },
        account.numberEncrypted,
      );
      await this.audit.append(tx, {
        companyId: staff.companyId,
        action: 'settlement_account.number_revealed',
        recordType: 'settlement_account',
        recordId: accountId,
        data: { reason: why.slice(0, 500), numberMasked: account.numberMasked },
      });
      return number;
    });
  }

  /** Where each owner's rent goes, for an agency (decision 6). */
  async agreements(actor: Actor | null): Promise<AgreementView[]> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'payments.view');
    if (staff.companyKind !== 'agency') return [];
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const today = await this.today(tx, staff.companyId);
      const owners = await tx
        .select({
          id: schema.owner.id,
          displayName: schema.owner.displayName,
          legalName: schema.owner.legalName,
        })
        .from(schema.owner)
        .where(sql`${schema.owner.archivedAt} is null`)
        .orderBy(schema.owner.displayName);
      const out: AgreementView[] = [];
      for (const o of owners) {
        const agreement = await currentAgreement(tx, o.id, today);
        out.push({
          ownerId: o.id,
          ownerName: o.legalName ?? o.displayName,
          destination: agreement?.destination ?? null,
          effectiveFrom: agreement?.effectiveFrom ?? null,
        });
      }
      return out;
    });
  }

  /** Sets where an owner's rent goes from a date: a new row, never an edit (decision 6). */
  async setAgreement(
    actor: Actor | null,
    ownerId: string,
    input: { readonly destination: RentDestination; readonly effectiveFrom: string },
  ): Promise<AgreementView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'settlement_account.change');
    if (staff.companyKind !== 'agency')
      throw conflict('not_an_agency', 'A landlord’s rent always goes to their own account');
    if (!(RENT_DESTINATIONS as readonly string[]).includes(input.destination))
      throw invalid('destination', 'Choose where this owner’s rent goes');
    return withCompany(this.database, staffContext(staff), async (tx) => {
      const owner = (await ownerFacts(tx, [ownerId])).get(ownerId);
      if (!owner) throw notFound('Owner');
      await tx.insert(schema.managementAgreement).values({
        companyId: staff.companyId,
        ownerId,
        destination: input.destination,
        effectiveFrom: input.effectiveFrom,
        createdBy: staff.personId,
      });
      return {
        ownerId,
        ownerName: owner.name,
        destination: input.destination,
        effectiveFrom: input.effectiveFrom,
      };
    });
  }

  /**
   * The ready job (`companies.settlement-account-ready`, plan 4.12): sets an approved account up
   * as a subaccount with every provider that settles directly (outside any transaction), then
   * activates it once its 24 hours have passed. Idempotent; returns when to run again, if ever.
   */
  async ready(companyId: string, accountId: string): Promise<{ again: Date | null }> {
    const ctx = { companyId, actorKind: 'system' as const };
    const loaded = await withCompany(this.database, ctx, async (tx) => {
      const account = await this.row(tx, accountId);
      const have = await tx
        .select({ provider: schema.providerSubaccount.provider })
        .from(schema.providerSubaccount)
        .where(eq(schema.providerSubaccount.settlementAccountId, accountId));
      const company = await companyRecord(tx, companyId);
      return { account, have: new Set(have.map((h) => h.provider)), company };
    });
    const { account } = loaded;
    if (account.status !== 'cooling_off') return { again: null };
    const missing = this.providers.settlingProviders().filter((p) => !loaded.have.has(p));
    if (missing.length > 0) {
      const number = await this.cipher.decrypt(
        {
          companyId,
          table: 'settlement_account',
          column: 'number_encrypted',
          rowId: accountId,
        },
        account.numberEncrypted,
      );
      for (const provider of missing) {
        const { subaccountCode } = await this.providers.get(provider).createSubaccount({
          businessName: (account.accountNameChecked ?? account.accountName).slice(0, 100),
          settlementBank: account.bankCode,
          accountNumber: number,
        });
        await withCompany(this.database, ctx, (tx) =>
          tx
            .insert(schema.providerSubaccount)
            .values({ companyId, settlementAccountId: accountId, provider, subaccountCode })
            .onConflictDoNothing(),
        );
      }
    }
    const now = this.clock.now();
    if (!account.usableFrom || account.usableFrom.getTime() > now.getTime())
      return { again: account.usableFrom };
    await withCompany(this.database, ctx, async (tx) => {
      const current = await this.row(tx, accountId, { lock: true });
      if (current.status !== 'cooling_off') return;
      await tx
        .update(schema.settlementAccount)
        .set({ status: 'active', activatedAt: now, updatedAt: now })
        .where(eq(schema.settlementAccount.id, accountId));
      await this.alert(tx, companyId, current.holder as 'owner' | 'agency', current.ownerId, {
        subject: 'Rent now settles to a new account',
        body: `${this.label(current.holder as 'owner' | 'agency', await this.ownerName(tx, current.ownerId))}: rent now settles to ${current.bankName} ${current.numberMasked}. If you did not expect this, contact your agent or landlord at once.`,
        accountId,
      });
    });
    return { again: null };
  }

  // Approval handlers -------------------------------------------------------------------------------

  registerApprovals(): void {
    if (this.registered) return;
    this.registered = true;
    this.approvals.register({
      actionType: SETTLEMENT_ADD_ACTION,
      eligibleRoles: APPROVERS,
      schema: accountPayload,
      onePerSubject: true,
      currentPayload: async (tx, request) => {
        const account = await this.row(tx, request.subjectId);
        return {
          ...(request.payload as z.infer<typeof accountPayload>),
          awaiting: account.status === 'awaiting_approval',
        };
      },
      execute: async (tx, request) => {
        const now = this.clock.now();
        const from = usableFrom(now);
        const account = await this.row(tx, request.subjectId, { lock: true });
        await tx
          .update(schema.settlementAccount)
          .set({ status: 'cooling_off', approvedAt: now, usableFrom: from, updatedAt: now })
          .where(eq(schema.settlementAccount.id, account.id));
        await enqueueOutbox(tx, {
          companyId: request.companyId,
          type: SETTLEMENT_APPROVED_EVENT,
          payload: { accountId: account.id },
          idempotencyKey: `${SETTLEMENT_APPROVED_EVENT}:${account.id}`,
        });
        const company = await companyRecord(tx, request.companyId);
        await this.alert(
          tx,
          request.companyId,
          account.holder as 'owner' | 'agency',
          account.ownerId,
          {
            subject: 'A new account for your rent was approved',
            body: `${this.label(account.holder as 'owner' | 'agency', await this.ownerName(tx, account.ownerId))}: the new account ${account.bankName} ${account.numberMasked} was approved. Rent settles to it from ${formatBusinessDate(toIsoDate(businessDateOf(instantFrom(from), company?.timeZone ?? 'Africa/Accra')))} (${company?.timeZone ?? 'Africa/Accra'}), 24 hours from now. If you did not expect this, contact your agent or landlord at once.`,
            accountId: account.id,
          },
        );
      },
    });
    this.approvals.register({
      actionType: SETTLEMENT_RETIRE_ACTION,
      eligibleRoles: APPROVERS,
      schema: retirePayload,
      onePerSubject: true,
      currentPayload: async (tx, request) => {
        const account = await this.row(tx, request.subjectId);
        return {
          ...(request.payload as z.infer<typeof retirePayload>),
          live: ['active', 'cooling_off'].includes(account.status),
        };
      },
      execute: async (tx, request, payload) => {
        const now = this.clock.now();
        const account = await this.row(tx, request.subjectId, { lock: true });
        await tx
          .update(schema.settlementAccount)
          .set({
            status: 'retired',
            retireRequestId: request.id,
            retiredAt: now,
            retireReason: payload.reason,
            updatedAt: now,
          })
          .where(eq(schema.settlementAccount.id, account.id));
        await this.alert(
          tx,
          request.companyId,
          account.holder as 'owner' | 'agency',
          account.ownerId,
          {
            subject: 'An account for your rent was retired',
            body: `${this.label(account.holder as 'owner' | 'agency', payload.ownerName)}: rent no longer settles to ${account.bankName} ${account.numberMasked}.`,
            accountId: account.id,
          },
        );
      },
    });
  }

  // Helpers -----------------------------------------------------------------------------------------

  private label(holder: 'owner' | 'agency', ownerName: string | null): string {
    return holder !== 'agency' && ownerName ? `For ${ownerName}` : 'For your company';
  }

  /**
   * The owner is told by SMS and email (ADR-008): an owner in the register on the phone and email
   * recorded there; the company's own account, its admins and owners. A security notice about
   * their own money, so no tenancy consent applies (packages/domain/src/messaging).
   */
  private async alert(
    tx: Tx,
    companyId: string,
    holder: 'owner' | 'agency',
    ownerId: string | null,
    message: { subject: string; body: string; accountId: string },
  ): Promise<void> {
    const common = {
      purpose: 'settlement_alert' as const,
      subject: message.subject,
      body: message.body.slice(0, 4_000),
      channels: ['sms', 'email'] as ('sms' | 'email')[],
      related: { type: 'settlement_account', id: message.accountId },
    };
    if (holder !== 'agency' && ownerId) {
      await queueMessage(tx, companyId, { ...common, recipient: { type: 'owner', ownerId } });
      return;
    }
    // The company's own account: everyone who may change where rent settles is told.
    const company = await companyRecord(tx, companyId);
    for (const personId of await membersWhoCan(
      tx,
      this.policy,
      { id: companyId, kind: company?.kind ?? 'agency' },
      'settlement_account.change',
    ))
      await queueMessage(tx, companyId, { ...common, recipient: { type: 'staff', personId } });
  }

  private async today(tx: Tx, companyId: string): Promise<string> {
    const company = await companyRecord(tx, companyId);
    return isoNow(this.clock, company?.timeZone ?? 'Africa/Accra');
  }

  private async ownerName(tx: Tx, ownerId: string | null): Promise<string | null> {
    if (!ownerId) return null;
    return (await ownerFacts(tx, [ownerId])).get(ownerId)?.name.slice(0, 200) ?? null;
  }

  private async row(tx: Tx, id: string, options: { lock?: boolean } = {}): Promise<AccountRow> {
    const query = tx
      .select()
      .from(schema.settlementAccount)
      .where(eq(schema.settlementAccount.id, id));
    const [row] = options.lock ? await query.for('update') : await query;
    if (!row) throw notFound('Settlement account');
    return row;
  }

  private async views(tx: Tx, rows: readonly AccountRow[]): Promise<SettlementAccountView[]> {
    const owners = await ownerFacts(
      tx,
      rows.flatMap((r) => (r.ownerId ? [r.ownerId] : [])),
    );
    const ready = new Set(
      (rows.length === 0
        ? []
        : await tx
            .select({ id: schema.providerSubaccount.settlementAccountId })
            .from(schema.providerSubaccount)
            .where(
              inArray(
                schema.providerSubaccount.settlementAccountId,
                rows.map((r) => r.id),
              ),
            )
      ).map((r) => r.id),
    );
    const adding = await this.approvals.openFor(
      tx,
      rows.map((r) => r.id),
      SETTLEMENT_ADD_ACTION,
    );
    const retiring = await this.approvals.openFor(
      tx,
      rows.map((r) => r.id),
      SETTLEMENT_RETIRE_ACTION,
    );
    const open = new Map<string, { kind: 'add' | 'retire'; approvalId: string }>();
    for (const [id, approvalId] of adding) open.set(id, { kind: 'add', approvalId });
    for (const [id, approvalId] of retiring) open.set(id, { kind: 'retire', approvalId });
    const closed = await this.approvals.requestsIn(
      tx,
      rows.flatMap((r) => (r.approvalRequestId ? [r.approvalRequestId] : [])),
    );
    return rows.map((r) => {
      // A request rejected, withdrawn or expired leaves its account rejected; the row records
      // only what was asked, and the decision lives with the request.
      const requestStatus = r.approvalRequestId
        ? closed.get(r.approvalRequestId)?.status
        : undefined;
      const status: SettlementAccountStatus =
        r.status === 'awaiting_approval' &&
        requestStatus &&
        ['rejected', 'cancelled', 'expired'].includes(requestStatus)
          ? 'rejected'
          : (r.status as SettlementAccountStatus);
      return {
        id: r.id,
        holder: r.holder as 'owner' | 'agency',
        ownerId: r.ownerId,
        ownerName: r.ownerId ? (owners.get(r.ownerId)?.name ?? null) : null,
        bankCode: r.bankCode,
        bankName: r.bankName,
        branch: r.branch,
        accountNameChecked: r.accountNameChecked,
        accountName: r.accountName,
        numberMasked: r.numberMasked,
        status: SETTLEMENT_ACCOUNT_STATUSES.includes(status) ? status : 'awaiting_approval',
        usableFrom: r.usableFrom,
        providerReady: ready.has(r.id),
        createdAt: r.createdAt,
        approvalId: r.approvalRequestId,
        openRequest: open.get(r.id) ?? null,
      };
    });
  }

  approval(actor: Actor | null, id: string): Promise<ApprovalView> {
    return this.approvals.get(actor, id);
  }
}

export type { StaffActor };
