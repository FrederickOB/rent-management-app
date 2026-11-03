import { terminationSteps, type AmountLine, type TerminationFigures } from '@/lib/termination';

/**
 * The early-termination settlement, step by step (AR-04, P13; plan 5.4): charges, any unused-day
 * credit, the prepayment applied to open lines, deductions, the refund and what is still owed.
 * Each figure is the API's; the steps only say them in order, so a second person can check them.
 */
export function TerminationSteps({
  figures,
  charges,
  deductions,
}: {
  readonly figures: TerminationFigures;
  readonly charges: readonly AmountLine[];
  readonly deductions: readonly AmountLine[];
}) {
  return (
    <ol className="space-y-4" data-testid="termination-steps">
      {terminationSteps(figures, { charges, deductions }).map((step) => (
        <li
          key={step.key}
          data-testid={`termination-step-${step.key}`}
          className="space-y-1 border-l-2 border-slate-200 pl-3 text-sm"
        >
          <p className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-medium text-slate-900">{step.title}</span>
            {step.total ? (
              <span className="font-semibold tabular-nums" data-testid="termination-step-total">
                {step.total}
              </span>
            ) : null}
          </p>
          {step.lines.length ? (
            <ul className="space-y-0.5 text-slate-700">
              {step.lines.map((line, index) => (
                <li key={`${line.label}-${index}`} className="flex flex-wrap justify-between gap-2">
                  <span>{line.label}</span>
                  <span className="tabular-nums">{line.amount}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {step.note ? <p className="text-slate-600">{step.note}</p> : null}
        </li>
      ))}
    </ol>
  );
}
