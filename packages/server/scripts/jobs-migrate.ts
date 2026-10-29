import { installJobSchema } from '../src/core/jobs/install';

const ownerUrl = process.env.DATABASE_OWNER_URL;
if (!ownerUrl) {
  console.error('DATABASE_OWNER_URL is not set. Copy .env.example to .env for local development.');
  process.exit(1);
}

await installJobSchema(ownerUrl);
console.log('Job queue schema installed.');
