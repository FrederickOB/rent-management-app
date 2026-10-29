'use client';

import type { TenantDetailView } from '@rent/contracts';
import type { MessageChannel } from '@rent/domain/messaging';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { CONSENT_VERSION, consentWording, type ConsentDraft } from '@/lib/tenant-form';

const CHANNEL_NAMES: Record<MessageChannel, string> = { sms: 'SMS', email: 'Email' };

/**
 * Consent per channel (CM-09; decision 2). Each grant or withdrawal is a new record with the
 * consent text's version; nothing is overwritten. Without consent on a channel, the business
 * sends nothing on it; one-time codes the person asks for are exempt.
 */
export function ConsentRows({
  consent,
  addresses,
  canManage,
  who,
  onRecord,
}: {
  readonly consent: ConsentDraft;
  readonly addresses: Readonly<Record<MessageChannel, string | null>>;
  readonly canManage: boolean;
  /** For labels: "the tenant", or a contact's name. */
  readonly who: string;
  readonly onRecord: (channel: MessageChannel, action: 'grant' | 'withdraw') => Promise<void>;
}) {
  const [confirming, setConfirming] = useState<MessageChannel | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function record(channel: MessageChannel, action: 'grant' | 'withdraw') {
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
        {(['sms', 'email'] as const).map((channel) => {
          const granted = consent[channel];
          const address = addresses[channel];
          return (
            <li key={channel} data-testid={`consent-${channel}`} className="space-y-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-14 font-medium">{CHANNEL_NAMES[channel]}</span>
                {granted ? <Badge tone="green">Agreed</Badge> : <Badge>Not agreed</Badge>}
                {!address ? (
                  <span className="text-slate-600">
                    No {channel === 'sms' ? 'phone' : 'email'} on file
                  </span>
                ) : null}
                {canManage && confirming !== channel ? (
                  granted ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      pending={pending}
                      aria-label={`Record that ${who} withdrew ${CHANNEL_NAMES[channel]} consent`}
                      onClick={() => void record(channel, 'withdraw')}
                    >
                      Record a withdrawal
                    </Button>
                  ) : address ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-label={`Record ${CHANNEL_NAMES[channel]} consent for ${who}`}
                      onClick={() => setConfirming(channel)}
                    >
                      Record consent
                    </Button>
                  ) : null
                ) : null}
              </div>
              {confirming === channel ? (
                <div
                  role="group"
                  aria-label={`Confirm ${CHANNEL_NAMES[channel]} consent`}
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
  tenant,
  canManage,
  onChanged,
}: {
  readonly tenant: TenantDetailView;
  readonly canManage: boolean;
  readonly onChanged: (text: string) => Promise<void>;
}) {
  return (
    <Card data-testid="consent">
      <CardHeader
        title="Messages"
        description="What the tenant agreed to receive, by channel. Every change is kept."
      />
      <CardBody>
        <ConsentRows
          consent={tenant.consent}
          addresses={{ sms: tenant.phone, email: tenant.email }}
          canManage={canManage}
          who="the tenant"
          onRecord={async (channel, action) => {
            await api().tenants.recordConsent({ tenantId: tenant.id, channel, action });
            await onChanged(
              action === 'grant'
                ? `Recorded ${CHANNEL_NAMES[channel]} consent for ${tenant.displayName}.`
                : `Recorded that ${tenant.displayName} withdrew ${CHANNEL_NAMES[channel]} consent.`,
            );
          }}
        />
      </CardBody>
    </Card>
  );
}
