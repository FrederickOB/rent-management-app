import type { Me } from '@rent/contracts';

/** Where a session belongs (AD-06): TOTP enrolment first, then a company, then the app. */
export function homeFor(me: Me): string {
  switch (me.state) {
    case 'enrolment_required':
      return '/enrol';
    case 'company_required':
      return '/choose-company';
    case 'ready':
      return '/';
  }
}
