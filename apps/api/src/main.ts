import { loadConfig } from '@rent/server/core';
import { createApiApp } from './app';

const config = loadConfig();
const app = await createApiApp({ config, applicationName: 'rent-api' });
app.enableShutdownHooks();
const port = Number(new URL(config.API_BASE_URL).port || 3000);
await app.listen({ port, host: '0.0.0.0' });
