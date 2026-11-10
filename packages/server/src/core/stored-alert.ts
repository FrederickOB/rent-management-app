import { schema, withSystem, type Database } from '@rent/db';
import type { Alert, AlertPort } from '@rent/integrations';
import type { AppLogger } from './logging/logger';
import { scrub, scrubString } from './logging/redact';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MESSAGE_LIMIT = 500;

/** The company an alert concerns, when its context names one by id. */
function subjectCompanyOf(alert: Alert): string | null {
  const id = alert.context?.companyId;
  return typeof id === 'string' && UUID.test(id) ? id : null;
}

/**
 * What is stored of an alert (M10 decision 15): its code, severity and message, the company it
 * concerns, and its context as the logger would write it. Alerts carry ids and counts by contract;
 * the log scrubber is applied anyway, so a phone number, email, code or token never reaches the
 * table even by mistake (CLAUDE.md section 10).
 */
export function storedAlertOf(alert: Alert) {
  return {
    severity: alert.severity,
    code: alert.code.slice(0, 200),
    message: scrubString(alert.message).slice(0, MESSAGE_LIMIT),
    subjectCompanyId: subjectCompanyOf(alert),
    data: alert.context === undefined ? null : (scrub(alert.context) as Record<string, unknown>),
  };
}

/**
 * Every alert raised through ALERT_PORT is also stored in `alert_event` (M10 decision 15), so the
 * console's system health lists recent alerts. Sending comes first and is what the caller waits
 * on: a failure to store is logged and never stops the alert, and a failure to send is still
 * thrown after the alert is stored.
 */
export class StoredAlert implements AlertPort {
  constructor(
    private readonly inner: AlertPort,
    private readonly database: Database,
    private readonly logger?: AppLogger,
  ) {}

  async raise(alert: Alert): Promise<void> {
    const [sent, stored] = await Promise.allSettled([this.inner.raise(alert), this.store(alert)]);
    if (stored.status === 'rejected')
      this.logger?.warn({ err: stored.reason, alertCode: alert.code }, 'could not store an alert');
    if (sent.status === 'rejected') throw sent.reason;
  }

  private async store(alert: Alert): Promise<void> {
    await withSystem(this.database, {}, (tx) =>
      tx.insert(schema.alertEvent).values(storedAlertOf(alert)),
    );
  }
}
