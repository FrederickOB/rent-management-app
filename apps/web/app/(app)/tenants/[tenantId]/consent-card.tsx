'use client';

import type { ConsentChannel } from '@rent/domain/messaging';
import { useState } from 'react';
import { useApp } from '@/components/app-context';
import { LoadFailed, Loading } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import {
  consentChannelName,
  consentHistoryText,
  NO_ADDRESS_TEXT,
  type ChannelConsent,
} from '@/lib/messaging-consent';
import { CONSENT_VERSION, consentWording } from '@/lib/tenant-form';

const BY_CHANNEL: Record<ConsentChannel, string> = {
  sms: 'by SMS',
  email: 'by email',
  whatsapp: 'on WhatsApp',
  push: 'by app notification',
};

type Confirming = { readonly channel: ConsentChannel; readonly action: 'grant' | 'withdraw' };

/**
 * Consent per channel (CM-09; M3 decision 2, M6 plan 4.8): app notifications, WhatsApp, SMS and
 * email. Each grant or withdrawal is a new record with the consent text's version; nothing is
 * overwritten, so both are confirmed before they are recorded. Without consent on a channel, the
 * business starts nothing on it; one-time codes the person asks for, and replies within 24 hours
 * of their own message, are exempt.
 */
export function ConsentRows({
  channels,
  canManage,
  who,
  onRecord,
}: {
  readonly channels: readonly ChannelConsent[];
  readonly canManage: boolean;
  /** For labels: "the tenant", or a contact's name. */
  readonly who: string;
  readonly onRecord: (channel: ConsentChannel, action: 'grant' | 'withdraw') => Promise<void>;
}) {
  const { timeZone } = useApp();
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function record(channel: ConsentChannel, action: 'grant' | 'withdraw') {
    setPending(true);
    setError(null);
    try {
      await onRecord(channel, action);
      setConfirming(null);
    } catch (failure) {
      setError(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-3">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <ul className="space-y-3" aria-label={`Consent for ${who}`}>
        {channels.map(({ channel, granted, source, recordedAt, reachable, reason }) => {
          const name = consentChannelName(channel);
          return (
            <li key={channel} data-testid={`consent-${channel}`} className="space-y-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-28 font-medium">{name}</span>
                {granted ? <Badge tone="green">Agreed</Badge> : <Badge>Not agreed</Badge>}
                {!reachable ? (
                  <span className="text-slate-600">{NO_ADDRESS_TEXT[channel]}</span>
                ) : null}
                {canManage && confirming?.channel !== channel ? (
                  granted ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Record that ${who} withdrew ${name} consent`}
                      onClick={() => setConfirming({ channel, action: 'withdraw' })}
                    >
                      Record a withdrawal
                    </Button>
                  ) : reachable ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-label={`Record ${name} consent for ${who}`}
                      onClick={() => setConfirming({ channel, action: 'grant' })}
                    >
                      Record consent
                    </Button>
                  ) : null
                ) : null}
              </div>
              {recordedAt && (source || reason) ? (
                <p className="text-slate-600" data-testid="consent-source">
                  {consentHistoryText({ channel, granted, source, reason: reason ?? null })},{' '}
                  <time dateTime={recordedAt}>{formatTime(recordedAt, timeZone)}</time>
                </p>
              ) : null}
              {confirming?.channel === channel && confirming.action === 'withdraw' ? (
                <div
                  role="group"
                  aria-label={`Confirm ${name} withdrawal`}
                  className="space-y-2 rounded-md border border-red-200 bg-red-50 p-3 text-red-900"
                >
                  <p>
                    Record that {who} no longer agrees to messages {BY_CHANNEL[channel]}? The
                    withdrawal is kept for good: nothing more is sent {BY_CHANNEL[channel]} until
                    they agree again, and that is recorded as a new consent.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="danger"
                      pending={pending}
                      onClick={() => void record(channel, 'withdraw')}
                    >
                      They withdrew it
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : null}
              {confirming?.channel === channel && confirming.action === 'grant' ? (
                <div
                  role="group"
                  aria-label={`Confirm ${name} consent`}
                  className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3"
                >
                  <p>
                    &ldquo;{consentWording(channel)}&rdquo;{' '}
                    <span className="text-slate-600">({CONSENT_VERSION})</span>
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      pending={pending}
                      onClick={() => void record(channel, 'grant')}
                    >
                      They agreed to this
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The tenant's own consent, by channel. */
export function ConsentCard({
  channels,
  problem,
  onRetry,
  canManage,
  onRecord,
}: {
  /** Null while loading, or when the read failed (`problem`). */
  readonly channels: readonly ChannelConsent[] | null;
  readonly problem: string | null;
  readonly onRetry: () => void;
  readonly canManage: boolean;
  readonly onRecord: (channel: ConsentChannel, action: 'grant' | 'withdraw') => Promise<void>;
}) {
  return (
    <Card data-testid="consent">
      <CardHeader
        title="Messages"
        description="What the tenant agreed to receive, by channel. Every change is kept, and a changed phone or email starts with no consent."
      />
      <CardBody>
        {channels ? (
          <ConsentRows
            channels={channels}
            canManage={canManage}
            who="the tenant"
            onRecord={onRecord}
          />
        ) : problem ? (
          <LoadFailed message={`Consent could not be loaded. ${problem}`} onRetry={onRetry} />
        ) : (
          <Loading what="consent" />
        )}
      </CardBody>
    </Card>
  );
}
