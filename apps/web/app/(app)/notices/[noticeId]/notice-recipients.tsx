'use client';

import type { NoticeDetail } from '@rent/contracts';
import { NOTICE_STATUS_LABELS, NOTICE_WITHHELD_REASON_LABELS } from '@rent/domain/notices';
import { toDataURL } from 'qrcode';
import { useState } from 'react';
import { useApp } from '@/components/app-context';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import {
  CHANNEL_MODE_LABELS,
  eventsByRecipient,
  noticeChannelName,
  RECIPIENT_KIND_LABELS,
  recordKindLabel,
  type NoticeEvent,
  type NoticeRecipient,
} from '@/lib/notices';

/**
 * Who the notice went to (LN-03, LN-07; decisions 4, 5 and 7): each recipient's channels as
 * planned at issue, with service, courtesy copy or withheld and why; delivery with the channel
 * that confirmed it; the first open and the signature; and every event for them, by server time.
 */
export function RecipientsCard({ notice }: { readonly notice: NoticeDetail }) {
  const groups = eventsByRecipient(notice.events);
  const general = groups.get(null) ?? [];
  // C2: the API says who may show a recipient's handover link (decision 6).
  const mayHandOver = notice.actions.handover;
  return (
    <Card data-testid="notice-recipients">
      <CardHeader
        title={notice.recipients.length === 1 ? 'Recipient' : 'Recipients'}
        description={
          notice.completion === 'any_one'
            ? 'One signature acknowledges receipt for the company. Signing acknowledges receipt, not agreement.'
            : 'Signing acknowledges receipt, not agreement. An unsigned notice is still in force.'
        }
      />
      <CardBody>
        <ul className="space-y-6">
          {notice.recipients.map((recipient) => (
            <RecipientItem
              key={recipient.id}
              noticeId={notice.id}
              recipient={recipient}
              events={groups.get(recipient.id) ?? []}
              mayHandOver={mayHandOver && !recipient.acknowledged}
            />
          ))}
        </ul>
        {general.length ? (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-900">The notice as a whole</h3>
            <EventList events={general} />
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

function RecipientItem({
  noticeId,
  recipient,
  events,
  mayHandOver,
}: {
  readonly noticeId: string;
  readonly recipient: NoticeRecipient;
  readonly events: readonly NoticeEvent[];
  readonly mayHandOver: boolean;
}) {
  const { timeZone } = useApp();
  const address = [recipient.phoneMasked, recipient.emailMasked].filter(Boolean).join(' · ');
  return (
    <li className="space-y-2" data-testid="notice-recipient">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-base font-semibold text-slate-900">{recipient.name}</span>
        <Badge>{RECIPIENT_KIND_LABELS[recipient.kind]}</Badge>
        {recipient.status ? (
          <span data-testid="recipient-status">
            <Badge tone={recipient.acknowledged ? 'green' : 'blue'}>
              {NOTICE_STATUS_LABELS[recipient.status]}
            </Badge>
          </span>
        ) : null}
        {recipient.acknowledged && !recipient.signedAt ? (
          <Badge tone="green">Acknowledged for the company</Badge>
        ) : null}
        {recipient.unitCode ? (
          <span className="font-mono text-xs">{recipient.unitCode}</span>
        ) : null}
      </div>
      {address ? <p className="text-sm text-slate-600">{address}</p> : null}
      <ul className="flex flex-wrap gap-1" aria-label={`Channels for ${recipient.name}`}>
        {recipient.channels.map((c) => (
          <li key={c.channel} data-testid="recipient-channel" data-mode={c.mode}>
            <Badge tone={c.mode === 'withheld' ? 'amber' : c.mode === 'service' ? 'green' : 'blue'}>
              {noticeChannelName(c.channel)}: {CHANNEL_MODE_LABELS[c.mode]}
              {c.reason ? ` (${NOTICE_WITHHELD_REASON_LABELS[c.reason]})` : ''}
            </Badge>
          </li>
        ))}
      </ul>
      {recipient.physicalServicePlanned ? (
        <p className="text-sm text-amber-900">
          No channel can serve them electronically, so physical service is planned.
        </p>
      ) : null}
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-slate-600">Delivered</dt>
          <dd>
            {recipient.deliveredAt
              ? `${formatTime(recipient.deliveredAt, timeZone)}${recipient.deliveredVia ? `, confirmed by ${noticeChannelName(recipient.deliveredVia)}` : ''}`
              : 'Not confirmed yet'}
          </dd>
        </div>
        <div>
          <dt className="text-slate-600">First opened</dt>
          <dd>
            {recipient.firstOpenedAt ? formatTime(recipient.firstOpenedAt, timeZone) : 'Not yet'}
          </dd>
        </div>
        <div>
          <dt className="text-slate-600">Signed</dt>
          <dd>{recipient.signedAt ? formatTime(recipient.signedAt, timeZone) : 'Not yet'}</dd>
        </div>
      </dl>
      {events.length ? <EventList events={events} /> : null}
      {mayHandOver ? <Handover noticeId={noticeId} recipient={recipient} /> : null}
    </li>
  );
}

function EventList({ events }: { readonly events: readonly NoticeEvent[] }) {
  const { timeZone } = useApp();
  return (
    <ol className="space-y-1 border-l border-slate-200 pl-3 text-sm" aria-label="Events">
      {events.map((event) => (
        <li key={event.id} data-testid="notice-event" data-kind={event.kind}>
          <span className="font-medium">{recordKindLabel(event.kind)}</span>
          {event.channel ? ` by ${noticeChannelName(event.channel)}` : ''} ·{' '}
          <time dateTime={event.at}>{formatTime(event.at, timeZone)}</time>
          {event.actorName ? ` · ${event.actorName}` : ''}
          {typeof event.data?.reason === 'string' ? (
            <span className="text-slate-600"> · {event.data.reason}</span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/** The QR code of a link, or null when it cannot be drawn: the link is then shown to copy. */
async function qrOf(url: string): Promise<string | null> {
  try {
    return await toDataURL(url, { margin: 1, width: 240, errorCorrectionLevel: 'M' });
  } catch {
    return null;
  }
}

/**
 * A signing link for one recipient, shown as a QR code to scan in person (decision 6). It does
 * not replace earlier links. It lives only in this panel and is never stored or put in the
 * address bar.
 */
function Handover({
  noticeId,
  recipient,
}: {
  readonly noticeId: string;
  readonly recipient: NoticeRecipient;
}) {
  const { timeZone } = useApp();
  const [link, setLink] = useState<{ url: string; expiresAt: string; qr: string | null } | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function make() {
    setPending(true);
    setProblem(null);
    try {
      const made = await api().notices.handoverLink({ noticeId, recipientId: recipient.id });
      setLink({ ...made, qr: await qrOf(made.url) });
    } catch (failure) {
      setProblem(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  if (!link)
    return (
      <div className="space-y-1">
        <Button size="sm" variant="secondary" pending={pending} onClick={() => void make()}>
          Show a link for {recipient.name} to scan
        </Button>
        {problem ? <Alert tone="error">{problem}</Alert> : null}
      </div>
    );
  return (
    <div
      className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3"
      data-testid="handover"
    >
      {link.qr ? (
        <img
          src={link.qr}
          alt={`QR code of the signing link for ${recipient.name}`}
          className="size-60"
        />
      ) : null}
      <label className="block text-sm">
        <span className="font-medium">The link</span>
        <input
          readOnly
          value={link.url}
          className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs"
          onFocus={(event) => event.target.select()}
        />
      </label>
      <p className="text-xs text-slate-600">
        Works until {formatTime(link.expiresAt, timeZone)}. Earlier links keep working.
      </p>
      <Button size="sm" variant="ghost" onClick={() => setLink(null)}>
        Hide the link
      </Button>
    </div>
  );
}
