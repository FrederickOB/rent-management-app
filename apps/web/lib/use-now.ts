import { useState } from 'react';
import { useInterval } from './use-interval';

/**
 * The time now, in milliseconds, moving on every `everyMs` (M10 review N7): a support grant shows
 * as ended once its expiry passes, without a reload. For display only; evidence times come from
 * the server.
 */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useInterval(() => setNow(Date.now()), everyMs);
  return now;
}
