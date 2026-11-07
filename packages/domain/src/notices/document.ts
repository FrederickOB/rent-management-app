import { NOTICE_SIGNING_STATEMENT } from '../esign/signing';
import { formatBusinessDate } from '../dates';
import { format, money } from '../money';
import { COUNSEL_WORDING_PLACEHOLDER } from './records';
import {
  NOTICE_FIELD_LABELS,
  NOTICE_SUBTYPE_FIELD_LABELS,
  NOTICE_SUBTYPE_LABELS,
  NOTICE_TYPE_LABELS,
  type NoticeSubtype,
  type NoticeType,
} from './types';

/**
 * A notice's words for its frozen PDF (LN-01, LN-04; decision 1): the template `notices.notice`
 * version 1, filled from the notice's own facts. Every legal sentence is counsel's, so until counsel
 * supplies the wording each legal section reads COUNSEL_WORDING_PLACEHOLDER. Staff's own words (the
 * particulars and the optional details paragraph) and the facts are shown as entered.
 */
export const NOTICE_TEMPLATE = { key: 'notices.notice', version: 1 } as const;
export const SERVICE_PACK_TEMPLATE = { key: 'notices.service-pack', version: 1 } as const;
/**
 * Decision 1: whether counsel has reviewed the built-in wording of each template version. None has
 * yet; a reviewed version is a new version with this set.
 */
export const NOTICE_TEMPLATE_COUNSEL_REVIEWED: Readonly<Record<string, boolean>> = {
  'notices.notice@1': false,
};
export const counselReviewedTemplate = (key: string, version: number): boolean =>
  NOTICE_TEMPLATE_COUNSEL_REVIEWED[`${key}@${version}`] ?? false;

/** The legal sections of each type, in order: headings only; the words are counsel's. */
const LEGAL_SECTIONS: Readonly<Record<NoticeType, readonly string[]>> = {
  rent_demand: ['Demand for payment', 'If the arrears are not paid'],
  rent_review: ['Notice of the new rent', 'When the new rent takes effect'],
  notice_to_quit: ['Notice to quit', 'The ground for this notice', 'Your rights'],
  entry: ['Notice of entry', 'Access to the premises'],
  breach: ['The breach of the tenancy', 'What you must do'],
  non_renewal: ['Notice that the tenancy will not be renewed', 'When the tenancy ends'],
  building_wide: ['Notice to occupants'],
  tenant_originated: [],
};

export interface NoticeDocumentInput {
  readonly type: NoticeType;
  readonly subtype: NoticeSubtype | null;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly number: string;
  readonly issueDate: string;
  readonly landlordName: string;
  readonly propertyName: string;
  /** The unit, or the blocks of a building-wide notice. */
  readonly premises: string;
  readonly recipients: readonly string[];
  readonly replaces: string | null;
  readonly counselReviewed: boolean;
}

export interface NoticeDocumentContent {
  readonly title: string;
  readonly reference: string;
  readonly landlordName: string;
  readonly issuedOn: string;
  readonly propertyName: string;
  readonly premises: string;
  readonly recipients: string[];
  readonly facts: { label: string; value: string }[];
  readonly sections: { heading: string; text: string }[];
  readonly replaces: string | null;
  readonly counselReviewed: boolean;
  readonly acknowledgement: string;
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/** One field as the notice prints it: dates in words, amounts as cedis, lists counted. */
function factValue(field: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (field.endsWith('Minor') && typeof value === 'number') return format(money(value));
  if (Array.isArray(value)) return value.length === 0 ? null : `${value.length}`;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value))
    return formatBusinessDate(value);
  return text(value);
}

/** Fields shown as their own sections, in staff's words, not in the facts table. */
const PROSE_FIELDS: ReadonlySet<string> = new Set(['particulars', 'details', 'reason']);
/** Fields that are ids, not facts a tenant can read. */
const HIDDEN_FIELDS: ReadonlySet<string> = new Set(['propertyId', 'blockIds', 'documentId']);

export function noticeDocumentContent(input: NoticeDocumentInput): NoticeDocumentContent {
  const facts: { label: string; value: string }[] = [];
  if (input.subtype)
    facts.push({
      label: NOTICE_SUBTYPE_FIELD_LABELS[input.type] ?? 'Kind',
      value: NOTICE_SUBTYPE_LABELS[input.subtype],
    });
  for (const [field, value] of Object.entries(input.fields)) {
    if (PROSE_FIELDS.has(field) || HIDDEN_FIELDS.has(field)) continue;
    const shown = factValue(field, value);
    if (shown === null) continue;
    const label =
      field === 'invoiceIds'
        ? 'Invoices covered'
        : (NOTICE_FIELD_LABELS[field] ?? field).replace(/^The /, '');
    facts.push({ label: label.charAt(0).toUpperCase() + label.slice(1), value: shown });
  }
  const sections: { heading: string; text: string }[] = LEGAL_SECTIONS[input.type].map(
    (heading) => ({ heading, text: COUNSEL_WORDING_PLACEHOLDER }),
  );
  const reason = text(input.fields.reason);
  if (reason) sections.push({ heading: 'The reason given', text: reason });
  const particulars = text(input.fields.particulars);
  if (particulars) sections.push({ heading: 'Particulars', text: particulars });
  const details = text(input.fields.details);
  if (details) sections.push({ heading: 'Further details', text: details });
  const title =
    input.type === 'building_wide' && text(input.fields.title)
      ? `${NOTICE_TYPE_LABELS[input.type]}: ${text(input.fields.title)}`
      : NOTICE_TYPE_LABELS[input.type];
  return {
    title: title.slice(0, 200),
    reference: input.number,
    landlordName: input.landlordName,
    issuedOn: formatBusinessDate(input.issueDate),
    propertyName: input.propertyName,
    premises: input.premises,
    // Review MF-5 (Act 843): a building-wide notice is addressed to the occupants and names no
    // tenant, since every occupant receives the same document.
    recipients:
      input.type === 'building_wide'
        ? [
            `The occupants of ${input.propertyName}${input.premises ? `, ${input.premises}` : ''}`.slice(
              0,
              200,
            ),
          ]
        : [...input.recipients],
    facts,
    sections,
    replaces: input.replaces,
    counselReviewed: input.counselReviewed,
    acknowledgement: `${NOTICE_SIGNING_STATEMENT} The notice has effect whether or not it is signed.`,
  };
}

/**
 * The service pack's cover and affidavit (plan 4.7; OQ-10): what to serve, to whom and how to
 * record it. The affidavit's wording is counsel's: the placeholder until then.
 */
export function servicePackContent(input: {
  readonly title: string;
  readonly number: string;
  readonly issueDate: string;
  readonly landlordName: string;
  readonly propertyName: string;
  readonly premises: string;
  readonly recipients: readonly { readonly name: string; readonly premises: string }[];
  readonly noticeSha256: string;
}) {
  return {
    title: input.title,
    reference: input.number,
    landlordName: input.landlordName,
    issuedOn: formatBusinessDate(input.issueDate),
    propertyName: input.propertyName,
    premises: input.premises,
    recipients: input.recipients.map((r) => ({ name: r.name, premises: r.premises })),
    noticeSha256: input.noticeSha256,
    instructions: [
      'Serve the notice that follows, exactly as it is printed, on each person listed above.',
      'Record how, when and by whom it was served on the notice in the app, with a witness where there is one and a photo where it was posted on the premises.',
      'Keep the completed affidavit; upload it to the notice once it is sworn.',
    ],
    affidavit: {
      heading: 'Affidavit of service',
      text: COUNSEL_WORDING_PLACEHOLDER,
      blanks: [
        'Name of the person who served',
        'Date and time of service',
        'How it was served',
        'Where it was served',
        'Witness',
        'Signature',
      ],
    },
  };
}
