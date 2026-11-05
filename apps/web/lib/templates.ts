import type { MessageTemplate } from '@rent/contracts';
import type { TemplateCategory, TemplateKey, TemplateStatus } from '@rent/domain/messaging';

// WhatsApp templates (CM-07; M6 plan 3): our text, its name at Meta, and its approval on each
// number the company may send from. Statuses come from Meta's template webhook and a daily check.

export const TEMPLATE_KEY_LABELS: Record<TemplateKey, string> = {
  rent_reminder: 'Rent reminder',
  receipt_ready: 'Receipt ready',
  pay_link: 'Pay link',
  renewal_reminder: 'Renewal reminder',
  signing_link: 'Signing link',
  signing_reminder: 'Signing reminder',
  signed_copy: 'Signed copy',
  id_check_link: 'ID check link',
  paid_until_prompt: 'Paid-until reminder',
  building_notice: 'Building notice (broadcasts)',
  conversation_reopen: 'Reopen a conversation',
};

export const TEMPLATE_CATEGORY_LABELS: Record<TemplateCategory, string> = {
  utility: 'Utility',
  marketing: 'Marketing',
  authentication: 'Authentication',
};

export const TEMPLATE_STATUS_LABELS: Record<TemplateStatus, string> = {
  pending: 'Waiting for approval',
  approved: 'Approved',
  rejected: 'Refused',
  paused: 'Paused',
  disabled: 'Disabled',
};

/** A template's status on a number, for people; null means it was never submitted there. */
export const templateStatusText = (status: TemplateStatus | null): string =>
  status ? TEMPLATE_STATUS_LABELS[status] : 'Not submitted';

/** `{{1}}` is `{landlord}`: each parameter's name, so staff can read the text. */
export function namedBody(template: Pick<MessageTemplate, 'body' | 'parameters'>): string {
  return template.body.replace(/\{\{(\d+)\}\}/g, (whole, index: string) => {
    const name = template.parameters[Number(index) - 1];
    return name ? `{${name}}` : whole;
  });
}

/** Whether the template can go on the number the company sends from now. */
export function usableOnSendingNumber(template: Pick<MessageTemplate, 'statuses'>): boolean {
  return template.statuses.some((s) => s.sending && s.status === 'approved');
}
