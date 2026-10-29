import type { TestProject } from 'vitest/node';
import { createTemplateDatabase, dropDatabase } from './index';

declare module 'vitest' {
  export interface ProvidedContext {
    templateDatabase: string;
  }
}

let template: string | undefined;

export async function setup(project: TestProject) {
  template = await createTemplateDatabase('db');
  project.provide('templateDatabase', template);
}

export async function teardown() {
  if (template) await dropDatabase(template);
}
