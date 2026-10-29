import { createElement, type ComponentType, type ReactElement } from 'react';
import type { z } from 'zod';
import type { Branding } from './branding';
import { DocumentError, describeIssues } from './errors';

export interface TemplateProps<Data> {
  readonly data: Data;
  readonly branding: Branding;
}

export interface TemplateDefinition<Schema extends z.ZodType> {
  /** Stable name stored with every document, for example `system.sample`. */
  readonly key: string;
  /**
   * A frozen document is its template version plus its data (ADR-006), so any change to what a
   * template shows is a new version and old versions stay registered.
   */
  readonly version: number;
  /** The document title PDF readers show. */
  readonly title: string;
  /** Strict, with no defaults or transforms, so the stored data is exactly what was rendered. */
  readonly schema: Schema;
  readonly Component: ComponentType<TemplateProps<z.output<Schema>>>;
}

/** A template with its types erased, so templates with different data can share a registry. */
export interface Template {
  readonly key: string;
  readonly version: number;
  readonly title: string;
  readonly schema: z.ZodType;
  /** Validates `data` and returns the element to render. Throws `invalid_data`. */
  element(data: unknown, branding: Branding): ReactElement;
}

const TEMPLATE_KEY = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;

export function defineTemplate<Schema extends z.ZodType>(
  definition: TemplateDefinition<Schema>,
): Template {
  const { key, version, title, schema, Component } = definition;
  if (!TEMPLATE_KEY.test(key)) {
    throw new DocumentError('invalid_template', `Template keys look like area.name, not ${key}`);
  }
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new DocumentError('invalid_template', `${key}: versions are positive integers`);
  }
  return Object.freeze({
    key,
    version,
    title,
    schema,
    element(data: unknown, branding: Branding): ReactElement {
      const parsed = schema.safeParse(data);
      if (!parsed.success) {
        throw new DocumentError(
          'invalid_data',
          `Data does not fit ${key} version ${version}`,
          describeIssues(parsed.error),
        );
      }
      return createElement(Component, { data: parsed.data, branding });
    },
  });
}

export class TemplateRegistry {
  private readonly templates = new Map<string, Template>();

  constructor(templates: readonly Template[] = []) {
    for (const template of templates) this.register(template);
  }

  register(template: Template): void {
    const id = `${template.key}@${template.version}`;
    if (this.templates.has(id)) {
      throw new DocumentError(
        'template_exists',
        `${template.key} version ${template.version} is already registered`,
      );
    }
    this.templates.set(id, template);
  }

  get(key: string, version: number): Template {
    const template = this.templates.get(`${key}@${version}`);
    if (!template) {
      throw new DocumentError('template_not_found', `No template ${key} version ${version}`);
    }
    return template;
  }

  list(): readonly { readonly key: string; readonly version: number; readonly title: string }[] {
    return [...this.templates.values()].map(({ key, version, title }) => ({ key, version, title }));
  }
}
