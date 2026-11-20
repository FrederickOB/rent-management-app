import { oc } from '@orpc/contract';
import { AGE_BUCKETS } from '@rent/domain/billing';
import {
  ONBOARDING_BATCH_KINDS,
  ONBOARDING_BATCH_STATUSES,
  ONBOARDING_IMPORT_MAX_BYTES,
  ONBOARDING_STEPS,
} from '@rent/domain/onboarding';
import { z } from 'zod';

/**
 * Pilot onboarding (M11 decisions 2 and 3; P25). One screen, three steps, each with a preview
 * before anything is written:
 * 1. the register: properties, units and (for agencies) owners, through the register import
 *    (`registerImports`, which gains an Owners sheet);
 * 2. tenancies: Tenants and Leases, recorded as paper leases (a scan may follow);
 * 3. opening balances: Arrears, Advances, Deposits, Withholding and Owner items, dated the
 *    company's cut-over, previewed per lease and committed through a second person.
 * Corrections after commit come from an adjustment workbook of signed changes, with the same
 * preview and approval. An import never messages tenants. For company admins and unscoped
 * managers (`onboarding.import`). Amounts are integer pesewas; dates `YYYY-MM-DD`.
 */
const uuid = z.string().uuid();
const iso = z.string().datetime();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date such as 2026-11-01');
const minor = z.number().int();
const named = z.object({ id: uuid, name: z.string() });
const byKeys = <K extends readonly [string, ...string[]]>(keys: K) =>
  z.object(Object.fromEntries(keys.map((k) => [k, minor])) as { [P in K[number]]: typeof minor });

const presignedUpload = z.object({
  uploadId: uuid,
  url: z.string().url(),
  fields: z.record(z.string(), z.string()),
  expiresAt: iso,
});

const issueSchema = z.object({
  sheet: z.string(),
  row: z.number().int().nullable(),
  column: z.string().nullable(),
  message: z.string(),
});

const counts = z.object({ create: minor, update: minor, unchanged: minor });

/** The onboarding screen's state. */
export const onboardingStateSchema = z.object({
  /**
   * The cut-over date: every opening entry is dated it. On or before the day it is set; fixed once
   * opening balances are posted.
   */
  cutOverDate: isoDate.nullable(),
  cutOverFixed: z.boolean(),
  steps: z.array(
    z.object({
      step: z.enum(ONBOARDING_STEPS),
      status: z.enum(['not_started', 'in_progress', 'done']),
      /** The latest batch of the step (for `register`, the latest register import). */
      lastBatchId: uuid.nullable(),
    }),
  ),
  /** Imported leases whose scan is still to follow (decision 2). */
  leasesMissingScan: minor,
});
export type OnboardingState = z.infer<typeof onboardingStateSchema>;

/** A tenancies, balances or adjustment batch, with its validation report. */
export const onboardingBatchSchema = z.object({
  id: uuid,
  kind: z.enum(ONBOARDING_BATCH_KINDS),
  status: z.enum(ONBOARDING_BATCH_STATUSES),
  fileName: z.string().nullable(),
  cutOverDate: isoDate.nullable(),
  report: z
    .object({
      sha256: z.string(),
      /** Per sheet: what a commit would create, update or leave unchanged. */
      counts: z.record(z.string(), counts),
      issues: z.array(issueSchema),
      issueCount: minor,
      /** For balances and adjustments: the money a commit posts, in total. */
      totals: z
        .object({
          arrearsMinor: minor,
          advancesMinor: minor,
          depositsMinor: minor,
          withholdingMinor: minor,
          agentCashMinor: minor,
          rentTaxOutstandingMinor: minor,
        })
        .nullable(),
    })
    .nullable(),
  /** For balances and adjustments: the second person's approval (`opening_balances`). */
  approval: z
    .object({
      requestId: uuid,
      status: z.string(),
      /** OQ-29: a single-user company confirms after the cooling-off, from this instant. */
      selfConfirmFrom: iso.nullable(),
    })
    .nullable(),
  createdBy: named.nullable(),
  createdAt: iso,
  committedAt: iso.nullable(),
  postedAt: iso.nullable(),
  /** Why a batch failed (the file missing, a job giving up, the records changed since the check). */
  error: z.string().nullable().optional(),
});
export type OnboardingBatchView = z.infer<typeof onboardingBatchSchema>;

/**
 * One lease as the landlord will see it after commit (decision 3), to check against their own
 * records: what is owed and its age, paid-until, the deposit held and withholding still to be
 * certified. For an adjustment, `before` holds the figures today.
 */
const leaseFigures = z.object({
  /** Owed now: opening arrears less what has been paid of them. */
  arrearsMinor: minor,
  arrearsByAge: byKeys(AGE_BUCKETS),
  /** Paid ahead and not yet drawn (2010). */
  advanceMinor: minor,
  /** The last day the rent is paid to; null when nothing is paid ahead. */
  paidUntil: isoDate.nullable(),
  depositHeldMinor: minor,
  withholdingOutstandingMinor: minor,
  /** Arrears less what is paid ahead: positive owes, negative is in credit. */
  balanceMinor: minor,
});

export const onboardingPreviewSchema = z.object({
  batchId: uuid,
  cutOverDate: isoDate,
  leases: z.array(
    z.object({
      leaseId: uuid,
      unitCode: z.string(),
      tenantName: z.string(),
      owner: named,
      after: leaseFigures,
      /** For an adjustment: the figures today. */
      before: leaseFigures.nullable(),
    }),
  ),
  owners: z.array(
    z.object({
      owner: named,
      leases: minor,
      arrearsMinor: minor,
      advancesMinor: minor,
      depositsHeldMinor: minor,
      withholdingOutstandingMinor: minor,
      /** Owner items. */
      agentCashMinor: minor,
      rentTaxOutstandingMinor: minor,
      rentTaxDueOn: isoDate.nullable(),
    }),
  ),
});
export type OnboardingPreview = z.infer<typeof onboardingPreviewSchema>;

export const onboardingContract = {
  get: oc
    .route({ method: 'GET', path: '/onboarding', summary: 'The onboarding steps and the cut-over' })
    .output(onboardingStateSchema),
  setCutOver: oc
    .route({
      method: 'PUT',
      path: '/onboarding/cut-over',
      summary:
        'Set the cut-over date (on or before today). 409 CUT_OVER_FIXED once opening balances are posted',
    })
    .input(z.object({ cutOverDate: isoDate }))
    .output(onboardingStateSchema),
  /** Step 1 (M11 backend): the register import's template with an Owners sheet first. */
  registerTemplate: oc
    .route({
      method: 'GET',
      path: '/onboarding/register-template',
      summary:
        'Step 1: the register import template (PR-08) with an Owners sheet first, for agencies; upload it through registerImports',
    })
    .output(z.file()),
  template: oc
    .route({
      method: 'GET',
      path: '/onboarding/templates/{kind}',
      summary: 'The workbook template for tenancies, balances or an adjustment, with a Lists sheet',
    })
    .input(z.object({ kind: z.enum(ONBOARDING_BATCH_KINDS) }))
    .output(z.file()),
  createUpload: oc
    .route({ method: 'POST', path: '/onboarding/batches/uploads' })
    .input(
      z.object({
        kind: z.enum(ONBOARDING_BATCH_KINDS),
        sizeBytes: z.number().int().positive().max(ONBOARDING_IMPORT_MAX_BYTES),
        fileName: z.string().trim().max(200).optional(),
      }),
    )
    .output(z.object({ batchId: uuid, upload: presignedUpload })),
  validate: oc
    .route({
      method: 'POST',
      path: '/onboarding/batches/{batchId}/validate',
      summary:
        'The dry run: every problem by sheet, row and column, and the counts; nothing is written. 409 STEP_ORDER when an earlier step is missing (leases need their units; balances their leases)',
    })
    .input(z.object({ batchId: uuid }))
    .output(onboardingBatchSchema),
  batches: oc
    .route({ method: 'GET', path: '/onboarding/batches', summary: 'Batches, newest first' })
    .input(z.object({ kind: z.enum(ONBOARDING_BATCH_KINDS).optional() }))
    .output(z.array(onboardingBatchSchema)),
  batch: oc
    .route({ method: 'GET', path: '/onboarding/batches/{batchId}' })
    .input(z.object({ batchId: uuid }))
    .output(onboardingBatchSchema),
  preview: oc
    .route({
      method: 'GET',
      path: '/onboarding/batches/{batchId}/preview',
      summary:
        'Balances and adjustments: each lease as it will be after commit, with totals per owner. 409 NOT_VALIDATED',
    })
    .input(z.object({ batchId: uuid }))
    .output(onboardingPreviewSchema),
  commit: oc
    .route({
      method: 'POST',
      path: '/onboarding/batches/{batchId}/commit',
      summary:
        'Tenancies: written at once, never messaging a tenant. Balances and adjustments: a second person is asked (`opening_balances`); they post once approved. 409 HAS_ISSUES, NOT_VALIDATED, CUT_OVER_MISSING. Requires an Idempotency-Key',
    })
    .input(z.object({ batchId: uuid }))
    .output(onboardingBatchSchema),
  attachScan: oc
    .route({
      method: 'POST',
      path: '/onboarding/leases/{leaseId}/scan',
      summary:
        'Attach the scan to an imported paper lease (an upload from `leases.createUpload`). 409 SCAN_PRESENT',
    })
    .input(z.object({ leaseId: uuid, scanUploadId: uuid }))
    .output(z.object({ leaseId: uuid, scanDocumentId: uuid })),
  leasesMissingScan: oc
    .route({
      method: 'GET',
      path: '/onboarding/leases-missing-scan',
      summary: 'Imported paper leases whose scan is still to follow',
    })
    .output(
      z.array(
        z.object({
          leaseId: uuid,
          unitCode: z.string(),
          tenantName: z.string(),
          startDate: isoDate,
          importedAt: iso,
        }),
      ),
    ),
};
