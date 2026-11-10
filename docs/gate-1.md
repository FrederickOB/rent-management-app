# Gate 1: pilot proven

- **Status:** M11 (done-when item 3). Written from the code and the docs on 10 Nov 2026. **Nothing below is signed yet.**
  - **The rules table:** 27 legal and tax values; none is verified (4 are `from_prd`, 23 `unverified`).
  - **Open questions:** 49 are open; 28 of them block the pilot or live rent collection.
  - **Outside tracks:** none is recorded as complete.
- **Covers:**
  - the three Gate 1 criteria (PRD section 18) and how the product measures them;
  - every rules-table value awaiting confirmation, with who signs it;
  - every open question that blocks the pilot or live rent collection;
  - the tracks outside the code;
  - the sign-off table.
- **The pilot starts after the first deployment** (M12; M11 decision 1). **Live rent collection** waits, in addition, for counsel's written opinion on Bank of Ghana licensing (OQ-03; CLAUDE.md section 8).

## 1. The three criteria

The PRD sets three criteria for Gate 1: "legal opinion on e-notices; 95% of payments auto-matched; 95% collection rate in pilot".

| Criterion | How it is measured | Who signs |
| --- | --- | --- |
| **1. Legal opinion on e-notices** | Not measured by the product. It is counsel's written opinion that electronic service of notices, acknowledged by a one-time-code signature, is effective under the Electronic Transactions Act 2008 (Act 772) and the Rent Act, with the wording of the lease's electronic-service clause and of the service affidavit (OQ-10). It should also answer OQ-09 (notice periods), OQ-57 (serving on a channel after an opt-out) and OQ-53 (template and affidavit wording). Until then, every notice to quit is also posted on the premises, and the ladder ends in physical service (`runbooks/notice-escalation.md`). | Counsel |
| **2. 95% of payments auto-matched** | **Provider payments matched with no person, out of all provider payments in the month** (M9 decision 10). A payment still waiting in Unmatched receipts counts against the rate. Direct transfers into landlords' own accounts never reach a provider, so they are shown separately, as "Direct transfers matched to a lease" (prd-issues 35). | Founder, from the Gate 1 page |
| **3. 95% collection rate in pilot** | **Rent and service charge collected, out of rent and service charge due, by the month each line covers** (F2, founder decision 2026-11-06). Due is the rent and service-charge lines whose charge period starts in the month, less credit notes dated by the month's end. Collected is what of each line was settled by the month's end, by payment, deposit or tax withheld, with a value date on or before it, never more than the line. Money paid in advance and tax withheld count. A write-off doesn't. Deposits, VAT and levies, and one-off charges are left out. | Founder, from the Gate 1 page |

### Where to read the figures

- **Console → Gate 1 metrics** (`/platform/gate1`), for platform admins (`metrics.platform.read`):
  - **"Every company, <month>":** the month's measures in total;
  - **"By company":** each company's row;
  - **"Gate 1 targets, month by month":** each month met, not met, or not measurable (nothing was due or paid), per company and in total, between two months you choose, with "Export to Excel".
- **Each company's Home dashboard** shows the same measures and targets for that company.

### How the figures are made

- **When:** `reporting.metrics-rollup` runs nightly at 04:00 Africa/Accra and stores each month's figures with their inputs (`metric_daily`).
- **No rounding into a pass:** "met" is decided from the exact counts, never the rounded percentage. 18,999 of 20,000 shows 95.00% and is **not** met.
- **Totals:** the platform total adds the companies' counts exactly; it is never an average of shares. It covers every company with figures. For the pilot, read the pilot companies' own rows.
- **Months:** they start from each company's cut-over (the onboarding date, P25).
- **To decide before sign-off:** the PRD doesn't say over how many months the targets must hold, or whether each pilot company must meet them or only the total. The founder decides and records it here.

### The other success measures

PRD section 19's other measures are computed on the same page. They are not Gate 1 criteria:

| Measure | Notes |
| --- | --- |
| Paid digitally | |
| Receipts sent within a minute, and delivered within a minute | |
| Notices e-signed within 7 days | 85% target |
| Emergency repairs started within target | |
| Arrears over 60 days | Against the first full month after the cut-over |
| Staff active 3 days a week or more | |
| Tenants using WhatsApp | |
| Net revenue retention | Shown once 12 months of subscription invoices exist |

## 2. Rules-table values awaiting confirmation

**How a value is confirmed:**

1. Counsel or the tax adviser confirms it in writing, with the source.
2. A platform admin adds a **new** row with its own effective date. Existing rows are never edited:

   ```bash
   pnpm rules:add --key <key> --value '<json>' --from <date> --source "<source>" \
     --status verified --verified-by "<name, role>" --by "<who added it>"
   ```

3. Past receipts, notices and reports keep the rule version they used.
4. The console's Rules page (`/platform/rules`) lists every row with its status. Unverified ones stand out.

**Values:**

- "None" means the row exists with no value: the product enforces nothing for it and says so where it is used.
- "Affects" says whether the value changes a **tax amount**, a **legal outcome**, or only an alert or record.

| # | Key | Value | Status | What it affects | Affects | Signs |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `rent_tax.rate.residential` | 800 bps (8%) | from_prd | Rent tax accrued on each receipt of residential rent (P17; TX-01) | Tax amount | Tax adviser |
| 2 | `rent_tax.rate.commercial` | 1500 bps (15%) | from_prd | The same, commercial rent | Tax amount | Tax adviser |
| 3 | `rent_tax.due_days_after_receipt` | 30 days | from_prd | The due date of each rent tax item (TX-02). GRA's published guidance, not statute (OQ-17) | Tax (due date) | Tax adviser |
| 4 | `rent_tax.alert_days` | 21 and 28 days | from_prd | When staff are alerted before a rent tax item falls due (TX-02) | Alerts only | Tax adviser |
| 5 | `rent_tax.base` | Rent received, including advances | unverified | Whether an advance is taxed in full when received (D9; OQ-17, OQ-64) | Tax amount | Tax adviser |
| 6 | `rent_tax.rounding` | Half up, per receipt | unverified | How each receipt's tax is rounded (OQ-17) | Tax amount | Tax adviser |
| 7 | `rent_tax.includes_service_charge` | true | unverified | Service charge in the rent tax base (OQ-19) | Tax amount | Tax adviser |
| 8 | `withholding_tax.rate.residential` | 800 bps | unverified | The rate the withholding form expects from a tenant who withholds (TX-04; OQ-18) | Tax amount | Tax adviser |
| 9 | `withholding_tax.rate.commercial` | 1500 bps | unverified | The same, commercial leases | Tax amount | Tax adviser |
| 10 | `vat.commercial_rent` | VAT 1500 + NHIL 250 + GETFund 250 bps | unverified | VAT and levies on commercial invoices of VAT-registered owners (CT-04, P32; OQ-20) | Tax amount | Tax adviser |
| 11 | `vat.applies_to_service_charge` | true | unverified | VAT and levies on commercial service charge (OQ-20) | Tax amount | Tax adviser |
| 12 | `vat.return_due_days` | None | unverified | The VAT return due date in the compliance list, shown as "Due date unverified" (P33; OQ-61) | Tax (due date) | Tax adviser |
| 13 | `vat.platform_subscription` | As row 10 | unverified | VAT on the platform's own subscription invoices, only once the terms record the platform's VAT registration, which is off (OQ-48) | Tax amount | Tax adviser |
| 14 | `advance_rent.max_months.monthly_or_shorter` | 1 month | unverified | The advance-rent check (AR-05). It flags nothing while `advance_rent_policy` is `off`, the setting in force (D6, OQ-28); months paid ahead are recorded regardless (OQ-11) | Legal outcome | Counsel |
| 15 | `advance_rent.max_months.over_six_months` | 6 months | unverified | The same, tenancies over six months | Legal outcome | Counsel |
| 16 | `rent_control.registration_days` | 14 days | unverified | The Rent Control registration deadline and its reminders (TX-05; OQ-52) | Legal outcome | Counsel |
| 17 | `notice_to_quit.statutory_min_days.residential` | None | unverified | The earliest date of a notice to quit. With none, only the lease's own period is enforced and the composer warns (D7; OQ-09) | Legal outcome | Counsel |
| 18 | `notice_to_quit.statutory_min_days.commercial` | None | unverified | The same, commercial leases | Legal outcome | Counsel |
| 19 | `notice_to_quit.assessment_bar_months` | 24 months | unverified | A notice to quit is refused this long after a Rent Officer assessment (Act 220 s.23); the anniversary counts as inside | Legal outcome | Counsel |
| 20 | `stamp_duty.deadline_months` | 2 months | unverified | The stamping deadline and its reminders on each lease (OQ-45) | Legal outcome | Counsel, with the tax adviser |
| 21 | `lease.writing_exemption_max_years` | 3 years | unverified | Leases longer than this take the formal-lease path: legal practitioner, wet-signed copy, registration (OQ-44) | Legal outcome | Counsel |
| 22 | `data_retention.financial_and_notices` | 6 years | unverified | How long stored evidence (signed documents, notices, receipts, audit anchors) is locked write-once. Today the lock is in governance mode; **once verified it becomes compliance mode, which no one can undo.** Erasure holds these records (OQ-14, OQ-49) | Legal outcome | Counsel |
| 23 | `data_retention.other.messages` | None | unverified | Erasure holds messages until it has a verified value (OQ-14) | Legal outcome | Counsel |
| 24 | `data_retention.other.identity_data` | None | unverified | Erasure holds ID numbers and TINs (OQ-14) | Legal outcome | Counsel |
| 25 | `data_retention.other.webhook_bodies` | None | unverified | Erasure holds payment providers' webhook bodies (OQ-14) | Legal outcome | Counsel |
| 26 | `data_retention.other.tenant_profile` | None | unverified | Erasure holds the tenant's name, contact details and contacts (OQ-14, OQ-65) | Legal outcome | Counsel |
| 27 | `data_protection.request_response_days` | None | unverified | The due date of a data protection request; none is shown until set (OQ-65) | Legal outcome | Counsel |

**Where the warnings show:** an unverified value that affects a legal outcome is flagged to staff where it is used. Examples: the notice composer's warnings on the statutory minimum and the s.23 bar, and the data protection register's "the response time is still to be set by counsel".

## 3. Open questions that block the pilot or live rent collection

Full text, defaults and research are in `docs/open-questions.md`.

### Before any live rent collection

| OQ | Question, in one line | Owner | It blocks |
| --- | --- | --- | --- |
| OQ-03 | Does split settlement need a Bank of Ghana licence (Act 987)? | Counsel | All live rent collection (CLAUDE.md section 8) |
| OQ-43 | If a licence is needed, which category, and what ownership? | Founder with counsel | Live rent, if OQ-03 says a licence is needed |
| OQ-01 | Can Paystack settle each payment straight to the landlord's or agency's account, in writing; MoMo wallets too? | Founder with Paystack | Live rent through Paystack (D1, D2); MoMo destinations |
| OQ-06 | May we give Paystack a synthetic per-tenant email for tenants without one? | Paystack | Charging tenants who have no email |
| OQ-41 | After a payout, whose balance a refund or chargeback comes from | Founder with providers | The landlord terms on chargebacks |
| OQ-42 | Who verifies a new subaccount, how long it takes, and whether by API | Paystack | Each landlord's first payout |
| OQ-46 | Does PNDCL 138 s.4(2) expose landlords, or the platform, when rent on an unregistered tenancy is collected through it? | Counsel | Collecting rent on residential tenancies not yet registered |

The external penetration test (section 4) also comes before live rent collection.

### Before the pilot, or for Gate 1

| OQ | Question, in one line | Owner | It blocks |
| --- | --- | --- | --- |
| OQ-10 | Is electronic service of notices effective, and what should the clause and affidavit say? | Counsel | Gate 1 criterion 1 |
| OQ-09 | What minimum notice periods apply, by tenancy type? | Counsel | Gate 1; relying on a notice to quit's date |
| OQ-57 | After an opt-out, may a notice still be served on that channel under the lease's clause? | Counsel | Gate 1; electronic service after STOP |
| OQ-53 | Will counsel supply the starter tenancy agreements, notice templates and service affidavit? | Founder with counsel | Sending leases and notices to real tenants (the composer says "Do not send it to real tenants until they have") |
| OQ-44 | Are e-signed leases valid, and do the Land Act's formalities apply? | Counsel | E-signing real leases in the pilot |
| OQ-47 | Does the platform need a licence under the Real Estate Agency Act (Act 1047)? | Counsel | The pilot |
| OQ-14 | Retention periods, erasure against retention, Data Protection Commission registration, hosting abroad | Counsel | The pilot (rules 22 to 26) |
| OQ-50 | Must the platform register as a controller, a processor or both, and must each landlord? | Counsel | The pilot |
| OQ-49 | Must tax records stay in Ghana (Act 915 s.27); does the draft Data Protection Bill 2025 affect hosting or ID data? | Counsel | The first deployment (M12), hence the pilot |
| OQ-65 | How long a landlord has to answer a data protection request, and is anonymisation enough when records must be kept? | Counsel | The pilot (rule 27) |
| OQ-66 | What Act 843 requires after a personal data breach (whom to notify, by when, with what), and whether a breach notice may reach a tenant who opted out of every channel | Counsel | The pilot (breach runbook) |
| OQ-40 | Do the landlord terms let the platform message tenants on the landlord's behalf on the shared WhatsApp number? | Counsel | WhatsApp in the pilot |
| OQ-24 | Meta business verification, numbers, templates and lead times | Founder | WhatsApp in the pilot |
| OQ-58 | Are there SMS sending hours in Ghana, and are these messages promotional? | Counsel | SMS in the pilot |
| OQ-39 | Does L.I. 2523 bind landlords or the platform, and does a check through a provider satisfy it? | Counsel | Ghana Card checks in the pilot |
| OQ-22 | Which Ghana Card verification provider? | Founder with the provider | Ghana Card checks (only a fake exists) |
| OQ-64 | Is the tax treatment of opening balances right? | Tax adviser | Onboarding a pilot landlord's balances (P25) |
| OQ-56 | How tax withheld on a month that is later credited back is treated | Tax adviser | The commercial pilot |
| OQ-61 | When a VAT return is due to GRA | Tax adviser | The commercial pilot (rule 12) |
| OQ-62 | Whether the remittance hold-back for a letting-business owner holds back enough | Tax adviser | The commercial pilot |
| OQ-63 | Should owners get an unsubscribe link for statements? | Founder | Agencies sending owner statements in the pilot |

### Open, not blocking: the pilot runs on their defaults

| OQ | One line | Owner |
| --- | --- | --- |
| OQ-02 | Which second provider also settles directly? No failover until one is confirmed | Founder with providers |
| OQ-04 | The best settlement time and fee | Founder |
| OQ-05 | Reference lengths on MoMo and bank narrations | Founder with providers |
| OQ-08 | Bank transfer collection or virtual accounts | Founder with providers |
| OQ-11 | Is the advance cap current, and to which tenancies does it apply? (rules 14 and 15) | Counsel |
| OQ-12 | Rent while a tenant holds over | Counsel |
| OQ-13 | Rules on security deposits | Counsel |
| OQ-15 | Late fees (not built; Phase 2) | Counsel |
| OQ-17 | Rent tax on advances, and rounding (rules 5 and 6) | Tax adviser |
| OQ-18 | Rent tax for corporate owners, and withholding as final or credit | Tax adviser |
| OQ-19 | Rent tax on service charge and refunds (rule 7) | Tax adviser |
| OQ-23 | GhanaPost GPS access | Founder |
| OQ-35 | Messaging allowance and overage pricing | Founder |
| OQ-37 | Subscription rates (billing stays off until set) | Founder |
| OQ-45 | Stamping tenancy agreements (rule 20) | Counsel with the tax adviser |
| OQ-48 | VAT on the platform's subscriptions (rule 13) | Tax adviser |
| OQ-51 | An advance limit for terms of one to six months | Counsel |
| OQ-52 | When Rent Control's 14 days start, and which tenancies (rule 16) | Counsel |
| OQ-55 | Is the settlement-account alert exempt from consent? | Founder, with counsel if needed |
| OQ-59 | Limits on deposits and deductions at move-out | Counsel |
| OQ-60 | VAT on management fees | Tax adviser |

## 4. Tracks outside the code

None is recorded as complete in the repository as of 10 Nov 2026. The founder updates the status column.

| Track | Owner | Needed by | Covers | Status |
| --- | --- | --- | --- | --- |
| Payments licensing opinion (Act 987) | Founder with counsel | Before any live rent collection | OQ-03, OQ-43 | Open |
| Ghanaian property lawyer | Founder | Gate 1, the pilot | OQ-09 to OQ-14, OQ-39, OQ-40, OQ-44 to OQ-47, OQ-49, OQ-50, OQ-53, OQ-57, OQ-58, OQ-65, OQ-66; rules 14 to 27 | Open |
| Tax adviser | Founder | The pilot; the commercial pilot | OQ-17 to OQ-19, OQ-48, OQ-56, OQ-60 to OQ-62, OQ-64; rules 1 to 13 | Open |
| Paystack agreement and a test account | Founder | Live rent | OQ-01, OQ-04 to OQ-06, OQ-08, OQ-41, OQ-42 | Open |
| Second provider due diligence | Founder | Failover | OQ-02 | Open |
| Meta business verification and App Review | Founder | WhatsApp in the pilot | OQ-24 | Open |
| Meta developer app with a test number | Founder | The WhatsApp smoke test | M6 decision 14 | Open |
| SMS two-way short code (Hubtel) and gateway account | Founder | SMS replies and STOP | M6 decision 1 | Open |
| Email sending and inbound domains (Postmark) | Founder | Email | M6 decision 2 | Open |
| D-U-N-S number, then Apple and Google developer accounts, then `eas init` | Founder | Store builds and push | OQ-25 | Open |
| Ghana Card verification contract | Founder | Ghana Card checks | OQ-22 | Open |
| GhanaPost GPS API access | Founder | Address lookup (manual entry meanwhile) | OQ-23 | Open |
| Data Protection Commission registration | Founder with counsel | The pilot | OQ-14, OQ-50 | Open |
| AWS account (organisation, billing, root MFA) | Founder | M12 | M11 decision 1 | Open |
| Latency test for the hosting region | Engineering | M12 | ADR-009, OQ-21 | Open (runs in M12) |
| External penetration test | Founder | Before any live rent collection | PRD section 20; M11 decision 6 | Open |

## 5. Sign-off

**How to sign:**

- one row per item;
- a rules row is signed by its signer and then added as a verified row (section 2);
- an open question is signed when its answer is recorded in `docs/open-questions.md`;
- a track is signed when it is done.

| Area | Item | Signs | Signed by | Date |
| --- | --- | --- | --- | --- |
| Gate 1 | Criterion 1: counsel's written opinion on e-notices (OQ-10) | Counsel | | |
| Gate 1 | Criterion 2: 95% of provider payments auto-matched, over the agreed months | Founder | | |
| Gate 1 | Criterion 3: 95% collection rate in the pilot, over the agreed months | Founder | | |
| Rules | 1 `rent_tax.rate.residential` | Tax adviser | | |
| Rules | 2 `rent_tax.rate.commercial` | Tax adviser | | |
| Rules | 3 `rent_tax.due_days_after_receipt` | Tax adviser | | |
| Rules | 4 `rent_tax.alert_days` | Tax adviser | | |
| Rules | 5 `rent_tax.base` | Tax adviser | | |
| Rules | 6 `rent_tax.rounding` | Tax adviser | | |
| Rules | 7 `rent_tax.includes_service_charge` | Tax adviser | | |
| Rules | 8 `withholding_tax.rate.residential` | Tax adviser | | |
| Rules | 9 `withholding_tax.rate.commercial` | Tax adviser | | |
| Rules | 10 `vat.commercial_rent` | Tax adviser | | |
| Rules | 11 `vat.applies_to_service_charge` | Tax adviser | | |
| Rules | 12 `vat.return_due_days` | Tax adviser | | |
| Rules | 13 `vat.platform_subscription` | Tax adviser | | |
| Rules | 14 `advance_rent.max_months.monthly_or_shorter` | Counsel | | |
| Rules | 15 `advance_rent.max_months.over_six_months` | Counsel | | |
| Rules | 16 `rent_control.registration_days` | Counsel | | |
| Rules | 17 `notice_to_quit.statutory_min_days.residential` | Counsel | | |
| Rules | 18 `notice_to_quit.statutory_min_days.commercial` | Counsel | | |
| Rules | 19 `notice_to_quit.assessment_bar_months` | Counsel | | |
| Rules | 20 `stamp_duty.deadline_months` | Counsel, with the tax adviser | | |
| Rules | 21 `lease.writing_exemption_max_years` | Counsel | | |
| Rules | 22 `data_retention.financial_and_notices` | Counsel | | |
| Rules | 23 `data_retention.other.messages` | Counsel | | |
| Rules | 24 `data_retention.other.identity_data` | Counsel | | |
| Rules | 25 `data_retention.other.webhook_bodies` | Counsel | | |
| Rules | 26 `data_retention.other.tenant_profile` | Counsel | | |
| Rules | 27 `data_protection.request_response_days` | Counsel | | |
| Live rent | OQ-03 Bank of Ghana licensing | Counsel | | |
| Live rent | OQ-43 Licence category and ownership | Founder with counsel | | |
| Live rent | OQ-01 Paystack direct settlement, in writing | Founder with Paystack | | |
| Live rent | OQ-06 Synthetic email | Paystack | | |
| Live rent | OQ-41 Chargebacks after payout | Founder with providers | | |
| Live rent | OQ-42 Subaccount verification | Paystack | | |
| Live rent | OQ-46 Rent on unregistered tenancies | Counsel | | |
| Live rent | External penetration test | Founder | | |
| Pilot | OQ-10 Electronic service of notices | Counsel | | |
| Pilot | OQ-09 Notice periods | Counsel | | |
| Pilot | OQ-57 Service after an opt-out | Counsel | | |
| Pilot | OQ-53 Templates and affidavit wording | Founder with counsel | | |
| Pilot | OQ-44 E-signed leases | Counsel | | |
| Pilot | OQ-47 Real Estate Agency Act licence | Counsel | | |
| Pilot | OQ-14 Retention, registration, hosting abroad | Counsel | | |
| Pilot | OQ-50 Controller or processor | Counsel | | |
| Pilot | OQ-49 Records in Ghana; draft Bill 2025 | Counsel | | |
| Pilot | OQ-65 Request response time; erasure against retention | Counsel | | |
| Pilot | OQ-66 Breach notification under Act 843 | Counsel | | |
| Pilot | OQ-40 Messaging on the landlord's behalf | Counsel | | |
| Pilot | OQ-24 Meta verification | Founder | | |
| Pilot | OQ-58 SMS sending hours | Counsel | | |
| Pilot | OQ-39 L.I. 2523 | Counsel | | |
| Pilot | OQ-22 Ghana Card provider | Founder with the provider | | |
| Pilot | OQ-64 Opening balances and tax | Tax adviser | | |
| Pilot | OQ-56 Withheld tax on credited months | Tax adviser | | |
| Pilot | OQ-61 VAT return due date | Tax adviser | | |
| Pilot | OQ-62 Remittance hold-back | Tax adviser | | |
| Pilot | OQ-63 Owner unsubscribe | Founder | | |
| Pilot | Data Protection Commission registration | Founder with counsel | | |
| Pilot | First deployment (M12), with the AWS account and the latency test | Founder | | |
