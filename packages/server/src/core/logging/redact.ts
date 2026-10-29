/**
 * Log redaction (CLAUDE.md section 10): no phone numbers, emails, ID numbers, one-time codes,
 * tokens, signatures or request bodies in logs. Two layers: sensitive keys are dropped by name,
 * and every string is scrubbed for values that look like personal data or secrets.
 */
const SENSITIVE_KEY =
  /^(phone|phones|phonenumber|phone_number|msisdn|to|from|email|emails|code|otp|token|tokens|accesstoken|refreshtoken|idtoken|password|newpassword|currentpassword|secret|secretkey|totpuri|backupcodes|idnumber|id_number|ghanacard|cardnumber|accountnumber|account_number|passport|passportnumber|passport_number|tin|tinnumber|tin_number|signature|authorization|cookie|cookies|set-cookie|body|payload|value)$/i;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Ids are not secrets and logs need them; anything else long and token-like is masked.
const maskToken = (match: string) => (UUID.test(match) ? match : '[TOKEN]');

const PATTERNS: readonly [RegExp, string | ((match: string) => string)][] = [
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]'],
  [/\bGHA-?\d{9}-?\d\b/gi, '[ID_NUMBER]'],
  // Passport numbers and TINs as the product stores them: one or two capitals, then digits
  // (G1234567, C0012345678; M3 plan 4.4). Our ids are lower-case, so they are left alone.
  [/\b[A-Z]{1,2}\d{6,10}\b/g, '[ID_NUMBER]'],
  [/\+\d[\d\s-]{6,17}\d/g, '[PHONE]'],
  [/\b0\d{2}[\s-]?\d{3}[\s-]?\d{4}\b/g, '[PHONE]'],
  [/\b233\d{9}\b/g, '[PHONE]'],
  [/\b[A-Za-z0-9_-]{32,}={0,2}/g, maskToken],
  [/\b\d{6}\b/g, '[CODE]'],
];

export const REDACTED = '[REDACTED]';

export function scrubString(value: string): string {
  let out = value;
  for (const [pattern, replacement] of PATTERNS) {
    out =
      typeof replacement === 'string'
        ? out.replace(pattern, replacement)
        : out.replace(pattern, replacement);
  }
  return out;
}

/** Returns a copy of `value` that is safe to log. Depth- and size-limited. */
export function scrub(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 6) return '[DEPTH]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (value instanceof Error) {
    return {
      type: value.name,
      message: scrubString(value.message),
      stack: value.stack ? scrubString(value.stack) : undefined,
    };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1, seen));
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[BUFFER ${value.length}]`;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : scrub(v, depth + 1, seen);
  }
  return out;
}
