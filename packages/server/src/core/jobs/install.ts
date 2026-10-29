import { runStatements } from '@rent/db';
import { PgBoss } from 'pg-boss';
import { PGBOSS_SCHEMA } from './jobs.service';

/**
 * Installs or upgrades pg-boss's schema as the owner role, then grants the application role
 * what pg-boss needs at runtime (DML only). Part of `pnpm db:migrate`.
 */
export async function installJobSchema(ownerUrl: string): Promise<void> {
  const boss = new PgBoss({
    connectionString: ownerUrl,
    schema: PGBOSS_SCHEMA,
    migrate: true,
    supervise: false,
    schedule: false,
    max: 1,
  });
  await boss.start();
  await boss.stop({ graceful: false, close: true });

  await runStatements(
    ownerUrl,
    `
      grant usage on schema ${PGBOSS_SCHEMA} to rent_app;
      grant select, insert, update, delete on all tables in schema ${PGBOSS_SCHEMA} to rent_app;
      grant usage, select on all sequences in schema ${PGBOSS_SCHEMA} to rent_app;
      grant execute on all functions in schema ${PGBOSS_SCHEMA} to rent_app;
      alter default privileges in schema ${PGBOSS_SCHEMA} grant select, insert, update, delete on tables to rent_app;
      alter default privileges in schema ${PGBOSS_SCHEMA} grant usage, select on sequences to rent_app;
      alter default privileges in schema ${PGBOSS_SCHEMA} grant execute on functions to rent_app;`,
  );
}
