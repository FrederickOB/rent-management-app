import type { ArtisanView } from '@rent/contracts';
import {
  MAINTENANCE_CATEGORIES,
  MAINTENANCE_CATEGORY_LABELS,
  type MaintenanceCategory,
} from '@rent/domain/maintenance';
import { tryNormalisePhone } from '@rent/domain/phone';

// Artisans (M8 decision 6; MI-04): a light contact per company with a name, a phone, trades and
// the channels they agreed to be contacted on. No rates, ratings or payment details (MI-09).

export interface ArtisanDraft {
  readonly name: string;
  readonly phone: string;
  readonly trades: readonly MaintenanceCategory[];
  readonly whatsapp: boolean;
  readonly sms: boolean;
}

export const emptyArtisan: ArtisanDraft = {
  name: '',
  phone: '',
  trades: [],
  whatsapp: false,
  sms: false,
};

export const draftOfArtisan = (artisan: ArtisanView): ArtisanDraft => ({
  name: artisan.name,
  phone: '',
  trades: artisan.trades,
  whatsapp: artisan.consent.whatsapp,
  sms: artisan.consent.sms,
});

export type ArtisanField = 'name' | 'phone' | 'trades' | 'consent';

export interface ArtisanInput {
  name: string;
  phone: string;
  trades: MaintenanceCategory[];
  consent: { whatsapp: boolean; sms: boolean };
}

/**
 * A new artisan as the API takes it, or the problems by field. The phone is checked as a Ghana
 * number (E.164 after normalising) and sent as typed; the API normalises it again. Without consent
 * on any channel the job sheet cannot be sent to them, so one is required.
 */
export function artisanInput(
  draft: ArtisanDraft,
  options: { readonly needPhone: boolean } = { needPhone: true },
): { readonly input: ArtisanInput | null; readonly errors: Partial<Record<ArtisanField, string>> } {
  const errors: Partial<Record<ArtisanField, string>> = {};
  const name = draft.name.trim();
  if (name.length < 2) errors.name = 'Enter their name';
  else if (name.length > 120) errors.name = 'Use at most 120 characters';
  const phone = draft.phone.trim();
  if (options.needPhone) {
    if (!phone) errors.phone = 'Enter their phone number';
    else if (phone.length > 20 || tryNormalisePhone(phone) === null)
      errors.phone = 'Enter a phone number such as 024 412 3456 or +233 24 412 3456';
  }
  const trades = MAINTENANCE_CATEGORIES.filter((c) => draft.trades.includes(c));
  if (trades.length === 0) errors.trades = 'Choose at least one trade';
  if (!draft.whatsapp && !draft.sms)
    errors.consent =
      'Record at least one channel they agreed to. Without one, no job sheet can be sent to them.';
  if (Object.keys(errors).length > 0) return { input: null, errors };
  return {
    input: { name, phone, trades, consent: { whatsapp: draft.whatsapp, sms: draft.sms } },
    errors: {},
  };
}

/** The changes to send for an edit: only what differs (each consent change is a new record). */
export function artisanPatch(
  artisan: ArtisanView,
  draft: ArtisanDraft,
): {
  name?: string;
  trades?: MaintenanceCategory[];
  consent?: { whatsapp: boolean; sms: boolean };
} {
  const patch: {
    name?: string;
    trades?: MaintenanceCategory[];
    consent?: { whatsapp: boolean; sms: boolean };
  } = {};
  const name = draft.name.trim();
  if (name !== artisan.name) patch.name = name;
  const trades = MAINTENANCE_CATEGORIES.filter((c) => draft.trades.includes(c));
  const before = MAINTENANCE_CATEGORIES.filter((c) => artisan.trades.includes(c));
  if (trades.join() !== before.join()) patch.trades = trades;
  if (draft.whatsapp !== artisan.consent.whatsapp || draft.sms !== artisan.consent.sms)
    patch.consent = { whatsapp: draft.whatsapp, sms: draft.sms };
  return patch;
}

export const tradesText = (trades: readonly MaintenanceCategory[]): string =>
  trades.map((t) => MAINTENANCE_CATEGORY_LABELS[t]).join(', ') || 'None';

/** "WhatsApp and SMS", "SMS only", or "None: no job sheet can be sent". */
export function consentText(consent: ArtisanView['consent']): string {
  if (consent.whatsapp && consent.sms) return 'WhatsApp and SMS';
  if (consent.whatsapp) return 'WhatsApp only';
  if (consent.sms) return 'SMS only';
  return 'None: no job sheet can be sent';
}

/** An artisan who can be given work now: not archived, and reachable on some channel. */
export const assignable = (artisan: ArtisanView): boolean =>
  artisan.archivedAt === null && (artisan.consent.whatsapp || artisan.consent.sms);
