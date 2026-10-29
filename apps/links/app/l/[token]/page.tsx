import { notFound } from 'next/navigation';

/**
 * A secure link (CLAUDE.md section 9). Token resolution arrives in M3 and M4b; until then no
 * token is valid, so this page never reads the token, let alone logs or shows it.
 */
export default function SecureLinkPage(): never {
  notFound();
}
