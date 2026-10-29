/**
 * Log redaction (CLAUDE.md section 10): no phone numbers, emails, ID numbers, one-time codes,
 * tokens, signatures or request bodies in logs. Two layers: sensitive keys are dropped by name,
 * and every string is scrubbed for values that look like personal data or secrets.
 */
const SENSITIVE_KEY =
  /^(phone|phones|phonenumber|phone_number|msisdn|to|from|email|emails|code|otp|token|tokens|accesstoken|refreshtoken|idtoken|password|newpassword|currentpassword|secret|secretkey|totpuri|backupcodes|idnumber|id_number|ghanacard|cardnumber|accountnumber|account_number|passport|passportnumber|passport_number|tin|tinnumber|tin_number|signature|authorization|cookie|cookies|set-cookie|body|payload|value)$/i;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A run of word characters starts or ends here (ids, numbers and tokens are such runs). */
const START = '(?<![A-Za-z0-9_-])';
const END = '(?![A-Za-z0-9_-])';
const DATE = '\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])';

/**
 * Every pattern, tried left to right in one pass, so nothing is scrubbed twice and a match that
 * must survive (an id, a date, a time, a placeholder of ours) is claimed before anything else
 * can take part of it. Each kind is a named group; `KEEP` kinds are written back unchanged.
 */
const KINDS: readonly (readonly [name: string, pattern: string, replacement: string | null])[] = [
  // Our own placeholders, so scrubbing twice changes nothing.
  ['placeholder', '\\[(?:REDACTED|EMAIL|ID|PHONE|TOKEN|CODE|DEPTH|CIRCULAR|BUFFER \\d+)\\]', null],
  // Request, job and record ids, dates and timestamps are not personal data, and logs need them.
  [
    'uuid',
    `${START}[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}${END}`,
    null,
  ],
  [
    'timestamp',
    `${START}${DATE}[T ](?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d{1,9})?)?(?:Z|[+-](?:[01]\\d|2[0-3])(?::?[0-5]\\d)?)?(?![A-Za-z0-9_])`,
    null,
  ],
  ['date', `${START}${DATE}${END}`, null],
  ['email', '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}', '[EMAIL]'],
  ['ghanacard', '\\b[Gg][Hh][Aa]-?\\d{9}-?\\d\\b', '[ID]'],
  ['phone', '\\+\\d[\\d\\s-]{6,17}\\d', '[PHONE]'],
  ['localphone', '\\b0\\d{2}[\\s-]?\\d{3}[\\s-]?\\d{4}\\b', '[PHONE]'],
  ['msisdn', '\\b233\\d{9}\\b', '[PHONE]'],
  ['token', '\\b[A-Za-z0-9_-]{32,}={0,2}', '[TOKEN]'],
  ['code', '\\b\\d{6}\\b', '[CODE]'],
  // Passport numbers (6 to 12 letters or digits) and TINs (6 to 20 letters, digits or hyphens),
  // as the domain accepts and returns them: upper case (packages/domain identity-numbers). Any
  // such run of capitals, digits and hyphens standing on its own is masked. That also masks some
  // upper-case words of six letters or more (ECONNREFUSED, DELETE): accepted over-redaction.
  ['idnumber', `${START}[A-Z0-9-]{6,20}${END}`, '[ID]'],
];

const SCRUB = new RegExp(KINDS.map(([name, pattern]) => `(?<${name}>${pattern})`).join('|'), 'g');

function replace(match: string, ...args: unknown[]): string {
  const groups = args.at(-1) as Record<string, string | undefined>;
  for (const [name, , replacement] of KINDS) {
    if (groups[name] === undefined) continue;
    if (replacement === null) return match;
    // A long run that is exactly a UUID is an id, not a token.
    if (name === 'token' && UUID.test(match)) return match;
    return replacement;
  }
  return match;
}

export const REDACTED = '[REDACTED]';

export function scrubString(value: string): string {
  return value.replace(SCRUB, replace);
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
