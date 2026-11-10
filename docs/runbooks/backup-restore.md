# Backup and restore

- **Status:** M11. The local scripts, the CI restore check and the two drills (a restore, and point-in-time recovery from a base backup and the WAL archive) work and were run on 2026-11-10; CI runs both drills monthly (`.github/workflows/scheduled.yml`). The production settings are applied at the first deployment (M12). The recovery targets were set by the founder on 2026-11-10 (M11 decision 10).
- **Covers:** the PostgreSQL database: the ledger, the audit chains and every business record (NFR backup; `docs/plans/M1.md` section 4.19).

## Production settings (infrastructure step)

Apply these when the RDS instance is created, in the region chosen under ADR-009. Values marked *proposed* are starting points chosen for this runbook, not requirements; confirm them at that step.

| Setting | Value |
| --- | --- |
| Encryption at rest | On, with a customer-managed KMS key. RDS cannot encrypt an existing instance, so create it encrypted. Backups and snapshots inherit the key. |
| Automated backups | On, kept 30 days: point-in-time recovery to any moment in the last 30 days. |
| Backup window | 02:00 to 03:00 Africa/Accra (UTC), after the nightly audit jobs at 01:00 and 01:30 (*proposed*). |
| Daily snapshots | An AWS Backup plan takes one a day and keeps it 35 days (*proposed*). |
| Cross-region copies | The same plan copies each snapshot to the second region (ADR-009), encrypted with a KMS key in that region. |
| Deletion protection | On, with a final snapshot if the instance is ever deleted. |
| Restore drill | Quarterly in production, as below (the NFR); monthly in CI with plain PostgreSQL tools. |
| Recovery point objective (RPO) | At most 5 minutes of data lost (founder, M11 decision 10). RDS point-in-time recovery meets it. |
| Recovery time objective (RTO) | Service back within 4 hours of the decision to restore (founder, M11 decision 10). |

Decide at the same step:

- **Vault Lock.** AWS Backup Vault Lock stops anyone, administrators included, from deleting backups early. Its compliance mode cannot be undone, so choose the mode deliberately.
- **Where copies may live.** Copying personal data to another region, and keeping it in backups after an Act 843 deletion request, are questions for counsel (OQ-14, OQ-49; the `data_retention.*` rules are unverified).
- **Evidence files.** Signed documents and audit anchors live in S3 with versioning and Object Lock (ADR-006). Replicate those buckets to the same second region: the database refers to object versions by id and SHA-256.

## Quarterly restore drill (production, from M12)

1. Restore the latest snapshot, or a point in time, to a new instance. Never restore over production.
2. Run every nightly check against the copy with `scripts/drill-checks.ts`, as the drills below do. It covers `audit.verify-chain` (every chain recomputed, every recorded anchor still matching), `billing.subledger-check` (books balance; receivables, prepayments and deposits against their sub-ledgers), `ledger.agent-cash-check`, `reporting.fee-check` and `subscription.subledger-check`:

   ```bash
   cd packages/server
   DATABASE_URL=postgres://rent_app:…@<copy>/rent DATABASE_OWNER_URL=postgres://rent_owner:…@<copy>/rent \
     node_modules/.bin/tsx --tsconfig tsconfig.runtime.json scripts/drill-checks.ts --json checks.json
   ```

   The script refuses a database called `rent` on purpose, so on a production copy, name the restored database otherwise (`rent_restore_<date>`). It reads only, with alerts off, and prints ids and counts, never personal data.
3. For each company, check that the event at the last anchored sequence number before the restore point carries the anchored hash (`audit.anchor-heads` job). A mismatch means the chain was rewritten.
4. Record how long the restore took (against the 4-hour RTO) and how much data the restore point lost (against the 5-minute RPO), then delete the copy.

## The drills (M11)

Both use plain PostgreSQL tools on the Compose image, refuse `rent` (as source and as target), and clean up after themselves. Each runs the same nightly checks the worker runs, through `packages/server/scripts/drill-checks.ts`, and fails if any check fails. The source is a seeded copy, never `rent`: locally a scratch database, in CI `rent_drill_source`.

### Restore: `pnpm drill:restore <source> [--json FILE]`

As run (`scripts/drill-restore.sh`):

1. `pg_dump` of the source as the superuser (forced RLS hides other companies from anyone else), checked with `pg_restore --list`.
2. Restore into a fresh database (`drill_restore_<pid>`) in one transaction, through `scripts/db-restore.sh`.
3. Row counts of every table (182) on both sides, as the superuser: they must be identical.
4. Every nightly check on the copy, as the application role, with row level security on.
5. The copy and the dump are dropped, pass or fail.

Run on 2026-11-10, local (Apple silicon, Docker Desktop), source `rent_scratch_drill` (the demo seed):

| Step | Time |
| --- | ---: |
| Dump (2.2 MB) | 0.9 s |
| Restore | 2.9 s |
| Row counts (182 tables, 6,044 rows, identical) | 0.6 s |
| Nightly checks (17 of 17 passed, 4 companies; 1.2 s of checking, the rest starting the services) | 20.2 s |
| Total | 24.5 s |

Run again the same day after the M11 migration revoked TEMPORARY from `rent_app` (both drills now grant CONNECT only), on `rent_scratch_load`, the load test's database after a smoke run, so with real payment traffic: 192 tables and 46,319 rows identical; the dump (5.8 MB) took 1.6 s and the restore 3.3 s; 9 of 9 checks passed; 25.0 s in total.

The checks were also run on a copy corrupted on purpose: one journal line's amount changed with triggers off. `billing.subledger-check` failed, naming the unbalanced entry, and the drill exited 1.

### Point-in-time recovery: `pnpm drill:pitr <source> [--json FILE]`

As run (`scripts/drill-pitr.sh`), in a throwaway container (`postgres:18.6`, the Compose image; its own port, 54391 or `PITR_PORT`, and its own volume; never the Compose database):

1. Start PostgreSQL with `wal_level=replica`, `archive_mode=on` and an `archive_command` copying each completed segment to an archive directory. Create the roles from `packages/db/sql/bootstrap.sql` (without its `rent` database) and load the source's dump as `rent_drill`.
2. `pg_basebackup --wal-method=stream --checkpoint=fast`.
3. **Changes A:** a company created through `app.create_company` (audited, with its book) and a marker row. Note the time T. **Changes B:** the same again. `pg_switch_wal()`, then wait until the segment holding A, T and B is archived.
4. Stop and remove the server (the primary is lost). Copy the base backup to a new data directory with `restore_command`, `recovery_target_time = T`, `recovery_target_action = 'promote'` and `recovery.signal`, and start a second container on it.
5. Wait until recovery ends (`pg_is_in_recovery()` false). Assert A is present and B absent, then run every nightly check on the recovered `rent_drill`.
6. Both containers and the volume are removed, pass or fail.

Run on 2026-11-10, local, source `rent_scratch_drill`:

| Step | Time |
| --- | ---: |
| Start the server and load the copy | 8.6 s |
| Base backup | 2.8 s |
| Changes A, the target, changes B, WAL archived | 5.2 s |
| Prepare the recovery | 7.1 s |
| Recover to the target (start to promoted) | 5.0 s |
| Nightly checks (21 of 21 passed, 5 companies) | 19.4 s |
| Total | 48.1 s |

Recovered to 09:27:25.10 UTC: company A present and company B absent (4 companies before A, 6 after B, 5 recovered); marker A present, marker B absent.

Run again after TEMPORARY was revoked, on `rent_scratch_load`: 39.3 s in total (base backup 2.8 s, recovery 1.9 s from start to promoted), A present and B absent, 13 of 13 checks passed for 3 companies, as the application role with CONNECT only.

### What the drills say about the targets

- **RPO 5 minutes:** point-in-time recovery returns every change committed up to the chosen moment that reached the WAL archive. RDS archives continuously, uploading WAL every 5 minutes (its "latest restorable time" trails by about that much), so the RPO holds there. The drill archives on demand (`pg_switch_wal`). A self-managed server would need `archive_timeout = 300` or less.
- **RTO 4 hours:** at this size a restore takes seconds. The time that counts is the decision and the work around it: creating the RDS instance from a snapshot or a point in time (typically 15 to 60 minutes for a small instance), running the checks, pointing the apps at it, and checking. Record each part of it in the first production drill (M12).
- **CI:** `.github/workflows/scheduled.yml` runs both drills on the 1st of each month and on demand, on a freshly migrated and seeded `rent_drill_source`, and keeps their JSON results and logs as the `backup-drills` artifact.

## Local commands

They cover the Compose database only. Its data is fake, but treat a dump from any other environment as personal data. `backups/` is ignored by git.

```bash
pnpm db:backup                                        # writes backups/<UTC timestamp>.dump
pnpm db:restore backups/20261028T120000Z.dump         # restores into a new database, rent_restore
pnpm db:restore backups/20261028T120000Z.dump my_copy # or into a name you choose
```

- The backup is a `pg_dump` custom-format archive, taken as the `postgres` superuser through the Compose container. Company tables force row level security, so only a role that bypasses it sees every company's rows. The script checks that `pg_restore` can read the archive before keeping it.
- The restore refuses `rent` and any database that already exists. It creates the target owned by `rent_owner`, grants `rent_app` CONNECT, and restores in one transaction, so a failure leaves an empty database, never a partial one.
- Roles belong to the server, not the dump. On a fresh server, run `packages/db/sql/bootstrap.sql` first.
- To use a copy, point `DATABASE_URL` at it, for example `postgres://rent_app:rent_app_dev@localhost:54320/rent_restore`. To remove it: `docker compose exec -T postgres dropdb --username=postgres --force rent_restore`.

## CI restore check

The `backup` job in `.github/workflows/ci.yml` migrates and seeds a fresh database, then runs `bash scripts/ci-restore-check.sh`. The script dumps `rent`, restores the dump into a scratch database (`rent_restore_check`) and, as the superuser, calls `audit.verify_chain` for every company that has a company row, a chain head or audit events. It fails unless at least one chain was checked and every chain is intact, and it always drops the scratch database. Locally it runs the same way against the Compose database:

```text
ok      019a3000-0000-7000-8000-000000000001  2 events
ok      019a3000-0000-7000-8000-000000000002  11 events
ok      019a3000-0000-7000-8000-000000000003  3 events
Restore check passed: 3 audit chains (16 events) verified in the restored copy.
```

It shows that a dump and restore keep the evidence intact. It does not test RDS restores or anchors; the quarterly drill covers both.
