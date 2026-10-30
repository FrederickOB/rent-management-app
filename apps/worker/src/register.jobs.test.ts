import type { JobContext, JobDefinition } from '@rent/server/jobs';
import {
  COMMIT_IMPORT_JOB,
  VALIDATE_IMPORT_JOB,
  type PropertyFilesService,
  type RegisterImportService,
} from '@rent/server/portfolio';
import { describe, expect, it, vi } from 'vitest';
import { registerJobs } from './register.jobs';

const companyId = '01960000-0000-7000-8000-000000000001';
const importId = '01960000-0000-7000-8000-000000000002';
const ownerId = '01960000-0000-7000-8000-000000000003';
const scope = { ownerIds: [ownerId], propertyIds: [] };

function setup() {
  const imports = {
    validate: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    validationAbandoned: vi.fn(async () => undefined),
    commitAbandoned: vi.fn(async () => undefined),
  };
  const jobs = registerJobs({
    propertyFiles: {} as PropertyFilesService,
    imports: imports as unknown as RegisterImportService,
  }) as unknown as JobDefinition<Record<string, unknown>>[];
  const job = (name: string) => jobs.find((j) => j.name === name)!;
  return { imports, job };
}

const context = {} as JobContext;
const logger = { logger: {} as JobContext['logger'] };

describe('AD-02 import scope in the worker', () => {
  it('runs the check and the commit with the scope their payload carries', async () => {
    const { imports, job } = setup();
    const validate = job(VALIDATE_IMPORT_JOB);
    await validate.handle(validate.schema.parse({ companyId, importId, scope }), context);
    expect(imports.validate).toHaveBeenCalledWith(companyId, importId, { scope });
    const commit = job(COMMIT_IMPORT_JOB);
    await commit.handle(
      commit.schema.parse({ companyId, importId, attempt: 1_761_700_000_000, scope: null }),
      context,
    );
    expect(imports.commit).toHaveBeenCalledWith(companyId, importId, {
      attempt: 1_761_700_000_000,
      scope: null,
    });
  });

  it('refuses a payload that lost its scope or its attempt, rather than running unscoped', () => {
    const { job } = setup();
    expect(job(VALIDATE_IMPORT_JOB).schema.safeParse({ companyId, importId }).success).toBe(false);
    expect(
      job(COMMIT_IMPORT_JOB).schema.safeParse({ companyId, importId, scope: null }).success,
    ).toBe(false);
  });
});

describe('PR-08 import jobs that give up', () => {
  it('mark the import failed after the last retry, for the check the commit followed', async () => {
    const { imports, job } = setup();
    const commit = job(COMMIT_IMPORT_JOB);
    await commit.onDeadLetter!(
      commit.schema.parse({ companyId, importId, attempt: 42, scope }),
      logger,
    );
    expect(imports.commitAbandoned).toHaveBeenCalledWith(companyId, importId, 42);
    const validate = job(VALIDATE_IMPORT_JOB);
    await validate.onDeadLetter!(validate.schema.parse({ companyId, importId, scope }), logger);
    expect(imports.validationAbandoned).toHaveBeenCalledWith(companyId, importId);
  });
});
