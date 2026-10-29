import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const appDir = path.resolve(import.meta.dirname, '..');

function run(env: Record<string, string>) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: appDir,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  return { child, output: () => output };
}

describe('PLATFORM fake providers: process', () => {
  it('refuses to start with NODE_ENV=production', async () => {
    const { child, output } = run({ NODE_ENV: 'production', PORT: '0', HOST: '127.0.0.1' });
    const [code] = (await once(child, 'exit')) as [number | null];
    expect(code).toBe(1);
    expect(output()).toContain('must never run in production');
  });

  it('starts on a free port when PORT=0 and prints the address it bound', async () => {
    const { child, output } = run({ NODE_ENV: 'test', PORT: '0', HOST: '127.0.0.1' });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`did not start: ${output()}`)), 10_000);
        child.stdout.on('data', () => {
          const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output());
          if (match?.[1]) {
            clearTimeout(timer);
            resolve(match[1]);
          }
        });
      });
      expect(url).not.toMatch(/:0$/);
      expect(await (await fetch(`${url}/health`)).json()).toEqual({ ok: true });
    } finally {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  });
});
