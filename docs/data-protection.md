# Data protection (Act 843)

- **Status:** M11 (decision 5; prd-issues 30; NFR data protection). Written from the code on 10 Nov 2026.
  - **Built:** the request register, the tenant export, erasure limited by retention, messaging stopped on erasure, and the nightly retention review.
  - **Unsettled:** every retention period, the response time to a request, registration and hosting abroad. All of these are counsel's (OQ-14, OQ-49, OQ-50, OQ-65).
  - **Not legal advice:** this document says what the product does. Whether that meets Act 843 is for counsel.
- **Covers:**
  - a checklist mapping Act 843's data protection principles to what the product does, with gaps marked;
  - the records of processing: each category of personal data, why it is held, where, who sees it, its retention rule, and the processors;
  - how data protection requests work.
- **Related:** `docs/runbooks/breach-response.md`, `docs/privacy-notice-outline.md`, `docs/gate-1.md` (the rules awaiting counsel), `docs/security-review.md`.

## Who is the controller

- **Tenants' data:** each landlord or agency (a company) is the controller. The product follows from that:
  - the request register is in the landlord's app;
  - a company's data is visible only inside that company (row level security);
  - platform staff see none of it without the company's support grant (`docs/runbooks/support-access.md`).
- **Its own data:** the platform is the controller of its customers' accounts, subscriptions and staff sign-in records.
- **Open:** whether the platform is also a processor, or a controller, of tenants' data under Act 843, and which registrations follow for it and for each landlord, is OQ-50.

## Act 843 checklist

The principles as Act 843 sets them out (section 17). The reading is ours, for counsel to confirm. ✗ marks a gap.

| Principle | What the product does | Gaps |
| --- | --- | --- |
| **Accountability** | <ul><li>Every financial record, lease and notice change, permission change, sign-in, ID number reveal, support access and approval goes in an append-only audit chain per company.</li><li>Each chain is hash-linked, checked nightly and anchored daily in write-once storage.</li><li>Data protection requests are kept in an audited register.</li><li>These records of processing exist.</li></ul> | ✗ Registration with the Data Protection Commission, for the platform and for each landlord, is not done (OQ-14, OQ-50; a track in `docs/gate-1.md`).<br>✗ No person is named as answering for data protection, at the platform or in a pilot company. |
| **Lawfulness of processing** | <ul><li>Business-initiated messages go only on a channel with consent recorded (CM-09). Consent is recorded per channel with its text version and hash; STOP and unsubscribe are honoured everywhere.</li><li>Identity checks are biometric matches through the identity provider; no image of a Ghana Card is ever requested or stored (OQ-39).</li></ul> | ✗ The lawful basis for each category below (contract, legal obligation, consent) is not set by counsel.<br>✗ Whether L.I. 2523 binds landlords, and whether a check through a provider satisfies it, is open (OQ-39). |
| **Specification of purpose** | <ul><li>Each category below is held for named requirements (PRD IDs).</li><li>The rule is to collect only what a requirement needs (CLAUDE.md section 10), so optional fields stay optional: ID numbers, TIN, occupation.</li></ul> | ✗ Tenants aren't told the purposes: no privacy notice exists (`docs/privacy-notice-outline.md`). |
| **Compatibility of further processing** | <ul><li>The Gate 1 and dashboard metrics use counts and amounts, never names.</li><li>There is no marketing use, and no sharing between landlords: a tenant with two landlords is two separate records (TL-12).</li><li>Platform admins see company data only under a grant, and then counts only.</li><li>Demo data is flagged as test contacts.</li></ul> | None found. |
| **Quality of information** | <ul><li>Phones are validated to E.164.</li><li>Staff correct a tenant's details on the tenant page (`tenant.manage`).</li><li>A changed phone or email starts with no consent on that channel (OQ-54).</li><li>Correction requests are recorded in the register.</li></ul> | ✗ Tenants can't correct their own details in the app.<br>✗ A correction request has no action of its own: staff edit the record and record the outcome. |
| **Openness** | <ul><li>Consent texts are versioned and kept with each grant.</li><li>The signing and notice pages say what a signature means (receipt, not agreement).</li><li>The support access card tells the company what support can see.</li></ul> | ✗ No privacy notice, in the tenant app, on the links pages or in the lease templates. Wording is for counsel (OQ-53, OQ-14). |
| **Data security safeguards** | <ul><li>Row level security is forced on every company table, with an application role that can't bypass it.</li><li>ID, TIN and account numbers are field-encrypted, masked by default, and revealed only with a permission and a reason, audited.</li><li>Staff sign in with a password and an authenticator; sessions time out and can be revoked; breached passwords are refused.</li><li>Logs redact personal data (tested).</li><li>Secure link tokens and codes are stored hashed, and their use is rate-limited.</li><li>Uploads are virus-scanned before anyone else can open them.</li><li>CSP and HSTS are set; there is an ASVS review (`docs/security-review.md`).</li></ul> | ✗ The production key service (AWS KMS), secrets manager and encrypted backups arrive with M12.<br>✗ No key rotation procedure.<br>✗ No way to end every session at once.<br>✗ No object storage access logs.<br>✗ The external penetration test is a track.<br>✗ Tenants and caretakers sign in by SMS code alone: an accepted risk for the pilot (founder decision 3). |
| **Data subject participation** | <ul><li>A register for access, correction, erasure and objection requests.</li><li>A per-tenant export for access.</li><li>Erasure stops messaging at once, then anonymises only what retention allows.</li><li>STOP withdraws consent on every channel.</li></ul> | ✗ The response time is unset (`data_protection.request_response_days`, null; OQ-65), so no due date is shown.<br>✗ With today's rules nothing is anonymised for anyone (below).<br>✗ An objection has no automatic effect.<br>✗ Tenants can't make a request in the app: staff record what they receive. |

**Other Act 843 duties, from the research in `docs/open-questions.md`:**

- **Registration before processing,** renewed every two years (ss.27, 50, 53): a track for counsel and the founder (OQ-14, OQ-50).
- **No retention "longer than is necessary"** unless required by law (s.24): every non-financial retention rule is null until counsel supplies it.
- **Countries data is transferred to must be declared** (s.47(1)(g)). The hosting region is decided by ADR-009's latency test, with eu-west-1 as the fallback (OQ-21). Whether tax records must stay in Ghana (Act 915 s.27) is OQ-49. So is the draft Data Protection Bill 2025's localisation of ID data.
- **✗ No processing agreements are recorded** with the processors below.

## Records of processing

**Storage:**

- **"Database"** is PostgreSQL. Every company table has `company_id` and forced row level security.
- **"Files"** is S3-compatible object storage: SeaweedFS locally, AWS S3 from M12. There are two buckets, `rent-files` and `rent-evidence`. Evidence (signed documents, issued notices, receipts, audit anchors) is stored write-once.

**Roles in the "Who sees it" column:**

- "Landlord" is a self-managing owner company's owner.
- "Admin" is an agency admin.
- "Manager" and "accountant" are company staff.
- "Caretaker" sees only assigned properties.
- "Adviser" and "client owner" see only their owners' records.
- Platform admins see none of these without a support grant.

**Retention rules:**

- Every retention rule is in the rules table and is **unverified**.
- `data_retention.financial_and_notices` holds 6 years from Act 915 s.27, for counsel to confirm. Every `data_retention.other.*` row holds **no value** until counsel supplies one (OQ-14).

| Category | Data held | Purpose (requirements) | Where | Who sees it | Retention rule (status) |
| --- | --- | --- | --- | --- | --- |
| **Tenants** | Name, legal name (company tenant), phone, WhatsApp number, email, occupation, business type and registration number (company tenant), notes; the link to the tenant's app account | Tenancy records, billing, messages, notices (TL-01, TL-04, BC-01, CM-01, LN-02) | Database: `tenant` | Landlord, admin, manager, accountant, adviser, client owner (in scope). Caretaker: name, phone and unit only. The tenant: their own, in the app. | `data_retention.other.tenant_profile` (null, unverified) |
| **Tenants' contacts** | Guarantor, next of kin, employer reference, authorised signatory, finance contact: name, phone, email, relationship, organisation, position, notes | Guarantees, emergencies, company tenants' signatories (TL-03, TL-04, LN-07) | Database: `tenant_contact` | As tenants, without caretakers | `data_retention.other.tenant_profile` (null, unverified), anonymised with the tenant |
| **Artisans** | Name, phone, trades; consent per channel | Sending repair jobs (MI-04) | Database: `artisan`, `contact_consent_event` | Landlord, admin, manager | ✗ No rule |
| **Owners** | Name, legal name, phone, email, country of residence, time zone, notes; letting-business and VAT flags; TIN (encrypted); settlement accounts: bank, branch, account name, account number (encrypted) | Statements, remittance, tax, settlement straight to the owner (AC-02, AC-04, AC-05, TX-01, D1) | Database: `owner`, `settlement_account` | Landlord, admin, manager, accountant, adviser, client owner (their own). Account numbers revealed only to the landlord and admins. Never caretakers. | ✗ No rule of its own; statements fall under `data_retention.financial_and_notices` |
| **Staff** | Name, email, phone; password hash; authenticator secret (encrypted) and backup codes (hashed); sessions with IP address and device; memberships and roles; WhatsApp opt-in for emergency alerts | Sign-in, permissions, audit (AD-01, AD-03, AD-06, AD-07; OQ-33) | Database: `person`, `account`, `two_factor`, `session`, `membership`, `contact_consent_event` | The person (Settings → Security); the company's landlord and admins (Users and roles); platform admins, for account recovery only: name, companies and roles | ✗ No rule |
| **ID numbers** | Ghana Card or passport number, and a company tenant's or owner's TIN: encrypted (AES-256-GCM, per-company key wrapped by KMS), masked form, keyed blind index; the identity check's status and the provider's check id. **Never an image of the card, a selfie or biometric data.** | Identity checks (TL-02), TINs on VAT invoices (CT-04) | Database: `tenant`, `owner`, `id_check` | Masked to those who see the tenant. In full only through a reveal, with a reason, audited (`id_number.revealed`), by the landlord, admins and managers. Never caretakers, accountants, advisers or client owners. | `data_retention.other.identity_data` (null, unverified) |
| **Leases, invoices, notices** | Lease terms and parties, rent schedule, invoices, notices and their recipients, service records and affidavits, tasks | Tenancy, billing, legal notices (TL-05 to TL-07, BC-01, LN-01 to LN-09) | Database; files (frozen PDFs, write-once) | Landlord, admin, manager, accountant, adviser, client owner (in scope). Caretaker: unit and dates, and notices on assigned properties. The tenant: their own. | `data_retention.financial_and_notices` (6 years, unverified) |
| **Payments** | Payments, allocations, receipts, refunds, cash records (with receipt-book photos), direct transfers (with proof); the MoMo number a payment came from (encrypted, masked); payment providers' webhook bodies as received | Collection, receipts, reconciliation (BC-02 to BC-12, AC-01) | Database: `payment`, `receipt`, `allocation`, `payment_intent`, `cash_record`, `webhook_inbox` (system table); files | Landlord, admin, manager, accountant; adviser and client owner (in scope) through billing views; caretakers their own cash records. The tenant: their own. | `data_retention.financial_and_notices` (6 years, unverified); webhook bodies `data_retention.other.webhook_bodies` (null, unverified) |
| **Messages** | Every message in and out: text, channel, address, delivery events and cost; inbound media, copied to our storage at once; push device tokens | Inbox, reminders, receipts, notices (CM-01 to CM-10, BC-09) | Database: `message`, `message_event`, `message_attachment`, `conversation`, `push_device`; files | Landlord, admin, manager, accountant, adviser, caretaker (in scope). Client owners don't. The tenant: their own conversation. | `data_retention.other.messages` (null, unverified) |
| **Consent records** | Per channel: grant or withdrawal, source (staff, reply, STOP, START, the app, unsubscribe, data protection, import), text version and hash, time | Proving consent (CM-09) | Database: `consent_event`, `contact_consent_event` | Those who see the tenant | ✗ No rule of its own |
| **Signatures** | Typed name or drawn signature (an image file), consent text version and hash, server time, the masked phone or email the code went to, IP address, device, document hash; the code itself only hashed | E-signing leases, notices, move-in reports, renewals (TL-07, LN-04, TL-08; ADR-007) | Database: `signature`, `signing_event`, `otp_challenge`; files (signed PDFs and certificate pages, write-once) | With the document: landlord, admin, manager, accountant, adviser, client owner (in scope) | `data_retention.financial_and_notices` (6 years, unverified) |
| **Photos and recordings** | Repair photos, video and voice notes from tenants and caretakers; inspection and move-in photos; photos of posted notices; cash and banking slips; job-sheet photos from artisans | Repairs, inspections, deposits, service evidence (MI-01, MI-02, MI-10, TL-08, TL-11, LN-05, BC-05, P07) | Files, with their records in the database | Maintenance and inspections: landlord, admin, manager, accountant, adviser, client owner, caretaker (in scope). The tenant: their own repairs. | ✗ No rule; not in any erasure category |
| **IP hashes and device data** | Sign-in events: a keyed hash of the address and the device; rate-limit keys: keyed hashes, pruned after 24 hours. (Sessions and signatures hold the address in full: above.) | Security and audit (AD-06, AD-07; CLAUDE.md section 9) | Database: `audit_event`, `rate_limit` | Audit log: landlord, admin, accountant | ✗ No rule for audit events, which are immutable. Rate-limit rows: 24 hours (`ops.prune`). |
| **Data protection requests** | The tenant, kind, dates, notes, outcome; the export archive | Act 843 requests (decision 5) | Database: `data_protection_request`, `data_protection_export`; files (the export, write-once) | Landlord and admins (`data_protection.manage`, `data_protection.export`) | ✗ No rule |

**Kept out of the audit log by design:** contact details appear in row-change audit only as "changed", never by value. That makes anonymising them possible without breaking the chain.

**Deleted on a timer, which is all that is:**

- rate-limit rows after 24 hours;
- rejected webhooks after 30 days. These are bad signatures or too large, and keep no body.

Both are handled by `ops.prune`. Nothing personal is deleted on a timer: the retention review only counts.

### Processors

| Processor | What it receives | Why | Built | Status |
| --- | --- | --- | --- | --- |
| **Paystack** | Amount, reference, payer's MoMo number or card details (entered at Paystack), an email (a synthetic per-tenant address where the tenant has none, OQ-06); the tenant's name in the charge's metadata | Rent and subscription payments (BC-02, AD-08) | Adapter (`packages/integrations/src/payments/paystack.ts`) | Agreement and test account pending (OQ-01, OQ-06, OQ-41, OQ-42) |
| **Meta (WhatsApp Cloud API)** | Phone numbers, message text and media, template parameters (landlord's and tenant's names, links) | WhatsApp messages and inbox (CM-01 to CM-03) | Adapter (`whatsapp/meta.ts`) | Business verification and a test number pending (OQ-24); messaging on landlords' behalf (OQ-40) |
| **Hubtel** | Phone numbers, SMS text, one-time codes | SMS, replies and STOP by SMS, sign-in codes (CM-09, AD-06) | Adapter (`sms/sms.ts`) | Account and two-way short code pending |
| **Postmark** | Email addresses, message text, attachments (receipts, statements), inbound replies | Email (CM-10), owner statements (AC-04) | Adapter (`email/email.ts`) | Sending and inbound domains pending |
| **Expo push service** | Push tokens and notification text | Tenant app notifications | Adapter (`push/push.ts`) | Needs `eas init` and the store accounts |
| **Identity provider** (Smile ID recommended, OQ-22) | The ID number and a live selfie, captured and kept by the provider; we keep its check id and result | Ghana Card checks (TL-02) | Interface and fake only, no live adapter | Contract pending (OQ-22); scope of L.I. 2523 (OQ-39) |
| **AWS** (from M12) | Everything: database, files, backups, keys | Hosting (ADR-009) | M12 | Account pending; region by the latency test; transfers abroad (OQ-14, OQ-49) |

**Not processors of personal data:**

- **Have I Been Pwned:** receives the first 5 characters of a new password's SHA-1 hash, never the password, an email or a name.
- **ClamAV:** scans uploads inside our own worker.
- **GhanaPost GPS** (if access comes, OQ-23): would receive property addresses only.

## Data protection requests

**Where:**

- Settings → Data protection (`/settings/data-protection`) lists every request, with a tenant picker;
- each tenant's page shows that tenant's requests.

**Who:** the landlord and agency admins (`data_protection.manage`; the export also needs `data_protection.export`). Scoped admins, managers, caretakers and advisers can't. The register and the export stay open while a company's subscription is read-only. Every change is audited (`data_protection.request_recorded`, `data_protection.request_updated`, and the export and erasure events).

### Recording a request

- **Fields:** the tenant who asked, what they ask (access, correction, erasure or objection), the day received (today or earlier) and optional notes. Record it the day it arrives, however it arrived.
- **Due date:** the rules row `data_protection.request_response_days`, as of the day received. It has no value (OQ-65), so the register shows "the response time is still to be set by counsel" and no due date.
- **Moving it on:** received, in progress, then completed or refused. A completed or refused request needs an outcome, and is then closed.

### Access: the export

1. **"Prepare the export".** A job (`data-protection.export`) builds one archive of that tenant's records only and stores it write-once:
   - an Excel workbook with sheets Profile, Contacts, Consent, Leases, Invoices, Payments, Receipts, Notices and Messages;
   - the stored PDFs of their leases, receipts and notices.

   ID and TIN numbers are given masked. The tenant knows their own.
2. **"Download the export"** once it is ready. The link lasts five minutes. Each link issued is audited.
3. **Hand it to the tenant** the way they asked, and record that in the outcome.

The export is read in the company's context, filtered to the one tenant on every query, and never logged.

### Correction and objection

- **Correction:** staff correct the record on the tenant page, then complete the request with what was changed. A changed phone or email starts with no consent on that channel; ask the tenant again (OQ-54).
- **Objection:** the product has no automatic action. For messages, withdraw consent on the channels they object to (the tenant page's "Messages" card, or the tenant sends STOP). For anything else, ask counsel, then record the outcome.

### Erasure, limited by retention

**On recording** an erasure request, messaging to the tenant stops at once on every channel:

- consent is withdrawn on each channel for the tenant and each contact, with source `data_protection`;
- the send job refuses anything for the tenant while the request stands.

A refused request lifts the block. Consent stays withdrawn until staff record it again with the tenant.

**A legal notice is never blocked.** Its electronic copy is withheld and service falls back to physical (`docs/runbooks/notice-escalation.md`).

**"Erase"** (it asks for confirmation) works through each category:

| Category | Anonymised when | What anonymising does |
| --- | --- | --- |
| Tenant profile and contacts | The rule is verified, has a value, and its period, from the end of the last lease, has passed | Name becomes "Anonymised tenant" or "Anonymised contact"; phone, WhatsApp, email, occupation, company details, notes and the app link are cleared; the rows stay, marked `anonymised_at` (once, for good) |
| ID numbers and TINs | Its rule, likewise | Encrypted values, blind indexes and masks cleared; the identity check keeps only its status and the provider's id |
| Leases, invoices, payments, receipts, notices | Its rule, from the latest of the tenancy's end and the last invoice, payment, receipt or notice | **Held even then:** these records are immutable, and no database path exists yet to anonymise the names copied onto them |
| Messages | Its rule, from the last message | **Held even then:** messages are never edited; no path yet |
| Providers' webhook bodies | Its rule, from the last provider payment | **Held even then:** no path yet |

**The outcome lists:**

- what was anonymised;
- each category held, with "until <date>", or "until the retention period is set" while the rule has no verified value, and the reason.

**Today,** every rule is unverified, so **nothing is anonymised for anyone**: every category is held. Messaging still stops at once. Financial records keep their amounts and references; only personal fields are ever anonymised, and the books and the audit chain still verify afterwards.

### The retention review

- **What:** `retention.review` runs nightly at 03:15 Africa/Accra. It counts, per category and across companies, the records past each **verified** retention period. Nothing is deleted on a timer.
- **Where:** the API serves it to platform admins (`GET /platform/retention`). **Gap:** no console page shows it yet.

## Gaps, in one place

1. **Registration with the Data Protection Commission,** for the platform and each landlord (OQ-14, OQ-50).
2. **No privacy notice** (`docs/privacy-notice-outline.md`; OQ-53, OQ-14).
3. **Every retention rule is unverified,** and every `data_retention.other.*` row has no value (OQ-14). There is no rule at all for artisans, owners, staff, consent records, photos and recordings, audit events, or the request register.
4. **No response time for requests** (OQ-65).
5. **Anonymising financial records, notices, messages and webhook bodies** needs a database path that doesn't exist, even once their periods pass.
6. **Photos and recordings** are in no erasure category.
7. **Objection and correction** have no action of their own. Tenants can't make or follow a request themselves.
8. **No processing agreements** are recorded with the processors.
9. **The retention review** has no console page.
10. **Hosting abroad and in-country records** (OQ-14, OQ-49) wait for the M12 region decision.
11. **Breach notification:** what Act 843 requires, and by when, is not asked in any open question in so many words (`docs/runbooks/breach-response.md`).
