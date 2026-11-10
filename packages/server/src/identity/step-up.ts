import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql, withCompany, withSystem, type Database } from '@rent/db';
import type { AlertPort } from '@rent/integrations';
import { AuditService } from '../audit/audit.service';
import type { Clock } from '../core/clock';
import type { AppConfig } from '../core/config';
import { ALERT_PORT, CLOCK, CONFIG, DATABASE } from '../core/tokens';
import { claimTotpStep, totpSecretOf, totpStepOf } from './totp';

/** Wrong step-up codes allowed per person in a window, then the step-up locks (R1 F4). */
export const STEP_UP_ATTEMPTS = 5;
export const STEP_UP_WINDOW_MINUTES = 15;

export type StepUpOutcome = 'verified' | 'wrong_code' | 'locked';

/**
 * Step-up confirmation with the person's own TOTP code, for sensitive actions such as a
 * single-user landlord self-confirming an approval after cooling off (OQ-29).
 *
 * M11 review R1 F4: every attempt is counted before the code is compared, atomically, so parallel
 * guesses cannot share one count. Five in 15 minutes lock it until the window ends; each failure is
 * audited as `approval.step_up_failed` in the company's chain, and the lock raises an alert. A
 * code is accepted once: its time step is recorded, and a code from that step or an earlier one is
 * refused (F9).
 */
@Injectable()
export class StepUpVerifier {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(AuditService) private readonly audit?: AuditService,
    @Optional() @Inject(ALERT_PORT) private readonly alerts?: AlertPort,
    @Optional() @Inject(CLOCK) private readonly clock?: Clock,
  ) {}

  /** True when the code is the person's current TOTP code, unused, and the step-up is not locked. */
  async verifyTotp(personId: string, code: string, companyId?: string): Promise<boolean> {
    return (await this.check(personId, code, companyId)) === 'verified';
  }

  async check(personId: string, code: string, companyId?: string): Promise<StepUpOutcome> {
    const attempt = await this.countAttempt(personId);
    if (attempt > STEP_UP_ATTEMPTS) {
      await this.failed(personId, companyId, 'locked', attempt);
      return 'locked';
    }
    const secret = await totpSecretOf(this.database, this.config.BETTER_AUTH_SECRET, personId);
    const step = secret ? await totpStepOf(secret, code) : null;
    if (step !== null && (await claimTotpStep(this.database, personId, step))) {
      await this.reset(personId);
      return 'verified';
    }
    await this.failed(personId, companyId, step === null ? 'wrong_code' : 'code_reused', attempt);
    return 'wrong_code'; // the next attempt finds it locked
  }

  private key(personId: string): string {
    return `step-up:${personId}`;
  }

  /** Counts this attempt in the fixed window and returns its number (1 for the first). */
  private async countAttempt(personId: string): Promise<number> {
    const now = this.now();
    const windowStart = now - STEP_UP_WINDOW_MINUTES * 60_000;
    const key = this.key(personId);
    const result = await withSystem(this.database, { personId }, (tx) =>
      tx.execute<{ count: number }>(sql`
        insert into rate_limit (key, count, last_request) values (${key}, 1, ${now})
        on conflict (key) do update set
          count = case when rate_limit.last_request <= ${windowStart} then 1 else rate_limit.count + 1 end,
          last_request = case when rate_limit.last_request <= ${windowStart} then ${now} else rate_limit.last_request end
        returning count`),
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  private async reset(personId: string): Promise<void> {
    await withSystem(this.database, { personId }, (tx) =>
      tx.execute(sql`delete from rate_limit where key = ${this.key(personId)}`),
    );
  }

  private async failed(
    personId: string,
    companyId: string | undefined,
    reason: 'wrong_code' | 'code_reused' | 'locked',
    attempt: number,
  ): Promise<void> {
    if (companyId && this.audit) {
      const audit = this.audit;
      await withCompany(this.database, { companyId, personId, actorKind: 'staff' }, (tx) =>
        audit.append(tx, {
          companyId,
          action: 'approval.step_up_failed',
          recordType: 'person',
          recordId: personId,
          data: { reason, attempt: Math.min(attempt, STEP_UP_ATTEMPTS + 1) },
        }),
      );
    }
    // The alert goes once, on the attempt that locks it.
    if (attempt === STEP_UP_ATTEMPTS && reason !== 'locked')
      await this.alerts
        ?.raise({
          severity: 'warning',
          code: 'auth.step_up_locked',
          message: `A person's step-up confirmation is locked for ${STEP_UP_WINDOW_MINUTES} minutes after ${STEP_UP_ATTEMPTS} wrong codes`,
          context: { personId, ...(companyId ? { companyId } : {}) },
        })
        .catch(() => undefined);
  }

  private now(): number {
    return (this.clock?.now() ?? new Date()).getTime();
  }
}
