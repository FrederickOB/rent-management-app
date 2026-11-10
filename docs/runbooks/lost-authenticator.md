# Lost authenticator

- **Status:** M11 (founder decision 4, 2026-11-10; security review R1 F14). The console action and the command line are built: `packages/server/src/identity/account-recovery.ts` and `packages/server/scripts/identity-recover.ts`.
- **Covers:** a staff member who signs in with a password and an authenticator app (TOTP) and has lost the app. That is an owner, agency admin, manager, accountant, adviser or platform admin (AD-06).
  - Tenants and caretakers sign in with a code sent to their phone and have no authenticator. A changed phone number is a profile change, not this runbook.
- **The risk:** a reset hands the account to whoever has the password. Phishing gets passwords, so a convincing request for a reset is exactly what an attacker sends. The identity check below is the control. When in doubt, don't reset.

## 1. Backup codes first

Ask: "Did you save backup codes when you set up two-step sign-in?"

- **Yes:**
  - **To sign in:** they sign in as usual. On the code step they choose "Use a backup code instead" and enter one. Each code works once.
  - **Once in:** they check Settings → Security (`/settings/security`), "where you are signed in", and sign out any device they don't recognise. A lost or stolen phone is one of them.
  - **If the old authenticator can be restored** (a phone backup, the same app on a new phone), they need nothing more.
  - **Otherwise they still need a reset.** "Make new backup codes" needs a current code from the authenticator. **Gap:** nobody can move to a new authenticator by themselves, even when signed in with a backup code. The backup code keeps them working today, and the check below can proceed without hurry.
- **No:** go on to the identity check.

## 2. The identity check

**Who does it:**

- a platform admin, through the console;
- the person asking must not be the platform admin doing the reset;
- a platform admin who lost their own authenticator is reset by another platform admin. With only one platform admin, the command line is the only way; `pnpm platform:bootstrap --add-admin` adds a second.

**Do all of these. Write down what you did as you go; it goes in the reason.**

1. **The request comes from someone on record:**
   - from the email address on their account;
   - or from their company's landlord or agency admin, writing from the address on *their* account.

   A request from a new address or number is not acted on, whatever it says.
2. **Call them back on a number you already had.** Use the number their company's admin confirms for them, or the phone on their account. Never use a number given in the request.
3. **A second person at their company confirms.** The company's landlord or an agency admin confirms, in writing or on a call you placed, two things: that this person works with them, and that they lost their authenticator.
   - If the person *is* the company's only admin, use the facts in step 4 instead, and both checks in step 5.
4. **Facts only the account holder would know,** which the console lets you check without a support grant. Ask; don't prompt:
   - the companies they work in and their role in each. The console shows these after "Find";
   - for a company's landlord or admin: the company's plan tier, and the month and amount of its last subscription invoice. Console → Companies → the company → Invoices.
5. **Signs of a takeover.** Stop and treat it as a security incident (`incident-response.md`) if:
   - the person says they did not ask for a password reset, but someone did;
   - the company's admin knows nothing of the request;
   - the request is urgent and pushes you to skip a step;
   - they ask for the reset to be sent somewhere new.

   The company's admin can check the Audit log (`/audit`) for recent `auth.password_set` with `via: reset`, or a run of `auth.sign_in_failed`, for this person.

**Never:**

- ask for their password, an authenticator code or a backup code;
- ask for an ID card, a photo of one, or its number. The product never takes images of a Ghana Card (CLAUDE.md section 10; OQ-39), and an ID number in an audit reason could never be removed;
- reset because a caller sounds right. If any step fails, don't reset. Offer the backup-code route, and try again once the company's admin can confirm.

**Not legal advice:** these checks are this runbook's own. No law reviewed for the product sets an identity check for this. If counsel later requires one (for example under Act 843's security duties), it replaces this list.

## 3. The reset

### In the console (the normal way)

1. **Open Account recovery** (`/platform/people`). It is linked from Console → Support access, not from the menu. It needs `person.two_factor.reset`, which platform admins hold.
2. **Find them** by their exact email address. The search goes by POST, so the email never sits in a URL.
3. **Check the card:**
   - the name;
   - "Two-factor set up";
   - the number of sessions signed in;
   - the companies and roles.

   If the companies don't match what you were told, stop.
4. **"Reset two-factor".** Give the reason: 10 to 500 characters, saying how you checked who they are. For example: "Lost phone. Request from account email; called back on the number the agency admin confirmed; the admin confirmed in writing; ticket 812." No ID numbers and no phone numbers.
5. **Confirm:** "Yes, reset two-factor".

### At the command line (console unreachable, or during an incident)

```bash
# Prefer --person <id> when you have it: an email typed here stays in your shell history.
pnpm identity:recover reset-two-factor --person <person id> \
  --reason "Lost phone. Request from account email; called back on number confirmed by the agency admin; ticket 812" \
  --operator "<your full name>"

pnpm identity:recover reset-two-factor --email <their email> --reason "…" --operator "<your full name>"
```

- It reads `DATABASE_URL` from the environment or the repository's `.env`.
- It prints "Done for person <id>: N session(s) ended, two-factor removed (they enrol again at next sign-in)."
- It refuses:
  - a reason outside 10 to 500 characters;
  - an operator name shorter than 2 characters;
  - a person it can't find ("No person with that id or email").
- If you used `--email`, remove the line from your shell history afterwards.
- **Gap:** the command records the operator's name as typed and doesn't check that it names a platform admin. The ops commands do check (`operatorByEmail`). Only people who hold the production database credentials can run it, so who holds them is the real control until this is fixed.

## What the reset does

**At once, in one transaction:**

- removes their authenticator secret and every backup code;
- marks two-factor off;
- **ends every session they have, on every device.** That includes a tenant-app session, if the same person is also someone's tenant.

**Audit:**

- **In the platform's chain:** `auth.two_factor_reset`, with the reason, how it was done (`console` or `cli:<name>`), the sessions ended and whether two-factor was removed.
- **In the chain of each company they work in:** the same event, without the reason (it may describe them), marked as done by the platform. Their admins can see it in the Audit log.

**At their next sign-in:**

- they sign in with their password;
- the only thing that session can do is enrol a new authenticator (`/enrol`);
- they then save the new backup codes it shows. **Tell them to keep these somewhere other than the phone.**

**The password is unchanged.** If they think it is known to someone else, they change it after enrolling (Settings → Security → Password). That also signs out their other devices.

### "Sign out everywhere" on its own

The same page has "Sign out everywhere":

- **what it does:** ends every session at once and leaves the password and authenticator alone;
- **when to use it:** a stolen laptop, or a phone that is lost but still has the authenticator locked behind its own screen lock;
- **on the command line:** `pnpm identity:recover revoke-sessions`, with the same flags;
- **audited** as `auth.sessions_revoked_all`.

## Afterwards

- **Tell the company's admin** that the reset was done, and when.
- **Check, a day later,** that the console shows "Two-factor set up" again for them. If it doesn't, they haven't enrolled; ask them to.
- **A password and email both lost** are out of scope here. The password reset link goes only to the email on record. Stop and escalate to the founder. Don't change anyone's email address by hand.
