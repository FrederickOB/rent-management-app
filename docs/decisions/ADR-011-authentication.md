# ADR-011: Authentication library

- **Status:** Accepted, 2026-10-28. The M1 spike passed all five checks on 2026-10-28, plus a sixth: one-time codes stored hashed (docs/plans/M1.md, section 5).

## Context

Staff (owners, agency admins, managers, accountants, advisers, platform admins) need a password plus TOTP, session timeouts and a device list with remote sign-out (AD-06). Tenants and caretakers sign in with a phone one-time code. Clients are Next.js web apps and an Expo app; the server is NestJS; data must stay in our PostgreSQL. The M1 prompt says to use a maintained library chosen by ADR and not to hand-roll cryptography.

## Decision

- **Better Auth**, mounted in `apps/api`, with:
    - the two-factor plugin (TOTP and backup codes), mandatory for staff roles;
    - the phone-number plugin for one-time-code sign-in, sending through our SMS adapter (WhatsApp authentication template as fallback);
    - built-in session listing and revocation for the device list;
    - built-in rate limiting on sign-in and code endpoints;
    - the Drizzle adapter, so identity tables live in our database;
    - the Expo client for the tenant app.
- **Memberships stay ours.** Company, role and scope live in our `membership` table and are read by `PolicyService`. Better Auth's organisation plugin is not used, to keep one source of truth.
- A NestJS guard turns a Better Auth session into an actor (person, membership, scope) for the policy layer.
- Passwords use the library's default hashing, or argon2id if configurable.
- **Session timeouts:** staff idle 30 minutes and absolute 12 hours; platform admins idle 15 minutes; tenants by short access token plus revocable refresh token.

## M1 spike

Before building on it, prove five things:
1. The NestJS integration works, on the Fastify adapter if used.
2. TOTP is enforced per role.
3. Idle and absolute timeouts behave as above.
4. The device list and remote sign-out work.
5. Phone sign-in works end to end in the Expo app with the fake SMS provider.

## Consequences

- A maintained library with our data in our database, and one sign-in system for web and mobile.
- The project is younger than some alternatives: pin the version and review changelogs.
- **Fallback if the spike fails:** sessions built on vetted primitives (`@node-rs/argon2`, `otplib`, database sessions), reviewed in M11.

## Alternatives considered

- **Auth.js.** Centred on Next.js; weak fit for NestJS and Expo.
- **Keycloak, Ory or Zitadel.** Mature, but another service to run and theme.
- **Clerk or Auth0.** Hosted; per-user cost, data abroad, and uncertain SMS delivery to Ghanaian numbers.
- **Supabase Auth.** Ties identity to a platform we are not otherwise using.

## Revisit when

- The M1 spike fails any of its five checks.
- Commercial tenant portals (Phase 2) need SSO with tenants' corporate identity providers.
