# ADR-009: Hosting region

- **Status:** Proposed, 2026-10-28. The founder accepted the decision rule below on 2026-10-28 (OQ-21); the region itself is fixed by the latency test before the first deployment. Local development (M1) does not depend on it.

## Context

Decision D5 asks for a choice between AWS Cape Town (af-south-1) and an EU region. Users are in Ghana on MTN, Telecel and AT mobile data; diaspora owners are mostly in the UK and US. AWS has no region in Ghana. Cape Town is closer on the map, but West African traffic often routes through Europe over submarine cables, so distance does not predict latency. Cape Town is an opt-in region where some services arrive later and prices are higher. The Data Protection Act 2012 (Act 843) governs transfers abroad; counsel must confirm what registration and safeguards it needs (OQ-14). The Revenue Administration Act 2016 (Act 915) s.27 requires tax records to be kept within the country for six years. The draft Data Protection Bill 2025 would localise biometric and ID data. Counsel to confirm how both apply (OQ-49).

## Decision

- **Cloud:** AWS.
- **Choose the region by measurement.** Over three days, including evening peaks, measure round-trip time and TLS handshake from Accra and Kumasi on MTN, Telecel and fixed broadband to af-south-1, eu-west-1 (Ireland) and eu-west-2 (London).
- **Rule:**
    - Choose af-south-1 if its median latency on mobile is at least 30 ms lower than the best EU region, and every service we need runs there: RDS for PostgreSQL, S3 with Object Lock, KMS, Secrets Manager, and our email provider.
    - Otherwise choose the faster of eu-west-1 and eu-west-2.
    - If the test cannot run in time, default to eu-west-1.
- **Portability:** infrastructure as code parameterised by region; backups copied to a second region; a CDN in front of static assets and the Expo web build.
- **Records in Ghana:** if counsel confirms Act 915 applies, keep a copy of financial and notice records in Ghana (OQ-49).

## Consequences

- The choice rests on data from the networks tenants actually use.
- A short task before first deployment.
- Moving region later stays possible, because nothing is hard-wired to one.

## Alternatives considered

- **Google Cloud africa-south1 (Johannesburg) or Azure South Africa North.** Viable, with the same distance-versus-routing question; AWS has the broadest managed services for this stack.
- **Colocation in Ghana.** Lowest latency and simplest data residency, but heavy operations for a small team. Revisit if counsel or the Bank of Ghana requires local hosting.

## Revisit when

- Counsel or the Bank of Ghana requires data to stay in Ghana.
- A major provider requires a specific region.
- Measured latency shifts as new cables and regions come online.
