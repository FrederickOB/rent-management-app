import type { anyCountryPhone } from './phone-any';

/** Every country's phone rules, fetched as a bundle of their own the first time they are needed. */
export const loadAnyCountryPhone = async (): Promise<typeof anyCountryPhone> =>
  (await import('./phone-any')).anyCountryPhone;
