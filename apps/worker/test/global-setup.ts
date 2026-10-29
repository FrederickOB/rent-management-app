import { createTemplateDatabase, dropDatabase } from '@rent/db/testing';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    templateDatabase: string;
  }
}

let template: string | undefined;

export async function setup(project: TestProject) {
  template = await createTemplateDatabase('worker');
  project.provide('templateDatabase', template);
}

export async function teardown() {
  if (template) await dropDatabase(template);
}
