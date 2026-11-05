import type { Me } from '@rent/contracts';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';
import { api } from './api';
import { authClient } from './auth-client';
import { clearCache, recallPerson, rememberPerson } from './cache';
import { forgetOutbox } from './outbox';
import { forgetRepairQueue } from './repair-queue';
import { toProblem } from './problems';
import { dismissAll } from './push';
import {
  finishPendingSignOut,
  forgetRegistration,
  hasRegisteredToken,
  leaveThisDevice,
  markSignOutPending,
  signOutPending,
} from './push-registration';

interface SessionValue {
  readonly me: Me | null;
  readonly loading: boolean;
  /** The API stopped accepting the session while it was in use: it expired or was signed out. */
  readonly ended: boolean;
  /**
   * The app opened without reaching the API, as the person last signed in here: the screens show
   * the figures cached on this device (M4b plan 4.10) until the API answers again.
   */
  readonly offline: boolean;
  refresh(): Promise<Me | null>;
  signOut(): Promise<void>;
  /** Forgets a session the API refused (401), so the screens send the person to sign in. */
  expire(): void;
  /**
   * Finishes a sign-out made offline, if there is one. Sign-in calls it before asking for a code,
   * so the retry never signs out the session that sign-in is about to make.
   */
  finishSignOut(): Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [ended, setEnded] = useState(false);
  const [offline, setOffline] = useState(false);
  /** Signed out while offline: the API has still to hear of it (push-registration.ts). */
  const [leaving, setLeaving] = useState(false);
  const current = useRef<Me | null>(null);

  const refresh = useCallback(async () => {
    try {
      if (await signOutPending()) {
        // The person signed out here while offline: that session never resumes. Once the API can
        // be reached, this device's token goes, then the session itself.
        const finished = await finishPendingSignOut(() => authClient.signOut());
        current.current = null;
        setMe(null);
        setOffline(false);
        setLeaving(!finished);
        return null;
      }
      const next = await api.me.get();
      current.current = next;
      setMe(next);
      setEnded(false);
      setOffline(false);
      void rememberPerson(next);
      return next;
    } catch (error) {
      // Not a refusal: the API could not be reached. The person last signed in here, whose
      // session has not run out, keeps their cached figures; a refusal always signs out.
      const problem = toProblem(error);
      if (problem.code === 'network') {
        const known = current.current ?? (await recallPerson<Me>());
        if (known && Date.parse(known.sessionExpiresAt) > Date.now()) {
          current.current = known;
          setMe(known);
          setOffline(true);
          return known;
        }
      }
      // A refusal: the session ended while the app was closed (expired, or revoked from another
      // device). Nothing of the person stays on the phone: their cached figures and messages,
      // what they had not sent, and this device's token, which the API dropped with the session.
      if (problem.status === 401 || problem.status === 403) {
        forgetOutbox();
        forgetRepairQueue();
        forgetRegistration();
        await clearCache();
      }
      current.current = null;
      setMe(null);
      setOffline(false);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    // While the session still works: this phone stops getting the person's notifications, and
    // the tray is emptied. Offline, the session is kept on the device (signed out on the screen)
    // until the API can be reached: signing out of Better Auth forgets it before the request goes,
    // so the token would never be removed and the notifications would keep coming.
    const reached = await leaveThisDevice();
    if (reached) await authClient.signOut().catch(() => undefined);
    else await markSignOutPending();
    // A shared phone keeps nothing of the person who signed out: what they had not sent, and the
    // files of repair requests on the phone.
    forgetOutbox();
    forgetRepairQueue();
    await clearCache();
    current.current = null;
    setMe(null);
    setEnded(false);
    setOffline(false);
    setLeaving(!reached);
  }, []);

  const expire = useCallback(() => {
    // Only a session that was in use can end; a refusal before sign-in is not news.
    if (!current.current) return;
    current.current = null;
    setMe(null);
    setEnded(true);
    setOffline(false);
    // The API dropped the session's push token with it; the next sign-in registers again. The
    // tray is emptied of the person's notifications.
    void hasRegisteredToken().then((had) => {
      forgetRegistration();
      if (had) void dismissAll();
    });
    forgetOutbox();
    forgetRepairQueue();
    void clearCache();
  }, []);

  const finishSignOut = useCallback(async () => {
    if (!(await signOutPending())) return;
    setLeaving(!(await finishPendingSignOut(() => authClient.signOut())));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Opened offline, or signed out offline: ask again when the person comes back to the app.
  useEffect(() => {
    if (!offline && !leaving) return;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void refresh();
    });
    return () => subscription.remove();
  }, [offline, leaving, refresh]);

  const value = useMemo(
    () => ({ me, loading, ended, offline, refresh, signOut, expire, finishSignOut }),
    [me, loading, ended, offline, refresh, signOut, expire, finishSignOut],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
