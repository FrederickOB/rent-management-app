import { useEffect, useRef, useState } from 'react';
import { useInterval } from './use-interval';

/**
 * Like useInterval, but quiet while the tab is hidden: a sending broadcast's stats need no
 * refresh nobody is looking at (review W9). Showing the tab again calls `callback` at once.
 */
export function useVisibleInterval(callback: () => void, delayMs: number | null): void {
  const latest = useRef(callback);
  useEffect(() => {
    latest.current = callback;
  }, [callback]);
  const [visible, setVisible] = useState(true);
  const running = delayMs !== null;
  useEffect(() => {
    const onChange = () => {
      const shown = document.visibilityState !== 'hidden';
      setVisible(shown);
      if (shown && running) latest.current();
    };
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, [running]);
  useInterval(callback, visible ? delayMs : null);
}
