import { randomBytes } from 'node:crypto';

/** A random token shaped like a real one: 256 bits, base64url (CLAUDE.md section 9). */
export function fakeToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Every value of one header. Use headersArray(), which keeps Set-Cookie and repeats. */
export function headerValues(headers: { name: string; value: string }[], name: string): string[] {
  return headers
    .filter((header) => header.name.toLowerCase() === name)
    .map((header) => header.value);
}

/** The nonce in a policy's script-src. */
export function nonceOf(policy: string): string {
  const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(policy)?.[1];
  if (!nonce) throw new Error(`no nonce in the policy: ${policy}`);
  return nonce;
}

/** A policy as directive name to sources, with the nonce replaced so policies compare. */
export function policyShape(policy: string): Record<string, string[]> {
  const nonce = nonceOf(policy);
  return Object.fromEntries(
    policy.split(';').map((directive) => {
      const [name = '', ...sources] = directive.trim().split(/\s+/);
      return [name, sources.map((source) => source.replace(nonce, 'NONCE'))];
    }),
  );
}
