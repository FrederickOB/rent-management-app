import { DomainError } from '../errors';

/**
 * Lease templates as structured content (TL-05): sections of clauses with plain-text bodies and
 * placeholders from a fixed list, never free HTML. Placeholders are filled from the lease's
 * frozen data, so the document signers see is exactly what was rendered.
 */
export const PLACEHOLDERS = {
  'landlord.name': 'The landlord, or the owner the agency acts for',
  'agent.name': 'The managing agency, when there is one',
  'tenant.name': 'The tenant (a person or a company)',
  'tenant.phone': 'The tenant’s phone number',
  'tenant.email': 'The tenant’s email address',
  'tenant.signatories': 'A company tenant’s authorised signatories',
  'guarantor.name': 'The guarantor, when there is one',
  'property.name': 'The property',
  'property.address': 'The property’s address',
  'unit.code': 'The unit code, such as ACC-LEG-B2-04',
  'unit.description': 'The unit type and features',
  'lease.startDate': 'The first day of the lease',
  'lease.endDate': 'The last day of the lease',
  'lease.term': 'The length of the lease, exactly: 12 months, or 12 months and 6 days',
  'rent.monthly': 'The monthly rent, such as GH₵1,500.00',
  'rent.cycle': 'How often rent is billed',
  'rent.steps': 'The rent changes during the lease',
  'rent.initialAdvance': 'The months paid in advance at the start, if agreed',
  'deposit.amount': 'The security deposit',
  'serviceCharge.monthly': 'The monthly service charge',
  'notice.days': 'The contractual notice period, in days',
  'break.summary': 'The break clause, if any',
  'electronicService.contacts': 'The phone numbers and email the tenant agrees to be served at',
} as const;
export type Placeholder = keyof typeof PLACEHOLDERS;

export interface TemplateClause {
  readonly key: string;
  readonly title: string | null;
  /** Plain text: paragraphs separated by blank lines, lists as lines starting "1." or "-". */
  readonly body: string;
  readonly required: boolean;
  readonly editable: boolean;
}

export interface TemplateSection {
  readonly key: string;
  readonly heading: string;
  readonly clauses: readonly TemplateClause[];
}

export interface TemplateContent {
  readonly sections: readonly TemplateSection[];
}

/** Clauses every lease keeps (M3 plan 4.5; the electronic-service clause: prd-issues 25). */
export const REQUIRED_CLAUSES = [
  'parties',
  'premises',
  'term',
  'rent',
  'electronic_service',
  'signatures',
] as const;

const KEY = /^[a-z][a-z0-9_]{1,40}$/;
const TOKEN = /\{\{\s*([a-zA-Z.]+)\s*\}\}/g;
const MAX_BODY = 6_000;

/** Placeholders used in a body, in order of appearance. */
export function placeholdersIn(body: string): string[] {
  return [...body.matchAll(TOKEN)].map((m) => m[1]!);
}

/**
 * Checks a template version before it is saved: keys, plain text only, known placeholders, and
 * every required clause still present and unchanged in what it must say.
 */
export function checkTemplateContent(content: TemplateContent): TemplateContent {
  const seen = new Set<string>();
  if (content.sections.length === 0)
    throw new DomainError('template.empty', 'A template needs at least one section');
  for (const section of content.sections) {
    if (!KEY.test(section.key) || seen.has(section.key))
      throw new DomainError(
        'template.key_invalid',
        `Section key "${section.key}" is invalid or repeated`,
      );
    seen.add(section.key);
    if (!section.heading.trim())
      throw new DomainError('template.heading_missing', 'Every section needs a heading');
    for (const clause of section.clauses) {
      if (!KEY.test(clause.key) || seen.has(clause.key))
        throw new DomainError(
          'template.key_invalid',
          `Clause key "${clause.key}" is invalid or repeated`,
        );
      seen.add(clause.key);
      if (clause.body.length > MAX_BODY)
        throw new DomainError(
          'template.body_too_long',
          `Clause "${clause.key}" is longer than ${MAX_BODY} characters`,
        );
      if (/<\s*[a-zA-Z!/]/.test(clause.body))
        throw new DomainError(
          'template.html',
          `Clause "${clause.key}" contains markup; use plain text`,
        );
      for (const name of placeholdersIn(clause.body))
        if (!Object.hasOwn(PLACEHOLDERS, name))
          throw new DomainError(
            'template.placeholder_unknown',
            `{{${name}}} in "${clause.key}" is not a known placeholder`,
          );
    }
  }
  for (const key of REQUIRED_CLAUSES)
    if (!seen.has(key))
      throw new DomainError('template.clause_required', `The "${key}" clause cannot be removed`);
  return content;
}

/**
 * Checks a new version against the template's latest one (TL-05). The editor honours each
 * clause's flags, and so does every version: a clause the latest version marks required stays,
 * still required, and one it marks not editable keeps its title and wording and stays fixed.
 */
export function checkTemplateVersion(
  previous: TemplateContent,
  next: TemplateContent,
): TemplateContent {
  const content = checkTemplateContent(next);
  const after = new Map(content.sections.flatMap((s) => s.clauses).map((c) => [c.key, c]));
  for (const clause of previous.sections.flatMap((s) => s.clauses)) {
    const label = clause.title ?? clause.key;
    const kept = after.get(clause.key);
    if (clause.required && !kept?.required)
      throw new DomainError('template.clause_required', `The "${label}" clause cannot be removed`);
    if (
      kept &&
      !clause.editable &&
      (kept.editable || kept.title !== clause.title || kept.body !== clause.body)
    )
      throw new DomainError(
        'template.clause_fixed',
        `The "${label}" clause cannot be changed: its wording is fixed`,
      );
  }
  return content;
}

/** Fills a body's placeholders; a placeholder with no value is left as a visible gap. */
export function fillPlaceholders(
  body: string,
  values: Partial<Record<Placeholder, string>>,
): string {
  return body.replace(TOKEN, (_, name: string) =>
    Object.hasOwn(values, name) && values[name as Placeholder]
      ? values[name as Placeholder]!
      : '________',
  );
}
