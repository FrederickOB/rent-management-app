import type { TemplateRowView } from '@rent/contracts';

export type TemplateKind = TemplateRowView['kind'];

export const TEMPLATE_KINDS: readonly TemplateKind[] = [
  'residential',
  'commercial',
  'short_fixed_term',
  'custom',
];

export const TEMPLATE_KIND_LABELS: Record<TemplateKind, string> = {
  residential: 'Residential',
  commercial: 'Commercial',
  short_fixed_term: 'Short fixed term',
  custom: 'Your own',
};
