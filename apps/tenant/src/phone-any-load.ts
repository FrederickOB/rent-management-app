import { anyCountryPhone } from './phone-any';

/** Every country's phone rules. On iOS and Android they are part of the app (src/phone-any-load.web.ts loads them on demand on the web). */
export const loadAnyCountryPhone = async (): Promise<typeof anyCountryPhone> => anyCountryPhone;
