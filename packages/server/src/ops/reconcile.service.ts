import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Module } from '@nestjs/common';
import { schema, type Database } from '@rent/db';
import { businessDateOf, instantFrom, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { AuditModule } from '../audit/audit.module';
import { AuditService } from '../audit/audit.service';
import type { Clock } from '../core/clock';
import { invalid } from '../core/errors';
import { jobErrorSummary } from '../core/jobs/job-error';
import type { PaymentProviders } from '../core/payment-providers';
import { CLOCK, DATABASE, PAYMENT_PROVIDERS } from '../core/tokens';
import { PaymentsModule } from '../payments/payments.module';
import { ReconciliationService, type TransactionRun } from '../payments/reconciliation.service';
import { withPlatform } from '../subscription/platform';
import { operatorData, opsReason, type OpsOperator } from './operator';

/** One provider's part of a run: what the transactions and settlements reconciliation did. */
export interface ReconcileProviderResult {
  readonly provider: string;
  readonly transactions: TransactionRun;
  readonly settlementsPosted: number;
}

export interface ReconcileRunResult {
  /** The run's id in the platform's audit chain (`ops.reconciliation_*`). */
  readonly runId: string;
  readonly day: string;
  readonly providers: readonly ReconcileProviderResult[];
}

/**
 * A day's reconciliation run by hand (M11 coordinator follow-up; `pnpm ops:reconcile`): the very
 * services of `payments.reconcile-transactions` and `payments.reconcile-settlements`, in their
 * order (every provider's transactions, then every provider's settlements), for one Accra day and
 * one provider or all. Both are idempotent: a missed payment goes through the normal path, which
 * posts each charge once; a settlement posts once per provider settlement id; an exception is
 * raised once per kind and reference. So running a day again changes nothing already reconciled.
 *
 * The run takes a reason and an operator (a platform admin) and is recorded in the platform
 * company, in one transaction each time: before anything runs, an ops_action row (`reconcile_run`,
 * the run's id and day, outcome `started`) and `ops.reconciliation_started` in its audit chain;
 * afterwards a second row (ops_action is append-only), outcome `finished` or `failed`, with
 * `ops.reconciliation_finished` and the counts or `ops.reconciliation_failed` and the error's code.
 */
@Injectable()
export class ReconciliationRunService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PAYMENT_PROVIDERS) private readonly providers: PaymentProviders,
    @Inject(ReconciliationService) private readonly reconciliation: ReconciliationService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async runAs(
    operator: OpsOperator,
    input: { readonly day: string; readonly provider?: string | null },
    reason: string,
  ): Promise<ReconcileRunResult> {
    const why = opsReason(reason);
    const day = this.dayOf(input.day);
    const names = input.provider ? [input.provider] : this.providers.names();
    for (const name of names)
      if (!this.providers.has(name))
        throw invalid('bad_provider', 'That payments provider is not configured here');
    const runId = randomUUID();
    const run = { runId, day, reason: why };
    await this.record(operator, run, 'started', {
      day,
      providers: names,
      via: operator.via,
      reason: why,
    });
    const transactions = new Map<string, TransactionRun>();
    const settlements = new Map<string, number>();
    let current = names[0] ?? null;
    try {
      for (const provider of names) {
        current = provider;
        transactions.set(provider, await this.reconciliation.transactions(provider, day));
      }
      for (const provider of names) {
        current = provider;
        settlements.set(provider, await this.reconciliation.settlements(provider, day));
      }
    } catch (error) {
      const e = error as { name?: unknown; message?: unknown; code?: unknown };
      await this.record(operator, run, 'failed', {
        day,
        provider: current,
        error: jobErrorSummary({ name: e.name, message: e.message, code: e.code }),
      });
      throw error;
    }
    const providers = names.map((provider) => ({
      provider,
      transactions: transactions.get(provider)!,
      settlementsPosted: settlements.get(provider) ?? 0,
    }));
    await this.record(operator, run, 'finished', { day, providers });
    return { runId, day, providers };
  }

  /** An Accra day, today or earlier: the provider has nothing for a day still to come. */
  private dayOf(value: string): string {
    let day: string;
    try {
      day = toIsoDate(parseBusinessDate(value));
    } catch {
      throw invalid('bad_day', 'The day is a date, YYYY-MM-DD');
    }
    const today = toIsoDate(businessDateOf(instantFrom(this.clock.now())));
    if (day > today) throw invalid('bad_day', 'Reconcile today or an earlier day');
    return day;
  }

  /** One step of the run: its ops_action row and its audit event, together. */
  private async record(
    operator: OpsOperator,
    run: { readonly runId: string; readonly day: string; readonly reason: string },
    outcome: 'started' | 'finished' | 'failed',
    data: Record<string, unknown>,
  ): Promise<void> {
    await withPlatform(
      this.database,
      {
        personId: operator.personId,
        requestId: operator.requestId ?? null,
        actorKind: operator.via === 'console' ? 'platform_admin' : 'system',
      },
      async (tx, platformId) => {
        await tx.insert(schema.opsAction).values({
          companyId: platformId,
          kind: 'reconcile_run',
          targetId: run.runId,
          targetName: run.day,
          reason: run.reason,
          personId: operator.personId,
          outcome,
        });
        await this.audit.append(tx, {
          companyId: platformId,
          action: `ops.reconciliation_${outcome}`,
          recordType: 'reconciliation_run',
          recordId: run.runId,
          data: { ...data, ...operatorData(operator) },
        });
      },
    );
  }
}

/**
 * The reconciliation run's module, for `pnpm ops:reconcile` only: it brings payments (and through
 * it billing and the ledger). The command loads tax, management fees and subscriptions beside it,
 * as the worker does, so a payment posted here is assessed and charged as the worker would.
 */
@Module({
  imports: [PaymentsModule, AuditModule],
  providers: [ReconciliationRunService],
  exports: [ReconciliationRunService],
})
export class OpsReconcileModule {}
