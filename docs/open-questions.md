# Open questions

54 questions block or shape the build. Each has a recommended default that the build uses until the person named answers. Answers go in the "Decision" column with a date. Legal and tax values stay `unverified` in the rules table until then (`CLAUDE.md` section 7).

**Status on 28 Oct 2026:** 16 decided by the founder. 32 wait on counsel, the tax adviser or providers; research findings with sources are at the end of this file. 2 (OQ-35, OQ-37) wait on pricing research.

## Payments and settlement

| ID | Question | Who answers | Needed by | Recommended default | Decision |
| --- | --- | --- | --- | --- | --- |
| OQ-01 | Can Paystack settle each rent payment directly into the landlord's or agency's bank or MoMo account through subaccounts or splits, at rent volumes, with the platform as merchant of record? (D1, D2) | Founder with Paystack | M4b | Yes for bank-account subaccounts, which are documented. MoMo wallets as settlement destinations only after Paystack confirms in writing. | |
| OQ-02 | Which second provider also settles directly to landlord and agency accounts? (prd-issues 9) | Founder with providers | M4b | Flutterwave is the candidate (bank-account splits documented). Hubtel cannot carry rent under D1 (no splits). No failover until Flutterwave confirms. | |
| OQ-03 | Does the split-settlement model need a Bank of Ghana licence, registration or agency arrangement for the platform? (PRD: "Can the platform hold a payment licence or must all money flow through partners?") | Counsel | Pilot | Counsel's written opinion is a gate before live rent collection: Act 987 s.7(2)(l) and (m) may cover a platform that never holds funds. | |
| OQ-04 | Which aggregator gives the best settlement time and fee for rent volumes? (PRD) | Founder | M4b | Paystack: 1.95%, paid out the next working day. Flutterwave: 2% for MoMo and bank, 2.6% for card, plus VAT. | |
| OQ-05 | What length and characters do MTN MoMo, Telecel Cash, AT Money and bank narration fields allow for references? (prd-issues 15) | Founder with providers | M4a | 7 characters, letters and digits only: 6 Crockford base32 plus a check character computed in the same alphabet. | |
| OQ-06 | Paystack requires a customer email. May we use a synthetic per-tenant address on a platform domain for tenants without email? | Paystack | M4b | Yes: a per-tenant address on a platform-owned domain, never derived from the phone number. Pass Paystack's `label` so checkout shows the tenant's name. | |
| OQ-07 | Who bears provider fees: the landlord or agency, the platform, or the tenant as a surcharge? | Founder | M4b | The landlord or agency (subaccount bears the fee); configurable per company. | Decided 2026-10-28: the landlord or agency bears the fee. |
| OQ-08 | Which provider offers reference-based bank transfer collection or per-lease virtual accounts in Ghana? | Founder with providers | M4b | MoMo and card first. Add Paystack "Pay with Transfer" once Paystack confirms splits apply to it; other bank transfers are recorded as direct receipts (P28). | |
| OQ-41 | After a payout to a landlord's subaccount, whose balance is debited for a refund or chargeback? Flutterwave debits the platform's main account; Paystack's documentation is silent. | Founder with providers | M4b | Recover from the landlord's next settlements (P21, P22). Landlord terms let the platform recover anything a provider debits from it. | |
| OQ-42 | Paystack holds a new or changed subaccount's first payout until it is verified. Who verifies, how long does it take, and can it be done by API? | Paystack | M4b | Collect settlement details at onboarding, so verification finishes before the first rent falls due. | |

## Legal (Ghanaian property lawyer)

| ID | Question | Who answers | Needed by | Recommended default | Decision |
| --- | --- | --- | --- | --- | --- |
| OQ-09 | What minimum notice periods apply by tenancy type? (PRD, D7) | Counsel | M7, Gate 1 | Act 220 sets no notice periods. Possession needs a court or Rent Control order (s.17), and pressuring a tenant to leave is an offence (s.27). Use the lease's contractual period with the composer warning; common-law periods (a week, month or quarter; six months for yearly tenancies) stay unverified. An expired notice leads to court or Rent Control, never a lockout. | |
| OQ-10 | Is electronic service of notices, acknowledged by one-time-code signature, effective under Act 772 and the Rent Act? What wording should the lease's electronic-service clause and the service affidavit use? (prd-issues 25) | Counsel | M3 (clause), M7, Gate 1 | Notices: electronic acknowledgement plus physical posting on the premises, both recorded. Leases: see OQ-44. | |
| OQ-11 | Is the 6-month advance cap in Act 220 s.25(5) still current, and to which residential tenancies does it apply? | Counsel | M3 | s.25(5) caps advances at one month's rent on monthly or shorter tenancies and six months' on tenancies over six months, for all premises. Warnings stay off (OQ-28); the calculation covers both limits and commercial premises. | |
| OQ-12 | When a tenant holds over after the lease ends, does rent continue at the last rate, and what can the landlord charge? (prd-issues 20) | Counsel | M3 | The tenant becomes a statutory tenant from month to month on the original terms (s.29(1)(a), s.36). Rent continues at the last rate, with no holding-over surcharge: taking more than the recoverable rent is an offence (s.25(1)(a)). | |
| OQ-13 | Do any rules apply to security deposits: caps, interest, or a separate account? | Counsel | M4a | No statutory deposit rules found. A deposit must not look like a premium (s.25(1)(b)). Agencies hold client money in a separate client account (Act 1047 s.46). | |
| OQ-14 | What retention periods apply per record type (financial records, notices, messages, ID documents)? How do deletion requests under Act 843 interact with retention? Does the platform need Data Protection Commission registration, and on what basis may data be hosted abroad (ADR-009)? | Counsel | M11, pilot | Retain financial and notice records for six years (Act 915 s.27). Register with the Data Protection Commission before processing, and renew every two years (Act 843 ss.27, 50, 53). Declare transfer countries (s.47(1)(g)). Erase other personal data once it is no longer needed (s.24). | |
| OQ-15 | Are late fees lawful, and on what terms? (BC-10, P2) | Counsel | Phase 2 | Not built: s.25(1)(a) caps what a landlord may receive at the recoverable rent, whatever the lease says. | |
| OQ-16 | While statutory notice periods are unverified, should notices to quit be allowed in the pilot? | Founder with counsel | M7 | Allowed only after a company admin records an acknowledgement of the risk, with two-person approval on each notice. | Decided 2026-10-28: as recommended. |
| OQ-39 | Does NIA's L.I. 2523 (real-time biometric verification; no copies of the Ghana Card) bind landlords, agencies or the platform when they verify tenants? Does a check through a provider satisfy it? May the card number itself be stored? Which effective date applies: 9 June or 2 November 2026? | Counsel | M3 | Biometric check through the provider; the number stored encrypted; card images never requested or stored. | |
| OQ-40 | WhatsApp's policy bars messaging "in the voice of another business" without permission. Do the platform's landlord terms give that permission for the shared number? | Counsel | M6 | Landlord terms authorise the platform to message tenants on the landlord's behalf. | |
| OQ-43 | If a Bank of Ghana licence is needed (OQ-03), which category applies, and what ownership does it require? Act 987 s.8(4) requires at least 30% Ghanaian equity; PSP Standard is reserved for wholly Ghanaian-owned entities. | Founder with counsel | Pilot | Decide after counsel's opinion. | |
| OQ-44 | Are e-signed leases valid? The Electronic Transactions Act (s.4(e)) excludes contracts for any interest in immovable property. Do Land Act ss.33 (prepared by a legal practitioner), 68 (attested by a witness) and 227 (no effect until registered) apply to tenancy agreements? Does s.36(1)(f) exempt leases of three years or less from the writing requirement? | Counsel | M3 | Keep e-signing as the agreed record of terms, add a witness signature, and send leases over three years down a lawyer path. | |
| OQ-45 | How should tenancy agreements be stamped? Agreements for letting are dutiable (Stamp Duty Act s.22) within two months (s.12), and an unstamped agreement cannot be given in evidence (s.32(6)). What rate applies under Act 1109, and who stamps? | Counsel with the tax adviser | M3 | Track stamping per lease: a deadline two months after signing, the stamped copy uploaded, and reminders until done. | |
| OQ-46 | PNDCL 138 s.4(2) appears to bar demanding or receiving rent on an unregistered residential tenancy. Does that expose landlords, or the platform, when rent is collected through it? | Counsel | M3 | Track and remind (decided under OQ-27); never block collection. | |
| OQ-47 | Does the platform need a licence under the Real Estate Agency Act 2020 (Act 1047), whose "broker" includes one who assists completion of a leasing agreement? | Counsel | Pilot | Position the platform as software that landlords and licensed agencies operate. | |
| OQ-49 | The Revenue Administration Act 2016 (Act 915) s.27 requires tax records to be kept within the country for at least six years. Does that apply to landlords' records held by the platform? Would the draft Data Protection Bill 2025, which localises biometric and ID data, affect hosting or Smile ID? | Counsel | First deployment | Retain financial and notice records for six years, and keep a copy in Ghana. | |
| OQ-50 | Must the platform register with the Data Protection Commission as a controller, a processor or both? Must each landlord register too? | Counsel | Pilot | The platform registers as both; onboarding tells landlords about their own duty. | |

## Tax (tax adviser)

| ID | Question | Who answers | Needed by | Recommended default | Decision |
| --- | --- | --- | --- | --- | --- |
| OQ-17 | Is rent tax due on advance rent when received, or as it is earned? What rounding does GRA expect? (D9) | Tax adviser | M5 | When received, including advances: individuals are taxed on a cash basis (Act 896 s.19(2), s.20). GRA's 30-day payment rule is published guidance, not statute. No rounding rule found, so half up per receipt. | |
| OQ-18 | Does per-receipt rent tax apply to corporate owners? When a corporate tenant withholds tax, does it settle the owner's rent tax, or is it a credit? (prd-issues 12, 13) | Tax adviser | M5 | Withholding on rent is final for individuals and for companies not in the business of letting (Act 896 s.119(1)); for a letting business it is a credit (s.120). Owners carry a `letting_business` flag, and rent tax per receipt applies to the rest (P17, P20). | |
| OQ-19 | Does rent tax apply to service charge? Does refunding an advance reduce rent tax already accrued or paid? (prd-issues 14) | Tax adviser | M5 | Service charge may count as rent (Act 896 defines rent to include payment for "assistance ancillary to a use"), so it is taxed by default, switchable in the rules table. No automatic adjustment on refunds. | |
| OQ-20 | How do VAT and levies apply to commercial rent: rates, tax point, service charge, VAT withholding by designated agents, and GRA's E-VAT invoicing? | Tax adviser | M4a | VAT-registered commercial owners charge 15% VAT plus 2.5% NHIL and 2.5% GETFund on commercial rent (Act 1151, GRA guidance AG/26/001), at the invoice or the payment, whichever comes first (P32). Dwellings are exempt. | Decided 2026-10-28: commercial landlords are in the pilot, so VAT lines on commercial invoices are built in M4a. |
| OQ-48 | Services carry VAT with no registration threshold. Must the platform register for VAT, and charge VAT and levies on subscription invoices? | Tax adviser | M10 | Register, and show VAT and levies on subscription invoices. | |

## Platform and providers

| ID | Question | Who answers | Needed by | Recommended default | Decision |
| --- | --- | --- | --- | --- | --- |
| OQ-21 | Do you accept the latency-test rule for the hosting region? (ADR-009) | Founder | First deployment | Yes; eu-west-1 if the test cannot run. | Decided 2026-10-28: choose by the latency test. |
| OQ-22 | Which Ghana Card verification provider: coverage, cost per check, response time, and the fallback when NIA is unavailable? (TL-02) | Founder with provider | M3 | Biometric check (selfie against the NIA record) through Smile ID. Never request or store an image of the card; a failed check stays "verification pending" and is retried. | |
| OQ-23 | Can we get GhanaPost GPS API access, and on what terms? (PR-03) | Founder | M2 | Manual entry, validated against the digital-address pattern. Lookup only through a licensed source (Ghana Post, or Dojah); never scrape the app. | |
| OQ-24 | Meta business verification, a WhatsApp number per company or the shared platform number, display names and template approval: what lead times, and how does a shared number show each landlord? (CM-01) | Founder | Start now; M6 | Shared platform number, with shared templates that carry the landlord's name. Landlord terms authorise messaging on their behalf (OQ-40). Start business verification and App Review now. | |
| OQ-25 | Who publishes the tenant app in the App Store and Google Play, and are the developer accounts ready? (ADR-010) | Founder | M4b | The platform publishes one tenant app; landlords are not separate publishers. | Decided 2026-10-28: your company publishes one app. |
| OQ-26 | Does the chosen Expo SDK still support iOS 15, as the PRD requires? (prd-issues 34) | Engineering | M1 | Use the newest SDK that supports iOS 15; if none does, ask to raise the NFR to the SDK's minimum. | Decided 2026-10-28: iOS 16.4 and above with Expo SDK 58. |
| OQ-27 | Is Rent Control registration available digitally for integration? (PRD; TX-05, now MVP) | Founder with counsel | M3 | The Rent Control portal (rentcontrol.mwh.gov.gh) has no public API, so staff record the registration number and date. | Decided 2026-10-28: track registration and remind landlords until it is done; rent collection is never blocked. |
| OQ-51 | Act 220 s.25(5) sets advance limits for tenancies of a month or less and for those over six months. Which limit, if any, applies to a fixed term longer than one month but not more than six? (M3 plan 4.12) | Counsel | M5 (compliance report) | No limit is applied to those terms, so the advance check raises no flag for them, and the lease records that no rule was found. | |
| OQ-52 | Do Rent Control's 14 days (PNDCL 138 s.4) run from signing or from the start of the tenancy? Which tenancies must be registered: residential only, or commercial too? (TX-05) | Counsel | M3 | Count 14 days from signing, using the unverified `rent_control.registration_days` rule. Track residential leases, and commercial leases when the company chooses. | |
| OQ-53 | Will counsel supply or review the starter tenancy agreements (residential, commercial and short fixed-term)? The legal clauses are placeholders until then. (TL-05, M3 decision 3) | Founder with counsel | M3, Gate 1 | Ship the starters with "Wording to be supplied by your lawyer" in each legal clause. Each template version records whether counsel has reviewed it, and the builder warns until it has. | |

## Product (founder)

| ID | Question | Who answers | Needed by | Recommended default | Decision |
| --- | --- | --- | --- | --- | --- |
| OQ-28 | Advance rent over the cap: record and warn, or enforce the cap? (PRD open decision, D6) | Founder | M3 | Warn (`advance_rent_policy = warn`), switchable per company. | Decided 2026-10-28: no warning for now (`advance_rent_policy = off`); months paid ahead are still recorded. Re-confirmed after research showed s.25(5) covers all premises and that Rent Control announced prosecutions in June 2026. |
| OQ-29 | How do single-user landlords satisfy two-person approval? (prd-issues 8) | Founder | M1 | A nominated second approver; failing that, self-approval by one-time code after a 24-hour cooling-off, recorded as such. | Decided 2026-10-28: as recommended. |
| OQ-30 | Can one person sign in once and see tenancies with several landlords? (TL-12) | Founder | M3 | Yes: login at person level; each landlord's data stays scoped to that landlord. | Decided 2026-10-28: as recommended. |
| OQ-31 | What is the management fee base: gross or net, with or without advances and deposits? (prd-issues 18) | Founder | M9 | Rent and service charge settled, including advances and tax withheld, excluding deposits. | Decided 2026-10-28: as recommended. |
| OQ-32 | Should owner statements show cash, accrual or both? (prd-issues 19) | Founder with an accountant | M9 | Both: a cash section and an accrual section. | Decided 2026-10-28: both sections. |
| OQ-33 | Who gets emergency maintenance alerts, and on which channels, before the caretaker app exists? (prd-issues 33) | Founder | M8 | SMS to manager and caretaker, plus web push to managers. | Decided 2026-10-28: WhatsApp and SMS to manager and caretaker; staff opt in to WhatsApp when added. |
| OQ-34 | Unpaid subscription: how long is the grace period, and do manager features then go read-only? (PRD section 21, open) | Founder | M10 | 14 days of grace, then read-only manager features; tenant flows never stop. | Decided 2026-10-28: as recommended. |
| OQ-35 | Messaging allowance per unit and overage pricing? (PRD section 21, open; PB-06 is P2) | Founder | M10 | Track cost per message from M6; price once pilot data exists. | |
| OQ-36 | Annual prepayment discount and tier-change rules? (PRD section 21, open) | Founder | M10 | As the PRD recommends: upgrade now with proration, downgrade next cycle; discount set in configuration. | Decided 2026-10-28: as recommended. |
| OQ-37 | Rates per tier and billing band? (PRD section 21) | Founder, from pricing research | M10 | Placeholder rates, editable in the admin console. | |
| OQ-38 | How long is the free trial or guided onboarding period? (PB-08) | Founder | M10 | 30 days, configurable. | Decided 2026-10-28: as recommended. |
| OQ-54 | Consent (CM-09) is recorded per channel, not per phone number or email. When staff change a tenant's or contact's phone or email, should the consent on record carry over to the new one, or must it be recorded again? (M3 review) | Founder, with counsel if needed | M6 (WhatsApp and broadcasts) | Ask again: a changed phone or email starts with no consent on that channel, and staff record the person's agreement for the new one. Until then, the edit forms say that consent stays with the new value and ask staff to check (M3). | |

## Research findings, 28 Oct 2026

Claude researched these from the pages linked. They are background for your lawyer, tax adviser and providers, not advice: confirm each one before relying on it.

### Payments and settlement

- **OQ-01 Paystack:**
    - **Splits:** splits and multi-splits work in GHS. Initialise and charge both accept a subaccount, a split code and a fee bearer.
    - **Settlement destinations:** subaccounts settle to bank accounts. MoMo codes appear in the GHS bank list, but nothing documents a subaccount settling to a wallet.
    - **Payouts:** next working day, with a GH₵50 minimum for bank payouts. A new or changed subaccount's first payout waits until Paystack verifies it.
    - **Reconciliation:** the settlements API lists settlements and their transactions per subaccount.
    - **MoMo charges:** MTN, Telecel and AT. The payer has 180 seconds to approve, and every payment needs a fresh approval: there is no MoMo autopay.
    - Sources: [split payments](https://docs-v2.production.paystack.co/docs/payments/split-payments), [subaccounts](https://docs-v2.production.paystack.co/docs/api/subaccount), [settlements](https://docs-v2.production.paystack.co/docs/api/settlement), [charge](https://docs-v2.production.paystack.co/docs/api/charge), [payout schedule](https://support.paystack.com/en/articles/2123586), [subaccount verification](https://support.paystack.com/hc/en-us/articles/360009973199).
- **OQ-02 Second provider:**
    - **Flutterwave** documents splits to Ghanaian bank accounts; MoMo destinations are not documented.
    - **Hubtel**'s checkout has no split field, so it would collect into a platform balance, which D1 rules out.
    - **ExpressPay, PaySwitch (theteller) and Zeepay** document no splits. Zeepay is not on Bank of Ghana's approved list.
    - Sources: [Flutterwave splits](https://developer.flutterwave.com/docs/split-payments), [Hubtel checkout API](https://dev-docs.hubtel.com/frontend/tools-and-sdks/checkout/api-reference.html), [Bank of Ghana approved institutions](https://www.bog.gov.gh/fintech-innovation/approved-institutions/).
- **OQ-03 and OQ-43 Licensing:**
    - **The licence requirement:** Act 987 s.7(1) bars a non-bank body corporate from providing a payment service without a licence. Section 7(2) includes "(l) payment system aggregation function" and "(m) provision of any electronic platform for payment or receipt of funds". Neither depends on holding funds.
    - **Categories:** PSP Standard ("payment application solution … merchant development platform", no capital required, reserved for wholly Ghanaian-owned entities) and Payment and Financial Technology Service Provider.
    - **Ownership:** any licence needs at least 30% Ghanaian equity (s.8(4)).
    - The quotes come from text recognition on a scanned PDF; check them against the gazetted copy.
    - Sources: [Act 987](https://www.bog.gov.gh/wp-content/uploads/2019/08/Payment-Systems-and-Services-Act-2019-Act-987-.pdf), [licence categories](https://www.bog.gov.gh/fintech-innovation/licence-categories/).
- **OQ-04 Fees and timing, on GH₵3,000 of rent:**
    - **Paystack:** GH₵58.50 (1.95%, no cap), paid out the next working day.
    - **Flutterwave:** GH₵60 for MoMo or bank (2%) or GH₵78 for card (2.6%), plus VAT. Payout timing is not published.
    - Sources: [Paystack pricing](https://support.paystack.com/en/articles/2130306), [Flutterwave pricing](https://flutterwave.com/gh/pricing).
- **OQ-05 References:**
    - No MoMo network or GhIPSS publishes narration limits.
    - Paystack references allow letters, digits, `-`, `.` and `=`. Hubtel allows up to 32 characters, ExpressPay 64; theteller requires exactly 12 digits.
    - Crockford's own check symbols include `*`, `~`, `$` and `=`, so the check character must come from the same 32-character alphabet.
    - Sources: [Paystack transactions](https://docs-v2.production.paystack.co/docs/api/transaction), [Crockford base32](https://www.crockford.com/base32.html).
- **OQ-06 Email:** Paystack requires an email and suggests generating one when you do not collect it. Its `label` field replaces the email shown at checkout. Source: [accept payments](https://docs-v2.production.paystack.co/docs/payments/accept-payments).
- **OQ-07 Fees borne:**
    - `bearer` is the platform account or the subaccount, and a charge fails if the subaccount's share cannot cover the fee.
    - Surcharges need Paystack support to enable them outside Nigeria. No Bank of Ghana ban was found; Act 987 s.54(c) requires charges to be disclosed.
    - Your decision (landlord or agency bears the fee) needs neither.
- **OQ-08 Bank transfers:**
    - Paystack "Pay with Transfer" issues a temporary account per transaction (15 minutes to 8 hours), paid by GhIPSS instant transfer.
    - Paystack's own pages conflict on dedicated virtual accounts in Ghana.
    - Flutterwave offers GHS virtual accounts (exact amount only), with no mention of splits.
    - Sources: [payment channels](https://docs-v2.production.paystack.co/docs/payments/payment-channels), [Flutterwave GHS virtual accounts](https://developer.flutterwave.com/docs/ghs-virtual-accounts).

### Platform and providers

- **OQ-21 AWS Cape Town:**
    - **Services:** af-south-1 has RDS (PostgreSQL 14 to 18), KMS, Secrets Manager and SES. SES there is API-only, with no SMTP endpoint.
    - **Storage:** S3 is available; Object Lock needs a test bucket.
    - **CDN:** no CloudFront edge in Ghana; the nearest is Lagos.
    - **Latency:** AWS publishes no latency data, so the test is still needed.
    - Sources: [SES endpoints](https://docs.aws.amazon.com/general/latest/gr/ses.html), [RDS PostgreSQL calendar](https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-release-calendar.html), [CloudFront locations](https://aws.amazon.com/cloudfront/features/).
- **OQ-22 Ghana Card:**
    - **NIA rule:** under L.I. 2523, NIA says verification "must now be done through real-time biometric verification against the NIA's database". Organisations "must not request, photocopy, scan or retain copies of the Ghana Card" unless the law permits.
    - **Effective date:** NIA's pages give two, 9 June 2026 and 2 November 2026.
    - **Direct NIA access:** by application, with business registration, Data Protection Commission and SSNIT certificates; no fees published.
    - **Smile ID:** Biometric KYC matches a live selfie to the authority's photo; Ghana ID-number checks are "available upon request"; React Native SDK available.
    - **Alternatives:** MetaMap (ID number plus selfie); Dojah (record lookup only). No public prices.
    - Sources: [NIA on L.I. 2523](https://nia.gov.gh/government-makes-biometric-verification-mandatory-for-ghana-card-verification-under-new-l-i-2523/), [NIA verification services](https://nia.gov.gh/service/verification-services/), [Smile ID Ghana coverage](https://docs.usesmileid.com/id-coverage/verify-with-id-number/ghana.md), [MetaMap Ghana card check](https://docs.metamap.com/reference/govcheck-ghana-verify-card-facematch).
- **OQ-23 GhanaPost GPS:**
    - **Access:** no published API or developer terms. The app's terms grant a personal licence and bar commercial exploitation, so access means asking Ghana Post. Dojah sells forward lookup.
    - **Format:** region letter, district letter or digit, 3-digit area code, 4-digit number (for example AK-039-5028). Validate with `^[A-Z][A-Z0-9]-\d{3}-\d{4}$` after upper-casing and normalising separators.
    - Sources: [GhanaPost GPS help](https://ghanapostgps.com/get-help/), [terms](https://ghanapostgps.com/terms-and-conditions/), [Dojah digital address](https://docs.dojah.io/api-reference/individual-verification/ghana/digital-address.md).
- **OQ-24 WhatsApp:**
    - **Onboarding:** tech providers need Meta business verification and App Review. Embedded Signup gives each landlord its own account and number, capped at 10 new businesses a week until verified, then 200.
    - **Messaging limits:** per business portfolio: 250, 2,000, 10,000, 100,000 or unlimited unique users per 24 hours. Leaving 250 needs verification.
    - **Templates:** review takes up to 24 hours. 250 templates until verified, then 6,000.
    - **Pricing:** per delivered message; Ghana is in "Rest of Africa". From 1 Oct 2026 only 1,000 service messages per number per month are free, and utility messages in an open window are charged. The rate card has not been read yet; it feeds OQ-35.
    - Sources: [tech providers](https://developers.facebook.com/docs/whatsapp/solution-providers/get-started-for-tech-providers), [messaging limits](https://developers.facebook.com/docs/whatsapp/messaging-limits), [templates](https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates), [business policy](https://whatsappbusiness.com/policy/).
- **OQ-25 App stores:**
    - **Apple:** a legal entity, a D-U-N-S number, signing authority, and a company-domain website and email; US$99 a year. D-U-N-S is free and takes up to 5 business days, plus 2 for Apple. 90% of reviews finish within 48 hours, and guideline 4.2.6 allows one app serving many clients.
    - **Google Play:** US$25 once. Organisation accounts need a D-U-N-S number, which can take up to 30 days. An organisation account avoids the 12-tester, 14-day rule for new personal accounts.
    - Sources: [Apple enrolment](https://developer.apple.com/programs/enroll/), [Apple D-U-N-S](https://developer.apple.com/support/D-U-N-S/), [review guidelines](https://developer.apple.com/app-store/review/guidelines/), [Google Play organisation accounts](https://support.google.com/googleplay/android-developer/answer/13628312).
- **OQ-26 Expo:** the current SDK 58 (October 2026, React Native 0.88) supports iOS 16.4 and above and Android 7 and above. SDK 56 (May 2026) raised the iOS minimum from 15.1 to 16.4; SDK 55 was the last for iOS 15. Sources: [Expo versions](https://docs.expo.dev/versions/latest/), [SDK 56 changelog](https://expo.dev/changelog/sdk-56), [SDK 58 changelog](https://expo.dev/changelog/sdk-58).

### Law and tax

Statutes were read from the Parliament repository, GRA, the Data Protection Commission and the Cyber Security Authority, because GhaLII refused automated access.

- **OQ-09 Notice periods:**
    - **Act 220 sets none.** Recovery of possession needs an order on the s.17(1) grounds. Six months' written notice applies only to grounds (h) and (i).
    - **Timing bar:** s.23 bars a notice to quit within two years of a Rent Officer assessment.
    - **Offence:** s.27 makes acts done "to compel the lessee … to give up possession" an offence.
    - **Otherwise:** periods come from the lease and common law.
    - **Reform:** the Rent Bill 2023 never passed. In June 2026 the minister called a consolidated Act "at an advanced stage".
    - Sources: [Act 220](https://repository.parliament.gh/items/7ed7ce4b-e397-405a-892d-e9aa3a962195), [Rent Bill 2023](https://repository.parliament.gh/items/179e7c8d-0ebf-4700-b5d8-ffe35653e2b4), [Graphic, June 2026](https://www.graphic.com.gh/news/general-news/government-moves-to-repeal-outdated-rent-laws-introduce-modern-rent-act.html).
- **OQ-10 and OQ-44 Electronic signing:**
    - **The exclusion:** ETA s.4(e) excludes "a contract for the sale or conveyance of immovable property or any interest in the immovable property". The Land Act's "conveyance" includes "a lease".
    - **Land Act formalities:**
        - writing and signatures (s.35), though s.36(1)(f) exempts leases not exceeding three years;
        - attestation by at least one witness (s.68(1));
        - preparation by a legal practitioner (s.33);
        - no effect until registered (s.227).
    - **Notices are not conveyances.** ETA s.5 lets electronic records satisfy writing. Land Act s.67 allows secure electronic communication where that is the mode of communication; s.57(2) requires email plus posting on the land.
    - Sources: [Electronic Transactions Act](https://csa.gov.gh/resources/Electronic%20Transactions%20Act.pdf), [Land Act 2020](https://repository.parliament.gh/items/82b89b1a-122f-42bd-bd96-139ac4eba158), [Lex Africa, July 2026](https://lexafrica.com/2026/07/ghanas-current-legal-framework-and-proposed-reforms-for-e-signatures/).
- **OQ-45 Stamp duty:** agreements for letting are dutiable (s.22) and must be stamped within two months (s.12). Unstamped documents shall "not be given in evidence" (s.32(6)). Act 1109 lists no separate rate above GH₵50. Sources: [Stamp Duty Act](https://repository.parliament.gh/items/e78a9039-6245-4d13-b108-90cf22fb24ac), [Act 1109](https://repository.parliament.gh/items/62900f0f-c035-499b-b8e0-83c25a136088).
- **OQ-11 Advance rent:**
    - **The offence:** s.25(5) makes it an offence to demand, "as a condition of the grant, renewal or continuance", more than a month's rent on a monthly or shorter tenancy, or more than six months' rent on a tenancy exceeding six months.
    - **Penalty:** 500 penalty units or two years (PNDCL 138 s.19(2)(b)), about GH₵6,000.
    - **Scope:** all premises (s.1).
    - **Enforcement:** Rent Control announced prosecutions in June 2026.
    - Sources: [Act 220](https://repository.parliament.gh/items/7ed7ce4b-e397-405a-892d-e9aa3a962195), [PNDCL 138](https://repository.parliament.gh/items/a1c755cd-c2d3-4cf3-9562-4c1f3de02acf), [GRA penalties](https://gra.gov.gh/domestic-tax/tax-offences-and-penalties/), [Graphic, June 2026](https://www.graphic.com.gh/news/general-news/ghana-news-report-landlords-demanding-rent-advance-beyond-6-months-rent-control.html).
- **OQ-12 Holding over:** a statutory tenant "remains in possession … after the determination … of his tenancy" (s.36) and holds month to month on the original terms (s.29(1)(a)). Taking more than the recoverable rent is an offence (s.25(1)(a)).
- **OQ-13 Deposits:** there is no cap, interest or segregation rule for landlords, but s.25(1)(b) forbids "any consideration … premium or otherwise". Agents need "a separate client's account" (Act 1047 s.46). Source: [Real Estate Agency Act](https://repository.parliament.gh/items/a6b97c78-46f5-42a5-a60f-e2e970a8bb54).
- **OQ-14, OQ-49 and OQ-50 Data:**
    - **Act 843:**
        - no retention "longer than is necessary" unless required by law (s.24);
        - registration before processing (ss.27, 53), renewed every two years (s.50), with penalties up to 250 penalty units (s.56);
        - transfer countries declared (s.47(1)(g));
        - no localisation.
    - **Processors:** the Data Protection Commission requires them to register too.
    - **Tax records:** Act 915 s.27 requires them to be kept "within the country" for at least six years.
    - **Draft Data Protection Bill 2025:** would localise biometric and ID data and require approval for large transfers.
    - Sources: [Act 843](https://dpc.gov.gh/wp-content/uploads/2025/05/data-protection-act-2012-act-843.pdf), [DPC registration](https://dpc.gov.gh/registration/), [Act 915](https://gra.gov.gh/wp-content/uploads/2023/01/Revenue-Administration-Act-2016-.pdf), [draft Bill 2025](https://dpc.gov.gh/wp-content/uploads/2025/11/DATA_PROTECTION_BILL1_DRAFT-1.pdf).
- **OQ-15 Late fees:** nothing authorises them; s.25(1)(a) caps receipts at the recoverable rent "notwithstanding any lease to the contrary".
- **OQ-27 and OQ-46 Rent Control:**
    - **Portal:** rentcontrol.mwh.gov.gh launched in September 2024, with logins, tenancy agreements and complaints, and no public API.
    - **Registration:** PNDCL 138 s.4 requires covered residential tenancies to be registered "within fourteen days", and the landlord "shall not demand or receive … rent" until then.
    - **Deadline:** 30 November 2026 to regularise.
    - Sources: [Rent Control portal](https://rentcontrol.mwh.gov.gh/), [PNDCL 138](https://repository.parliament.gh/items/a1c755cd-c2d3-4cf3-9562-4c1f3de02acf), [GNA, Sept 2024](https://gna.org.gh/2024/09/rent-control-department-goes-digital/), [Joy Online](https://myjoyonline.com/rent-control-makes-rent-cards-mandatory-for-landlords-hostel-operators-from-august-17).
- **OQ-17 Rent tax:**
    - **GRA guidance:** tax is "paid within 30 days after the rent income is received", at 8% residential and 15% commercial. Late payment carries interest at 125% of the statutory rate.
    - **Basis:** individuals use a cash basis (Act 896 s.19(2)), so advances are taxed on receipt (s.20).
    - **Gaps:** no statutory 30-day rule or rounding rule found. Act 1178 (2026) leaves rent unchanged.
    - Sources: [GRA rent tax](https://gra.gov.gh/domestic-tax/tax-types/rent-tax/), [Act 896](https://gra.gov.gh/wp-content/uploads/2020/09/INCOME-TAX-ACT-2015-ACT-896.pdf), [Act 1178](https://gra.gov.gh/wp-content/uploads/2026/09/Amendments-To-The-Income-Tax-2015-Act-896_Updated-1.pdf).
- **OQ-18 Corporate landlords:** withholding on rent (s.115) is final for individuals and for companies "other than rent received in conducting a business of sale or letting" (s.119(1)(b)–(c)); otherwise it is a credit (s.120). Rates are 8% and 15%. The withholder pays within 15 days after month-end (s.117). Source: [GRA withholding tax](https://gra.gov.gh/domestic-tax/tax-types/withholding-tax/).
- **OQ-19 Service charge:** Act 896 defines rent to include payment for "assistance ancillary to a use", so service charge may be taxable. Refunds are deductible "at the time of refund" (s.23(2)); how that fits a final tax is unclear.
- **OQ-20 and OQ-48 VAT:**
    - **Rates:** Act 1151, in force since 1 January 2026, repealed the 5% flat rate. VAT is 15%, plus NHIL and GETFund at 2.5% each; the COVID levy is repealed.
    - **Commercial rent:** GRA guidance AG/26/001 (22 July 2026) taxes "immovable property for rental purposes other than for accommodation in a dwelling" at 15% plus 5%. It also taxes property management, and requires lessors to register.
    - **Tax point:** the earliest of invoice, payment or supply. Dwellings stay exempt.
    - **Services:** no registration threshold.
    - Sources: [Act 1151](https://repository.parliament.gh/items/c2c7d45e-a150-4721-bca7-4f8b5980a737), [levies](https://repository.parliament.gh/items/562fcdd8-f035-46ee-929a-58ace152dfb6), [GRA AG/26/001](https://gra.gov.gh/wp-content/uploads/2026/08/Guidelines-On-Rental-Of-Commercial-Premises.pdf).
    - **What M4a builds on, for the tax adviser to confirm (2026-10-30):**
        1. **Base:** each rate (VAT 15%, NHIL 2.5%, GETFund 2.5%) applies to the line's net amount, with no levy inside the VAT base, rounded half up once per line.
        2. **Service charge:** VAT and levies apply to service charge as well as rent (`vat.applies_to_service_charge`, on, unverified).
        3. **Advances:** a payment made before its invoices exist issues them at once, so the payment is the tax point (M4a decision 4).
        4. **Corrections:** a credit note on a line reduces the VAT and levies charged on it; a write-off leaves the VAT already charged payable. Is bad-debt relief available?
        5. **Invoices:** numbered per company (`INV-000123`). Must they also go through GRA's E-VAT system?
        6. **TINs on invoices:** M4a prints the owner's and the commercial tenant's TINs masked, as M3 stores them for display; the full numbers stay encrypted.
            - Must a VAT invoice or receipt carry both TINs in full?
            - If so, issuing the invoice would decrypt them as an audited reveal and keep them in the frozen PDF.
