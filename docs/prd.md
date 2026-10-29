# Rent Management Platform: Product Requirements Document

Oct 26, 2026 · @FRANCIS OSEI

A Ghana-first platform that lets landlords and property managers collect rent, control cash, serve residential and commercial tenants over WhatsApp, email and a portal, and issue legally sound notices that tenants must open and e-sign.

## 1. Scope and assumptions

Version 1 serves Ghana, covers residential and commercial lettings, and is sold to both individual landlords and property management agencies. These assumptions were set without your confirmation and should be checked before build starts.

**Working assumptions**

- Launch market is Ghana; the data model allows other West African markets later (currency, tax rules and ID types configurable per country).
- The landlord is the paying customer, whether an individual or a corporate owner. Agencies use the same product and the same pricing.
- Property types: apartments, houses, compound houses, shops, offices, warehouses, mixed-use buildings and gated estates.
- Channels: web app for landlords and managers; mobile app and WhatsApp for tenants and caretakers; web portal for commercial tenants; USSD later.
- All amounts held and reported in Ghana cedis; foreign currency shown for reference only.
- Formal legal notices are delivered as a secure link that the recipient must open and e-sign to acknowledge, with automatic reminders until they do.

**Out of scope for version 1**

- Property sales and mortgage brokerage
- Short-stay and holiday letting
- Construction project management
- Building access hardware (gates, smart locks)

**Decisions still open**

- [x] Primary paying customer: the landlord. Agencies use the same product and pricing.
- [x] Pricing model: tiered subscription, charged per unit per month, with separate residential and commercial rates (section 21).
- [x] Build approach: in-house, by the founder's own team.
- [x] Advance rent policy: record advances without warning for now; a per-company setting can switch on warnings or enforcement later.

## 2. Problem and vision

Rent in Ghana is still largely collected by hand, recorded in notebooks and argued over on the phone. The product exists to remove that friction and the money that leaks through it.

**Pain points the product must solve**

| Pain point | Who feels it | What it costs |
| --- | --- | --- |
| Cash and MoMo collected by caretakers is not fully remitted | Landlords, diaspora owners | Lost income, mistrust |
| Advance rent paid as a lump sum with no record of what period it covers | Landlords, tenants | Disputes at exit, refund rows |
| No single record of what was said or agreed | All parties | Weak evidence before Rent Control or a court |
| Notices delivered by hand or text, with no proof of receipt | Landlords, managers | Notices challenged, evictions delayed |
| Repairs reported verbally and forgotten | Tenants, owners | Asset decay, tenant churn |
| Rent tax and property rate deadlines missed | Landlords | Interest and penalties |
| Corporate tenants deduct withholding tax with no certificate trail | Commercial landlords | Unreconciled balances |
| Owners abroad cannot see what is happening | Diaspora owners | Over-reliance on relatives and agents |

**Vision**

Every cedi traced from tenant to owner, every promise recorded, every notice acknowledged.

**Positioning**

The wedge is collection control (caretaker accountability, advance rent accounting, automatic reconciliation) plus a transparent owner view. Competitors such as Ownkey already offer compliance guides and listings, so the product must win on day-to-day operations, not information.

## 3. Users

Six user types share one record of each property, each with its own app surface and permissions.

| User | Typical profile | Main channel | Top needs |
| --- | --- | --- | --- |
| Landlord / owner | Individual with 1 to 50 units, often a professional or retiree; some live abroad | Web and mobile app | Know who has paid, see arrears, approve repairs, receive statements, stay tax compliant |
| Property manager / agency | Firm managing many owners' portfolios, with staff | Web app | Run collections at scale, assign work, report to owners, protect client money |
| Residential tenant | Household renting a room, apartment or house | WhatsApp, mobile app | Pay easily, get receipts, report repairs, know when rent ends |
| Commercial tenant | Company renting an office, shop or warehouse; several staff involved | Web portal, email, WhatsApp | Invoices, withholding tax handling, service charge detail, lease dates, response times |
| Caretaker | On-site staff, often with a basic smartphone and patchy data | Field app (offline) | Record payments and readings, log issues, prove what was done |
| Artisan / vendor | Plumber, electrician, painter, cleaning firm | WhatsApp, simple job link | Receive jobs, send quotes, upload proof, get paid |

A secondary user is the **owner's accountant or tax adviser**, given read-only access to statements and tax reports.

## 4. Product principles and non-functional requirements

The product must work on the phones, networks and payment rails Ghanaians actually use, and every record must stand up as evidence.

**Principles**

1. One record, many channels: every message, payment and document attaches to the tenant, unit and lease, whichever channel it came through.
2. Evidence by default: every action is timestamped, attributed to a user and kept in an audit log that cannot be edited.
3. Mobile money first: MoMo is the default payment path, not an add-on.
4. Offline tolerant: caretaker and tenant flows keep working on weak data and sync later.
5. Plain language: English by default, with Twi, Ga, Ewe and Hausa templates for tenant messages in a later phase.
6. Compliance built in: tax, notice periods and advance rent limits are calculated by the system, not remembered by the user.

**Non-functional requirements**

| Area | Requirement |
| --- | --- |
| Performance | Key screens load in under 3 seconds on a 3G connection; tenant pages under 1 MB |
| Availability | 99.5% monthly uptime; payment callbacks retried and never lost |
| Devices | Android 8 and above, iOS 16.4 and above (older iPhones use the tenant web app), modern browsers; tenant app usable on 5-inch screens |
| Offline | Caretaker app stores at least 7 days of work offline with conflict-safe sync |
| Security | Encryption in transit and at rest; two-factor login for owners, managers and accountants; role-based access |
| Data protection | Compliant with the Data Protection Act 2012 (Act 843); consent captured for WhatsApp and SMS; defined retention periods; tenant data export and deletion on request |
| Audit | Immutable log of financial entries, notice events, lease changes and permission changes |
| Scalability | Supports agencies with 5,000+ units and 50+ staff without redesign |
| Localisation | Currency, tax rates, ID types, address format and notice periods configurable per country |
| Backup | Daily backups, point-in-time recovery for 30 days, tested restore every quarter |

## 5. Module 1: Portfolio and property register

The register is the backbone: every payment, lease, message and repair hangs off a unit. Priority codes: MVP, P2 (Phase 2), P3 (Phase 3).

| ID | Requirement | Priority |
| --- | --- | --- |
| PR-01 | Create a portfolio with properties, blocks and units in a three-level hierarchy | MVP |
| PR-02 | Unit types include chamber and hall, single room self-contained, 1 to 5 bedroom, studio, shop, store, office, warehouse, kiosk | MVP |
| PR-03 | Capture GhanaPost GPS address, region, district, MMDA and map pin per property | MVP |
| PR-04 | Attach photos, title or indenture, site plan and building permit to a property | MVP |
| PR-05 | Record ECG and Ghana Water meter numbers and meter type (prepaid, postpaid, shared) per unit | MVP |
| PR-06 | Unit status: vacant, occupied, reserved, under repair, not lettable, with a status history | MVP |
| PR-07 | Ownership: single owner, joint owners or family property with percentage splits for income | P2 |
| PR-08 | Bulk import of properties and units from Excel | MVP |
| PR-09 | Amenities and features per unit (parking, borehole, generator, solar, air conditioning, furnished) | MVP |
| PR-10 | Asset register per property (water tanks, pumps, generators, ACs) with purchase date and warranty | P2 |

**User stories and acceptance criteria**

- As a landlord, I can set up a compound house with 12 rooms in under 10 minutes.
  - Units can be created in bulk by type and count, then edited one by one.
  - Each unit receives a unique code (for example ACC-LEG-B2-04) used in payment references.
- As an agency manager, I can see every unit's status across all owners on one screen.
  - Filters by owner, location, type and status; counts update in real time.
- As an owner abroad, I can see photos and documents for each property.
  - Documents open on mobile and are visible only to users with permission.

## 6. Module 2: Tenant and lease management

A tenant is onboarded once, verified, and tied to a lease that drives billing, reminders and notices automatically.

| ID | Requirement | Priority |
| --- | --- | --- |
| TL-01 | Tenant profile: individual or company, phone, WhatsApp number, email, occupation or business type; a tenant renting from several landlords on the platform signs in once and sees each tenancy, while each landlord sees only their own records | MVP |
| TL-02 | Ghana Card number capture and verification through an approved provider; passport for foreign nationals | MVP |
| TL-03 | Guarantor, next of kin and employer reference with contact details | MVP |
| TL-04 | Company tenants: registration number, TIN, authorised signatories, finance contact | MVP |
| TL-05 | Lease builder from templates (residential, commercial, short fixed-term) with editable clauses | MVP |
| TL-06 | Lease terms: start, end, rent, rent cycle (monthly, quarterly, 6-month, annual), deposit, service charge, escalation schedule, break clauses | MVP |
| TL-07 | E-signature of the lease by tenant, landlord and guarantor, with a signed PDF stored | MVP |
| TL-08 | Move-in condition report with timestamped photos signed by both parties | MVP |
| TL-09 | Renewal workflow: reminder 90, 60 and 30 days before expiry; renewal offer sent as a signable link | MVP |
| TL-10 | Rent review: proposed increase sent for acceptance; history of all rent changes | P2 |
| TL-11 | Move-out: notice, inspection, deposit deductions, final statement, refund | MVP |
| TL-12 | Tenant history across tenancies (payment record, conduct notes) visible within the same company only | P2 |
| TL-13 | Applicant screening checklist and approval step before a lease is issued | P2 |

**User stories and acceptance criteria**

- As a manager, I can issue a lease and have it signed by all parties without printing anything.
  - Each signer receives a link by WhatsApp and email; the lease activates only when all required signatures are in.
  - The signed PDF shows signer names, timestamps, IP or device details and a document fingerprint.
- As a landlord, I am told well before any lease ends.
  - Renewal reminders fire at 90, 60 and 30 days; an expiring-leases list sits on the dashboard.
- As a tenant, I can see my lease and my move-in report at any time.
  - Both are downloadable from the tenant app and on request through WhatsApp.

## 7. Module 3: Rent billing, collection and the advance rent engine

This is the module customers pay for: rent is billed automatically, paid by MoMo or bank, matched without manual work and receipted instantly.

**Billing and collection**

| ID | Requirement | Priority |
| --- | --- | --- |
| BC-01 | Invoices generated automatically from lease terms for each rent cycle | MVP |
| BC-02 | Payment by MTN MoMo, Telecel Cash, AT Money, bank transfer and card through a licensed aggregator, settled directly to the landlord's or agency's account; the provider fee is borne by the landlord or agency by default | MVP |
| BC-03 | Each tenant gets a unique payment reference; payments matched to the right invoice automatically | MVP |
| BC-04 | Payment links sent by WhatsApp, SMS and email; link shows amount due and lets the tenant pay part | MVP |
| BC-05 | Cash and cheque recorded with receiver name, photo of receipt book or cheque, and manager approval | MVP |
| BC-06 | Digital receipt issued within 1 minute of confirmed payment, sent on the tenant's channel | MVP |
| BC-07 | Partial payments, overpayments held as credit, and allocation rules (oldest debt first) | MVP |
| BC-08 | Arrears ageing: 0 to 30, 31 to 60, 61 to 90 and 90+ days, by tenant, property and owner | MVP |
| BC-09 | Reminder ladder: 7 days before due, on due date, 3, 7 and 14 days overdue; each step configurable | MVP |
| BC-10 | Late fees: fixed or percentage, with a grace period, applied only where the lease allows | P2 |
| BC-11 | Security deposit held in a separate ledger, never mixed with rent income | MVP |
| BC-12 | Unmatched payments queue for manual matching, with suggested matches | MVP |
| BC-13 | Payment plans for arrears with instalments and automatic reminders | P2 |
| BC-14 | Standing payment authority (direct debit or recurring MoMo) where supported | P3 |

**Advance rent engine**

| ID | Requirement | Priority |
| --- | --- | --- |
| AR-01 | Record a lump-sum advance and spread it month by month over the period it covers | MVP |
| AR-02 | Show a "paid until" date to tenant, landlord and manager at all times | MVP |
| AR-03 | Track unearned rent as a liability in the owner's accounts | MVP |
| AR-04 | Calculate refund due if a tenancy ends early, net of agreed deductions; unused days of the current month are credited only where the lease provides for it | MVP |
| AR-05 | Record months paid in advance on every lease; a per-company setting (off by default, warn or block) decides whether residential advances above 6 months (Rent Act, section 25(5)) are flagged on the lease and in compliance reports | MVP |
| AR-06 | Renewal prompt when the paid-until date is 90 days away | MVP |

**User stories and acceptance criteria**

- As a tenant, I pay my rent by MoMo and get a receipt without calling anyone.
  - Payment confirmed by the aggregator updates the balance and sends a receipt within 1 minute.
- As a landlord, I know exactly which month a two-year advance has paid up to.
  - The lease page shows the paid-until date and the remaining unearned balance in cedis.
- As a manager, I spend less than 10 minutes a day on reconciliation.
  - At least 95% of MoMo and bank payments match automatically; the rest appear in the unmatched queue.

## 8. Module 4: Legal notices with e-signature acknowledgement

Every formal notice is sent as a secure link that the recipient must open and e-sign to acknowledge, with automatic reminders until they do and a fallback service route if they never do.

One point needs stating plainly: a tenant's signature acknowledges receipt, not agreement. A tenant who refuses to sign must not be able to block a notice, so the system escalates to physical service after a set period. The legal effect of electronic service should be confirmed with a Ghanaian property lawyer before launch, with reference to the Electronic Transactions Act 2008 (Act 772) and the Rent Act. Until counsel confirms the statutory notice periods, notices to quit stay switched off for a company until its admin records that they accept the risk, and each one needs two-person approval.

**Notice types (templates)**

- Rent demand and arrears notice
- Notice of rent review or increase
- Notice to quit (with the statutory notice period calculated from the lease type)
- Notice of entry for inspection or repairs
- Breach of tenancy notice (noise, unauthorised occupants, sub-letting, damage)
- Lease renewal offer and non-renewal notice
- Building-wide notices that require acknowledgement (fire safety, major works)
- Tenant-originated notices: intention to vacate, formal complaint

**Notice lifecycle**

1. Drafted from a template; the system fills tenant, unit, amounts and dates and calculates the earliest lawful effective date.
2. Approved by a user with notice authority (two-person approval for notices to quit).
3. Issued: a unique secure link sent by WhatsApp, SMS and email at the same moment; the full notice is also stored as a PDF.
4. Opened: the system records the first open (time, device).
5. Signed: the tenant reads the notice, types or draws a signature and confirms with a one-time code sent to their phone.
6. Reminded: if unsigned, reminders follow the ladder below.
7. Escalated: if still unsigned, a printable copy and service affidavit template are generated for physical service, and the manager records how and when it was served.
8. Closed: outcome recorded (complied, paid, vacated, disputed, referred to Rent Control or court).

**Reminder ladder (defaults, configurable per notice type)**

| Time after issue | Action | Channel |
| --- | --- | --- |
| 24 hours | First reminder to open and sign | WhatsApp and SMS |
| 72 hours | Second reminder, stating the notice remains in force whether or not it is signed | WhatsApp, SMS and email |
| 5 days | Manager alerted; caretaker task created to remind the tenant in person | In-app task |
| 7 days | Escalation to physical service; printable pack generated | Manager dashboard |

**Requirements**

| ID | Requirement | Priority |
| --- | --- | --- |
| LN-01 | Notice templates per type, with mandatory fields and lawful notice periods enforced | MVP |
| LN-02 | Secure link per recipient, expiring only after the notice period ends; no login needed, one-time code to sign | MVP |
| LN-03 | Tracking: sent, delivered, opened, signed, reminded, escalated, served, closed, each timestamped | MVP |
| LN-04 | Signed PDF with signature, timestamp, phone number verified, device details and document fingerprint | MVP |
| LN-05 | Automatic reminder ladder with pause and cancel controls | MVP |
| LN-06 | Recipient can reply or dispute within the link; the reply attaches to the notice record | P2 |
| LN-07 | Commercial tenants: notice goes to every authorised signatory; one signature acknowledges for the company | MVP |
| LN-08 | Evidence bundle export: lease, payment history, notices, acknowledgements, messages and photos in one PDF | P2 |
| LN-09 | Notices dashboard: open notices by status and days outstanding | MVP |
| LN-10 | Tenants can issue their own notices (intention to vacate) to the landlord through the same flow | P2 |

**Acceptance criteria**

- A notice to quit cannot be issued with an effective date earlier than the lawful minimum for that lease.
- A notice cannot be edited after issue; corrections are issued as a new notice that references the old one.
- Every status change appears on the tenant's timeline and in the audit log.

## 9. Module 5: Unified inbox and two-way WhatsApp

All tenant conversations, whatever the channel, land in one inbox threaded by tenant and unit, so nothing lives only on a caretaker's personal phone.

**What a tenant can do over WhatsApp**

- Ask for balance and paid-until date; get an instant answer
- Request a receipt or statement as a PDF in the chat
- Pay through a secure payment link
- Send proof of payment for matching
- Report a repair with photos, video or a voice note; receive a ticket number
- Confirm viewing, inspection or artisan visit times
- Receive and open notice links (signing happens on the secure page, not in the chat)

**Requirements**

| ID | Requirement | Priority |
| --- | --- | --- |
| CM-01 | Official WhatsApp Business Platform number per company (or a shared platform number for small landlords) | MVP |
| CM-02 | Inbound messages matched to the tenant by phone number; unknown numbers go to a triage queue | MVP |
| CM-03 | Menu bot for routine requests (balance, receipt, pay, repair) with handover to a person | MVP |
| CM-04 | Repair messages create a maintenance ticket automatically, with media attached | MVP |
| CM-05 | Unified inbox: WhatsApp, SMS, email and in-app messages in one thread per tenant | MVP |
| CM-06 | Assign conversations to staff, tag them, set response time targets, alert on overdue replies | MVP |
| CM-07 | Approved message templates for reminders, receipts and notices (required by WhatsApp outside the 24-hour reply window) | MVP |
| CM-08 | Broadcast to a property, block or tenant group (water shutdown, fumigation) with delivery stats | MVP |
| CM-09 | Opt-in captured at onboarding; opt-out honoured; SMS fallback for tenants without WhatsApp | MVP |
| CM-10 | Email channel with inbound parsing (replies thread back to the record) | MVP |
| CM-11 | Message templates in local languages | P3 |
| CM-12 | Messaging cost tracking per company, so pricing can recover WhatsApp and SMS charges | P2 |

**Acceptance criteria**

- A tenant's WhatsApp reply appears on their record within 10 seconds.
- No message can be deleted by staff; edits are not possible after sending.
- A manager can see every conversation for a unit since the lease began, across all channels.

## 10. Module 6: Maintenance, inspections and vendors

Repairs are logged, approved, tracked and costed against the unit, with photo proof at each step so owners can trust what they are paying for.

| ID | Requirement | Priority |
| --- | --- | --- |
| MI-01 | Repair requests from tenant app, WhatsApp, caretaker app or manager, with photos, video or voice note | MVP |
| MI-02 | Priority levels (emergency, urgent, routine) with target response and completion times | MVP |
| MI-03 | Categories: plumbing, electrical, roofing, carpentry, painting, pest control, AC, generator, borehole, septic | MVP |
| MI-04 | Assign to an in-house person or an external artisan; artisan receives the job by WhatsApp link | MVP |
| MI-05 | Quote submission and approval with spending limits per role; owner approval above a threshold | P2 |
| MI-06 | Before and after photos required to close a job; tenant confirms completion | MVP |
| MI-07 | Job cost posted to the unit and owner ledger; recharge to tenant where damage is tenant-caused | P2 |
| MI-08 | Preventive maintenance schedules: septic emptying, borehole servicing, pest control, fire extinguishers, generator servicing, repainting | P2 |
| MI-09 | Vendor directory: trades, rates, ratings, response history, payment details | P2 |
| MI-10 | Inspections: routine, move-in, move-out, with room-by-room checklists and photos | MVP |
| MI-11 | Move-out inspection findings linked to deposit deductions with photo evidence | MVP |
| MI-12 | Maintenance cost per unit and per property reported monthly | P2 |

**Acceptance criteria**

- An emergency request triggers an immediate alert to the manager and caretaker by WhatsApp and SMS.
- A job cannot be closed without at least one after photo and a completion note.
- Owners see every job on their property, its cost and its photos, from their own view.

## 11. Module 7: Utilities and service charges

Shared costs are measured, split fairly and billed alongside rent, which removes one of the most common sources of tenant disputes in compound houses and estates.

| ID | Requirement | Priority |
| --- | --- | --- |
| UT-01 | Sub-meter readings captured by caretaker with photo of the meter | P2 |
| UT-02 | Shared-meter apportionment by equal split, occupants, floor area or sub-meter share | P2 |
| UT-03 | Recharges for water tanker deliveries, waste collection, security, cleaning, generator or solar fuel | P2 |
| UT-04 | Prepaid meter top-up log per unit (who bought what and when) | P3 |
| UT-05 | Service charge setup: annual budget per property, split by unit, billed monthly or quarterly | P2 |
| UT-06 | Year-end service charge reconciliation with surplus credited or deficit billed | P2 |
| UT-07 | Utility invoices from ECG and Ghana Water recorded against the property for owner reporting | P2 |

**Acceptance criteria**

- Each tenant's utility or service charge line shows how their share was calculated.
- A reading without a meter photo is flagged for review before billing.

## 12. Module 8: Accounting, owner reporting, tax and compliance

The system keeps a ledger per owner, deducts fees, produces statements and tracks every statutory deadline, so tax and compliance are calculated rather than remembered.

**Accounting and owner reporting**

| ID | Requirement | Priority |
| --- | --- | --- |
| AC-01 | Double-entry ledger per owner and per property: rent, deposits, service charge, expenses, fees | MVP |
| AC-02 | Management fee deducted automatically (a percentage of rent and service charge collected, including advances and excluding deposits, or a fixed amount per unit) | MVP |
| AC-03 | Expense recording with receipts attached, categorised and allocated to property or unit | MVP |
| AC-04 | Monthly owner statement as PDF, with a cash section (collections, expenses, fees, tax, net remittance) and an accrual section (rent earned, unearned rent, deposits held, arrears), plus occupancy | MVP |
| AC-05 | Owner remittance tracking: amount, date, method, reference | MVP |
| AC-06 | Client money held separately from agency operating money, with a reconciliation report | P2 |
| AC-07 | Export to Excel, QuickBooks and Xero; general ledger export | P2 |
| AC-08 | Year-end owner income summary for tax filing | P2 |

**Tax and compliance**

| ID | Requirement | Priority |
| --- | --- | --- |
| TX-01 | Rent tax calculated on every receipt: 8% residential, 15% commercial and non-residential | MVP |
| TX-02 | Rent tax due-date tracker: payment due within 30 days of rent received; alerts at 21 and 28 days | MVP |
| TX-03 | Record of GRA payments with receipts attached; rent tax report per owner | MVP |
| TX-04 | Withholding tax deducted by corporate tenants tracked against invoices, with certificate upload | MVP |
| TX-05 | Rent Control registration number and date per tenancy, with reminders until it is registered; rent collection is never blocked | MVP |
| TX-06 | Property rate (MMDA), ground rent, fire certificate, building insurance and permit expiry alerts | P2 |
| TX-07 | Compliance dashboard: overdue items by owner and property | P2 |
| TX-08 | Tax rates and rules held in configuration so changes in law need no code release | MVP |

**Acceptance criteria**

- The rent tax figure on an owner's report equals the sum of the tax calculated on each receipt in the period.
- An owner statement can be regenerated for any past month and produces the same figures.

## 13. Module 9: Commercial tenant portal

Office, shop and warehouse tenants get a company account with several users, a dashboard of what they owe and what is open, and the tax documents their finance teams need.

| ID | Requirement | Priority |
| --- | --- | --- |
| CT-01 | Company account with multiple users and roles: director, finance, office or facilities manager | P2 |
| CT-02 | Each user chooses notification channels: email, WhatsApp, portal | P2 |
| CT-03 | Dashboard: rent, service charge and utility balances with due dates | P2 |
| CT-04 | Invoices and receipts with company name and TIN; VAT shown where it applies | MVP |
| CT-05 | Withholding tax: tenant records amount withheld, uploads certificate; landlord confirms; balance clears | P2 |
| CT-06 | Lease summary: term, break dates, renewal date, escalation schedule, permitted use | P2 |
| CT-07 | Service requests with response and completion times measured against agreed standards | P2 |
| CT-08 | Service charge budget and line-by-line breakdown; year-end reconciliation statement | P2 |
| CT-09 | Document library: lease, amendments, insurance certificates, fit-out approvals, building rules | P2 |
| CT-10 | Fit-out and alteration requests with approval workflow and attached drawings | P3 |
| CT-11 | Parking allocation and access card register | P3 |
| CT-12 | Visitor pre-registration for multi-tenant buildings | P3 |

**User stories and acceptance criteria**

- As a tenant's finance officer, I can download every invoice, receipt and withholding tax certificate for the year in one file.
  - Bulk download by date range produces a zipped set of PDFs and a summary spreadsheet.
- As a facilities manager, I can see whether my landlord meets agreed response times.
  - The portal shows average response and completion times for the last 90 days.

If the first paying customers are office or retail landlords, this module moves into the MVP. Commercial landlords are in the pilot (decided 28 Oct 2026): CT-04 moves into the MVP, with VAT and levies on commercial invoices; the rest of the portal stays in Phase 2.

## 14. Modules 10 to 13: Leasing, caretaker app, diaspora owner view, dashboards

These four modules extend the core: filling vacancies faster, controlling on-site staff, serving owners abroad and showing portfolio performance at a glance.

**Module 10: Vacancy and leasing**

| ID | Requirement | Priority |
| --- | --- | --- |
| VL-01 | Listing page per vacant unit with photos, rent, terms and an enquiry form | P3 |
| VL-02 | Shareable listing link for WhatsApp, Facebook and property portals | P3 |
| VL-03 | Enquiry capture and viewing scheduling with caretaker assignment | P3 |
| VL-04 | Applicant pipeline: enquiry, viewing, application, screening, approved, lease issued | P3 |
| VL-05 | Waitlist per property; vacancy loss (days vacant times rent) reported | P2 |

**Module 11: Caretaker field app**

| ID | Requirement | Priority |
| --- | --- | --- |
| CF-01 | Offline-first mobile app with daily task list | P2 |
| CF-02 | Cash collection: amount, tenant, photo proof, digital receipt to tenant by SMS on sync | P2 |
| CF-03 | Daily cash-in-hand balance; manager confirms each handover to bank or office | P2 |
| CF-04 | Meter readings, inspection checklists, repair logging with photos | P2 |
| CF-05 | GPS and time stamp on every field entry | P2 |
| CF-06 | Tasks from the notice escalation ladder (in-person reminders, physical service record); handled in the manager web app until the field app ships | P2 |

**Module 12: Diaspora owner view**

| ID | Requirement | Priority |
| --- | --- | --- |
| DO-01 | Owner app and web view: collections, arrears, occupancy, open repairs | P2 |
| DO-02 | Remote approval of repair quotes above the owner's threshold | P2 |
| DO-03 | Photo and video proof of completed work | P2 |
| DO-04 | Statements in a format suited to overseas accountants; time zone shown on all times | P2 |
| DO-05 | Read-only access for a nominated family member or adviser | P2 |

**Module 13: Dashboards and analytics**

| ID | Requirement | Priority |
| --- | --- | --- |
| DA-01 | Portfolio dashboard: occupancy, collection rate, arrears, rent roll, paid-until coverage | MVP |
| DA-02 | Lease expiry pipeline for the next 3, 6 and 12 months | MVP |
| DA-03 | Net operating income and yield per property | P2 |
| DA-04 | Maintenance cost per unit and response times | P2 |
| DA-05 | Staff performance: collections by caretaker, response times by manager | P2 |
| DA-06 | Views filtered by owner, property, region and unit type; export to PDF and Excel | MVP |

## 15. Module 14: Administration, roles and security

Access is set by role, every sensitive action needs the right authority, and agencies can run many owners' portfolios inside one account without mixing their data.

| ID | Requirement | Priority |
| --- | --- | --- |
| AD-01 | Company account (landlord or agency) with branding: logo, colours, sender name on messages and documents | MVP |
| AD-02 | Multi-owner setup for agencies: each owner sees only their own properties | MVP |
| AD-03 | Roles: owner, agency admin, property manager, accountant, caretaker, artisan, tenant, commercial tenant user, read-only adviser | MVP |
| AD-04 | Permission matrix editable per company (who can issue notices, approve spend, record cash, refund) | P2 |
| AD-05 | Approval rules: two-person approval for notices to quit, refunds and write-offs; a landlord with no staff nominates a second approver, or re-confirms with a one-time code after 24 hours | MVP |
| AD-06 | Two-factor login; session timeout; device list with remote sign-out | MVP |
| AD-07 | Immutable audit log, searchable by user, record and date | MVP |
| AD-08 | Subscription and billing for the platform itself: tiers, per-unit rates by unit type, invoices, MoMo or card payment (section 21) | MVP |
| AD-09 | Data export for the company on request; tenant data deletion workflow under Act 843 | P2 |
| AD-10 | Platform admin console: company onboarding, support access with consent, usage and messaging costs | MVP |

**Acceptance criteria**

- A caretaker cannot see owner statements, other properties or tenant ID numbers.
- A permission change is logged with who made it, when, and the before and after values.

## 16. Screen inventory by app

The MVP needs about 40 screens across four surfaces; the designer should start with the tenant payment flow and the manager collections view, since those decide adoption.

| App | Screens | Phase |
| --- | --- | --- |
| Manager and landlord web app | Sign-in and 2FA; home dashboard; portfolio list; property detail; unit detail; tenant list; tenant profile and timeline; lease builder; lease detail; invoices; payments and unmatched queue; arrears; receipts; notices list; notice composer; notice tracker; inbox; broadcast composer; maintenance board; job detail; inspections; owner statements; expenses; rent tax report; compliance list; settings, users and roles; subscription | MVP |
| Tenant mobile app and web | Sign-in by phone code; home (balance, paid-until, next due); pay; payment history and receipts; lease and documents; repair request; repair tracking; notices to sign; messages; profile | MVP |
| Secure link pages (no login) | Pay rent; sign lease; sign notice; renewal offer; artisan job sheet | MVP |
| WhatsApp flows | Menu; balance; receipt; pay link; repair report; notice link delivery; reminders | MVP |
| Commercial tenant portal | Company dashboard; invoices and tax documents; withholding tax upload; lease summary; service charge breakdown; service requests and SLA view; document library; users and roles | P2 |
| Caretaker field app | Today's tasks; record cash; meter readings; inspection checklist; log repair; cash handover; sync status | P2 |
| Owner app (including diaspora) | Portfolio summary; property performance; approvals; repairs with photos; statements; remittances | P2 |
| Platform admin console | Companies; plans and billing; support access; messaging cost monitor; system health | MVP |

## 17. Integrations

Eight integrations carry the MVP; the provider names below are candidates to be confirmed on price, licensing and reliability during technical due diligence, not decisions.

| Integration | Purpose | Candidate providers | Phase |
| --- | --- | --- | --- |
| Payments aggregator | MoMo (MTN, Telecel, AT), card and bank collection with callbacks | Hubtel, Paystack, ExpressPay, Flutterwave | MVP |
| WhatsApp Business Platform | Two-way messaging, templates, media | Meta Cloud API directly, or a business solution provider such as Twilio or 360dialog | MVP |
| SMS gateway | Reminders, one-time codes, fallback channel | Hubtel, mNotify, Arkesel, Twilio | MVP |
| Email | Notices, statements, inbound replies | SendGrid, Postmark, Amazon SES | MVP |
| Identity verification | Ghana Card checks against NIA records | A licensed verification provider such as Smile ID | MVP |
| E-signature | Leases and notice acknowledgements | Built in-house with one-time code and audit trail, or a provider such as Dropbox Sign or DocuSign | MVP |
| Address and maps | GhanaPost GPS lookup, map pins | GhanaPost GPS (confirm API access), Google Maps | MVP |
| Cloud storage | Photos, documents, signed PDFs | Any major cloud with an African or EU region | MVP |
| Accounting export | Owner and agency books | QuickBooks, Xero, Excel | P2 |
| Property portals | Listing syndication | Meqasa and others where APIs exist | P3 |
| USSD | Balance and pay for basic phones | Through the payments or SMS provider | P3 |

Recommendation: build e-signature for notices in-house. It is a narrow, high-volume use, and owning the audit trail matters more than a third-party brand.

## 18. Release plan

Ship collections, notices and WhatsApp first, prove them in a pilot, then add the modules that protect assets and serve commercial and diaspora owners.

Text version of the release plan diagram, which does not survive export:

Phase 1 (MVP), "Collect, record, notify": property register; tenants, leases and e-sign;
billing, MoMo and receipts; advance rent engine; legal notices and reminders; WhatsApp and
unified inbox; repairs and inspections; owner statements, rent tax and dashboards.

Gate 1, pilot proven: legal opinion on e-notices; 95% of payments auto-matched; 95%
collection rate in pilot.

Phase 2, "Protect and report": maintenance quotes and vendors; utilities and service charge;
client money and ledger export; commercial tenant portal; caretaker field app; diaspora owner
view; compliance dashboard.

Gate 2, ready to scale: 70% weekly active managers; messaging costs recovered; commercial
demand confirmed.

Phase 3, "Grow and scale": vacancy and leasing; portal syndication; USSD channel;
local-language messages; fit-out, parking, visitors; direct debit payments.

Phases are sequenced by gate, not by calendar; durations will be set once the build approach and team size are decided.

## 19. Success metrics

The product succeeds if landlords collect more of their rent, faster, with less effort; the targets below are starting points to be reset once pilot data is in.

| Metric | Definition | 6-month target |
| --- | --- | --- |
| Collection rate | Rent collected in the month divided by rent due | 95% or higher for pilot portfolios |
| Digital payment share | Share of rent paid by MoMo, bank or card rather than cash | 80% |
| Auto-match rate | Share of digital payments matched without manual work | 95% |
| Time to receipt | Payment confirmed to receipt delivered | Under 1 minute |
| Notice acknowledgement | Share of notices e-signed within 7 days | 85% |
| Repair response | Emergency jobs attended within target time | 90% |
| Arrears over 60 days | Share of rent roll more than 60 days overdue | Down 30% from pilot baseline |
| Weekly active managers | Managers using the app at least 3 days a week | 70% of paying accounts |
| Tenant WhatsApp adoption | Tenants who opted in and used WhatsApp at least once a month | 75% |
| Net revenue retention | Revenue from accounts a year later, including growth | Above 100% |

## 20. Risks and open questions

The largest risks are legal (notice validity and advance rent), commercial (messaging costs eating the margin) and behavioural (caretakers and landlords who prefer cash).

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| Electronic notices challenged before Rent Control or a court | A failed notice delays recovery and damages trust in the product | Legal opinion before launch; physical service fallback built into the ladder; evidence bundle export |
| Product seen to normalise advance rent above the legal cap | Regulators and serious agencies may avoid it | Record months paid ahead on every lease; flagging can be switched on per company (off by default while large advances remain the norm); never present an advance as compliant |
| WhatsApp and SMS costs exceed what the pricing recovers | Margin erodes as reminders scale | Cost tracking per account; reminder caps; pass-through charges on heavy plans |
| Caretakers resist being tracked | Field app unused, leakage continues | Make the app save them time (fewer calls from landlords); tie handover confirmation to their pay process |
| Landlords keep cash habits | Digital share stays low | Tenant-side convenience (instant receipts, paid-until clarity) creates pull from tenants |
| Payment aggregator outage | Payments fail at month-end peaks | Two aggregators from launch; queued callbacks; manual record fallback |
| Data breach of tenant IDs and contacts | Legal exposure under Act 843 and reputational damage | Encryption, access control, ID numbers masked by default, annual security test |
| Direct competitors copy features | Price pressure | Win on operations depth and agency workflows, not listings |

**Open questions**

- [ ] Which payment aggregator gives the best settlement time and fee for rent volumes?
- [ ] Can the platform hold a payment licence or must all money flow through partners?
- [x] Should client money pass through the platform or settle directly into landlord and agency accounts? Decided: it settles directly through provider subaccounts or splits; the platform never holds rent.
- [ ] What minimum notice periods apply by tenancy type, as confirmed by legal counsel?
- [ ] Is Rent Control registration available digitally for integration?

## 21. Pricing and packaging

Landlords pay a monthly subscription: the tier sets which features they get, and the bill is the number of units multiplied by that tier's rate for each unit type, with three rates: single rooms, self-contained flats and houses, and commercial units. Vacant units are not billed.

**How the monthly bill is calculated**

Monthly bill = (occupied single rooms × single-room rate) + (occupied self-contained flats and houses × self-contained rate) + (occupied commercial units × commercial rate), and never less than the tier's minimum monthly fee. Each tier has its own set of three rates. A mixed-use building is billed unit by unit, each at its own band's rate.

| Billing band | Unit types included |
| --- | --- |
| Single room | Single room, chamber and hall, single room self-contained, kiosk-style room let for living |
| Self-contained flat or house | Studio, 1 to 5 bedroom apartment, detached or semi-detached house, townhouse |
| Commercial | Shop, store, office, warehouse, kiosk, any unit let for business use |

**Tiers (proposed)**

| Tier | Typical customer | What it includes |
| --- | --- | --- |
| Starter | Individual landlord with a few houses or a compound house | Property register; tenants and leases with e-sign; billing, MoMo collection and receipts; advance rent engine; WhatsApp reminders; rent tax tracker; core dashboard |
| Growth | Landlord with several properties, or a small agency | Everything in Starter, plus legal notices with e-sign and the reminder ladder; unified inbox and two-way WhatsApp; maintenance and inspections; owner statements; utilities and service charges |
| Portfolio | Large landlord, estate owner, commercial building owner or agency | Everything in Growth, plus multi-owner accounts; commercial tenant portal; caretaker field app; diaspora owner view; compliance dashboard; accounting export; priority support |

Rates per tier are not yet set. They should come from pricing research: what landlords now pay caretakers and agents, what they lose to leakage, and competitor prices.

**Why commercial units cost more**

Commercial rents are higher, each tenancy has several users, and these tenants use the heaviest features: tax invoices, withholding tax reconciliation, service charge statements and response time tracking.

**Pricing rules**

| Rule | Position | Status |
| --- | --- | --- |
| Billing bands | Three rates per tier: single rooms, self-contained flats and houses, commercial units; single rooms carry the lowest rate | Decided |
| Which units are billed | Occupied units only; vacant units are free; the tier minimum still applies; a unit is billable for a month if it had an active lease on any day of that month | Decided |
| Subscription continuity | The subscription renews and bills every month until the landlord cancels; tenant rent collection never stops | Decided |
| Unpaid subscription | Billing continues and arrears accrue; after a 14-day grace period the landlord's manager features go read-only, while tenant payments and receipts keep working | Decided |
| Messaging | Recommended: a monthly WhatsApp and SMS allowance per unit, with overage charged at cost plus a margin | Open |
| Annual payment | Discount for paying 12 months upfront; the rate is set in configuration | Decided |
| Changing tier | Upgrade immediately with a prorated charge; downgrade from the next cycle | Decided |

Billing on occupancy creates one obvious gap: a landlord could mark occupied units as vacant to cut the bill. Occupancy must therefore come from leases, not from a status the landlord sets by hand (PB-09).

**Requirements for the subscription engine**

| ID | Requirement | Priority |
| --- | --- | --- |
| PB-01 | Every unit carries a billing band: single room, self-contained flat or house, or commercial | MVP |
| PB-02 | Monthly snapshot of occupied (billable) units by band, vacant units excluded, stored for audit and dispute | MVP |
| PB-03 | Rate card per tier and unit type held in configuration, with effective dates | MVP |
| PB-04 | Feature access controlled by tier; locked features show what upgrading unlocks | MVP |
| PB-05 | Tier minimum fee, proration, annual prepayment and discount codes | MVP |
| PB-06 | Messaging allowance tracking and overage billing | P2 |
| PB-07 | Subscription invoices and receipts in cedis; payment by MoMo or card; automatic renewal | MVP |
| PB-08 | Free trial or guided onboarding period: 30 days by default, length configurable | MVP |
| PB-09 | A unit counts as occupied whenever it has an active lease; a unit cannot be set to vacant while a lease is active, and every status change is logged | MVP |
| PB-10 | Subscription renews monthly until the landlord cancels; cancellation takes effect at the end of the paid cycle, with data export offered | MVP |
| PB-11 | Unpaid subscription invoices tracked as arrears with reminders to the landlord; tenant payment links, receipts and notices are never switched off | MVP |

## Sources

- [Ghana Revenue Authority: Rent Income Tax](https://gra.gov.gh/?p=6177) (rates, 30-day payment rule, late payment interest)
- [Ownkey: Ghana Landlord Guide 2026](https://ownkey.com/blog/landlord-guide-ghana) (advance rent cap under section 25(5), market practice)
- [Ownkey: Ghana Tenancy Agreement Guide 2026](https://ownkey.com/blog/ghana-tenancy-agreement-guide) (cedi-only rent, Rent Control registration)

Statutes referenced for legal review: Rent Act 1963 (Act 220), Income Tax Act 2015 (Act 896), Data Protection Act 2012 (Act 843), Electronic Transactions Act 2008 (Act 772), Real Estate Agency Act 2020 (Act 1047).
