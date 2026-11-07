import { addNetworkStateListener } from 'expo-network';
import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import { flushAllRepairs, restoreRepairs } from './repair-queue';
import { useSession } from './session';

/**
 * Sends the repair requests waiting on this phone (M8 decision 3): once the signed-in person is
 * known, and again whenever the app comes back to the front or the phone is back online. Each send
 * repeats the request's `clientId`, so the API makes one job however often it is tried.
 */
export function RepairRunner() {
  const { me } = useSession();
  const personId = me?.personId ?? null;

  useEffect(() => {
    if (!personId) return;
    let live = true;
    const run = () => {
      if (live) void flushAllRepairs(personId).catch(() => undefined);
    };
    void restoreRepairs(personId).then(run, run);
    const app = AppState.addEventListener('change', (next) => {
      if (next === 'active') run();
    });
    let network: { remove(): void } | null = null;
    try {
      network = addNetworkStateListener((state) => {
        if (state.isConnected !== false && state.isInternetReachable !== false) run();
      });
    } catch {
      // No network events here: the app's return to the front still sends.
    }
    const web = Platform.OS === 'web' && typeof window !== 'undefined';
    if (web) window.addEventListener('online', run);
    return () => {
      live = false;
      app.remove();
      network?.remove();
      if (web) window.removeEventListener('online', run);
    };
  }, [personId]);

  return null;
}
