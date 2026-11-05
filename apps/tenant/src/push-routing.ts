import { isUuid } from './ids';

/**
 * Where tapping a notification goes (M6 plan 4.9 and 4.10), from the notification's `data`.
 *
 * The data names a screen from a fixed list, with the ids that screen needs:
 * `{ screen: 'receipt' | 'payments' | 'messages' | 'to_sign' | 'tenancy' | 'home', companyId?, leaseId? }`.
 * A notification that names only its message `purpose` is routed by purpose instead. Anything
 * else (an unknown screen, a path, a URL, an id that is not a UUID) opens nothing or the screen's
 * list: the app never navigates to a path the notification carries, and never shows its data.
 */
export function hrefForPush(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const fields = data as Readonly<Record<string, unknown>>;
  const screen =
    typeof fields.screen === 'string'
      ? fields.screen
      : typeof fields.purpose === 'string' && Object.hasOwn(PURPOSE_SCREENS, fields.purpose)
        ? PURPOSE_SCREENS[fields.purpose]!
        : null;
  switch (screen) {
    case 'receipt':
    case 'payments':
      // Receipts are downloaded from Payments and receipts; the app has no receipt screen.
      return '/payments';
    case 'messages':
      // One conversation per landlord (TL-12): the thread is the notification's landlord's.
      return isUuid(fields.companyId) ? `/messages/${fields.companyId}` : '/messages';
    case 'to_sign':
    case 'to-sign':
      return '/to-sign';
    case 'tenancy':
      return isUuid(fields.leaseId) ? `/tenancy/${fields.leaseId}` : '/home';
    case 'home':
      return '/home';
    default:
      return null;
  }
}

/**
 * Message purposes (packages/domain/src/messaging) to the screen that answers them, as the
 * server's `pushNotice` names it, for a notification that names no screen. The server always names
 * one (contracts `pushDataSchema`), so this is only a fallback. `rent_reminder` still opens Home,
 * where the rent and Pay are, as the M6 test of this table fixed it; the server sends `payments`.
 */
const PURPOSE_SCREENS: Readonly<Record<string, string>> = {
  receipt: 'receipt',
  rent_reminder: 'home',
  pay_link: 'payments',
  paid_until_prompt: 'payments',
  renewal_reminder: 'tenancy',
  signing_link: 'to_sign',
  signing_reminder: 'to_sign',
  signed_copy: 'tenancy',
  id_check_link: 'home',
  conversation_reply: 'messages',
  bot_reply: 'messages',
  broadcast: 'messages',
};
