import { formatBusinessDate } from '../dates';
import { SIGNER_ROLE_LABELS, type SignerRole } from '../esign/signing';
import { format, money } from '../money';
import {
  formatTerm,
  RENT_CYCLE_LABELS,
  termLength,
  type BreakParty,
  type LeaseTerms,
} from './lease-terms';
import {
  fillPlaceholders,
  placeholdersIn,
  REQUIRED_CLAUSES,
  type Placeholder,
  type TemplateContent,
} from './templates';

/**
 * A lease's document snapshot (TL-05, TL-07; ADR-006): the template's clauses filled from the
 * lease's own data, so the HTML preview, the frozen PDF and the signing page show the same words.
 * Everything here is a fact of the lease; legal wording comes only from the template (decision 3).
 */
export interface LeaseDocumentFacts {
  readonly title: string;
  /** Printed on every page, for example the lease's reference. */
  readonly reference: string;
  readonly landlordName: string;
  readonly agentName: string | null;
  readonly tenantName: string;
  readonly tenantPhone: string | null;
  readonly tenantEmail: string | null;
  readonly signatoryNames: readonly string[];
  readonly guarantorName: string | null;
  readonly propertyName: string;
  readonly propertyAddress: string;
  readonly unitCode: string;
  readonly unitDescription: string;
  readonly terms: LeaseTerms;
  readonly servicePhones: readonly string[];
  readonly serviceEmails: readonly string[];
  readonly parties: readonly { readonly role: SignerRole; readonly name: string }[];
}

/** The shape of the `tenancy.lease` document template's data (packages/documents). */
export interface LeaseDocument {
  readonly title: string;
  readonly reference: string;
  readonly sections: { heading: string; clauses: { title: string | null; text: string }[] }[];
  readonly signers: { role: string; name: string }[];
}

const amount = (minor: number) => format(money(minor));

const BREAK_WHO: Record<BreakParty, string> = {
  tenant: 'the tenant',
  landlord: 'the landlord',
  either: 'either party',
};

/** Facts the lease may not have; a clause made only of these is left out when they are absent. */
const OPTIONAL_FACTS: ReadonlySet<Placeholder> = new Set<Placeholder>([
  'deposit.amount',
  'serviceCharge.monthly',
  'guarantor.name',
  'agent.name',
]);

const joinNames = (names: readonly string[]) =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/** The value of every placeholder for this lease. Absent optional facts are empty. */
export function leasePlaceholderValues(facts: LeaseDocumentFacts): Record<Placeholder, string> {
  const t = facts.terms;
  const steps = t.steps.map(
    (s) =>
      `From ${formatBusinessDate(s.effectiveFrom)} the rent is ${amount(s.monthlyRentMinor)} a month.`,
  );
  const contacts = [...facts.servicePhones, ...facts.serviceEmails];
  const breakClause = t.breakClause;
  return {
    'landlord.name': facts.landlordName,
    'agent.name': facts.agentName ?? '',
    'tenant.name': facts.tenantName,
    'tenant.phone': facts.tenantPhone ?? '',
    'tenant.email': facts.tenantEmail ?? '',
    'tenant.signatories': joinNames(facts.signatoryNames),
    'guarantor.name': facts.guarantorName ?? '',
    'property.name': facts.propertyName,
    'property.address': facts.propertyAddress,
    'unit.code': facts.unitCode,
    'unit.description': facts.unitDescription,
    'lease.startDate': formatBusinessDate(t.startDate),
    'lease.endDate': formatBusinessDate(t.endDate),
    'lease.term': formatTerm(termLength(t.startDate, t.endDate)),
    'rent.monthly': amount(t.monthlyRentMinor),
    'rent.cycle': RENT_CYCLE_LABELS[t.cycle].toLowerCase(),
    'rent.steps': steps.length > 0 ? steps.join('\n') : 'The rent does not change during the term.',
    'rent.initialAdvance': t.initialAdvanceMonths
      ? `The first ${t.initialAdvanceMonths} months’ rent is paid in advance.`
      : 'No initial advance is agreed.',
    'deposit.amount': t.depositMinor ? amount(t.depositMinor) : '',
    'serviceCharge.monthly': t.serviceChargeMonthlyMinor ? amount(t.serviceChargeMonthlyMinor) : '',
    'notice.days': String(t.noticeDays),
    'break.summary': breakClause
      ? `From ${formatBusinessDate(breakClause.fromDate)}, ${BREAK_WHO[breakClause.party]} may end the lease early with ${breakClause.noticeDays} days’ notice${breakClause.creditUnusedDays ? ', and unused days of the current month are credited' : ''}.`
      : 'There is no break clause.',
    'electronicService.contacts': joinNames(contacts),
  };
}

/**
 * `{{lease.term}}` once printed the number of rent periods, so template versions published before
 * it printed the exact term say "{{lease.term}} months". Versions never change (TL-05), so their
 * wording is read as `{{lease.term}}`, which now carries its own unit: "12 months and 6 days".
 */
const LEGACY_TERM = /\{\{\s*lease\.term\s*\}\}\s+months?\b/g;
const withExactTerm = (body: string) => body.replace(LEGACY_TERM, '{{lease.term}}');

/**
 * Fills a template version from the lease's facts. A clause the law does not require, built only
 * from facts this lease does not have (no deposit, no service charge, no guarantor), is left out.
 */
export function buildLeaseDocument(
  content: TemplateContent,
  facts: LeaseDocumentFacts,
): LeaseDocument {
  const values = leasePlaceholderValues(facts);
  const required: ReadonlySet<string> = new Set(REQUIRED_CLAUSES);
  return {
    title: facts.title.slice(0, 200),
    reference: facts.reference.slice(0, 60),
    sections: content.sections
      .map((section) => ({
        heading: section.heading,
        clauses: section.clauses
          .filter((clause) => {
            if (required.has(clause.key)) return true;
            const used = placeholdersIn(clause.body) as Placeholder[];
            return !(used.length > 0 && used.every((p) => OPTIONAL_FACTS.has(p) && !values[p]));
          })
          .map((clause) => ({
            title: clause.title,
            text: fillPlaceholders(withExactTerm(clause.body), values),
          })),
      }))
      .filter((section) => section.clauses.length > 0),
    signers: facts.parties.map((p) => ({ role: SIGNER_ROLE_LABELS[p.role], name: p.name })),
  };
}
