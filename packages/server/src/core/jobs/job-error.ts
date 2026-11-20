import { scrubString } from '../logging/redact';

const CODE = /^[A-Za-z0-9_.:-]{1,60}$/;
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;

/**
 * Why a job failed, as a code and a short message (M11 decision 9): from pg-boss's stored output of
 * the failed job (the thrown error, serialised). Never a body, a stack or personal data: the first
 * line of the message only, scrubbed as logs are, at most 200 characters.
 */
export function jobErrorSummary(output: unknown): string | null {
  if (output === null || output === undefined) return null;
  if (typeof output !== 'object') return scrubString(String(output)).slice(0, 200) || null;
  const o = output as Record<string, unknown>;
  const code =
    typeof o.code === 'string' && CODE.test(o.code)
      ? o.code
      : typeof o.name === 'string' && NAME.test(o.name)
        ? o.name
        : 'error';
  const message =
    typeof o.message === 'string'
      ? scrubString(o.message.split('\n')[0]!.trim()).slice(0, 160)
      : typeof o.value === 'string'
        ? scrubString(o.value.split('\n')[0]!.trim()).slice(0, 160)
        : '';
  return (message ? `${code}: ${message}` : code).slice(0, 200);
}
