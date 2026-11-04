import { INBOX_STREAM_PATH, type InboxStreamEvent } from '@rent/contracts';
import { useEffect, useRef, useState } from 'react';
import { isRecord } from './errors';
import { backoffMs, parseStreamEvent } from './inbox';
import { sseParser, streamVerdict } from './sse';

// The live inbox (M6 plan 4.6): the API pushes server-sent events with ids only, and the screen
// fetches what changed. The stream goes through this origin's /api/v1 proxy with the session
// cookie, like every other call (next.config.ts), so the cookie never leaves the web origin. It is
// read with fetch rather than EventSource, so a refusal (401, 403) can stop it instead of being
// retried for ever (review W9).

export type StreamStatus = 'off' | 'connecting' | 'live' | 'reconnecting' | 'paused' | 'stopped';

export interface InboxStreamHandlers {
  /** Something changed: fetch the conversation or list it names. */
  readonly onEvent: (event: InboxStreamEvent) => void;
  /**
   * The stream (re)connected. Events sent while it was down are lost, so fetch everything shown
   * again. Also called on the first connection, which closes the gap since the page loaded.
   */
  readonly onResync: () => void;
}

export interface InboxStream {
  readonly status: StreamStatus;
  /**
   * How often to refresh by polling meanwhile: only while the stream is (re)connecting, growing
   * with each failed attempt. Null when live, paused in a hidden tab, stopped or off.
   */
  readonly pollMs: number | null;
}

/** While the stream is not live, refresh this often at first so nothing waits long (CM-02). */
export const FALLBACK_REFRESH_MS = 5_000;
const FALLBACK_MAX_MS = 60_000;

/** The polling interval after `failures` failed connections in a row. */
export function fallbackPollMs(status: StreamStatus, failures: number): number | null {
  if (status !== 'connecting' && status !== 'reconnecting') return null;
  return Math.min(
    FALLBACK_MAX_MS,
    FALLBACK_REFRESH_MS * 2 ** Math.max(0, Math.min(failures, 8) - 1),
  );
}

async function codeOf(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    return isRecord(body) && typeof body.code === 'string' ? body.code : null;
  } catch {
    return null;
  }
}

const SESSION_PAGES = { sign_in: '/sign-in', enrol: '/enrol', choose_company: '/choose-company' };

/**
 * Opens the stream while `enabled` and the tab is visible, reconnecting with backoff. A hidden
 * tab closes it and stops polling; showing the tab again reconnects and resyncs. A 401 sends the
 * person to sign in; a 403 (no access, not on the plan) stops it for good.
 */
export function useInboxStream(enabled: boolean, handlers: InboxStreamHandlers): InboxStream {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  }, [handlers]);
  const [status, setStatus] = useState<StreamStatus>('off');
  const [failures, setFailures] = useState(0);

  useEffect(() => {
    if (
      !enabled ||
      typeof fetch === 'undefined' ||
      typeof TextDecoder === 'undefined' ||
      typeof AbortController === 'undefined'
    ) {
      setStatus('off');
      return undefined;
    }
    let controller: AbortController | null = null;
    let timer: number | undefined;
    let attempt = 0;
    let finished = false;
    const hidden = () => document.visibilityState === 'hidden';

    const retry = () => {
      if (finished || hidden()) return;
      setStatus('reconnecting');
      attempt += 1;
      setFailures(attempt);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void connect(), backoffMs(attempt - 1));
    };

    const connect = async () => {
      if (finished) return;
      if (hidden()) {
        setStatus('paused');
        return;
      }
      const mine = new AbortController();
      controller = mine;
      setStatus(attempt === 0 ? 'connecting' : 'reconnecting');
      try {
        const response = await fetch(`${window.location.origin}/api/v1${INBOX_STREAM_PATH}`, {
          credentials: 'include',
          cache: 'no-store',
          headers: { accept: 'text/event-stream' },
          signal: mine.signal,
        });
        const verdict = streamVerdict(response.status, response.ok ? null : await codeOf(response));
        if (verdict !== 'open' || !response.body) {
          if (verdict === 'stop') {
            finished = true;
            setStatus('stopped');
          } else if (verdict === 'retry' || verdict === 'open') {
            retry();
          } else {
            finished = true;
            setStatus('stopped');
            window.location.assign(SESSION_PAGES[verdict]);
          }
          return;
        }
        attempt = 0;
        setFailures(0);
        setStatus('live');
        latest.current.onResync();
        const parser = sseParser((event) => {
          const parsed = parseStreamEvent(event.data);
          if (parsed) latest.current.onEvent(parsed);
        });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.push(decoder.decode(value, { stream: true }));
        }
        // The server or a proxy closed it: connect again.
        retry();
      } catch {
        // Aborted on purpose (hidden tab, page left), or the network dropped.
        if (!mine.signal.aborted) retry();
      }
    };

    const onVisibility = () => {
      if (finished) return;
      if (hidden()) {
        window.clearTimeout(timer);
        controller?.abort();
        controller = null;
        setStatus('paused');
      } else {
        attempt = 0;
        setFailures(0);
        void connect();
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    void connect();
    return () => {
      finished = true;
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearTimeout(timer);
      controller?.abort();
      controller = null;
    };
  }, [enabled]);

  return { status, pollMs: fallbackPollMs(status, failures) };
}

/**
 * Runs `callback` once, `delayMs` after the last of a burst of calls: a reply makes a message, a
 * conversation change and a delivery event in quick succession, and one fetch covers them all.
 */
export function useCoalesced(callback: () => void, delayMs = 250): () => void {
  const latest = useRef(callback);
  useEffect(() => {
    latest.current = callback;
  }, [callback]);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const [schedule] = useState(() => () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => latest.current(), delayMs);
  });
  return schedule;
}

export const STREAM_STATUS_TEXT: Record<StreamStatus, string> = {
  off: 'Live updates are off. Reload the page to see new messages.',
  connecting: 'Connecting live updates…',
  live: 'Live: new messages appear as they arrive.',
  reconnecting: 'Live updates dropped. Reconnecting; the page refreshes meanwhile.',
  paused: 'Live updates are paused while this tab is hidden.',
  stopped: 'Live updates stopped. Reload the page to try again.',
};
