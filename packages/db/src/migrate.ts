import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase } from './client';

export const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../migrations',
);

/** Applies every migration as the owner role (`rent_owner`). Never run as the application role. */
export async function runMigrations(ownerUrl: string): Promise<void> {
  const database = createDatabase(ownerUrl, { max: 1, applicationName: 'rent-migrate' });
  try {
    await migrate(database.db, {
      migrationsFolder: MIGRATIONS_FOLDER,
      migrationsSchema: 'drizzle',
    });
  } finally {
    await database.close();
  }
}
