# Support access

- **Status:** M11. Built in M10 (decision 13; `packages/server/src/admin/support.service.ts`). The database enforces the grant as well as the API (`app.current_company_id()`).
- **Covers:**
  - how a customer lets the platform's support read their company;
  - what a platform admin can see and do under that grant, and what is refused without one;
  - how the grant is audited and ended (AD-10; CLAUDE.md sections 5 and 6).
- **Not this runbook:** a person who lost their authenticator, or must be signed out everywhere, is `lost-authenticator.md`. That needs no grant.
- **The rule:** a platform admin sees a company's data only while that company's admin has granted access, only to read, and every page they open is written into the company's own audit log.

## How a customer grants access

1. **Who:** the landlord of a self-managing company, or an agency admin. A scoped admin (one limited to some owners or properties) can't grant it, and nor can managers, accountants, caretakers or advisers. Granting still works while the company's subscription is read-only.
2. **Where:** Settings → Subscription → "Support access" (`/settings/subscription`). The card says what the grant allows: "A platform administrator will be able to read your company's records, but not change them, until the access ends. Every page they open is recorded in your audit log. You can end it at any time."
3. **Fill in:**
   - **"Why support needs access":** 5 to 500 characters. Use the support ticket or the problem, and no tenant's personal data.
   - **"For how many hours":** 24 unless changed; 1 to 168 hours (7 days).
4. **"Grant read-only access".** It starts at once and ends by itself at the time shown, by the database's clock.

**When support asks for access:**

- **Ask in writing, from the platform's own address,** saying why and for how long.
- **Ask for the shortest time that will do.**
- **Never ask the customer for their password or a code** so that you can sign in as them. Support works only through the grant.

## What a platform admin can do under a grant

- **Where:**
  - Console → Support access (`/platform/support`) lists every grant across companies, active or not, with the requests made under each;
  - a company's detail page has the same list on its "Support access" tab;
  - "Open read-only", shown while a grant is active, goes to the read-only view, `/platform/support/<company>`.
- **What the read-only view shows** ("<company>, read-only"):
  - **counts:** properties, units, leases, tenants and approvals waiting;
  - **the last 10 payments:** date received, method and amount;
  - **the last 20 audit events:** the action, when, and who by kind ("Staff", "Tenant", "System", "Platform support", "Secure link"), never by name.
- **What it does not show:** a tenant's or owner's name, contact details or ID numbers, a lease, a message or a document.
- **Gap:** support can't open a specific tenant, lease, payment or notice, even under a grant. To look into one, ask the customer for its reference or id (a payment reference, a notice number). Don't ask for screenshots, which carry tenants' personal data.
- **Reading only:** the read runs in a read-only database transaction, and the policy refuses every staff action to a platform admin. Nothing can be changed, approved, sent or exported under a grant.

## Audit

- **In the company's own audit chain:**
  - **`support.granted`:** who granted it, the hours and the end time;
  - **`support.revoked`:** who ended it;
  - **`support.request`:** each time a platform admin opens the company. It records the grant, the route and the record. It is written in its own transaction **before** the read, so it is recorded even if the read fails. The database accepts it only under an active grant.

  The row trigger also records every insert and change on `support_grant`.
- **The customer sees** each request under its grant in the Support access card ("When", "Who", "What"). It is also in the Audit log (`/audit`) for the landlord, agency admins and accountants.
- **The platform sees** the same requests in the console's grant list. They are read from the company's chain through a narrow function, never by entering the company.

## Ending access

- **The customer:** "End this access now" on the grant, in Settings → Subscription → Support access. It ends at once and can be done once per grant. A second attempt answers "This support access was already revoked".
- **By itself:** at its end time.
- **The platform can't end a customer's grant.** If a platform admin must stop using one, just stop. If the platform admin's own account may be compromised, sign them out everywhere and reset their two-factor (`lost-authenticator.md`). Then ask the customer to end the grant.
- **After it ends,** the read-only view refuses at once, by the same check (below).

## What is refused without a grant

- **The read-only view:** the API answers 403 `support_no_grant`: "This company has not granted support access, or its grant has ended. One of its admins can grant it under Settings, Subscription."
- **In the database:** a platform admin's session in a customer company without an active grant has no company context (`app.current_company_id()` is null). Row level security therefore returns nothing, even to a query that got past the API.
- **Every company-scoped action:** the policy refuses it to platform admins ("platform admins see company data only under a support grant (M10)").

**What platform admins see without any grant** comes through narrow system paths and is the platform's own business:

- the company list, with tier, status, billable units, revenue and arrears;
- subscription invoices and usage;
- messaging costs;
- system health;
- Gate 1 metrics;
- the rules.

None of it holds a tenant's personal data.

## If something looks wrong

- **A `support.request` the platform didn't make, or one outside a grant's window:** treat it as a security incident (`incident-response.md`; `breach-response.md` if personal data may be involved). The database should have refused it.
- **A customer says support saw something it shouldn't have:** read the company's `support.request` events with them. The view shows counts, payment amounts and audit actions only, so check whether something else is the source.
