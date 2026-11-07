import { defineJob, type JobDefinition } from '@rent/server/jobs';
import { AGENT_CASH_CHECK_JOB, type AgentCashCheckService } from '@rent/server/ledger';
import { z } from 'zod';
import { fanOut, type WorkerDeps } from './jobs';

const companyDay = z
  .object({ companyId: z.string().uuid(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
  .passthrough();

/**
 * The agent cash check (founder decision F3; architecture section 10): `ledger.agent-cash-check`
 * nightly at 03:30 Africa/Accra, fanned out per company. Read only; any owner book whose 1070 is
 * below zero (a chargeback cannot be refused) raises the critical `ledger.agent_cash_negative`.
 */
export function agentCashJobs(
  deps: WorkerDeps & { readonly agentCash: AgentCashCheckService },
): JobDefinition<never>[] {
  return [
    fanOut(AGENT_CASH_CHECK_JOB, '30 3 * * *', `${AGENT_CASH_CHECK_JOB}.company`, deps),
    defineJob({
      name: `${AGENT_CASH_CHECK_JOB}.company`,
      scope: 'company',
      schema: companyDay,
      retry: { limit: 3, delaySeconds: 60, backoff: true },
      async handle({ companyId }, ctx) {
        const { negative } = await deps.agentCash.check(companyId, { alert: true });
        if (negative.length > 0)
          ctx.logger.warn({ owners: negative.length }, 'agent cash below zero');
      },
    }),
  ] as JobDefinition<never>[];
}
