import { usePathname, useRouter } from 'expo-router';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';
import {
  launchTap,
  listenForTaps,
  permission,
  pushAvailable,
  showWhileOpen,
  type PushPermission,
} from './push';
import {
  registerThisDevice,
  unregisterThisDevice,
  turnOffNotifications,
  turnOnNotifications,
  type PushConsent,
  type TurnOn,
} from './push-registration';
import { hrefForPush } from './push-routing';
import { useSession } from './session';

/** Whether this build can have push: the phone apps, with an EAS project for the tokens (push.ts). */
const pushSupported = pushAvailable();

interface PushValue {
  /** Whether this build can have push at all: the phone apps can, the web build cannot. */
  readonly supported: boolean;
  /** What the phone allows now; null until it is known. */
  readonly permission: PushPermission | null;
  /** The phone's prompt if needed, then the device and the consent (push-registration.ts). */
  turnOn(companyId?: string): Promise<TurnOn>;
  turnOff(companyId?: string): Promise<PushConsent>;
}

/** Outside the provider (the web build's tests, a screen rendered on its own), push is off. */
const NO_PUSH: PushValue = {
  supported: false,
  permission: null,
  turnOn: async () => ({ result: 'denied' }),
  turnOff: async () => [],
};

const PushContext = createContext<PushValue>(NO_PUSH);

export const usePush = (): PushValue => useContext(PushContext);

/** Screens a tapped notification waits behind: the start screen and sign-in. */
const NOT_YET = new Set(['/', '/sign-in']);

/**
 * Push for the whole app (M6 decision 5; plan 4.10), inside the session:
 * - a notification tapped (the one that opened the app, or any while it runs) opens its screen,
 *   once the tenant is signed in;
 * - on a phone that already allows notifications, the signed-in session's token is registered;
 *   the phone is never asked here, only when the tenant turns notifications on (Home, Profile);
 * - what the phone allows is checked again whenever the app comes back to the front.
 */
export function PushProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { me, offline } = useSession();
  const personId = me?.personId ?? null;
  const [allowed, setAllowed] = useState<PushPermission | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const checkPermission = useCallback(() => {
    void permission().then(setAllowed);
  }, []);

  useEffect(() => {
    if (!pushSupported) return;
    checkPermission();
    void showWhileOpen().catch(() => undefined);
    const open = (data: unknown) => {
      const href = hrefForPush(data);
      if (href) setPending(href);
    };
    let live = true;
    let stop: (() => void) | null = null;
    void launchTap().then((data) => {
      if (live && data) open(data);
    });
    void listenForTaps(open).then((remove) => {
      if (live) stop = remove;
      else remove();
    });
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') checkPermission();
    });
    return () => {
      live = false;
      stop?.();
      subscription.remove();
    };
  }, [checkPermission]);

  useEffect(() => {
    if (!pending || !personId || NOT_YET.has(pathname)) return;
    setPending(null);
    router.push(pending);
  }, [pending, personId, pathname, router]);

  useEffect(() => {
    if (!personId || offline || allowed === null) return;
    // A failure is tried again on the next sign-in or return to the app; push is a convenience.
    if (allowed === 'granted') void registerThisDevice().catch(() => undefined);
    // The phone no longer allows notifications (turned off in its settings): the token goes, so
    // the API stops counting on push and sends by the next channel instead.
    else void unregisterThisDevice().catch(() => undefined);
  }, [personId, offline, allowed]);

  const turnOn = useCallback(
    async (companyId?: string) => {
      try {
        return await turnOnNotifications(companyId);
      } finally {
        checkPermission();
      }
    },
    [checkPermission],
  );
  const turnOff = useCallback((companyId?: string) => turnOffNotifications(companyId), []);

  const value = useMemo<PushValue>(
    () => (pushSupported ? { supported: true, permission: allowed, turnOn, turnOff } : NO_PUSH),
    [allowed, turnOn, turnOff],
  );
  return <PushContext.Provider value={value}>{children}</PushContext.Provider>;
}
