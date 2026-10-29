import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import type { TestProject } from 'vitest/node';

const appDir = path.resolve(import.meta.dirname, '../../../../apps/fake-providers');
const PAYMENTS_SECRET_KEY = 'sk_test_contracts_http';
const WHATSAPP_APP_SECRET = 'contracts-http-whatsapp-app-secret';

/**
 * Starts a private fake-providers process on a free port for the contracts-http project, so the
 * suites run against the current code and never touch the instance on port 4010.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: appDir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: '0',
      HOST: '127.0.0.1',
      FAKE_PAYMENTS_SECRET_KEY: PAYMENTS_SECRET_KEY,
      FAKE_WHATSAPP_APP_SECRET: WHATSAPP_APP_SECRET,
      // Never deliver webhooks from tests to whatever a developer's .env points at.
      FAKE_PAYMENTS_WEBHOOK_URL: '',
      FAKE_WHATSAPP_WEBHOOK_URL: '',
      FAKE_IDENTITY_WEBHOOK_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`fake-providers did not start within 20 s:\n${output}`)),
      20_000,
    );
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const match = /listening on (http:\/\/\S+)/.exec(output);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`fake-providers exited with code ${code} before it started:\n${output}`));
    });
  });

  project.provide('fakeProvidersUrl', url);
  project.provide('fakePaymentsSecretKey', PAYMENTS_SECRET_KEY);
  project.provide('fakeWhatsAppAppSecret', WHATSAPP_APP_SECRET);

  return async () => {
    if (child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
    await exited;
    clearTimeout(timeout);
  };
}
