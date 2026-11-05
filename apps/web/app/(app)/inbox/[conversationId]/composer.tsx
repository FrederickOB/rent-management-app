'use client';

import { MESSAGE_BODY_MAX, type ConversationDetail, type ThreadMessage } from '@rent/contracts';
import { CHANNEL_LABELS, type InboundChannel } from '@rent/domain/messaging';
import { useRef, useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, SelectField, TextField, controlClass } from '@/components/ui/field';
import { api } from '@/lib/api';
import { sendOnce, useIdempotencyKeeper } from '@/lib/idempotency';
import { REPLY_UNAVAILABLE_TEXT, smsAlternative, startingChannel } from '@/lib/inbox';
import { replyContent, replyProblem, replyRefusal } from '@/lib/inbox-reply';

const MODE_WORDS = {
  free_text: 'any reply',
  template_only: 'reopen template only',
  unavailable: 'cannot send now',
} as const;

const TEMPLATE_STATUS_WORDS: Record<string, string> = {
  pending: 'waiting for Meta’s approval',
  rejected: 'refused by Meta',
  paused: 'paused by Meta',
  disabled: 'disabled by Meta',
};

/**
 * The reply box (plan 4.6). It starts on the channel the tenant last wrote on. What each channel
 * allows comes from the API: free text, only the reopen template (WhatsApp outside the 24-hour
 * window, CM-07), or nothing with the reason. Every reply carries a `clientMessageId` made once
 * per message, so a double click or a retry on a slow connection sends it once. A changed text,
 * subject, channel or template is a new message with a new id (review W4, C5).
 */
export function Composer({
  detail,
  windowText,
  onSent,
  onStale,
}: {
  readonly detail: ConversationDetail;
  /** The WhatsApp window's remaining time, while it is open. */
  readonly windowText: string | null;
  readonly onSent: (message: ThreadMessage) => void;
  /** The API says the conversation changed (resolved, a channel closed): fetch it again. */
  readonly onStale: () => void;
}) {
  const [chosen, setChosen] = useState<InboundChannel | null>(null);
  const [body, setBody] = useState('');
  const [subject, setSubject] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const keeper = useIdempotencyKeeper();
  // A second click before React re-renders sees `pending` as it was; this sees the send in flight.
  // Even then both requests would carry the same clientMessageId, which the API sends once.
  const inFlight = useRef(false);
  // What the current key was used for; any change starts a new message (and a new key).
  const keyedFor = useRef<string | null>(null);
  const active = startingChannel(detail, chosen);
  const option = detail.channels.find((c) => c.channel === active) ?? null;
  const sms = smsAlternative(detail);

  async function send(template: boolean) {
    if (!option || inFlight.current) return;
    setError(null);
    setSent(null);
    if (!template && !body.trim()) {
      setError('Write a reply first.');
      return;
    }
    const content = replyContent({
      channel: option.channel,
      template,
      body,
      subject: option.channel === 'email' ? subject : '',
    });
    if (keyedFor.current !== content) {
      keeper.reset();
      keyedFor.current = content;
    }
    inFlight.current = true;
    setPending(true);
    try {
      const message = await sendOnce(keeper, (clientMessageId) =>
        api().inbox.reply({
          conversationId: detail.id,
          clientMessageId,
          channel: option.channel,
          ...(template
            ? { template: 'conversation_reopen' as const }
            : {
                body: body.trim(),
                ...(option.channel === 'email' && subject.trim()
                  ? { subject: subject.trim() }
                  : {}),
              }),
        }),
      );
      keyedFor.current = null;
      if (!template) {
        setBody('');
        setSubject('');
      }
      setSent(
        template
          ? 'The reopen template is on its way. Once the tenant answers, you can write freely.'
          : `Your reply is on its way ${active === 'in_app' ? 'to the app' : `on ${CHANNEL_LABELS[option.channel]}`}.`,
      );
      onSent(message);
    } catch (failure) {
      const outcome = replyRefusal(failure);
      setError(replyProblem(failure));
      // A key the API saw with other content will never send this one: start afresh.
      if (outcome === 'key_reused') {
        keeper.reset();
        keyedFor.current = null;
      }
      // Resolved meanwhile, or the channel no longer takes this reply: show what it takes now.
      if (outcome === 'stale') onStale();
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send(false);
  }

  if (detail.channels.length === 0 || !option) {
    return (
      <Alert tone="info">
        There is no channel to reply on: the tenant has no phone, email or app on record.
      </Alert>
    );
  }

  const reopen = detail.reopenTemplate;
  const reopenUsable = reopen !== null && reopen.status === 'approved';

  return (
    <Card data-testid="composer">
      <CardHeader title="Reply" />
      <CardBody>
        <form onSubmit={submit} noValidate aria-label="Reply" className="space-y-4">
          <SelectField
            label="Channel"
            hint="It starts on the channel the tenant last wrote on."
            value={option.channel}
            options={detail.channels.map((c) => ({
              value: c.channel,
              label: `${CHANNEL_LABELS[c.channel]}${c.addressMasked ? ` (${c.addressMasked})` : ''}: ${MODE_WORDS[c.mode]}`,
            }))}
            onChange={(event) => {
              setChosen(event.target.value as InboundChannel);
              setSent(null);
              setError(null);
            }}
          />
          {option.channel === 'whatsapp' && option.mode === 'free_text' && windowText ? (
            <p className="text-sm text-slate-600">{windowText}</p>
          ) : null}

          {option.mode === 'free_text' ? (
            <>
              {option.channel === 'email' ? (
                <TextField
                  label="Subject (optional)"
                  maxLength={200}
                  value={subject}
                  onChange={(event) => setSubject(event.target.value)}
                />
              ) : null}
              <Field
                label="Message"
                hint={`Sent messages cannot be edited or deleted. Up to ${MESSAGE_BODY_MAX.toLocaleString('en-GB')} characters.`}
              >
                {(control) => (
                  <textarea
                    {...control}
                    rows={4}
                    maxLength={MESSAGE_BODY_MAX}
                    value={body}
                    onChange={(event) => setBody(event.target.value)}
                    className={controlClass}
                  />
                )}
              </Field>
              <Button type="submit" pending={pending}>
                Send reply
              </Button>
            </>
          ) : null}

          {option.mode === 'template_only' ? (
            <div className="space-y-3" data-testid="template-only">
              <Alert tone="info" title="The WhatsApp window has closed">
                {reopen ? (
                  <>
                    Outside the 24-hour window, WhatsApp takes only an approved template. This one
                    asks the tenant to reply: “{reopen.text}”
                    {!reopenUsable ? (
                      <p className="mt-1 font-medium">
                        It cannot go yet: it is{' '}
                        {reopen.status
                          ? (TEMPLATE_STATUS_WORDS[reopen.status] ?? reopen.status)
                          : 'not yet submitted to Meta'}
                        .
                      </p>
                    ) : null}
                  </>
                ) : (
                  'Outside the 24-hour window, WhatsApp takes only an approved template, and none is set up for reopening a conversation.'
                )}
              </Alert>
              <div className="flex flex-wrap gap-2">
                <Button pending={pending} disabled={!reopenUsable} onClick={() => void send(true)}>
                  Send the reopen template
                </Button>
                {sms ? (
                  <Button variant="secondary" onClick={() => setChosen('sms')}>
                    Write by SMS instead
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {option.mode === 'unavailable' ? (
            <Alert
              tone="warning"
              title={`No reply can go on ${CHANNEL_LABELS[option.channel]} now`}
            >
              {option.reason ? REPLY_UNAVAILABLE_TEXT[option.reason] : 'Choose another channel.'}
            </Alert>
          ) : null}

          {error ? <Alert tone="error">{error}</Alert> : null}
          {sent ? <Alert tone="success">{sent}</Alert> : null}
        </form>
      </CardBody>
    </Card>
  );
}
