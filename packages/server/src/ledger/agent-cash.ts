import { sql, type Tx } from '@rent/db';
import { conflict } from '../core/errors';

/**
 * The agent's cash for an owner (founder decision F3, 2026-11-06): money paid out of an owner's
 * agent-held cash (1070) never exceeds what the agency holds for that owner. Every path that pays
 * out of 1070 takes the owner's lock first, then checks, then posts, in one transaction:
 * - GRA rent tax (P18) and VAT (P33) paid from the agency's account;
 * - refunds paid from the agency's account (P13, P12);
 * - expenses the agent pays (P15);
 * - remittances and fees taken (P16), and owner money reversals.
 * A nightly check alerts if any owner's 1070 is ever below zero (a chargeback cannot be refused).
 */

/** Payments out of one owner's agent-held cash take turns (`owner-money:<owner>`). */
export async function lockOwnerMoney(tx: Tx, ownerId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`owner-money:${ownerId}`}, 0))`,
  );
}

/** 1070 in the owner's book, whatever the caller's scope (a narrow system function). */
export async function agentCashHeld(tx: Tx, bookId: string): Promise<number> {
  const rows = await tx.execute<{ held: string }>(
    sql`select app.agent_cash_held(${bookId}::uuid)::text as held`,
  );
  return Number(rows.rows[0]?.held ?? 0);
}

export const insufficientAgentCash = (heldMinor: number) =>
  conflict(
    'insufficient_agent_cash',
    'The agency does not hold this much of the owner’s money. Record the owner’s funding first.',
    { heldMinor: String(heldMinor) },
  );

/**
 * Takes the owner's lock and refuses a payment out of 1070 beyond what the agent holds for the
 * owner (409 INSUFFICIENT_AGENT_CASH). Call it in the paying transaction, before posting.
 */
export async function assertAgentCash(
  tx: Tx,
  input: { readonly ownerId: string; readonly bookId: string; readonly outMinor: number },
): Promise<void> {
  await lockOwnerMoney(tx, input.ownerId);
  const held = await agentCashHeld(tx, input.bookId);
  if (input.outMinor > held) throw insufficientAgentCash(held);
}
