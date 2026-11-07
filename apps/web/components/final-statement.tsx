import type { FinalStatementView } from '@rent/contracts';
import { formatBusinessDate } from '@/lib/business-dates';
import { cn } from '@/lib/cn';
import { checkStatement, statementSections } from '@/lib/move-out';
import { formatMinor } from '@/lib/tenancy-format';
import { Alert } from './ui/alert';

/**
 * The final statement (TL-11; plan 4.8), laid out so whoever approves it can see that it
 * balances: what is held, what is owed, how it is settled and what is left, then both checks
 * worked out again on screen. Every figure is the API's, from the ledger.
 */
export function FinalStatement({ statement }: { readonly statement: FinalStatementView }) {
  const check = checkStatement(statement);
  return (
    <div className="space-y-4 text-sm" data-testid="final-statement">
      <p className="text-slate-700">
        Last day {formatBusinessDate(statement.lastDay)}
        {statement.early ? ': an early end, so agreed charges and the break clause apply.' : '.'}
      </p>
      {statementSections(statement).map((section) => (
        <section key={section.key} aria-label={section.title} className="space-y-1">
          <h3 className="font-semibold text-slate-900">{section.title}</h3>
          <dl className="divide-y divide-slate-100 rounded-md border border-slate-200">
            {section.rows.map((row) => (
              <div
                key={row.key}
                className="flex flex-wrap justify-between gap-2 px-3 py-2"
                data-testid={`statement-${row.key}`}
              >
                <dt className={cn(row.strong ? 'font-semibold' : 'text-slate-700')}>{row.label}</dt>
                <dd className={cn('tabular-nums', row.strong && 'font-semibold')}>
                  {formatMinor(row.amountMinor)}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      {statement.creditToArrears.length > 0 || statement.depositToArrears.length > 0 ? (
        <details className="rounded-md border border-slate-200 px-3 py-2">
          <summary className="min-h-11 cursor-pointer py-2 font-medium">
            The lines it pays, oldest first
          </summary>
          <ul className="space-y-1 pb-2">
            {[
              ...statement.creditToArrears.map((l) => ({ ...l, from: 'Credit' })),
              ...statement.depositToArrears.map((l) => ({ ...l, from: 'Deposit' })),
            ].map((line) => (
              <li
                key={`${line.from}-${line.lineId}`}
                className="flex flex-wrap justify-between gap-2"
              >
                <span>
                  {line.from}: {line.invoiceNumber}, {line.label}
                  {line.periodStart && line.periodEnd
                    ? ` (${formatBusinessDate(line.periodStart)} to ${formatBusinessDate(line.periodEnd)})`
                    : ''}
                </span>
                <span className="tabular-nums">{formatMinor(line.amountMinor)}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <div
        className={cn(
          'space-y-1 rounded-md border px-3 py-2',
          check.balances ? 'border-emerald-300 bg-emerald-50' : 'border-red-300 bg-red-50',
        )}
        data-testid="statement-balance"
        data-balances={check.balances ? 'true' : 'false'}
      >
        <p className="font-semibold">{check.balances ? 'It balances' : 'It does not balance'}</p>
        <p>
          Held {formatMinor(check.inMinor)} = settled, kept and refunded{' '}
          {formatMinor(check.outMinor)}
        </p>
        <p>
          Owed {formatMinor(check.owedMinor)} = settled and still owed{' '}
          {formatMinor(check.settledMinor)}
        </p>
      </div>
      {!check.balances ? (
        <Alert tone="error">
          These figures do not add up. Do not approve it; report it so the statement can be checked.
        </Alert>
      ) : null}
    </div>
  );
}
