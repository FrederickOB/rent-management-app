import { defineJob, type JobDefinition } from '@rent/server/jobs';
import {
  ONBOARDING_COMMIT_JOB,
  ONBOARDING_POST_JOB,
  ONBOARDING_VALIDATE_JOB,
  type OnboardingService,
} from '@rent/server/onboarding';
import { z } from 'zod';

/** Outbox event types onboarding's jobs consume (M11 decisions 2 and 3; plan 4.14). */
export const ONBOARDING_EVENT_TYPES = [
  ONBOARDING_VALIDATE_JOB,
  ONBOARDING_COMMIT_JOB,
  ONBOARDING_POST_JOB,
] as const;

const uuid = z.string().uuid();
const forValidation = z
  .object({ companyId: uuid, batchId: uuid, validationId: uuid })
  .passthrough();
const forPosting = z.object({ companyId: uuid, batchId: uuid }).passthrough();

/**
 * Onboarding's jobs (plan 4.14). Each is idempotent: a dry run is keyed on its batch and
 * validation, a tenancies commit on the validation it follows, the posting of opening balances on
 * the batch after its approval; a job that finds its batch already moved on does nothing. Each
 * write is one transaction, so a job that fails its last retry has written nothing, and marks the
 * batch failed so it can be checked again.
 */
export function onboardingJobs(deps: {
  readonly onboarding: OnboardingService;
}): JobDefinition<never>[] {
  return [
    defineJob({
      name: ONBOARDING_VALIDATE_JOB,
      scope: 'company',
      schema: forValidation,
      retry: { limit: 3, delaySeconds: 30, backoff: true },
      handle: ({ companyId, batchId, validationId }) =>
        deps.onboarding.validate(companyId, batchId, validationId),
      onDeadLetter: ({ companyId, batchId, validationId }) =>
        deps.onboarding.validationAbandoned(companyId, batchId, validationId),
    }),
    defineJob({
      name: ONBOARDING_COMMIT_JOB,
      scope: 'company',
      schema: forValidation,
      retry: { limit: 3, delaySeconds: 60, backoff: true },
      handle: ({ companyId, batchId, validationId }) =>
        deps.onboarding.commitTenancies(companyId, batchId, validationId),
      onDeadLetter: ({ companyId, batchId, validationId }) =>
        deps.onboarding.commitAbandoned(companyId, batchId, validationId),
    }),
    defineJob({
      name: ONBOARDING_POST_JOB,
      scope: 'company',
      schema: forPosting,
      // An owner statement being issued at that moment refuses the posting (409, M9 review): the
      // retry posts in the open month.
      retry: { limit: 5, delaySeconds: 60, backoff: true },
      async handle({ companyId, batchId }) {
        await deps.onboarding.postBalances(companyId, batchId);
      },
      onDeadLetter: ({ companyId, batchId }) => deps.onboarding.postAbandoned(companyId, batchId),
    }),
  ] as JobDefinition<never>[];
}
