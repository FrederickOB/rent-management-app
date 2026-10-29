import type { TemplateClause, TemplateContent } from './templates';

/**
 * Starter lease templates (TL-05; M3 decision 3). The factual clauses are written from the
 * lease's own data. The legal clauses are marked placeholders: their wording must come from the
 * company's lawyer (OQ-53, OQ-10, OQ-44), so nothing here is legal advice or an invented term.
 * Every version starts as not reviewed by counsel, and the builder warns until a company admin
 * records that its lawyer has reviewed it.
 */
export const LAWYER_WORDING = 'Wording to be supplied by your lawyer.';

export const STARTER_TEMPLATE_KINDS = ['residential', 'commercial', 'short_fixed_term'] as const;
export type StarterTemplateKind = (typeof STARTER_TEMPLATE_KINDS)[number];

export const STARTER_TEMPLATE_NAMES: Record<StarterTemplateKind, string> = {
  residential: 'Residential tenancy agreement (starter)',
  commercial: 'Commercial lease (starter)',
  short_fixed_term: 'Short fixed-term tenancy (starter)',
};

const fact = (key: string, title: string, body: string): TemplateClause => ({
  key,
  title,
  body,
  required: true,
  editable: false,
});

const lawyer = (key: string, title: string): TemplateClause => ({
  key,
  title,
  body: LAWYER_WORDING,
  required: false,
  editable: true,
});

function starter(kind: StarterTemplateKind): TemplateContent {
  const commercial = kind === 'commercial';
  return {
    sections: [
      {
        key: 'agreement',
        heading: commercial ? 'Lease' : 'Tenancy agreement',
        clauses: [
          fact(
            'parties',
            'The parties',
            'This agreement is between {{landlord.name}} ("the landlord") and {{tenant.name}} ("the tenant").',
          ),
          fact(
            'premises',
            'The premises',
            'The premises are unit {{unit.code}} ({{unit.description}}) at {{property.name}}, {{property.address}}.',
          ),
          fact(
            'term',
            'The term',
            'The tenancy starts on {{lease.startDate}} and ends on {{lease.endDate}} ({{lease.term}} months).',
          ),
          fact(
            'rent',
            'Rent',
            'The rent is {{rent.monthly}} a month, billed {{rent.cycle}}. {{rent.initialAdvance}}\n\n{{rent.steps}}',
          ),
          fact('deposit', 'Security deposit', 'The security deposit is {{deposit.amount}}.'),
          fact(
            'service_charge',
            'Service charge',
            'The service charge is {{serviceCharge.monthly}} a month.',
          ),
          fact(
            'notice',
            'Notice',
            'The notice period the parties agreed is {{notice.days}} days. {{break.summary}}',
          ),
          lawyer('use', commercial ? 'Permitted use' : 'Use of the premises'),
          lawyer('repairs', 'Repairs and maintenance'),
          lawyer('obligations', 'Other obligations of the parties'),
          lawyer('termination', 'Ending the tenancy early'),
          fact(
            'electronic_service',
            'Electronic service',
            'The tenant agrees that notices about this tenancy may be served electronically at {{electronicService.contacts}}. ' +
              LAWYER_WORDING,
          ),
          fact(
            'signatures',
            'Signatures',
            'Signed electronically by the parties and a witness. The signing certificate attached to this document records each signature.',
          ),
        ],
      },
    ],
  };
}

export const STARTER_TEMPLATES: Record<StarterTemplateKind, TemplateContent> = {
  residential: starter('residential'),
  commercial: starter('commercial'),
  short_fixed_term: starter('short_fixed_term'),
};
