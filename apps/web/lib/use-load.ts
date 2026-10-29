import { useCallback, useEffect, useState } from 'react';
import { toProblem, type Problem } from './errors';

export type LoadState<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: T }
  | { readonly status: 'error'; readonly problem: Problem };

/**
 * Loads data in the browser and reloads on request. `load` must be stable (wrap it in
 * useCallback); a reply that arrives after the component has moved on is dropped.
 */
export function useLoad<T>(
  load: () => Promise<T>,
  toError: (error: unknown) => Problem = toProblem,
) {
  const [state, setState] = useState<LoadState<T>>({ status: 'loading' });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let current = true;
    void load().then(
      (data) => {
        if (current) setState({ status: 'ready', data });
      },
      (error: unknown) => {
        if (current) setState({ status: 'error', problem: toError(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [load, toError, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { state, reload };
}
