# Backup and restore

- **Status:** M1. The local scripts and the CI restore check work now. The production settings are applied at the infrastructure step (first deployment). The full runbook and the first drill are M11.
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
| Restore drill | Quarterly, as below. |

Decide at the same step:

- **Vault Lock.** AWS Backup Vault Lock stops anyone, administrators included, from deleting backups early. Its compliance mode cannot be undone, so choose the mode deliberately.
- **Where copies may live.** Copying personal data to another region, and keeping it in backups after an Act 843 deletion request, are questions for counsel (OQ-14, OQ-49; the `data_retention.*` rules are unverified).
- **Evidence files.** Signed documents and audit anchors live in S3 with versioning and Object Lock (ADR-006). Replicate those buckets to the same second region: the database refers to object versions by id and SHA-256.

## Quarterly restore drill

1. Restore the latest snapshot, or a point in time, to a new instance. Never restore over production.
2. Run `audit.verify_chain(company_id)` for every company, as `scripts/ci-restore-check.sh` does, with a role that can read every company's rows. Every chain must be intact.
3. For each company, check that the event at the last anchored sequence number before the restore point carries the anchored hash (`audit.anchor-heads` job). A mismatch means the chain was rewritten.
4. From M4a, also run the nightly ledger reconciliation checks against the copy.
5. Record how long the restore took and how much data the restore point lost, then delete the copy.

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
