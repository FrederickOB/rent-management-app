// Platform admin: WhatsApp numbers and interim plans (M6 decisions 3 and 9). The API checks the
// same rules; these answer sooner.

export interface NumberDraft {
  readonly phoneNumberId: string;
  readonly wabaId: string;
  readonly displayPhone: string;
  readonly displayName: string;
  readonly kind: 'shared' | 'company';
  readonly companyId: string;
}

export const EMPTY_NUMBER: NumberDraft = {
  phoneNumberId: '',
  wabaId: '',
  displayPhone: '',
  displayName: '',
  kind: 'company',
  companyId: '',
};

const META_ID = /^\d{5,30}$/;
const E164 = /^\+[1-9]\d{6,14}$/;

export function numberErrors(draft: NumberDraft): Partial<Record<keyof NumberDraft, string>> {
  const errors: { -readonly [K in keyof NumberDraft]?: string } = {};
  if (!META_ID.test(draft.phoneNumberId.trim()))
    errors.phoneNumberId = 'Use the phone number ID from Meta: digits only';
  if (!META_ID.test(draft.wabaId.trim()))
    errors.wabaId = 'Use the WhatsApp Business Account ID from Meta: digits only';
  if (!E164.test(draft.displayPhone.trim()))
    errors.displayPhone = 'Use the international form, such as +233302000000';
  const name = draft.displayName.trim().length;
  if (name < 2 || name > 60) errors.displayName = 'Use 2 to 60 characters';
  if (draft.kind === 'company' && !draft.companyId)
    errors.companyId = 'Choose the company that owns the number';
  return errors;
}

/** The register route's input: a company number names its company, the shared one none. */
export function numberInput(draft: NumberDraft) {
  return {
    phoneNumberId: draft.phoneNumberId.trim(),
    wabaId: draft.wabaId.trim(),
    displayPhone: draft.displayPhone.trim(),
    displayName: draft.displayName.trim(),
    kind: draft.kind,
    companyId: draft.kind === 'company' ? draft.companyId : null,
  };
}
