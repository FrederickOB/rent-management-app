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
import { toProblem } from './problems';

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
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [ended, setEnded] = useState(false);
  const [offline, setOffline] = useState(false);
  const current = useRef<Me | null>(null);

  const refresh = useCallback(async () => {
    try {
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
      if (toProblem(error).code === 'network') {
        const known = current.current ?? (await recallPerson<Me>());
        if (known && Date.parse(known.sessionExpiresAt) > Date.now()) {
          current.current = known;
          setMe(known);
          setOffline(true);
          return known;
        }
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
    await authClient.signOut().catch(() => undefined);
    // A shared phone keeps nothing of the person who signed out.
    await clearCache();
    current.current = null;
    setMe(null);
    setEnded(false);
    setOffline(false);
  }, []);

  const expire = useCallback(() => {
    // Only a session that was in use can end; a refusal before sign-in is not news.
    if (!current.current) return;
    current.current = null;
    setMe(null);
    setEnded(true);
    setOffline(false);
    void clearCache();
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Opened offline: ask again when the person comes back to the app.
  useEffect(() => {
    if (!offline) return;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void refresh();
    });
    return () => subscription.remove();
  }, [offline, refresh]);

  const value = useMemo(
    () => ({ me, loading, ended, offline, refresh, signOut, expire }),
    [me, loading, ended, offline, refresh, signOut, expire],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
