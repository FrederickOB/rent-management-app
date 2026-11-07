import type { NoticeCompose } from '@rent/contracts';
import { NOTICE_WITHHELD_REASON_LABELS } from '@rent/domain/notices';
import { CHANNEL_MODE_LABELS, noticeChannelName } from '@/lib/notices';
import { Badge } from './ui/badge';

type PlannedRecipient = Pick<
  NoticeCompose['recipients'][number],
  'name' | 'unitCode' | 'channels' | 'physicalServicePlanned'
>;

/**
 * Who a notice reaches and how (decisions 4, 5 and 7): each recipient's channels as service,
 * courtesy copy or withheld with the reason, and whether physical service is planned at issue.
 */
export function NoticeChannelPlan({
  recipients,
}: {
  readonly recipients: readonly PlannedRecipient[];
}) {
  if (recipients.length === 0) return <p className="text-sm text-slate-600">Nobody yet.</p>;
  return (
    <ul className="space-y-3 text-sm" data-testid="channel-plan">
      {recipients.map((r, index) => (
        <li key={`${r.name}-${index}`} className="space-y-1" data-testid="planned-recipient">
          <p className="font-medium">
            {r.name}
            {r.unitCode ? <span className="ml-1 font-mono text-xs">{r.unitCode}</span> : null}
          </p>
          <ul className="flex flex-wrap gap-1">
            {r.channels.map((c) => (
              <li key={c.channel} data-testid="planned-channel" data-mode={c.mode}>
                <Badge
                  tone={c.mode === 'withheld' ? 'amber' : c.mode === 'service' ? 'green' : 'blue'}
                >
                  {noticeChannelName(c.channel)}: {CHANNEL_MODE_LABELS[c.mode]}
                  {c.reason ? ` (${NOTICE_WITHHELD_REASON_LABELS[c.reason]})` : ''}
                </Badge>
              </li>
            ))}
          </ul>
          {r.physicalServicePlanned ? (
            <p className="text-amber-900" data-testid="physical-service-planned">
              Physical service is planned from the day it is issued.
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
