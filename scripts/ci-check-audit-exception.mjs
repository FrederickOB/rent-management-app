#!/usr/bin/env node
// The dependency audit ignores GHSA-mrhx-c7xc-m3w5, which the founder approved on 2026-11-10 for one
// case only: zod 3.25.76 reached through Expo's build-time tools (@expo/cli) and Playwright's
// chromium-bidi, which never ship in an app bundle. `pnpm audit --ignore` takes an advisory id, not
// a version, so this check keeps the exception that narrow (M11 review B11). It fails when the
// lockfile holds any other zod below 4.6.6, or when anything else comes to depend on zod 3.25.76.
import { readFileSync } from 'node:fs';

const ALLOWED_OLD = '3.25.76';
const FIXED = [4, 6, 6];
const ALLOWED_DEPENDENTS = ['@expo/cli@', 'chromium-bidi@'];

const lock = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8');
const lines = lock.split('\n');
const problems = [];

const below = (version) => {
  const parts = version.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (parts[i] !== FIXED[i]) return parts[i] < FIXED[i];
  }
  return false;
};

// Every zod version in the `packages:` section.
const versions = new Set();
for (const line of lines) {
  const match = /^ {2}zod@([0-9][^:(]*):$/.exec(line);
  if (match) versions.add(match[1]);
}
for (const version of versions) {
  if (below(version) && version !== ALLOWED_OLD)
    problems.push(`zod ${version} is below 4.6.6 and is not the approved exception`);
}

// Which snapshots depend on the old zod.
let inSnapshots = false;
let current = null;
const dependents = new Set();
for (const line of lines) {
  if (/^snapshots:/.test(line)) inSnapshots = true;
  else if (/^[a-z]/i.test(line)) inSnapshots = false;
  if (!inSnapshots) continue;
  const header = /^ {2}(\S.*):$/.exec(line);
  if (header) current = header[1].replace(/^'|'$/g, '');
  else if (current && new RegExp(`^ {6}zod: ${ALLOWED_OLD.replace(/\./g, '\\.')}$`).test(line))
    dependents.add(current);
}
for (const dependent of dependents) {
  if (!ALLOWED_DEPENDENTS.some((prefix) => dependent.startsWith(prefix)))
    problems.push(
      `${dependent.split('(')[0]} depends on zod ${ALLOWED_OLD}, outside the approved exception`,
    );
}

if (problems.length > 0) {
  console.error('The GHSA-mrhx-c7xc-m3w5 exception no longer holds:');
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}
console.log(
  `GHSA-mrhx-c7xc-m3w5 exception holds: zod ${[...versions].sort().join(', ')}; ` +
    `${ALLOWED_OLD} only through ${[...dependents].map((d) => d.split('(')[0]).join(', ') || 'nothing'}.`,
);
