# Rent Platform

A Ghana-first platform for landlords and agencies: collect rent by MoMo, card and bank, control cash, keep owner ledgers, serve residential and commercial tenants over WhatsApp, SMS, email and an app, and issue legal notices that tenants open and e-sign. The rules every change follows are in [CLAUDE.md](CLAUDE.md). The requirements are in [docs/prd.md](docs/prd.md), the design in [docs/architecture.md](docs/architecture.md), the decisions in [docs/decisions/](docs/decisions/) and the milestone plans in [docs/plans/](docs/plans/).

> **Development only.** Everything below is for local development. The passwords, keys, phone numbers and accounts are fake and must never be used anywhere else. Only fake providers are configured, so nothing is ever really sent.

## Prerequisites

- **Node.js 24 LTS**, the version in `.nvmrc`. With mise: `mise use --global node@24`. With nvm: `nvm install` in the repository.
- **Corepack**, which ships with Node.js 24: run `corepack enable` once. It installs the pnpm version pinned in `package.json` (`packageManager`).
- **Docker** with Compose v2, for PostgreSQL, object storage, Mailpit and the fake providers.
- For the tenant app on a device: Xcode with an iOS 16.4 or later simulator, or Android Studio with an emulator. The web build needs neither.

## First-time setup

```bash
cp .env.example .env
pnpm install
pnpm services:up   # Compose; the first run builds the fake-providers image
pnpm db:migrate
pnpm db:seed       # the Accra demo dataset (CLAUDE.md section 14)
pnpm dev
```

## Daily commands

| Command                                   | What it does                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                                | Starts the Compose services, then api, worker, web, links and the tenant app in watch mode              |
| `pnpm services:up` / `pnpm services:down` | Starts or stops the Compose services                                                                    |
| `pnpm build`                              | Production builds of web and links, and the tenant app's web export                                     |
| `pnpm lint` / `pnpm typecheck`            | ESLint (typed rules and the repository's own rules) and TypeScript                                      |
| `pnpm format` / `pnpm format:check`       | Prettier                                                                                                |
| `pnpm test`                               | Starts the services, then every unit and integration test (real PostgreSQL with RLS) and the Expo tests |
| `pnpm test:unit`                          | Unit tests only, no services                                                                            |
| `pnpm test:e2e`                           | Playwright, one app at a time; keep `pnpm dev` running (links builds and serves its own copy on 3792)   |
| `pnpm db:migrate`                         | Applies the SQL migrations as `rent_owner`                                                              |
| `pnpm db:seed`                            | Loads the demo dataset; idempotent, and refuses any database that is not local                          |
| `pnpm db:backup` / `pnpm db:restore`      | Local backup and restore ([runbook](docs/runbooks/backup-restore.md))                                   |
| `pnpm rules:add`                          | Adds a row to the legal and tax rules table (TX-08)                                                     |

## Ports

| Service                                             | Address                                 |
| --------------------------------------------------- | --------------------------------------- |
| API                                                 | http://localhost:3700 (`/health/ready`) |
| Web: landlord, manager and admin app                | http://localhost:3701                   |
| Links: no-login secure pages                        | http://localhost:3702                   |
| Expo dev server: the tenant app and its web build   | http://localhost:8081                   |
| Fake providers inbox: SMS sign-in codes appear here | http://localhost:4010                   |
| Mailpit: every email the apps send                  | http://localhost:8025 (SMTP on 1025)    |
| PostgreSQL (database `rent`)                        | localhost:54320                         |
| SeaweedFS, the local S3 API                         | http://localhost:8333                   |

## Demo accounts

Created by `pnpm db:seed` (`packages/server/scripts/seed.ts`). All are fictional.

**Staff** sign in to the web app with an email, the password `demo-password-2026` and a TOTP code.

| Email                       | Role                                                                                 | Company                     |
| --------------------------- | ------------------------------------------------------------------------------------ | --------------------------- |
| `admin@demo.invalid`        | Platform admin                                                                       | Rent Platform               |
| `agency.admin@demo.invalid` | Agency admin                                                                         | Osu Ridge Property Managers |
| `manager.one@demo.invalid`  | Property manager                                                                     | Osu Ridge Property Managers |
| `manager.two@demo.invalid`  | Property manager                                                                     | Osu Ridge Property Managers |
| `new.manager@demo.invalid`  | Property manager with no TOTP yet: enrols at first sign-in; every seed run resets it | Osu Ridge Property Managers |
| `accountant@demo.invalid`   | Accountant                                                                           | Osu Ridge Property Managers |
| `adviser@demo.invalid`      | Adviser (read-only)                                                                  | Osu Ridge Property Managers |
| `owner.accra@demo.invalid`  | Owner, agency client                                                                 | Osu Ridge Property Managers |
| `owner.london@demo.invalid` | Owner, agency client living in London                                                | Osu Ridge Property Managers |
| `landlord@demo.invalid`     | Owner, self-managing landlord                                                        | Kwabena Owusu-Demo          |
| `approver@demo.invalid`     | Adviser, nominated approver for the landlord                                         | Kwabena Owusu-Demo          |

**TOTP.** Every demo staff member shares one development secret. In an authenticator app, add an account by entering this setup key (time-based, 6 digits, 30 seconds):

```text
OJSW45BNMRSW23ZNORXXI4BNONSWG4TFOQWTEMBSGYWWY33DMFWA
```

The seed also prints it as an `otpauth://` URI. To print the current code without a phone:

```bash
pnpm --filter @rent/api exec node --input-type=module -e "import { generate } from 'otplib'; console.log(await generate({ secret: 'OJSW45BNMRSW23ZNORXXI4BNONSWG4TFOQWTEMBSGYWWY33DMFWA' }))"
```

Or, with oath-toolkit installed: `oathtool --totp -b OJSW45BNMRSW23ZNORXXI4BNONSWG4TFOQWTEMBSGYWWY33DMFWA`. Each staff member also has two single-use backup codes: `demo1-backup` and `demo2-backup`.

**Phone sign-in.** The tenant signs in to the tenant app with `+233 20 000 0021` (or `020 000 0021`); the caretakers use `+233 20 000 0011` and `+233 20 000 0012`. Codes go to the fake SMS provider: read them in the inbox at http://localhost:4010. A phone gets at most 3 codes in 15 minutes.

## Tenant app

The tenant app is Expo (SDK 58) and needs **iOS 16.4 or later**. Tenants on older iPhones use WhatsApp and the links pages instead. `pnpm dev` starts its dev server; for Expo's interactive menu (`i` for the iOS simulator, `a` for Android, `w` for the web), run `pnpm --filter @rent/tenant start` in its own terminal. An Android emulator reaches your machine at 10.0.2.2, so start it with `EXPO_PUBLIC_API_URL=http://10.0.2.2:3700`.
