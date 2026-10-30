import { oc } from '@orpc/contract';
import { RENT_DESTINATIONS, SETTLEMENT_ACCOUNT_STATUSES } from '@rent/domain/payments';
import { z } from 'zod';
import { approvalSchema } from './approvals';

/**
 * Provider payments (BC-02 to BC-04, BC-06, BC-09, BC-12; M4b plan 4.2 to 4.11). Amounts are
 * integer pesewas in `*Minor` fields. Money writes take an `Idempotency-Key` header, as in M4a.
 * The pay page's own API, like the signing pages', is called server to server by apps/links with
 * the links key; a token is the only authorisation for the page.
 */
const uuid = z.string().uuid();
const iso = z.string().datetime();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date such as 2026-11-01');
const minor = z.number().int();
const token = z.string().max(64);
const client = z
  .object({ ip: z.string().trim().min(1).max(64), userAgent: z.string().max(500) })
  .strict();
const download = z.object({ url: z.string() });

/** Ghana's MoMo networks, as the pay page offers them. */
export const MOMO_NETWORKS = ['mtn', 'telecel', 'at'] as const;
export const MOMO_NETWORK_LABELS: Record<(typeof MOMO_NETWORKS)[number], string> = {
  mtn: 'MTN MoMo',
  telecel: 'Telecel Cash',
  at: 'AT Money',
};
export const INTENT_STATUSES = [
  'initiated',
  'pending',
  'confirmed',
  'failed',
  'abandoned',
] as const;

export const PAY_SCREENS = ['pay', 'paid', 'settled', 'expired', 'revoked', 'unavailable'] as const;

export const payPageSchema = z.object({
  /**
   * `pay` takes a payment; `paid` follows one; `settled` means nothing is due on the invoice;
   * `unavailable` means the landlord cannot take payments now (no usable settlement destination,
   * or every provider is down), with their own payment instructions.
   */
  screen: z.enum(PAY_SCREENS),
  landlord: z.object({
    name: z.string(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    /** Their own instructions, for when online payment is unavailable. */
    manualInstructions: z.string().nullable(),
  }),
  timeZone: z.string(),
  linkExpiresAt: iso,
  tenantName: z.string(),
  unitCode: z.string(),
  propertyName: z.string(),
  paymentReference: z.string(),
  invoiceNumber: z.string(),
  /** Due now on the lease: this invoice and anything older, since payments pay the oldest first. */
  dueNowMinor: minor,
  paidUntil: isoDate.nullable(),
  partial: z.object({ monthStart: isoDate, amountMinor: minor }).nullable(),
  amounts: z.object({ prefillMinor: minor, minMinor: minor, maxMinor: minor }),
  methods: z.array(z.enum(['momo', 'card'])),
  /** The latest payment started from this link, if any. */
  latest: z
    .object({
      intentId: uuid,
      status: z.enum(INTENT_STATUSES),
      amountMinor: minor,
      receiptNumber: z.string().nullable(),
      message: z.string().nullable(),
    })
    .nullable(),
});
export type PayPage = z.infer<typeof payPageSchema>;

const intentSchema = z.object({
  intentId: uuid,
  status: z.enum(INTENT_STATUSES),
  amountMinor: minor,
  /** Card payments continue on the provider's checkout page. */
  checkoutUrl: z.string().url().nullable(),
  /** For example "Approve the payment on your phone". */
  message: z.string().nullable(),
  receiptNumber: z.string().nullable(),
});

export const payLinksContract = {
  open: oc
    .route({
      method: 'POST',
      path: '/links/pay/open',
      summary: 'Open a pay link: what is due, and what may be paid (BC-04)',
    })
    .input(z.object({ token, client }).strict())
    .output(payPageSchema),
  start: oc
    .route({
      method: 'POST',
      path: '/links/pay/intents',
      summary:
        'Start a payment: a MoMo approval prompt to the number given, or a card checkout. A double tap creates one charge.',
    })
    .input(
      z
        .object({
          token,
          client,
          amountMinor: z.number().int().positive(),
          method: z.enum(['momo', 'card']),
          momo: z
            .object({ phone: z.string().trim().max(24), network: z.enum(MOMO_NETWORKS) })
            .strict()
            .nullable()
            .optional(),
          /** From the form, so a resubmitted form finds the same intent. */
          submissionId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
        })
        .strict(),
    )
    .output(intentSchema),
  status: oc
    .route({
      method: 'POST',
      path: '/links/pay/status',
      summary: 'A payment’s status, checked with the provider when it is still pending',
    })
    .input(z.object({ token, client, intentId: uuid }).strict())
    .output(intentSchema),
};

export const settlementAccountSchema = z.object({
  id: uuid,
  holder: z.enum(['owner', 'agency']),
  ownerId: uuid.nullable(),
  ownerName: z.string().nullable(),
  bankCode: z.string(),
  bankName: z.string(),
  branch: z.string().nullable(),
  /** The name the provider returned for the account, where it can check. */
  accountNameChecked: z.string().nullable(),
  accountName: z.string(),
  numberMasked: z.string(),
  status: z.enum(SETTLEMENT_ACCOUNT_STATUSES),
  usableFrom: iso.nullable(),
  /** Set up with the provider as a subaccount. */
  providerReady: z.boolean(),
  createdAt: iso,
  approvalId: uuid.nullable(),
});
export type SettlementAccountView = z.infer<typeof settlementAccountSchema>;

export const managementAgreementSchema = z.object({
  ownerId: uuid,
  ownerName: z.string(),
  destination: z.enum(RENT_DESTINATIONS).nullable(),
  effectiveFrom: isoDate.nullable(),
});

export const settlementContract = {
  banks: oc
    .route({ method: 'GET', path: '/banks', summary: 'Banks the provider settles to (ADR-008)' })
    .output(z.array(z.object({ code: z.string(), name: z.string() }))),
  list: oc
    .route({ method: 'GET', path: '/settlement-accounts' })
    .output(z.array(settlementAccountSchema)),
  request: oc
    .route({
      method: 'POST',
      path: '/settlement-accounts',
      summary:
        'Ask to add a bank account rent settles to: a second person approves, it is usable 24 hours later, and the owner is told (ADR-008)',
    })
    .input(
      z.object({
        holder: z.enum(['owner', 'agency']),
        ownerId: uuid.nullable().optional(),
        bankCode: z.string().trim().min(2).max(20),
        branch: z.string().trim().max(120).nullable().optional(),
        accountNumber: z
          .string()
          .trim()
          .regex(/^\d{6,20}$/, 'Enter the account number, digits only'),
        accountName: z.string().trim().min(2).max(160),
      }),
    )
    .output(z.object({ account: settlementAccountSchema, approval: approvalSchema })),
  retire: oc
    .route({
      method: 'POST',
      path: '/settlement-accounts/{accountId}/retire',
      summary: 'Ask to stop settling to an account; a second person approves',
    })
    .input(z.object({ accountId: uuid, reason: z.string().trim().min(5).max(500) }))
    .output(z.object({ approval: approvalSchema })),
  agreements: oc
    .route({
      method: 'GET',
      path: '/management-agreements',
      summary: 'Where each owner’s rent goes, for an agency (M4b decision 6)',
    })
    .output(z.array(managementAgreementSchema)),
  setAgreement: oc
    .route({ method: 'PUT', path: '/owners/{ownerId}/management-agreement' })
    .input(
      z.object({
        ownerId: uuid,
        destination: z.enum(RENT_DESTINATIONS),
        effectiveFrom: isoDate,
      }),
    )
    .output(managementAgreementSchema),
};

export const suggestionSchema = z.object({
  leaseId: uuid,
  tenantName: z.string(),
  unitCode: z.string(),
  score: z.number().int(),
  reasons: z.array(
    z.enum([
      'amount_is_due_now',
      'amount_is_an_invoice',
      'amount_is_a_month',
      'phone_is_tenant',
      'phone_paid_before',
      'near_due_date',
      'name_matches',
    ]),
  ),
});

export const reconciliationExceptionSchema = z.object({
  id: uuid,
  kind: z.enum([
    'missing_here',
    'missing_at_provider',
    'amount_differs',
    'not_successful_at_provider',
    'settlement_difference',
    'verified_amount_differs',
    'receipt_late',
  ]),
  provider: z.string(),
  reference: z.string().nullable(),
  settlementId: z.string().nullable(),
  /** Plain words for a manager. Never a phone number, email or account number. */
  detail: z.string(),
  amountMinor: minor.nullable(),
  createdAt: iso,
  resolvedAt: iso.nullable(),
  resolutionNote: z.string().nullable(),
});

export const paymentsQueueContract = {
  suggestions: oc
    .route({
      method: 'GET',
      path: '/unmatched-receipts/{paymentId}/suggestions',
      summary: 'Leases this money may belong to, ranked; a person confirms (BC-12)',
    })
    .input(z.object({ paymentId: uuid }))
    .output(z.array(suggestionSchema)),
  refund: oc
    .route({
      method: 'POST',
      path: '/unmatched-receipts/{paymentId}/refund',
      summary:
        'Ask to refund money that belongs to no lease to its payer; a second person approves (P31)',
    })
    .input(
      z.object({
        paymentId: uuid,
        reason: z.string().trim().min(5).max(500),
        /** Proof for a transfer refunded outside the provider. */
        proofUploadId: uuid.nullable().optional(),
      }),
    )
    .output(z.object({ approval: approvalSchema })),
  exceptions: oc
    .route({
      method: 'GET',
      path: '/reconciliation/exceptions',
      summary: 'What reconciliation could not explain, for a person (CLAUDE.md section 8)',
    })
    .input(z.object({ open: z.stringbool().optional() }))
    .output(z.array(reconciliationExceptionSchema)),
  resolveException: oc
    .route({ method: 'POST', path: '/reconciliation/exceptions/{exceptionId}/resolve' })
    .input(z.object({ exceptionId: uuid, note: z.string().trim().min(5).max(500) }))
    .output(reconciliationExceptionSchema),
  sendPayLink: oc
    .route({
      method: 'POST',
      path: '/invoices/{invoiceId}/pay-link',
      summary: 'Send the tenant a pay link by SMS or email, where consent is recorded (BC-04)',
    })
    .input(z.object({ invoiceId: uuid }))
    .output(
      z.object({
        channels: z.array(z.enum(['sms', 'email'])),
        /** Why nothing went: no consent, or no usable settlement destination. */
        notSentReason: z.string().nullable(),
      }),
    ),
};

/** The tenant app's money (TL-01, BC-04; M4b plan 4.10). */
export const tenantBillingSchema = z.object({
  leaseId: uuid,
  landlordName: z.string(),
  unitCode: z.string(),
  paymentReference: z.string().nullable(),
  dueNowMinor: minor,
  paidUntil: isoDate.nullable(),
  partial: z.object({ monthStart: isoDate, amountMinor: minor }).nullable(),
  creditMinor: minor,
  nextDue: z.object({ dueDate: isoDate, amountMinor: minor }).nullable(),
  /** Whether "Pay" works now; when not, why, in plain words. */
  canPay: z.boolean(),
  cannotPayReason: z.string().nullable(),
  fetchedAt: iso,
});

export const tenantPaymentSchema = z.object({
  id: uuid,
  leaseId: uuid,
  landlordName: z.string(),
  amountMinor: minor,
  receivedOn: isoDate,
  method: z.string(),
  status: z.enum(['confirmed', 'reversed']),
  receiptId: uuid.nullable(),
  receiptNumber: z.string().nullable(),
});

export const tenantMoneyContract = {
  billing: oc
    .route({
      method: 'GET',
      path: '/me/leases/{leaseId}/billing',
      summary: 'The tenant’s own balance, paid-until and next due date',
    })
    .input(z.object({ leaseId: uuid }))
    .output(tenantBillingSchema),
  payments: oc
    .route({ method: 'GET', path: '/me/payments', summary: 'The tenant’s own payments' })
    .output(z.array(tenantPaymentSchema)),
  receiptDownload: oc
    .route({
      method: 'GET',
      path: '/me/receipts/{receiptId}/download',
      summary: 'A 5-minute link to the tenant’s own receipt',
    })
    .input(z.object({ receiptId: uuid }))
    .output(download),
  payLink: oc
    .route({
      method: 'POST',
      path: '/me/leases/{leaseId}/pay-link',
      summary:
        'A fresh pay link for the tenant’s oldest open invoice, to open in the app’s browser',
    })
    .input(z.object({ leaseId: uuid }))
    .output(z.object({ url: z.string().url(), expiresAt: iso })),
};
