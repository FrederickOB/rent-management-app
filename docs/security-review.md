# Security review (M11)

- **Status:** M11. Reviewed at `b11028d` (the M10 tip); the fixes landed on `m11-hardening`. The milestone's independent review checks the fixes again.
- **Covers:** OWASP ASVS 5.0, level 2, for authentication and sessions, authorisation and data isolation, and untrusted input reachable without a staff login (secure links, webhooks, uploads), plus field encryption and logging.
- **Method:** three reviewers who did not write the code, each on one area, read-only. Each finding had to name the code, a concrete attack or failure, and a fix. The owners reproduced each finding in a test before fixing it, where a test could show it.

## 1. Summary

| Area | High | Medium | Low | Open after M11 |
| --- | --- | --- | --- | --- |
| Authentication and sessions (A) | 1 | 4 | 11 | 1 accepted gap, 1 accepted risk, 1 item for M12 |
| Authorisation and isolation (Z) | 0 | 3 | 3 | none |
| Untrusted input, files and cryptography (U) | 1 (the same root cause as A1) | 1 | 9 | 1 item for M12 |

Every high and medium finding is fixed in M11. The two highs share one cause: the API trusted every proxy hop.

**Founder decisions taken in the review** (`docs/plans/M11.md` section 9, "Founder decisions during the build"):
- approver changes: widening the approver set needs a second person; narrowing it takes effect at once;
- invites: an existing person stays invited until they accept; phone-only roles never get an email; people are matched only on a verified identifier; resets only for password roles;
- SMS-only sign-in for tenants and caretakers is an accepted risk for the pilot;
- a lost authenticator is reset by a platform admin, by runbook;
- sign-in authenticator codes stay reusable within their window until M12.

## 2. Findings and outcomes

### A. Authentication and sessions

| # | Severity | Finding | Outcome |
| --- | --- | --- | --- |
| A1 | High | In production the API trusted every proxy hop, so `request.ip` was the client's own `X-Forwarded-For`. Every per-IP sign-in, TOTP, code and webhook limit could be bypassed. | **Fixed.** Fastify trusts only `TRUSTED_PROXIES`, and production refuses to start without it. Wrong passwords are also limited per account (an HMAC of the email). Tested (`apps/api/src/auth/request-origin.test.ts`, `m11-identity.int.test.ts`). |
| A2 | Medium | The 5-attempt cap on phone codes could be raced: concurrent wrong guesses counted as one. | **Fixed.** The attempt is counted atomically before the compare. Daily caps per phone (10 sends, 15 wrong codes) are alerted once, with their own error codes. Tested with 20 parallel guesses. |
| A3 | Medium | Invites attached unverified identifiers to the shared person record, so one company could pre-hijack access another company granted later. | **Fixed** (founder decision on invites): an existing person stays invited until they accept from a session that proves the role's identifier; caretakers never get an email; resets only for password roles. The first admin of a new company and a new platform admin follow the same rule. |
| A4 | Medium | The step-up authenticator code for a single user's self-confirm had no attempt limit and could be replayed. | **Fixed.** 5 failures in 15 minutes lock it, audited (`approval.step_up_failed`) and alerted; an accepted time step is refused again. |
| A5 | Medium | Authentication events after sign-in weren't audited, contrary to the M1 plan. | **Fixed.** Password set, reset and change, TOTP enrolment, backup codes, session revocation, sign-out, failed sign-in and step-up failures are audited without secrets; `auth.signed_in` carries a keyed IP hash and the user agent. |
| A6 | Low | A tenant's device list went empty after 24 hours. | **Fixed** (`freshAge: 0`); the app shows an error with a retry instead of an empty list. |
| A7 | Low | CSRF relied on SameSite=Lax alone; login CSRF was possible. | **Fixed.** An untrusted Origin, a cross-site `Sec-Fetch-Site` or a form or text body on any unsafe method is refused, the auth mount included. Webhooks, the links server and the native app still work (tested). |
| A8 | Low | The password-reset `redirectTo` wasn't pinned, so a reset token could go to another app claiming our scheme. | **Fixed:** pinned to `${WEB_ORIGIN}/accept-invite`. |
| A9 | Low | MFA lifecycle: `get-totp-uri` re-revealed the seed; backup codes needed only the password, were encrypted rather than hashed; codes could be replayed within their window. | **Fixed** for get-totp-uri, backup codes (a current code is needed; stored hashed) and the step-up replay. **Accepted gap:** a sign-in code can be used twice within its window until M12 (founder). Reuse still needs the password; the web e2e suite moves to signing in once per person, then the guard switches on. |
| A10 | Low | The session cookie used `__Secure-`, not `__Host-`. | **Fixed** in production. |
| A11 | Low | Production didn't refuse the published development `BETTER_AUTH_SECRET`, which serves many purposes. | **Fixed:** production refuses it. **M12:** separate keys per purpose and a rotation procedure (see section 4). |
| A12 | Low | Password hashing was below OWASP's scrypt guidance. | **Fixed:** scrypt N=2^14, r=8, p=5 (16 MiB per hash); old hashes are rewritten at the next sign-in. |
| A13 | Low | No change-password page; reset tokens lived 3 days, like invites. | **Fixed:** a change-password page; invites 3 days, resets 1 hour; a change keeps the `password_totp` session class. |
| A14 | Low | Signing in again left the old session valid; no way to sign a person out everywhere; no lost-authenticator process. | **Fixed:** a new sign-in ends the replaced session; platform admins can reset two-factor and sign a person out everywhere, with a reason, audited (`docs/runbooks/lost-authenticator.md`). |
| A15 | Low | Tenants and caretakers sign in with an SMS code only (AD-06). | **Accepted risk for the pilot** (founder). Optional authenticator sign-in for caretakers comes later. |
| A16 | Low | Response timing revealed registered phones and emails. | **Fixed:** codes and emails are sent after the response. |
| A17 | Known | No breached-password check. | **Fixed:** new passwords are checked against Have I Been Pwned by hash prefix. If the service is down, the password is accepted and an alert raised. |

### Z. Authorisation and isolation

| # | Severity | Finding | Outcome |
| --- | --- | --- | --- |
| Z1 | Medium | A scoped agency admin could lift their own scope or create unscoped staff, and could use company-wide actions. | **Fixed.** Nobody changes their own scope or approver flag; a scoped admin assigns only scopes within their own; company-wide actions (company settings, support grants, the subscription, the notice-to-quit acknowledgement, the agency's own settlement account) are refused to scoped people. |
| Z2 | Medium | One admin could defeat the two-person rule by removing the other approver or inviting a second account. | **Fixed** (founder decision on approvers): each request records its eligible approvers, and the engine and the database (RA018) refuse anyone else. Widening the approver set goes through approvals; narrowing is immediate and alerted; single-user requests are alerted to approvers removed in the last 30 days. The approvals engine is a required dependency, so the rule can't switch off. |
| Z3 | Medium | An invite reused another landlord's stored person record: it leaked that landlord's name for the tenant and could lock the person out of the tenant app. | **Fixed:** responses show the name the inviter typed; tenant-app sessions always act as the tenant; invites to existing people wait for acceptance. |
| Z4 | Low | `SECURITY DEFINER` functions searched the temporary schema first, so a temporary table could shadow a real one. | **Fixed** (migration 0068): `pg_temp` last on every definer function; TEMPORARY revoked from the application role. |
| Z5 | Low | `app.deposit_deduction_room` didn't check the company. | **Fixed** (0068). |
| Z6 | Low | The application role could read every company's raw webhook payloads. | **Fixed** (0069): forced RLS makes `webhook_inbox` visible only in a system transaction or to narrow functions. Revoking SELECT outright would have broken a passed test; every code path already reads it as the system. |
| Z7 | Known | A tenant session could read document rows beyond its own. | **Already closed** by earlier migrations; a new isolation test proves it. |
| Z8 | Known | The tenant search put phone numbers in the URL. | **Fixed:** search by POST. |

### U. Untrusted input, files and cryptography

| # | Severity | Finding | Outcome |
| --- | --- | --- | --- |
| U1 | High | The trusted-proxy flaw (A1), as it affected the webhook bad-signature limits: unbounded growth of `webhook_inbox` and `rate_limit`. | **Fixed** with A1, plus nightly pruning of expired rate-limit rows and of rejected (unsigned) webhook rows older than 30 days. |
| U2 | Medium | The job-sheet photo posts read up to about 100 MB into memory before checking the link, so a handful of requests could take down the links server. | **Fixed:** declared size refused first, per-address and per-server upload limits, the link checked with the API before the body is read, and parts streamed to disk (founder approved the test changes). |
| U3 | Low | Media staging didn't pin the object version it checked. | **Fixed:** the HEAD's version is pinned for the type check, the hash and the copy. |
| U4 | Low | Inbound email and WhatsApp attachments were stored by their declared type. | **Fixed:** bytes are sniffed and must match, otherwise the file is stored as rejected. |
| U5 | Low | Downloads had no `no-store`; user files rendered inline. | **Fixed:** `no-store` always; user media and inbound attachments download as attachments. |
| U6 | Low | Two rate-limit keys held an unkeyed hash of the IP. | **Fixed:** keyed hash. |
| U7 | Low | A link's code lockout reset every 30 minutes, indefinitely. | **Fixed:** after 3 lockouts the link is revoked and staff are alerted. |
| U8 | Low | The links server took the client IP from a header the client can set when no proxy overwrites it. | **Fixed:** only `CLIENT_IP_HEADER`, set by the edge; a real deployment refuses to start without it. |
| U9 | Low | Expired or revoked links still returned personal data to the links server. | **Fixed** for pay, receipt and signing links: a dead token gets the closed screen only. |
| U10 | Low | Tenant and artisan photos kept their EXIF and location. | **Fixed** for photos (job sheet, tenant app, staff repair photos, inbound WhatsApp and email). **M12:** location metadata in video and audio, tested with real phone samples (founder). |
| U11 | Low | The tax CSV export allowed spreadsheet formula injection. | **Fixed.** |
| U12 | Known | No malware scanning of uploads. | **Fixed:** ClamAV scans every upload; a file is served to nobody but its uploader until clean (409 `DOCUMENT_SCAN_PENDING`), and an infected file is quarantined and never served (410 `DOCUMENT_QUARANTINED`). The real scanner runs in CI. |
| U13 | Info | The WhatsApp media fetch followed redirects. | **Fixed:** redirects are refused. |

### Found during the build

- **The database pool had no error listener.** A connection ended by the server (a restart, a failover) would have crashed the API or worker. Fixed on M10 and M11, with a test (`packages/db/src/pool-errors.int.test.ts`).
- **The native tenant app never kept its session cookie** (since M3), because the sign-in client's cookie prefix didn't match ours. Fixed, with a test against the real client.
- **CI now runs a dependency audit**, failing on high and critical advisories in production dependencies. One advisory is excepted, with the founder's approval: zod 3 inside Expo's build-time tools.

## 3. Accepted risks and gaps

| Item | Why it's accepted | Revisit |
| --- | --- | --- |
| SMS code as the only factor for tenants and caretakers (A15) | AD-06; the pilot's users sign in by phone. Codes are now limited per code, per day and per phone. | Optional caretaker TOTP, later |
| Sign-in TOTP code reusable within its window (A9) | Guarding it now slows the web e2e suite by about 50 minutes; reuse also needs the password. | M12 |
| Support under a grant sees an overview only | The grant text says support may read the company's records; the access built is narrower, which is safe. | When support needs more |

## 4. For M12 (first deployment)

- Separate keys per purpose for what `BETTER_AUTH_SECRET` does today (cookies, TOTP secret encryption, code and IP HMACs, the signing hasher), with a rotation procedure. Rotating it today would lock out every staff authenticator.
- The AWS KMS adapter; production refuses the local one.
- `TRUSTED_PROXIES` and `CLIENT_IP_HEADER` from the real load balancer and edge.
- TLS at the edge, and HSTS `includeSubDomains` once the domains are known.
- Edge logs drop query strings (the Hubtel webhook secret).
- A lifecycle rule for discarded uploads; storage access logs; encrypted local dumps.
- Paging and on-call; platform-wide or company-wide session revocation.
- The audit log records names only as "changed" (founder decision; counsel under OQ-65).
- Location metadata in video and audio.
- An external penetration test before live rent collection (founder track).

## 5. Controls checked and found sound

- **Isolation:** forced RLS on every company table, with a CI test; composite foreign keys with `company_id`; context set per transaction; restrictive scope policies; the single `PolicyService` with its lint rule; ids resolved under the caller's scope before use; ID and TIN reveals need a permission, a reason and an audit event.
- **Support access:** refused by the database without a grant; read-only; audited before reading.
- **Secure links:** 256-bit tokens stored as SHA-256; one purpose and recipient per token; codes hashed with a key bound to their challenge, 10 minutes, 5 tries, sent only to the destination on record; a strict nonce CSP; no cookies; `no-store`.
- **E-signature evidence:** the frozen, fingerprinted document; server timestamps; consent text and its hash; write-once storage with Object Lock; both hashes in the audit chain.
- **Webhooks:** HMAC and shared-secret checks in constant time; money posted only after the provider's verify endpoint matches exactly; unique on provider and event.
- **Uploads:** exact presigned policies; size and type re-checked; bytes sniffed; images re-encoded; the zip guard on imports.
- **Field encryption:** AES-256-GCM with AAD binding company, table, column and row; per-company keys; a keyed blind index.
- **Sessions:** database sessions with idle and absolute limits per role; TOTP mandatory for password roles; memberships re-read on every request.
- **Logging:** the redactor, route templates only in request logs, no tokens in links logs (and now none in load-test logs).

## 6. Not applicable at level 2

OAuth and OIDC, federation, self-contained tokens (V9), GraphQL, WebSocket (the inbox uses server-sent events), WebRTC, OS command and LDAP or XPath injection, unsafe deserialisation beyond JSON and xlsx, archive extraction to disk, and public-key signatures (PAdES is deferred, ADR-006). TLS (V12) is the deployment's, in M12.
