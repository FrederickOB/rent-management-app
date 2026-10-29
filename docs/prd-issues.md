# PRD issues

The PRD has 43 known contradictions, gaps and ambiguities. Items 1 to 7 come from `BUILD_PLAYBOOK.md`. Items 8 to 36 were found in Prompt 0 (35 and 36 during the independent ledger review), and items 37 to 43 in the legal and tax research. Each carries a recommended resolution, which the build follows until the PRD is changed or the owner of the question rules otherwise. Questions for counsel, the tax adviser or providers are tracked in `docs/open-questions.md`.

| Status on 28 Oct 2026 | Items |
| --- | --- |
| Decided by the founder | 3 (through 33), 4, 8, 11, 18, 19, 33, 34, 36, 39, 40, 41 |
| Resolved in the design | 2, 6, 7, 10, 16, 17, 21, 22, 23, 24, 26, 27, 29, 32, 43 |
| Default in use; the founder may revisit | 28, 31, 35 |
| Waiting on counsel, the tax adviser or providers | 5, 9, 12, 13, 14, 15, 20, 25, 30, 37, 38, 42 |
| Resolved by updating the PRD | 1 |

## From the build playbook

1. **Release plan contradicts the requirement tables.** The diagram puts maintenance, inspections, owner ledgers and statements in Phase 2. The tables mark MI-01 to MI-04, MI-06, MI-10, MI-11 and AC-01 to AC-05 as MVP, and the MVP screen inventory includes the maintenance board, inspections, owner statements and expenses. *Assumption: the tables and screen inventory win.* They have to: CM-04 (MVP) turns WhatsApp repair messages into maintenance tickets, TL-11 (MVP) needs move-out inspections, and AC-01 (MVP) is the ledger everything else posts to. *Resolved 2026-10-28:* the PRD's release plan diagram now puts repairs, inspections and owner statements in Phase 1, matching the tables.
2. **TL-08 depends on MI-10.** The move-in condition report is an inspection. The milestones below build the inspection engine before completing move-in and move-out.
3. **Push alerts without a native app.** MI acceptance requires emergency alerts "by push and SMS". In the MVP that means web push through the PWA where the browser supports it, plus SMS. Confirm that is acceptable. *(Updated by item 33 after decision D4.)*
4. **PB-02 snapshot rule is undefined** (see D8). *Decided 2026-10-28:* a unit is billable for a month if it had an active lease on any day of that month.
5. **Rent tax on advance rent** (see D9).
6. **Caretaker tasks before the caretaker app.** The notice ladder (MVP) creates a caretaker task at day 5, but the field app is P2. The PRD already says these are handled in the manager web app until then; the milestones follow that.
7. **"Delivered" status for notices (LN-03)** depends on provider delivery receipts. WhatsApp and most SMS gateways provide them; email delivery is weaker. Status should record which channel confirmed delivery.

## Found in Prompt 0

### Money, tax and settlement

8. **Two-person approval is impossible for single-user landlords** (AD-05, AR-04, TL-11, section 8 lifecycle step 2). Starter targets "an individual landlord with a few houses", who may be the only user. Refunds, write-offs and notices to quit would be stuck. *Recommended:* let the landlord nominate a second approver (a family member or adviser given an approver right). With none, allow a recorded single-user mode: the same user re-confirms with a one-time code after a 24-hour cooling-off period, and the audit log and documents say so (OQ-29).

9. **The failover provider may break the settlement model** (D1, BC-02, section 20 "two aggregators from launch"). Under D1, every provider that collects rent must settle straight into landlord or agency accounts. A provider that settles into the platform's own balance would mean the platform holds rent. *Recommended:* confirm direct settlement with each candidate before choosing the second provider. If none qualifies, failover is limited to queued retries and manual recording (OQ-02). *Research 2026-10-28:* Flutterwave documents bank-account splits in Ghana; Hubtel's checkout has no splits, so it cannot carry rent under D1.

10. **Cash can be recorded but never banked in the MVP** (BC-05, CF-03). BC-05 records approved cash as held by the collector; recording its handover or banking is CF-03 (P2). Without it, undeposited cash never clears, and the caretaker accountability the wedge promises is missing. *Recommended:* add a minimal "record cash banked" action (amount, deposit slip photo, second-user approval) to M4a.

11. **Annual residential cycles always breach the advance cap** (TL-06, AR-05). TL-06 allows 6-month and annual cycles; AR-05 flags residential advances above 6 months. A residential lease billed annually demands 12 months ahead by design. *Recommended:* the lease builder warns on save when a residential cycle or agreed advance exceeds the cap, following `advance_rent_policy`. The flag is computed on months paid or demanded ahead of the current period, so compliance reports show real exposure (OQ-11, OQ-28). *Decided 2026-10-28 (OQ-28):* the founder chose no warnings for now, so AR-05 ships switched off (`advance_rent_policy = off`). Until warnings are switched on, the PRD's mitigation for the risk "product seen to normalise advance rent above the legal cap" (flag every breach) does not apply. The PRD's AR-05 and risk table were updated to say so on 2026-10-28.

12. **Rent tax may not apply to corporate owners** (TX-01, section 1). The landlord may be "an individual or a corporate owner", yet TX-01 applies 8% or 15% to every receipt. A company's rental income may be taxed as business income instead. *Recommended:* each owner carries a tax treatment (`individual_rent_tax`, `corporate`, `exempt`) that decides whether per-receipt rent tax accrues. Default `individual_rent_tax` (OQ-18).

13. **Withholding tax and rent tax can double count** (TX-01, TX-04). When a corporate tenant withholds tax on rent, TX-01 still computes rent tax on the same receipt. Tenants also often advise the withholding only after paying. *Recommended:* withholding can be recorded with the payment or later, and is pinned to the lines it was withheld on. For an individual owner, a confirmed WHT certificate settles the rent tax on those lines; for a corporate owner it becomes a tax credit (posting rules P19 and P20 in `docs/architecture.md`) (OQ-18).

14. **Rent tax base is unclear for deposits, service charge and refunds** (TX-01, BC-11, TL-06, AR-04). "Every receipt" would tax refundable deposits and cost-recovery service charge, and nothing says whether tax falls when part of a taxed advance is refunded. *Recommended:* tax rent only, including advances (D9), not deposits or service charge, and make no automatic adjustment on refunds, until the tax adviser rules (OQ-17, OQ-19).

15. **Payment references should belong to the lease, not the unit** (BC-03, section 5 user story). The PRD puts the unit code (ACC-LEG-B2-04) in payment references. Unit codes outlive tenancies, so a former tenant's transfer would match the current tenant, and long codes may exceed MoMo or bank narration limits. *Recommended:* each lease gets a short opaque reference: 6 Crockford base32 characters plus a check character from the same alphabet, so references are letters and digits only. It is shown next to the unit code. Pay-link payments match on provider metadata and need no typed reference (OQ-05).

16. **Arrears and collection rate are not defined** (BC-08, DA-01, section 19). Neither says whether it works from due dates or from cash, and a cash-based collection rate passes 100% whenever advances arrive. *Recommended:* arrears are invoice lines past their due date and still unpaid, aged from the due date. Collection rate is the rent due in the month that was paid by month end, measured from allocations.

17. **Paid-until is undefined for partial cover** (AR-02). *Recommended:* paid-until is the last day of the last fully covered rent period, with partial cover shown as "plus GH₵X towards the period starting …". Rent periods are anchored on the lease start date, so only a short final period is ever prorated.

18. **Management fee base is open** (AC-02). "Percentage of collections" could be gross or net of withholding and processing fees, and may or may not include advances and deposits. *Recommended:* rent and service charge settled (cash plus tax withheld), including advances, excluding deposits; configurable per management agreement (OQ-31).

19. **Owner statements need both cash and accrual views** (AC-04, AR-01). Owners think in cash ("what came in, what was remitted"), but AR-01 spreads advances month by month. *Recommended:* the statement has a cash section (collections, fees, expenses, tax, remittance) and an accrual section (rent earned, unearned rent held, deposits held, arrears) (OQ-32).

### Leases, occupancy and units

20. **No state for a tenant who stays past the lease end** (TL-06, TL-09, PB-09). Holding over is common, but nothing covers it. *Recommended:* a `holding_over` lease state. The unit stays occupied and billable; rent continues monthly at the last rate; reminders escalate towards a renewal offer or a notice (OQ-12).

21. **Manual unit statuses conflict with derived occupancy** (PR-06, PB-09). PR-06 lists five statuses set by hand; PB-09 derives occupancy from leases. *Recommended:* two fields. Occupancy is derived (occupied or vacant); availability is set by hand (available, reserved, under repair, not lettable). The displayed status combines them, and "under repair" on an occupied unit shows as a badge.

22. **When does a signed lease make a unit occupied?** (PB-09, D8). A lease signed in October to start in December could count from either date. *Recommended:* occupied and billable from the start date; "reserved" between signature and start.

23. **Invoices must exist before the first reminder** (BC-01, BC-09). The ladder starts 7 days before the due date, but BC-01 does not say when invoices are raised. *Recommended:* raise invoices 14 days before the due date by default, configurable per company.

24. **Joint ownership and the ledger** (PR-07, AC-01). P2 joint and family ownership splits income by percentage. *Recommended:* an owner can be a joint or family entity with member shares. Its book receives postings unsplit, and statements split by share. This avoids per-posting splits and a later migration.

### Notices and signatures

25. **Nothing records consent to electronic service of notices** (LN-02, CM-09). Notices go by WhatsApp, SMS and email, but the lease never records the tenant's agreement to be served that way. *Recommended:* lease templates include an electronic-service clause naming the tenant's numbers and email. Without it, the notice still goes out electronically, but physical service is planned from day one (OQ-10).

26. **Some commercial signatories have only an email** (LN-07, LN-02). A code to a phone is impossible for them. *Recommended:* send the one-time code to the phone where we have one, otherwise to the email on record; the certificate page states which was used.

27. **Notices without a notice period have no link expiry** (LN-02). Rent demands and building-wide notices have no period to end. *Recommended:* a per-type default of 90 days after issue, configurable.

### Channels, tiers and data protection

28. **Starter tier has no inbox or maintenance, yet repair messages create tickets** (CM-04, section 21). *Recommended:* on Starter the menu bot offers balance, receipt and pay only. A repair message is logged on the tenant timeline and forwarded to the landlord by SMS or email.

29. **No way for tenants to upload WHT certificates in the MVP** (TX-04, CT-05). TX-04 is MVP; tenant upload arrives with the commercial portal in P2. *Recommended:* managers upload certificates in the MVP.

30. **Data export and deletion: the NFR says MVP, AD-09 says P2** (section 4, AD-09). *Recommended:* in the MVP, meet Act 843 requests manually with an admin-run export and anonymisation script plus a runbook (M11); self-service stays P2. Anonymisation removes personal data but keeps financial and notice records for the retention period (OQ-14).

31. **Tiers list Phase 2 features** (PB-04, section 21). Growth and Portfolio include modules not in the MVP. *Recommended:* entitlement flags exist for all of them from M10; unbuilt ones show "coming soon" rather than an upgrade prompt.

32. **"Paid-until coverage" is undefined** (DA-01). *Recommended:* the share of occupied units whose paid-until date is today or later, plus the median months paid ahead.

33. **Emergency alerts by push after decision D4** (MI acceptance criteria; updates item 3). The Expo app gives tenants native push, but emergency alerts go to managers and caretakers. *Decided 2026-10-28 (OQ-33):* WhatsApp and SMS to managers and caretakers until the caretaker field app ships, in place of the PRD's "push and SMS". Staff opt in to WhatsApp when they are added, and the alert uses an approved template. The PRD's acceptance criterion was updated on 2026-10-28.

34. **The Expo tenant app and the NFRs** (D4, section 4, section 16). The 1 MB and device targets were written with web pages in mind. *Recommended:* the 1 MB budget applies to `apps/links` pages and to the first load of the Expo web build. Native key screens get a 100 KB API payload budget and an offline cache of balance, receipts and lease. *Decided 2026-10-28 (OQ-26):* current Expo (SDK 58) needs iOS 16.4, so the minimum moves from iOS 15 to iOS 16.4. Tenants on older iPhones use the web build, pay links or WhatsApp. The PRD's device requirement was updated to match.

### Found in the ledger review

35. **Tenants pay straight into landlords' accounts** (BC-02, BC-12, section 19 auto-match rate). BC-02 assumes digital payments go through an aggregator, but many tenants send MoMo or bank transfers directly to the landlord. Those never reach the platform, so receipts, balances and the 95% auto-match measure all miss them. *Recommended:* in the MVP, staff record direct transfers with proof and a second user approves (posting rule P28); bank and MoMo statement import follows in Phase 2. Measure auto-match on provider payments and report direct transfers separately.

36. **Proration on early exit is unspecified** (AR-04, TL-11). When a tenancy ends mid-month, nothing says whether the unused days are credited. *Decided 2026-10-28:* follow the lease's break clause; without one, no proration of the current month. Where proration applies, it is a credit note (P27) before the prepayment is applied and any refund calculated (P13).

### Found in the legal and tax research

37. **E-signed leases may not count as leases** (TL-07). The Electronic Transactions Act 2008 (s.4(e)) excludes contracts for any interest in immovable property, and the Land Act 2020 counts a lease as a conveyance. The Land Act also asks for:
    - writing and signatures (s.35), though leases of three years or less are exempt (s.36(1)(f));
    - a witness (s.68);
    - preparation by a legal practitioner (s.33);
    - registration (s.227).

    *Recommended,* until counsel rules (OQ-44): keep e-signing as the agreed record of terms, add a witness signature, and send leases over three years down a lawyer path.

38. **Stamp duty is missing** (TL-05 to TL-07). Tenancy agreements are dutiable and must be stamped within two months (Stamp Duty Act ss.12, 22). An unstamped agreement cannot be given in evidence (s.32(6)), which undercuts the product's evidence promise. *Recommended:* a stamping tracker on each lease: a deadline, the stamped copy uploaded, and reminders (OQ-45).

39. **Rent Control registration is a legal precondition, not a Phase 2 extra** (TX-05). PNDCL 138 s.4 requires residential tenancies to be registered within 14 days, and bars demanding or receiving rent before then. Rent Control set 30 November 2026 as the deadline to regularise. *Decided 2026-10-28:* TX-05 moves into the MVP as track-and-remind; rent collection is never blocked. The PRD was updated (OQ-27, OQ-46).

40. **The advance cap is wider than AR-05 says** (AR-05). Act 220 s.25(5) covers all premises, commercial included, and caps monthly tenancies at one month's rent. The penalty is up to 500 penalty units or two years, and Rent Control announced prosecutions in June 2026. *Decided 2026-10-28:* warnings stay off (OQ-28). The calculation covers both limits and all premises, so warnings will be accurate if switched on.

41. **Commercial rent now carries VAT** (CT-04, PRD section 13). Since 2026, commercial rent bears VAT at 15% plus 5% in levies, and lessors must register (Act 1151; GRA guidance AG/26/001). *Decided 2026-10-28:* commercial landlords are in the pilot. CT-04 (VAT on commercial invoices) moves into the MVP and is built in M4a (posting rule P32); the rest of the portal stays in Phase 2. The PRD was updated (OQ-20).

42. **Late fees may be unlawful** (BC-10). Act 220 s.25(1)(a) caps what a landlord may receive at the recoverable rent, whatever the lease says. *Recommended:* do not build BC-10 without counsel's approval (OQ-15).

43. **A notice to quit does not end a tenancy** (LN-01, section 8 lifecycle).
    - Possession needs a court or Rent Control order (Act 220 s.17).
    - Pressuring a tenant to leave is an offence (s.27).
    - No notice to quit may follow within two years of a Rent Officer assessment (s.23).

    *Resolved in the design:* a notice to quit closes by referral to Rent Control or court. The product never supports lockouts, utility cut-offs or other pressure on a tenant to leave. The composer checks the s.23 bar when an assessment date is on record.
