import { runMigrations } from '../migrate';

const ownerUrl = process.env.DATABASE_OWNER_URL;
if (!ownerUrl) {
  console.error('DATABASE_OWNER_URL is not set. Copy .env.example to .env for local development.');
  process.exit(1);
}

await runMigrations(ownerUrl);
console.log('Database migrations applied.');
