import type { MessagePurpose } from './messaging';

/**
 * What a push notification says (M6 decision 5): it names what arrived and who from, never an
 * amount, an address or a link, because it shows on a locked screen. The details open in the app,
 * on the screen named here.
 */
export const PUSH_SCREENS = [
  'receipt',
  'payments',
  'messages',
  'to_sign',
  'tenancy',
  'home',
  // M8: the tenant's repairs (a step on one of them).
  'repairs',
] as const;
export type PushScreen = (typeof PUSH_SCREENS)[number];

export interface PushNotice {
  readonly title: string;
  readonly body: string;
  readonly screen: PushScreen;
}

export function pushNotice(purpose: MessagePurpose, companyName: string): PushNotice {
  const title = companyName.slice(0, 60);
  switch (purpose) {
    case 'receipt':
      return { title, body: `Your receipt from ${companyName} is ready`, screen: 'receipt' };
    case 'rent_reminder':
      return { title, body: `A rent reminder from ${companyName}`, screen: 'payments' };
    case 'pay_link':
      return { title, body: `${companyName} sent you a way to pay`, screen: 'payments' };
    case 'paid_until_prompt':
      return { title, body: `A message from ${companyName} about your rent`, screen: 'payments' };
    case 'signing_link':
    case 'signing_reminder':
      return { title, body: `${companyName} has a document for you to sign`, screen: 'to_sign' };
    case 'signed_copy':
      return { title, body: `Your signed copy from ${companyName} is ready`, screen: 'tenancy' };
    case 'id_check_link':
      return { title, body: `${companyName} asks you to confirm your identity`, screen: 'home' };
    case 'broadcast':
      return { title, body: `A notice from ${companyName}`, screen: 'messages' };
    case 'conversation_reply':
    case 'bot_reply':
      return { title, body: `${companyName} replied to your message`, screen: 'messages' };
    case 'renewal_reminder':
      return { title, body: `A message from ${companyName} about your lease`, screen: 'tenancy' };
    // M7: a notice to acknowledge (plan 4.5); the app lists it under To sign.
    case 'notice_link':
    case 'notice_reminder':
    case 'notice_in_force':
      return { title, body: `${companyName} has sent you a notice`, screen: 'to_sign' };
    // M8: a step on a repair (plan 4.4), and the final statement at move-out (plan 4.8).
    case 'repair_update':
      return { title, body: `An update on your repair from ${companyName}`, screen: 'repairs' };
    case 'final_statement':
      return {
        title,
        body: `Your final statement from ${companyName} is ready`,
        screen: 'tenancy',
      };
    default:
      return { title, body: `A message from ${companyName}`, screen: 'messages' };
  }
}
