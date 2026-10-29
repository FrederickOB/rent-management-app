import type { EmailPort } from '../email/email';

/**
 * Operational alerts (CLAUDE.md section 8): dead-lettered jobs, broken audit chains, reconciliation
 * differences. M1 sends them to the log and to an ops email address.
 */
export type AlertSeverity = 'warning' | 'critical';

export interface Alert {
  readonly severity: AlertSeverity;
  /** Stable machine-readable code, for example `jobs.dead_letter`. */
  readonly code: string;
  readonly message: string;
  /** Ids and counts, never personal data. */
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface AlertPort {
  raise(alert: Alert): Promise<void>;
}

function checkAlert(alert: Alert): void {
  if (alert.severity !== 'warning' && alert.severity !== 'critical') {
    throw new Error('unknown alert severity');
  }
  if (alert.code.trim().length === 0) throw new Error('alert code required');
}

/** Records alerts in memory, for tests. */
export class InMemoryAlert implements AlertPort {
  readonly raised: (Alert & { readonly at: string })[] = [];

  async raise(alert: Alert): Promise<void> {
    checkAlert(alert);
    this.raised.push({ ...alert, at: new Date().toISOString() });
  }

  byCode(code: string): Alert[] {
    return this.raised.filter((a) => a.code === code);
  }
}

/** Hands each alert to a function, typically one that logs it (the logger redacts). */
export class CallbackAlert implements AlertPort {
  constructor(private readonly callback: (alert: Alert) => void | Promise<void>) {}

  async raise(alert: Alert): Promise<void> {
    checkAlert(alert);
    await this.callback(alert);
  }
}

// Context keys whose values must not leave the process in an email (CLAUDE.md section 10).
const SENSITIVE_KEY =
  /phone|e-?mail|otp|token|password|secret|id_?number|signature|authorization|cookie|^code$|^body$/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[nested]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        SENSITIVE_KEY.test(key) ? '[redacted]' : redact(v, depth + 1),
      ]),
    );
  }
  return value;
}

/** Emails each alert to an ops address. */
export class EmailAlert implements AlertPort {
  constructor(
    private readonly email: EmailPort,
    private readonly to: string,
    private readonly from?: string,
  ) {}

  async raise(alert: Alert): Promise<void> {
    checkAlert(alert);
    const firstLine = alert.message.split(/\r?\n/, 1)[0] ?? '';
    const subject = `[${alert.severity.toUpperCase()}] ${alert.code}: ${firstLine}`.slice(0, 200);
    const lines = [
      `Severity: ${alert.severity}`,
      `Code: ${alert.code}`,
      `Raised at: ${new Date().toISOString()} (UTC)`,
      '',
      alert.message,
      ...(alert.context === undefined
        ? []
        : ['', 'Context:', JSON.stringify(redact(alert.context), null, 2)]),
    ];
    await this.email.send({
      to: this.to,
      subject,
      text: lines.join('\n'),
      ...(this.from === undefined ? {} : { from: this.from }),
    });
  }
}

/** Raises each alert on every target, so a failed email does not stop the log; then reports failures. */
export class CompositeAlert implements AlertPort {
  constructor(private readonly targets: readonly AlertPort[]) {}

  async raise(alert: Alert): Promise<void> {
    const results = await Promise.allSettled(this.targets.map((target) => target.raise(alert)));
    const failures = results.filter((r) => r.status === 'rejected').map((r) => r.reason as unknown);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `${failures.length} of ${this.targets.length} alert targets failed`,
      );
    }
  }
}
