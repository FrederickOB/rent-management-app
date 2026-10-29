import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { toProblem, type Problem } from './problems';
import { useSession } from './session';

export type LoadState<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly problem: Problem }
  /** `refreshProblem`: a later reload failed, so what is shown may be out of date. */
  | { readonly status: 'ready'; readonly data: T; readonly refreshProblem: Problem | null };

export interface Loaded<T> {
  readonly state: LoadState<T>;
  /** Fetches again and keeps what is shown until the answer arrives. */
  reload(): void;
  /** Starts again from the loading state, after an error. */
  retry(): void;
}

/**
 * Loads from the API while `enabled` (the session is known), and reloads on request. `load` must
 * be stable (wrap it in useCallback). A reply that arrives after a newer request, or after the
 * screen has gone, is dropped. A 401 ends the session, so the screen sends the person to sign in.
 */
export function useLoad<T>(load: () => Promise<T>, enabled = true): Loaded<T> {
  const { expire } = useSession();
  const expireRef = useRef(expire);
  useEffect(() => {
    expireRef.current = expire;
  }, [expire]);
  const [state, setState] = useState<LoadState<T>>({ status: 'loading' });
  const latest = useRef(0);
  const inFlight = useRef(0);

  const run = useCallback(() => {
    latest.current += 1;
    const mine = latest.current;
    inFlight.current = mine;
    load().then(
      (data) => {
        if (mine !== latest.current) return;
        inFlight.current = 0;
        setState({ status: 'ready', data, refreshProblem: null });
      },
      (error: unknown) => {
        if (mine !== latest.current) return;
        inFlight.current = 0;
        const problem = toProblem(error);
        if (problem.status === 401) expireRef.current();
        setState((previous) =>
          previous.status === 'ready'
            ? { ...previous, refreshProblem: problem }
            : { status: 'error', problem },
        );
      },
    );
  }, [load]);

  useEffect(() => {
    if (enabled) run();
    return () => {
      // Drops the answer to anything still in flight.
      latest.current += 1;
      inFlight.current = 0;
    };
  }, [enabled, run]);

  const reload = useCallback(() => {
    // One request at a time: focus and visibility events often arrive together.
    if (enabled && inFlight.current === 0) run();
  }, [enabled, run]);

  const retry = useCallback(() => {
    if (!enabled) return;
    setState({ status: 'loading' });
    run();
  }, [enabled, run]);

  return { state, reload, retry };
}

/**
 * Reloads when the person comes back: to this screen from another one, or to the app from the
 * in-app browser (Android) or the signing tab (web). The screen's first focus is its first load,
 * so it is skipped.
 */
export function useReloadOnReturn(reload: () => void): void {
  const latest = useRef(reload);
  useEffect(() => {
    latest.current = reload;
  }, [reload]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') latest.current();
    });
    if (Platform.OS !== 'web' || typeof window === 'undefined') return () => subscription.remove();
    // A signing window on a desktop browser hands focus back without the tab ever being hidden,
    // and a tab restored from the back-forward cache shows no change of visibility.
    const onFocus = () => latest.current();
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) latest.current();
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      subscription.remove();
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, []);

  const first = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (first.current) {
        first.current = false;
        return;
      }
      latest.current();
    }, []),
  );
}
