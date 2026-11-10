# Personal data breach

- **Status:** M11 (decision 5; NFR data protection). The controls this runbook relies on are built: field encryption, redacted logs, audited reveals and exports, hash-chained audit, write-once evidence. **What Act 843 requires after a breach, who must notify whom, and by when, has not been answered by counsel** (OQ-14, OQ-50). This runbook states no deadline. Until counsel answers, do everything below as fast as you can and ask counsel the same day.
- **Covers:** a personal data breach under the Data Protection Act 2012 (Act 843): personal data the product holds that is read, copied, changed, lost or destroyed by someone who shouldn't have, or exposed to that risk. That includes:
  - a database copy or backup that leaves our control;
  - a staff or platform admin account used by someone else;
  - a bug that shows one company's or tenant's data to another;
  - messages sent to the wrong person;
  - a provider's own breach.

  `incident-response.md` runs alongside; a breach is always SEV1.
- **Who is who:**
  - **The landlord or agency is the controller** of its tenants' data. The product treats it so: the request register lives in the landlord's app.
  - **The platform processes it for them,** and is itself the controller of its own staff and customer accounts.
  - Whether the platform is a processor, a controller or both under Act 843, and which registrations follow, is OQ-50, for counsel.

## 1. Contain

Do what stops the exposure first. Keep evidence (section 4) at the same time where you can; where you can't, containment wins.

| If the path is | Do |
| --- | --- |
| A staff or platform admin account | Sign them out everywhere and reset their two-factor (`lost-authenticator.md`, "Sign out everywhere"). Remove their membership (Settings → Users and roles). Ask the company's admin to end any support grant (`support-access.md`). |
| Database credentials, a server, or a leaked `.env` | Change the database passwords and the application's secrets. In M12 that is the secrets manager. See the warning below before rotating `BETTER_AUTH_SECRET`. |
| A database dump or backup (`pnpm db:backup` writes plain dumps to `./backups`) | Find every copy, who had it, and where it went. A local dump is not encrypted. |
| Messages going to the wrong people | Stop the worker: nothing more is sent, and every job resumes safely once restarted (`queue-backlog.md`). |
| A bug showing data across companies or tenants | Take the feature down, or stop the API, until it is fixed. Row level security should make this impossible, so treat it as a defect in the database policy and fix it there, with a cross-company isolation test. |
| A provider (Paystack, Meta, Hubtel, Postmark, Expo, the identity provider, AWS) | Get the provider's own account of what was exposed, in writing. Change our keys with them. |

**Sessions can't all be ended at once.** "Sign out everywhere" works one person at a time. **Gap:** there is no control that ends every session on the platform, or every session of one company.

**Don't rotate `BETTER_AUTH_SECRET` on impulse.** Every staff authenticator secret is encrypted with it (`packages/server/src/identity/totp.ts`), and several keyed hashes use it. Rotating it would lock every staff member out of two-step sign-in. **Gap:** there is no rotation procedure yet for it, for `BLIND_INDEX_MASTER_KEY` or for the field-encryption key. M12 must write one.

## 2. Assess

Answer these, with counts and ids rather than names.

1. **What happened, and when?** First known access, last known access, and when we found out (UTC).
2. **Which companies?** Each one is a controller that must be told (section 3).
3. **Which categories of data?** Use the categories in `docs/data-protection.md`. **Were field-encrypted values exposed together with the keys?** (Below.)
4. **Whose data, and how many people?** Tenants, their contacts, owners, staff and artisans, counted per company.
5. **Is it still exposed?** Can the copy be recovered or confirmed destroyed?
6. **What harm could follow?**
   - fraud with ID or account numbers;
   - scams by someone posing as the landlord, using names, phones and amounts owed;
   - distress from messages or notices being read.

**Where to look:**

- **The company's audit chain:**
  - `support.request`;
  - ID number reveals;
  - settlement account reveals;
  - `data_protection.export_requested`, `data_protection.export_prepared` and `data_protection.export_link_issued`;
  - sign-ins (`auth.signed_in`, `auth.sign_in_failed`, with a keyed hash of the address);
  - membership changes.
- **The platform's chain:** account recovery, replays and retries.
- **Alerts** (`alert_event`, the ops email).
- **The API's and worker's logs.** They hold request ids but no phones, emails, codes or tokens (the logger redacts them, and a test proves it).
- **Gap:** object storage access logs are not configured, locally or yet in production (M12), so downloads of files can't be traced from storage itself.

**Whether it is a breach that the law requires to be notified** is for counsel. Send counsel the answers above.

### What an attacker with the database alone can and can't read

"The database alone" means a dump, a backup or the database itself, without the application's secrets (`BETTER_AUTH_SECRET`, `BLIND_INDEX_MASTER_KEY`) and without the key management service.

**Can't read:**

- **Field-encrypted values** (AES-256-GCM, a per-company data key wrapped by KMS, each value bound to its company, table, column and row):
  - tenants' Ghana Card and passport numbers;
  - company tenants' and owners' TINs;
  - owners' and agencies' bank and MoMo account numbers;
  - the MoMo number a payment was made from.

  What *is* in the clear is their masked form: a Ghana Card as `GHA-*******89-0` (two digits and the check digit), others and account numbers by their last four. A keyed blind index sits beside each, and can't be reversed without `BLIND_INDEX_MASTER_KEY`.
- **Passwords** (scrypt hashes).
- **Authenticator secrets** (encrypted with `BETTER_AUTH_SECRET`).
- **Backup codes** (keyed hashes).
- **One-time codes** (hashed, valid 10 minutes).
- **Secure links:** only each token's SHA-256 is stored, so no pay, signing, notice or job-sheet link can be opened from a dump.
- **Files:** signed leases and notices, receipts, photos, voice notes, drawn signatures and exports are in object storage, not the database. The database holds their keys and fingerprints only.

**Can read, in full:**

- **Tenants:** name, phone, WhatsApp number, email, occupation, notes, and a company tenant's registration details.
- **Tenants' contacts:** guarantors, next of kin, employers, signatories and finance contacts, with their phones and emails.
- **Owners:** name, phone, email, country of residence.
- **Staff:** name, email, phone.
- **Artisans:** name, phone.
- **Leases and rents;** invoices, payments, receipts and allocations (amounts, dates, methods).
- **Messages:** the text in full.
- **Notices:** their facts.
- **Consent records.**
- **Signature evidence:** the typed name, the signer's IP address and device, and the masked phone or email the code went to.
- **Session records:** IP address and device. Treat every live session as exposed and end those you can.
- **Payment providers' webhook bodies** as received (`webhook_inbox`), which may carry payer details.
- **Audit row changes:** contact details appear only as "changed", never by value.

**With the database and the application's secrets** (a compromised server, or a leaked environment), assume **everything** is readable. In production, decrypting field values also needs the server's permission to use the KMS key (M12). Locally the key is `LOCAL_KMS_MASTER_KEY` in `.env`.

## 3. Notify

**Every affected company, at once:**

- **Who:** each company's landlord or agency admins. They are the controller for their tenants' data and must be able to act on their own duties.
- **How:** the incident lead tells them by email, with what is known: what happened, the categories of data, approximate counts, what has been done and what they should do.
- **What not to send:** another company's details.
- **When:** keep them updated as the assessment firms up.

**The Data Protection Commission and the people affected:**

- **For counsel:**
  - whether Act 843 requires the Commission and the people affected to be told;
  - what it requires of the landlord and of the platform, and in what form;
  - **by when.**

  That is OQ-14 (Act 843 duties) and OQ-50 (the platform's role).
- **Gap:** neither question asks about breach notification in so many words. Counsel should be asked directly, and the answer recorded in `docs/open-questions.md`.
- **Who sends what:** counsel advises on each company's notice and the platform's own. Don't send anything to the Commission until counsel has seen it.
- **Ask counsel at the same time** whether any other body must be told.

**Reaching tenants:**

- Tenants are reached through their landlord, who holds the relationship and the consent records.
- **Gap:** broadcasts follow consent (CM-09), so a tenant who opted out of every channel can't be reached by the product. Whether a notice the law requires may go to them anyway is for counsel, as OQ-55 asked for security alerts. Until then, the landlord reaches them another way: by post, or in person.

**Staff and owners** whose own data is affected: tell them by email from the platform.

**Every message must:**

- be plain;
- say what happened, what data and what they can do (for example: watch for calls or messages claiming to be the landlord and asking for money or codes);
- give the contact address.
- **Never ask anyone for a password, a code or an ID number** in a breach notice. That is what an attacker's copy would ask for.

## 4. Evidence to keep

Take these before changing anything you can, and record who took each, when, and its SHA-256 (`shasum -a 256 <file>`):

- **A snapshot of the database before containment changed it** (M12: an RDS snapshot; locally `pnpm db:backup`). Signing someone out deletes their session rows, and with them the session IP and device.
- **The audit chains.** On a copy, `scripts/drill-checks.ts` recomputes every chain and checks it against the heads anchored daily in write-once storage. That proves whether the audit log was rewritten (`backup-restore.md`).
- **The `alert_event` rows and the alert emails** of the period.
- **The API's and worker's logs** of the period.
- **The `ops_action` and `support_grant` rows,** with their audit events.
- **Provider statements and tickets,** counsel's advice, and every message sent to companies, people and the Commission, with times.

**Where it goes:**

- in restricted storage the founder controls, never in this repository;
- the founder decides who may read it;
- how long it is kept is for counsel, since the retention rules are unverified (`data_retention.*`; OQ-14).

## 5. Record

**Write the breach record** alongside the incident record (`incident-response.md`). It should hold no personal data; keep any list of affected people separately, in the restricted evidence store.

```
Breach <date>-<n>   Lead: <name>   Counsel: <name>
Found (UTC):   First and last known access (UTC):   Contained (UTC):
What happened and how:
Companies affected (ids):   People affected (counts by kind):   Categories of data:
Field-encrypted values exposed with their keys? yes / no / unknown
Likely consequences:
What was done to contain it and to stop it happening again:
Companies told (who, when):   Commission told (when, by whom, reference):   People told (how, when):
Counsel's advice (date) and the decisions taken, with reasons:
Evidence kept (files, SHA-256, who holds them):
```

**Afterwards:**

- fix the cause, with a test named for what it proves (`NFR-DP`, `NFR-SEC`);
- add the finding to `docs/security-review.md`.
