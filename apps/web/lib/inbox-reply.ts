import { errorCode, statusOf, toProblem } from './errors';
import { isKeyReused, outcomeOf } from './idempotency';

// Replies from the inbox composer (plan 4.6). Kept apart from lib/inbox, which server pages
// import: the idempotency helpers carry React hooks.

/**
 * What a reply's `clientMessageId` stands for: one channel, template or not, one subject and
 * text. The composer starts a new id whenever this changes (review W4), so a retry of the same
 * reply sends once and an edited reply is a new message.
 */
export function replyContent(reply: {
  readonly channel: string;
  readonly template: boolean;
  readonly body: string;
  readonly subject: string;
}): string {
  return JSON.stringify([
    reply.channel,
    reply.template,
    reply.template ? '' : reply.body.trim(),
    reply.template ? '' : reply.subject.trim(),
  ]);
}

/** Named refusals that change what the composer does next. */
export type ReplyRefusal = 'key_reused' | 'stale' | 'other';

/**
 * 422 `IDEMPOTENCY_KEY_REUSED`: the id was used for a different reply (C5). 409
 * `CONVERSATION_RESOLVED` or `CHANNEL_UNAVAILABLE`: the conversation changed since it was shown
 * (C4, review W12).
 */
export function replyRefusal(error: unknown): ReplyRefusal {
  if (isKeyReused(error)) return 'key_reused';
  if (statusOf(error) === 409) {
    const code = errorCode(error);
    if (code === 'CONVERSATION_RESOLVED' || code === 'CHANNEL_UNAVAILABLE') return 'stale';
  }
  return 'other';
}

/** What to say when a reply fails, so the person knows whether sending again is safe. */
export function replyProblem(error: unknown): string {
  if (isKeyReused(error))
    return 'An earlier attempt with different words used this reply’s key, so nothing new was sent. Check the thread above, then send again.';
  if (statusOf(error) === 409 && errorCode(error) === 'CONVERSATION_RESOLVED')
    return 'This conversation was resolved meanwhile, so nothing was sent. Reopen it to reply.';
  if (statusOf(error) === 409 && errorCode(error) === 'CHANNEL_UNAVAILABLE')
    return 'That channel can no longer take this reply, so nothing was sent. The choices below are up to date now.';
  const { message } = toProblem(error);
  return outcomeOf(error) === 'unknown'
    ? `${message} It may already have gone. Sending it again is safe: it will not go twice.`
    : message;
}
