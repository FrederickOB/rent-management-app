import { defineJob, type JobDefinition } from '@rent/server/jobs';
import {
  COMMIT_IMPORT_JOB,
  PROCESS_PROPERTY_FILE_JOB,
  VALIDATE_IMPORT_JOB,
  type PropertyFilesService,
  type RegisterImportService,
} from '@rent/server/portfolio';
import { z } from 'zod';

/** Outbox event types the register's jobs consume (M2). */
export const REGISTER_EVENT_TYPES = [
  PROCESS_PROPERTY_FILE_JOB,
  VALIDATE_IMPORT_JOB,
  COMMIT_IMPORT_JOB,
] as const;

/**
 * The scope of the person who started an import (AD-02), null for the whole company. Required,
 * so a job that lost it fails rather than running unscoped.
 */
const scope = z
  .object({ ownerIds: z.array(z.string().uuid()), propertyIds: z.array(z.string().uuid()) })
  .nullable();

const forValidation = z
  .object({ companyId: z.string().uuid(), importId: z.string().uuid(), scope })
  .passthrough();

const forCommit = z
  .object({
    companyId: z.string().uuid(),
    importId: z.string().uuid(),
    /** The check the commit follows (its validatedAt in milliseconds). */
    attempt: z.number().int().positive(),
    scope,
  })
  .passthrough();

/**
 * The register's jobs (M2 plan 4.7 and 4.9). Each is idempotent: a processed file, a checked
 * import and a committed import are left as they are when a job runs again. An import job that
 * fails its last retry marks the import failed, so the person can start again.
 */
export function registerJobs(deps: {
  readonly propertyFiles: PropertyFilesService;
  readonly imports: RegisterImportService;
}): JobDefinition<never>[] {
  return [
    defineJob({
      name: PROCESS_PROPERTY_FILE_JOB,
      scope: 'company',
      schema: z
        .object({ companyId: z.string().uuid(), propertyFileId: z.string().uuid() })
        .passthrough(),
      retry: { limit: 5, delaySeconds: 30, backoff: true },
      handle: ({ companyId, propertyFileId }) =>
        deps.propertyFiles.process(companyId, propertyFileId),
    }),
    defineJob({
      name: VALIDATE_IMPORT_JOB,
      scope: 'company',
      schema: forValidation,
      retry: { limit: 3, delaySeconds: 30, backoff: true },
      handle: ({ companyId, importId, scope }) =>
        deps.imports.validate(companyId, importId, { scope }),
      onDeadLetter: ({ companyId, importId }) =>
        deps.imports.validationAbandoned(companyId, importId),
    }),
    defineJob({
      name: COMMIT_IMPORT_JOB,
      scope: 'company',
      schema: forCommit,
      retry: { limit: 3, delaySeconds: 60, backoff: true },
      handle: ({ companyId, importId, attempt, scope }) =>
        deps.imports.commit(companyId, importId, { attempt, scope }),
      onDeadLetter: ({ companyId, importId, attempt }) =>
        deps.imports.commitAbandoned(companyId, importId, attempt),
    }),
  ] as JobDefinition<never>[];
}
