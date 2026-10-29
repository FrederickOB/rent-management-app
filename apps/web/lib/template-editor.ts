import {
  checkTemplateContent,
  PLACEHOLDERS,
  placeholdersIn,
  type TemplateClause,
  type TemplateContent,
  type TemplateSection,
} from '@rent/domain/tenancy';
import { domainProblem } from './register-format';

// The lease template editor (TL-05; M3 plan 4.5, decision 3): sections of clauses with plain-text
// bodies and placeholders from a fixed list. Every change returns new content; publishing it
// makes a new version, and earlier versions never change. Required clauses stay; clauses marked
// not editable keep their wording, which comes from the lease's data or from counsel.

export type Content = TemplateContent;

const KEY = /^[a-z][a-z0-9_]{1,40}$/;

function keysOf(content: Content): Set<string> {
  const keys = new Set<string>();
  for (const section of content.sections) {
    keys.add(section.key);
    for (const clause of section.clauses) keys.add(clause.key);
  }
  return keys;
}

/** A key for a new section or clause from its title: `Use of the garden` is `use_of_the_garden`. */
export function keyFrom(title: string, content: Content, fallback = 'clause'): string {
  const taken = keysOf(content);
  let base = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 36);
  if (!/^[a-z]/.test(base)) base = `${fallback}_${base}`.replace(/_+$/, '');
  if (!KEY.test(base)) base = fallback;
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base}_${n}`;
  return key;
}

const mapClauses = (
  content: Content,
  change: (clauses: readonly TemplateClause[], section: TemplateSection) => TemplateClause[],
): Content => ({
  sections: content.sections.map((section) => ({
    ...section,
    clauses: change(section.clauses, section),
  })),
});

export function findClause(content: Content, clauseKey: string): TemplateClause | undefined {
  for (const section of content.sections) {
    const found = section.clauses.find((c) => c.key === clauseKey);
    if (found) return found;
  }
  return undefined;
}

/** A new clause at the end of a section; companies' own clauses are optional and editable. */
export function addClause(content: Content, sectionKey: string, title: string): Content {
  const key = keyFrom(title, content);
  const clause: TemplateClause = {
    key,
    title: title.trim() || null,
    body: '',
    required: false,
    editable: true,
  };
  return {
    sections: content.sections.map((section) =>
      section.key === sectionKey ? { ...section, clauses: [...section.clauses, clause] } : section,
    ),
  };
}

/** Changes a clause's title or body. A clause that is not editable keeps its wording. */
export function updateClause(
  content: Content,
  clauseKey: string,
  patch: { readonly title?: string; readonly body?: string },
): Content {
  return mapClauses(content, (clauses) =>
    clauses.map((clause) => {
      if (clause.key !== clauseKey || !clause.editable) return clause;
      return {
        ...clause,
        ...(patch.title !== undefined ? { title: patch.title.trim() ? patch.title : null } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
      };
    }),
  );
}

/** Removes a clause; required clauses (parties, premises, term, rent, service, signatures) stay. */
export function removeClause(content: Content, clauseKey: string): Content {
  return mapClauses(content, (clauses) =>
    clauses.filter((clause) => clause.key !== clauseKey || clause.required),
  );
}

/** Moves a clause up or down within its section. */
export function moveClause(content: Content, clauseKey: string, by: -1 | 1): Content {
  return mapClauses(content, (clauses) => {
    const index = clauses.findIndex((c) => c.key === clauseKey);
    const target = index + by;
    if (index < 0 || target < 0 || target >= clauses.length) return [...clauses];
    const next = [...clauses];
    [next[index], next[target]] = [next[target]!, next[index]!];
    return next;
  });
}

export function addSection(content: Content, heading: string): Content {
  const key = keyFrom(heading, content, 'section');
  return { sections: [...content.sections, { key, heading: heading.trim(), clauses: [] }] };
}

export function renameSection(content: Content, sectionKey: string, heading: string): Content {
  return {
    sections: content.sections.map((s) => (s.key === sectionKey ? { ...s, heading } : s)),
  };
}

/** Removes a section that holds no required clause. */
export function removeSection(content: Content, sectionKey: string): Content {
  return {
    sections: content.sections.filter(
      (s) => s.key !== sectionKey || s.clauses.some((c) => c.required),
    ),
  };
}

/** Placeholders in a body that are not on the fixed list; the API refuses a version with any. */
export function unknownPlaceholders(body: string): string[] {
  return [...new Set(placeholdersIn(body).filter((name) => !Object.hasOwn(PLACEHOLDERS, name)))];
}

/** Why the content cannot be published, in the domain's words, or null when it can. */
export function contentProblem(content: Content): string | null {
  return domainProblem(() => checkTemplateContent(content));
}

export function sameContent(a: Content, b: Content): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** `{{tenant.name}}`, ready to paste into a clause. */
export const placeholderToken = (name: string): string => `{{${name}}}`;

/** The content as the API takes it: the same sections and clauses, in plain arrays. */
export function forApi(content: Content) {
  return {
    sections: content.sections.map((section) => ({
      key: section.key,
      heading: section.heading,
      clauses: section.clauses.map((clause) => ({ ...clause })),
    })),
  };
}
