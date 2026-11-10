# Notice escalation

- **Status:** M11. Built in M7: the ladder, tasks, the service pack, physical service and closing (`packages/domain/src/notices/ladder.ts`, `packages/server/src/notices/tracking.service.ts`). Every legal value in it is still unverified (`docs/gate-1.md`). The templates' legal wording, and the service affidavit's, is a placeholder until counsel supplies it (OQ-53).
- **Covers:**
  - what happens after a notice is issued: the reminder ladder at 24 hours, 72 hours, 5 days and 7 days, then physical service (PRD section 8; LN-03, LN-05, LN-09);
  - what staff do at each step;
  - notices to quit: the risk acknowledgement, two-person approval and the unverified notice periods (OQ-09, OQ-16).
- **Rules that never bend:**
  - **A signature acknowledges receipt, not agreement.** The tenant's notice page says so above the signature box, and has no way to decline.
  - **An unsigned notice is never blocked.** It is in force whether or not it is signed. The ladder only helps it reach the tenant, and ends in physical service.
  - **A notice to quit never ends a tenancy by itself.** Possession needs a court or Rent Control order (Act 220 s.17).
  - **The product never supports lockouts, utility cut-offs or any other pressure on a tenant to leave** (Act 220 s.27; CLAUDE.md section 7). Staff must not use a reminder, a visit or a task for that either. Closing a notice records an outcome only: it never ends a lease, takes possession or changes a unit.

## At issue

- **The notice is frozen** (template version and data, rendered to PDF and fingerprinted) and its secure links go out on every channel the recipient can be served on, at the same moment.
- **Each channel is planned per recipient** and shown on the notice:
  - **service:** an address the lease's electronic-service clause names;
  - **courtesy:** a copy on a channel with ordinary consent;
  - **withheld:** not sent. The reason is shown: no address; no consent and not named in the clause; or the tenant opted out (STOP or unsubscribe).

  Opt-outs are honoured for notices too. Whether the clause should override an opt-out is OQ-57, for counsel.
- **Physical service is planned from issue** when it is needed:
  - **A recipient nobody can serve electronically** gets a task, "Serve notice … on … in person", due in 48 hours. That is a lease with no electronic-service clause, or every named channel withheld. The composer warns of this before issue.
  - **Every notice to quit** also gets a task, "Post notice … on the premises", due in 24 hours, whether or not the tenant signs (OQ-10).
- **The link** works until the notice period ends (LN-02). For a type with no period, it works for the company's no-period days (90 by default; Settings → Notices).

## The ladder

**How it runs:**

- `notices.ladder` runs every 15 minutes for every company, and fires each step once per recipient.
- Hours count from issue.
- Messages to the tenant wait for the company's sending window, 07:00 to 20:00 company time by default (a product setting, M7 decision 11; OQ-58). If several reminders fall due while the window is shut, only the latest is sent.
- Staff alerts, tasks and escalation are never held.

**These are the PRD's defaults.** Each company can change them per notice type under Settings → Notices, in the "Reminders, quiet hours and links" form. A notice keeps the ladder it was issued with.

| After issue | Step | Who it reaches | What staff do |
| --- | --- | --- | --- |
| 24 hours | First reminder to open and sign, by WhatsApp and SMS | The tenant | Nothing, usually. Look at the notice page (Notices → the notice). Is it delivered or opened? Does the timeline show "Reminder not sent: no channel"? If every channel failed, don't wait for day 7: serve it physically now and record it. |
| 72 hours | Second reminder, saying the notice remains in force whether or not it is signed, by WhatsApp, SMS and email | The tenant | Nothing, usually. The same check. |
| 5 days | The property's managers get an email ("Not yet acknowledged: notice …"), and a task "Remind … in person about notice …" goes to the property's caretaker, due within 24 hours | Staff | **Caretaker:** visit the tenant, say a notice is waiting and how to open it, then complete the task in Tasks (`/tasks`). Remind them, and nothing more: no threats, no conditions, nothing done to the unit or its services. **Manager:** check the task is done. |
| 7 days | Escalation to physical service: the notice becomes Escalated, the service pack is made, a task asks for it to be served, and the managers get an email ("Escalated to physical service: notice …") | Staff | **Serve the pack, then record it** (below). |

**What the service pack contains:**

- a cover sheet;
- the service affidavit template;
- the frozen notice itself, appended unchanged and checked against its fingerprint.

Open it from the notice's Documents card.

**When the ladder stops:**

- **For one recipient:** once they acknowledge. For a company tenant, one signatory's signature counts for the company (LN-07).
- **For everyone:** when the notice closes, or staff pause or cancel the ladder.
- **Already served:** a notice served in person before day 7 needs no escalation, and that step is skipped.

**Which types get which steps:**

| Notice types | Steps |
| --- | --- |
| Rent demand, rent review, notice to quit, breach, non-renewal | All of them. A company's own ladder for these types must keep the escalation step. |
| Notice of entry, building-wide notice | Reminders only |
| Notice from the tenant | None (staff record it when it is received) |

## Pause, resume or cancel

- **Where:** the "Reminders and escalation" card on the notice page.
- **Who:** the landlord, agency admins and managers.
- **Each needs a reason.**
- **The notice stays in force** in every case.

| Control | Effect |
| --- | --- |
| Pause the reminders | Nothing more goes to the tenant until you resume. Escalation waits too. |
| Resume the reminders | Carries on where it stopped: the steps move later by the time spent paused, so no burst of overdue reminders. |
| Cancel the reminders | No more reminders, in-person steps or escalation, for good. The notice still needs serving some other way if it isn't acknowledged. |

**Pause, for example:** while the tenant is in hospital, or while a payment plan for the arrears is agreed. Don't pause to stop a notice reaching the tenant.

## Recording physical service

- **Where:** the notice's "Physical service" card, "Record service".
- **Who:** the landlord, agency admins, managers and caretakers (on their properties).

**Record:**

- **how:** handed to the tenant, posted on the premises, left with an adult occupant, registered post or courier;
- **when;**
- **by whom;**
- **the witness;**
- **a photo of the posted notice;**
- **the sworn affidavit,** uploaded once it is sworn.

**The affidavit:**

- **Its wording** is a placeholder until counsel supplies it (OQ-53).
- **Gap:** this runbook can't say before whom it is sworn, or how. Ask counsel.

**A record is never edited.** A mistake is corrected by a new record that names the one it corrects.

**"Served too late for its date":** if service happens too late for the date the notice states, the notice page says so. It shows the earliest lawful date counted from the service date and how many days short the notice is. Issue a correction: a new notice that references this one (Close or correct → correct). The old notice closes as superseded.

## Closing a notice

- **Where:** "Close or correct" on the notice page.
- **Who:** the landlord, agency admins and managers.
- **What it records:** an outcome and a note.

**Outcomes:**

- complied;
- paid;
- vacated;
- disputed;
- referred to Rent Control;
- referred to court;
- withdrawn.

A correction sets "superseded" itself.

**For an expired notice to quit,** the next step is a referral to Rent Control or court. It is never a lockout.

## Notices to quit

**They are off for every company until its admin accepts the risk** (OQ-16, decided 2026-10-28):

- **Where:** Settings → Notices → "Notices to quit". The card shows the statement (its version and SHA-256).
- **Who:** an agency admin or the landlord. Not a scoped admin.
- **How:** type your full name to accept it. Withdrawing needs a reason and turns them off again.
- **What the statement says, in short:**
  - the statutory minimum periods are unverified;
  - the templates' wording is not yet from counsel;
  - a notice to quit never ends a tenancy by itself, and the product never supports pressure to leave;
  - each one needs a second person.
- **Until it is accepted,** a notice to quit can be drafted but not issued. The composer says "Notices to quit are turned off for your company".

**Two-person approval** (AD-05):

- Submitting a notice to quit opens an approval request (Approvals, `/approvals`).
- A second person with notice authority approves: the landlord, an agency admin or a manager. **The person who submitted it can never approve it;** the database enforces this.
- **A landlord who works alone** confirms it themselves with a one-time code after the 24-hour cooling-off (OQ-29). The approval records that.

**The earliest effective date** (D7; OQ-09):

- **Statutory minimum:** none is in force. The rules rows `notice_to_quit.statutory_min_days.residential` and `.commercial` hold no value and are unverified. Counsel has to confirm whether any minimum applies (OQ-09; Act 220 sets none, per the research).
- **What is enforced:** the lease's own notice period. The composer warns that the statutory minimum is unverified and that only the lease's period is enforced.
- **A lease with a notice period of 0 days** gets its own warning.
- **The Rent Officer bar** (Act 220 s.23):
  - **If an assessment is on record,** a notice to quit inside the bar is refused. The bar is `notice_to_quit.assessment_bar_months`, 24 months, unverified, and the composer says so. The anniversary of the assessment counts as inside the bar until counsel confirms.
  - **With no assessment on record,** the composer warns that the bar can't be checked. Record one on the lease if there was one.

**Before a company relies on electronic service of a notice to quit,** counsel's opinion on electronic service is needed (OQ-10) — the first Gate 1 criterion. So is an answer on opt-outs (OQ-57). Until then, the notice is also posted on the premises, every time.

## Where to watch

- **Notices** (`/notices`) has three views:
  - open notices by status;
  - open notices by days since issue;
  - notices served too late for their date.
- **Tasks** (`/tasks`): the in-person reminders, postings and service tasks.
- **The notice page:** the full timeline (sent, delivered, opened, signed, reminded, escalated, served, closed), each with its server time. That is the evidence (LN-03, LN-04).
- **Gate 1 metrics:** "Notices e-signed within 7 days" (PRD section 19's 85%) is on the dashboard card and the console's Gate 1 page.
