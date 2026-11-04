// A small reader for server-sent events (the HTML standard's `text/event-stream` format), used by
// the live inbox (lib/inbox-stream). The browser's EventSource cannot see the response status, so
// it cannot tell a dropped connection from a refused one (401, 403 `NOT_ON_PLAN`); reading the
// stream with fetch can.

export interface SseEvent {
  /** The `event:` field, or `message` when there is none. */
  readonly type: string;
  readonly data: string;
}

/**
 * Feeds text in as it arrives and calls `dispatch` once per complete event. Comments (lines
 * starting with `:`, the heartbeats) and events without data dispatch nothing.
 */
export function sseParser(dispatch: (event: SseEvent) => void): {
  readonly push: (chunk: string) => void;
} {
  let buffer = '';
  let type = '';
  let data: string[] = [];

  const line = (text: string) => {
    if (text === '') {
      if (data.length) dispatch({ type: type || 'message', data: data.join('\n') });
      type = '';
      data = [];
      return;
    }
    if (text.startsWith(':')) return;
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') type = value;
    // `id` and `retry` are not used: the client resyncs everything on reconnect.
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      for (;;) {
        const match = /\r\n|\r|\n/.exec(buffer);
        if (!match) break;
        // A lone \r at the end may be the first half of \r\n: wait for the next chunk.
        if (match[0] === '\r' && match.index === buffer.length - 1) break;
        line(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
      }
      // Never hold an unbounded line: the stream sends ids only.
      if (buffer.length > 64_000) buffer = '';
    },
  };
}

/** What to do with the stream's answer. */
export type StreamVerdict = 'open' | 'sign_in' | 'enrol' | 'choose_company' | 'stop' | 'retry';

/**
 * A 401 means the session ended; a 403 is a refusal that retrying will not change (no access, or
 * not on the plan), apart from the two session states the rest of the app follows too. Anything
 * else that is not a stream is retried with backoff.
 */
export function streamVerdict(status: number, code: string | null): StreamVerdict {
  if (status === 401) return 'sign_in';
  if (status === 403) {
    const upper = (code ?? '').toUpperCase();
    if (upper === 'ENROLMENT_REQUIRED') return 'enrol';
    if (upper === 'COMPANY_REQUIRED') return 'choose_company';
    return 'stop';
  }
  if (status === 404) return 'stop';
  return status >= 200 && status < 300 ? 'open' : 'retry';
}
