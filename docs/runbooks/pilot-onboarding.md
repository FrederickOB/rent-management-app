# Onboarding a pilot landlord

- **Status:** M11. The onboarding workbook (three steps), opening balances (P25) and the adjustment workbook are built and tested end to end (`apps/web/e2e/m11-onboarding.spec.ts`). Plan: `docs/plans/M11.md` decisions 2 and 3 and the founder decisions in section 9.
- **Covers:** bringing a real landlord's portfolio onto the platform, from creating the company to the first month billed on the platform. Rent collection stays off until the licensing opinion (OQ-03) and the provider's written confirmation (OQ-01) are in hand; onboarding does not depend on them.

## Before the day

- **Agree the cut-over date** with the landlord: the day the platform takes over billing. Opening balances are as at that day. It is fixed once tenancies are imported.
- **Ask for their records** as at the cut-over: properties and units; owners (agencies); tenants with their phone numbers and which channels each agreed to (WhatsApp, SMS, email); every lease (start, end, rent, cycle, deposit, notice period, signed date); and, per lease, what is owed and for which months, any rent paid ahead, and the deposit held. For agencies: cash the agency holds for each owner, withholding tax still awaiting a certificate, and rent tax still owed, with its due date.
- **Settlement accounts are not imported.** They need a second person's approval and the 24-hour wait. Add them by hand early.
- **ID numbers are optional** and are encrypted on import. Never collect or upload pictures of Ghana Cards.

## 1. Create the company (platform admin)

1. Console → Companies → New: kind, name, time zone (Africa/Accra by default), tier and trial length, and the first admin's name and email.
2. The first admin gets an invitation (3 days), sets a password and enrols an authenticator. If they already use the platform, they accept the invitation from their own sign-in instead.
3. The first admin invites the second person who will approve opening balances: an owner, agency admin, property manager or accountant. In a new company with one admin, adding an approver goes through the 24-hour cooling-off, so do this the day before.

## 2. Step 1: the register

Onboarding → set the cut-over date → **Register**: download the template (Properties, Units and, for agencies, Owners), fill it, upload it.

- The check lists every problem by sheet, row and column. Nothing is written until the file has none.
- Codes are the keys: importing the same file again changes nothing, and a corrected file updates what changed.

## 3. Step 2: tenancies

**Tenancies**: download the template (Tenants and Leases), fill it, upload it, read the check, commit.

- Tenants are matched by phone (E.164, `+233…`) within the company; a company tenant by name and TIN.
- Consent columns record what each tenant agreed to, with the import as the source. Leave a channel empty if they did not agree to it.
- Leases are recorded as paper leases. Billing starts at the first rent period on or after the cut-over.
- Scans can follow: an imported lease without a scan is listed under **Scans to follow**; upload each from the lease page.
- **Nothing is sent to tenants.** No welcome, no reminder, no catch-up for past due dates.

## 4. Step 3: opening balances

**Balances**: download the template (Arrears, Advances, Deposits, Withholding, Owner items), fill it, upload it.

- **Arrears:** one row per lease, month and kind (rent or service charge), with the amount and its original due date, so ageing is right.
- **Advances:** an amount, or a paid-through date (whole periods only).
- **Deposits:** the amount held.
- **The preview shows each lease as it will look after posting:** balance, arrears by age, paid-until, deposit held, withholding, and totals per owner (agent cash, rent tax owed and its due date). Go through it with the landlord against their own records. A month that starts on the cut-over day is billed by the platform as usual, so it shows on top of the opening arrears.
- **Commit** sends it to the second person. They see the batch, the cut-over and the money per owner on their approval card, and approve or refuse. The person who committed can never approve it. Posting starts once approved.

What posting does, and does not do:

- Opening amounts post to opening balances (3900), never to income, with no rent tax and no management fee: that money was received before the platform (OQ-64, for the tax adviser).
- Rent tax still owed comes in as its own item with its due date, and reminders follow it.
- Arrears paid after the cut-over are rent received: taxed and charged a fee as usual.
- Advances become credit that later months draw on, so paid-until moves on as for any lease.

## 5. Corrections after posting

Use an **adjustment** workbook (same sheets, signed amounts), with the same preview and approval. Never edit records by hand.

- Lowering arrears credits that month's opening lines, latest first, never below what has been paid.
- Raising arrears for a month already brought in adds a second opening line for that month; it is paid after the original.
- An advance or a deposit is never lowered below what has been drawn; agent cash never below what was brought in.

## 6. After onboarding

- Check the dashboard and two or three lease pages against the landlord's records: balance, paid-until, deposit held.
- Send tenants a welcome through Broadcasts when the landlord is ready; consent decides the channels.
- Gate 1's arrears-over-60-days baseline is the first full month after the cut-over. Opening money counts in neither rent due nor rent collected.

## If something goes wrong

- A check that lists problems: fix the file and upload it again.
- A batch that fails to post: its error shows on the batch. Fix the cause and commit again (the same file is matched, never posted twice). See `incident-response.md` if it repeats.
- A figure that is wrong after posting: an adjustment workbook (section 5).
