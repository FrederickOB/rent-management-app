import type { Me } from '@rent/contracts';

/** Where a phone session with no company to work in is told why (AD-06). */
export const PHONE_NO_ACCESS_PATH = '/sign-in/phone/no-access';

/**
 * A phone sign-in that carries no company. The API gives a phone session only the roles that may
 * sign in by phone (caretakers), so a tenant, or staff whose roles all need a password, arrive
 * here with no memberships: there is nothing for them in this app.
 */
export function phoneSessionWithoutCompany(me: Me): boolean {
  return me.state === 'ready' && me.authMethod === 'phone_otp' && me.memberships.length === 0;
}

/** Where a session belongs (AD-06): TOTP enrolment first, then a company, then the app. */
export function homeFor(me: Me): string {
  if (phoneSessionWithoutCompany(me)) return PHONE_NO_ACCESS_PATH;
  switch (me.state) {
    case 'enrolment_required':
      return '/enrol';
    case 'company_required':
      return '/choose-company';
    case 'ready':
      return '/';
  }
}
