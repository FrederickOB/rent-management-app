import { createTemplateDatabase, dropDatabase } from '@rent/db/testing';
import type { TestProject } from 'vitest/node';
import { installJobSchema } from '../../src/core/jobs/install';

declare module 'vitest' {
  export interface ProvidedContext {
    templateDatabase: string;
  }
}

let template: string | undefined;

export async function setup(project: TestProject) {
  template = await createTemplateDatabase('server', installJobSchema);
  project.provide('templateDatabase', template);
}

export async function teardown() {
  if (template) await dropDatabase(template);
}
