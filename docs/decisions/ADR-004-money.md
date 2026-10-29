# ADR-004: Money representation and rounding

- **Status:** Accepted, 2026-10-28

## Context

All amounts are Ghana cedis (GH₵1 = 100 pesewas). The product computes percentages (rent tax 8% and 15%, management fees), splits amounts across periods (annual rent into months, final-period proration) and allocates payments across lines. Floating point produces cent errors that make ledgers fail to balance and statements fail to regenerate.

## Decision

- **Unit.** Integer pesewas, held in a `Money` value type in `packages/domain/money`. The type carries the currency (`GHS`) and asserts `Number.isSafeInteger`. Multiplication uses `BigInt` internally, so no intermediate result loses precision.
- **Storage.** `bigint` columns named `*_minor`, plus a `currency char(3)` column. Never `float`, `real`, `double precision` or `numeric` for money.
- **Rates.** Integer basis points (8% = 800, 7.5% = 750).
- **Rounding.** Half up to the nearest pesewa, applied once per calculated line (one tax amount per receipt, one fee per receipt, one prorated amount per period), and only inside `packages/domain/money`. The rounding rule for tax is also a rules-table value (`rent_tax.rounding`, unverified), so a different rule from the tax adviser needs no code change.
- **Splitting.** Largest remainder: an annual rent of GH₵10,000 becomes twelve periods of GH₵833.33 with the 4 leftover pesewas on the first four periods, so the parts always add up exactly.
- **API.** Integer minor units in fields ending `Minor`. Clients format for display only (`Intl.NumberFormat('en-GH', { style: 'currency', currency: 'GHS' })`, shown as GH₵).
- **Enforcement.** A lint rule bans `parseFloat`, `toFixed` and `Math.round` in money code paths. fast-check properties prove that splits preserve totals, that allocation never exceeds the amount due, and that rounding is applied once.

## Consequences

- Sums are exact; ledgers balance to the pesewa.
- JSON numbers stay exact up to about GH₵90 trillion, far beyond any realistic portfolio.
- Developers must use `Money` helpers instead of arithmetic operators, which is caught in review and by lint.

## Alternatives considered

- **Decimal library everywhere** (decimal.js and similar). Correct, but slower and easy to mix with plain numbers by mistake.
- **`BigInt` end to end.** Exact, but JSON serialisation needs custom handling at every boundary.
- **`numeric` columns.** Exact in the database, but they arrive in JavaScript as strings or floats and invite mistakes.

## Revisit when

- A market with a different minor-unit exponent arrives. `Money` already carries currency; add the exponent.
