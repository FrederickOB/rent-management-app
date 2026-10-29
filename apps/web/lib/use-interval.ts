import { useEffect, useRef } from 'react';

/**
 * Calls `callback` every `delayMs` while `delayMs` is not null, always with the latest callback.
 * Used for polling (files being processed, an import being checked) and periodic refreshes.
 */
export function useInterval(callback: () => void, delayMs: number | null): void {
  const latest = useRef(callback);
  useEffect(() => {
    latest.current = callback;
  }, [callback]);
  useEffect(() => {
    if (delayMs === null) return undefined;
    const id = window.setInterval(() => latest.current(), delayMs);
    return () => window.clearInterval(id);
  }, [delayMs]);
}

/** Calls `callback` whenever the tab becomes visible again, so a list is fresh on return. */
export function useOnVisible(callback: () => void): void {
  const latest = useRef(callback);
  useEffect(() => {
    latest.current = callback;
  }, [callback]);
  useEffect(() => {
    const onChange = () => {
      if (document.visibilityState === 'visible') latest.current();
    };
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
}
