# ADR-006: PDF rendering and document fingerprinting

- **Status:** Accepted, 2026-10-28

## Context

The product produces leases, notices, receipts, owner statements, move-in reports and signature certificates. They are evidence before Rent Control or a court, so a document must be provably unchanged. Signers must see exactly what they sign, and documents carry each company's branding (AD-01) and the cedi sign (GH₵, U+20B5).

## Decision

- **Templates** live in `packages/documents` as versioned HTML templates (React components rendered to static HTML). The same template produces the on-screen preview and the PDF.
- **Freezing.** A document is defined by its template version plus a JSON data snapshot. Both are stored, with the snapshot's hash.
- **Rendering** runs in `apps/worker` with headless Chromium (Playwright), kept warm in a small pool. Fonts are embedded and must include U+20B5.
- **Fingerprint.** SHA-256 over the final PDF bytes, stored on the `document` row and written into the audit chain.
- **Storage.** Final PDFs go to a write-once bucket with S3 Object Lock (SeaweedFS locally, ADR-013). The retention period comes from the rules table (`data_retention.financial_and_notices`). While that value is unverified, objects are locked in governance mode, which only a break-glass role can shorten; once counsel verifies it, new objects use compliance mode (amended 2026-10-28 in M1).
- **Signing** appends a certificate page with pdf-lib and stores the result as a new document with its own hash. The original is never modified.
- **Regeneration.** We never regenerate a stored document. Statements are regenerated for their figures (ADR-003), not their bytes.
- **Verification** (Phase 2): a page that hashes an uploaded PDF and reports whether it matches a stored document.

## Consequences

- One template system serves preview and PDF, so what signers read is what is stored.
- The worker image includes Chromium (a few hundred MB). Rendering takes one to two seconds, which fits the 60-second receipt target with a warm pool.
- Byte-for-byte reproducible rendering is not required, because the stored bytes are the evidence.

## Alternatives considered

- **React-PDF.** Lighter, with no browser, but its own layout system means a second set of templates for the HTML preview.
- **Hosted PDF service.** Less to run, but documents with personal data leave our region.
- **PAdES digital signatures on every PDF.** Stronger tamper evidence in any PDF reader. Worth adding in Phase 2 with a platform signing certificate, if counsel advises.

## Revisit when

- Counsel asks for PAdES or an accredited timestamp.
- Render latency threatens the receipt target at month-end volume.
