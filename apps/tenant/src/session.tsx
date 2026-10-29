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
import { api } from './api';
import { authClient } from './auth-client';

interface SessionValue {
  readonly me: Me | null;
  readonly loading: boolean;
  /** The API stopped accepting the session while it was in use: it expired or was signed out. */
  readonly ended: boolean;
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
  const current = useRef<Me | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api.me.get();
      current.current = next;
      setMe(next);
      setEnded(false);
      return next;
    } catch {
      current.current = null;
      setMe(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    await authClient.signOut().catch(() => undefined);
    current.current = null;
    setMe(null);
    setEnded(false);
  }, []);

  const expire = useCallback(() => {
    // Only a session that was in use can end; a refusal before sign-in is not news.
    if (!current.current) return;
    current.current = null;
    setMe(null);
    setEnded(true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ me, loading, ended, refresh, signOut, expire }),
    [me, loading, ended, refresh, signOut, expire],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
