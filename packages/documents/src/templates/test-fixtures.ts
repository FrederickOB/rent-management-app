import type { Branding } from './branding';
import type { SystemSampleData } from './system-sample';

/** A 1×1 PNG, standing in for a company logo. */
export const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** Fictional company and tenant, as in the demo dataset (CLAUDE.md section 14). */
export const sampleBranding: Branding = {
  senderName: 'Demo Lettings Ltd',
  primaryColour: '#0F766E',
  accentColour: '#F59E0B',
  logoDataUri: `data:image/png;base64,${TINY_PNG_BASE64}`,
};

export const sampleData: SystemSampleData = {
  title: 'Sample receipt',
  recipientName: 'Esi Ɔforiwaa',
  reference: 'ACC-LEG-B2-04',
  amountMinor: 150_000,
  currency: 'GHS',
  issuedAt: '2026-10-28T14:05:00Z',
  timeZone: 'Africa/Accra',
};
