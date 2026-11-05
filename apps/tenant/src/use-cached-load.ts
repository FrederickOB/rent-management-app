import { useCallback, useEffect, useState } from 'react';
import { readCache, writeCache, type Cached } from './cache';
import type { Problem } from './problems';
import { useSession } from './session';
import { useLoad } from './use-load';

export type CachedView<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly problem: Problem }
  | {
      readonly status: 'ready';
      readonly data: T;
      /** When this device fetched what is shown (ISO 8601). */
      readonly fetchedAt: string;
      /** The API cannot be reached, so this is the last copy, which may be out of date. */
      readonly offline: boolean;
      /** A later reload failed for another reason, so what is shown may be out of date. */
      readonly refreshProblem: Problem | null;
    };

export interface CachedLoaded<T> {
  readonly view: CachedView<T>;
  reload(): void;
  retry(): void;
}

interface Timed<T> {
  readonly data: T;
  readonly fetchedAt: string;
}

/** A request that never reached the API: the device is offline, or the API is down. */
export const isOffline = (problem: Problem | null): boolean =>
  problem !== null && problem.status === null && problem.code === 'network';

/**
 * useLoad, with the offline cache (M4b plan 4.10): each answer is kept for the signed-in person
 * under `name`, and when the API cannot be reached the last copy is shown with the time it was
 * fetched. A refusal (401, 404 and so on) never falls back to the cache. `load` must be stable.
 * `toCache`, also stable, is what is kept of an answer: messages keep their text without links
 * (M6), since the cache refuses anything that holds one.
 */
export function useCachedLoad<T>(
  name: string,
  load: () => Promise<T>,
  enabled = true,
  toCache?: (data: T) => T,
): CachedLoaded<T> {
  const { me } = useSession();
  const personId = me?.personId ?? null;
  const timed = useCallback(
    async (): Promise<Timed<T>> => ({ data: await load(), fetchedAt: new Date().toISOString() }),
    [load],
  );
  const { state, reload, retry } = useLoad(timed, enabled && personId !== null);

  useEffect(() => {
    if (state.status === 'ready' && state.refreshProblem === null && personId) {
      const kept = toCache ? toCache(state.data.data) : state.data.data;
      void writeCache(personId, name, kept, state.data.fetchedAt);
    }
  }, [state, personId, name, toCache]);

  const key = `${personId ?? ''}:${name}`;
  const offlineFirst = state.status === 'error' && isOffline(state.problem);
  const [fallback, setFallback] = useState<{
    readonly key: string;
    readonly cached: Cached<T> | null;
  } | null>(null);
  useEffect(() => {
    if (!offlineFirst || !personId) return;
    let live = true;
    void readCache<T>(personId, name).then((cached) => {
      if (live) setFallback({ key, cached });
    });
    return () => {
      live = false;
    };
  }, [offlineFirst, personId, name, key]);

  let view: CachedView<T>;
  if (state.status === 'loading') view = { status: 'loading' };
  else if (state.status === 'ready') {
    const offline = isOffline(state.refreshProblem);
    view = {
      status: 'ready',
      data: state.data.data,
      fetchedAt: state.data.fetchedAt,
      offline,
      refreshProblem: offline ? null : state.refreshProblem,
    };
  } else if (offlineFirst && fallback?.key !== key) view = { status: 'loading' };
  else if (offlineFirst && fallback?.cached) {
    view = {
      status: 'ready',
      data: fallback.cached.data,
      fetchedAt: fallback.cached.savedAt,
      offline: true,
      refreshProblem: null,
    };
  } else view = { status: 'error', problem: state.problem };

  return { view, reload, retry };
}
