# ADR-008: Payment settlement model

- **Status:** Accepted, 2026-10-28 (decision D1, confirmed by the founder); provider capabilities to be confirmed (OQ-01 to OQ-03)

## Context

The PRD leaves open whether client money should pass through the platform or settle directly into landlord and agency accounts. Holding client money likely needs a Bank of Ghana licence or a licensed partner structure, plus a client-money ledger and payout operations. Agencies still need to collect for many owners and remit to them (AC-05).

## Decision

- **The platform is a technology provider and never holds rent.** It collects through licensed payment service providers, Paystack first, using subaccounts or splits.
- **Settlement destination per payment,** resolved from lease → unit → property → owner → management agreement:
    - the owner's own account, when the owner self-manages or the agreement says rent goes to the owner;
    - the agency's client account, when the agency holds the money.
- **Every provider used for rent, the failover included, must settle directly.** A provider that settles into a platform balance cannot carry rent (prd-issues 9).
- **Refunds, deposit returns and owner remittances** are paid outside the platform by the landlord or agency, and recorded with a reference and proof (P12, P13, P16). Provider refunds and chargebacks are recorded as reversals (P21).
- **Platform revenue** (subscriptions, PB-07) is collected on the platform's own provider account, never mixed with rent.
- **Settlement accounts are high-risk records.** Adding or changing one needs an account-name check with the provider where available, two-person approval, a 24-hour delay before first use, and an SMS and email alert to the owner. Redirecting rent is the most likely fraud against this product.
- **Reconciliation** compares provider transactions and settlement reports with our payments every day (`docs/architecture.md`, section 8).

## Consequences

- No client money on the platform's books. That alone may not avoid licensing: Act 987 s.7(2)(l) and (m) cover payment aggregation and "any electronic platform for payment or receipt of funds", whether or not funds are held. Counsel's written opinion (OQ-03, OQ-43) is a gate before live rent collection.
- We depend on provider features. Paystack documents GHS splits, bank-account subaccounts, a settlements API and metadata. MoMo wallets as subaccount destinations are not documented and need written confirmation (OQ-01). New or changed subaccounts are paid only after Paystack verifies them (OQ-42).
- Refunds and chargebacks after a payout may be debited from the platform's account, not the landlord's; Flutterwave says it does this. Landlord terms must let the platform recover such amounts (OQ-41).
- Provider fees are borne by the landlord or agency by default (OQ-07, decided 2026-10-28). A tenant surcharge is a per-company option only if provider and Bank of Ghana rules allow it.
- Failover waits for a second direct-settlement provider. Flutterwave documents bank-account splits in Ghana; Hubtel has no splits, so it cannot carry rent (OQ-02).

## Alternatives considered

- **Collect, then pay out.** Simpler fee capture and refunds, but licensing, client-money accounting, payout operations and much higher fraud and compliance exposure.
- **Each landlord's own provider account, driven by their API keys.** No marketplace setup, but storing customers' secret keys is a security liability, and onboarding is heavy for small landlords.

## Revisit when

- Providers cannot support direct settlement at rent volumes.
- The platform obtains, or partners for, a licence that makes holding funds worthwhile.
