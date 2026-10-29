# ADR-007: E-signature built in-house

- **Status:** Accepted, 2026-10-28; legal sufficiency to be confirmed by counsel before Gate 1 (OQ-10)

## Context

The PRD recommends building e-signature for notices in-house (section 17): it is narrow, high-volume, and owning the audit trail matters more than a third-party brand. The same need covers leases (TL-07), move-in reports (TL-08) and renewal offers (TL-09). Tenants arrive mostly from WhatsApp links on mobile data, and per-envelope fees from commercial providers would weigh on margins.

## Decision

- **One engine** in the `esign` module, used by tenancy, notices and moveout.
- **Flow:** freeze the document (ADR-006); create a signing request with signers, roles and a required flag; issue one secure link per signer; capture a typed or drawn signature with explicit consent text; confirm with a one-time code to the phone on record; record evidence; append a certificate page when the last required signer is done; store the result write-once; record both hashes in the audit chain.
- **Evidence per signature:** signature image or typed name, consent text version, server time, verified phone or email, IP address, user agent, document SHA-256.
- **Notices** state that signing acknowledges receipt, not agreement. A notice cannot be declined; an unsigned notice escalates through the ladder to physical service.
- **Leases** can be declined, which returns the lease to Draft with the reason recorded.
- **Security:** token and code rules as in `CLAUDE.md` section 9; included in the M11 security review.

## Consequences

- No per-signature fees, and full control of the evidence and the WhatsApp-first flow.
- We carry the burden of proving the evidence standard is adequate under the Electronic Transactions Act 2008 (Act 772) and the Rent Act. The physical-service fallback and evidence bundle (LN-08, Phase 2) reduce the risk.
- Research on 2026-10-28 found that the Electronic Transactions Act (s.4(e)) excludes contracts for interests in immovable property, which may include leases. The Land Act also asks for a witness, a legal practitioner and registration (OQ-44). Notices are unaffected. Until counsel rules:
    - lease signing adds a witness signature;
    - leases over three years go to a lawyer;
    - stamping is tracked on each lease (OQ-45).
- Careful implementation and review are mandatory: this is a security-critical, no-login surface.

## Alternatives considered

- **DocuSign or Dropbox Sign.** Recognised brands, but per-envelope cost, data processed abroad and weaker WhatsApp flows.
- **Hybrid** (a provider for leases, in-house for notices). Two implementations and two evidence formats.

## Revisit when

- Counsel requires an accredited certification service or a qualified signature for leases.
- Disputes show the evidence package is being challenged.
