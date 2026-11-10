#!/usr/bin/env node
// Fails unless the tests whose names contain TITLE ran and passed (M11): some suites skip when
// their service is not reachable (the real ClamAV ones, for example), and CI must not let a skip
// pass for a run. Reads Vitest's or Jest's JSON reports. Node built-ins only.
//
//   node scripts/ci-assert-ran.mjs --title "the real ClamAV" --min 3 REPORT.json...
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: args, positionals: reports } = parseArgs({
  allowPositionals: true,
  options: { title: { type: 'string' }, min: { type: 'string', default: '1' } },
});
if (!args.title || reports.length === 0) {
  console.error('usage: ci-assert-ran.mjs --title TEXT [--min N] REPORT.json...');
  process.exit(2);
}

const found = [];
for (const file of reports) {
  if (!existsSync(file)) {
    console.error(`No report at ${file}`);
    continue;
  }
  const report = JSON.parse(readFileSync(file, 'utf8'));
  for (const suite of report.testResults ?? [])
    for (const a of suite.assertionResults ?? []) {
      const name = [...(a.ancestorTitles ?? []), a.title].join(' > ');
      if (name.includes(args.title)) found.push({ name, status: a.status });
    }
}
for (const t of found) console.log(`${t.status.padEnd(8)} ${t.name}`);
const passed = found.filter((t) => t.status === 'passed').length;
const notPassed = found.filter((t) => t.status !== 'passed');
if (found.length < Number(args.min) || notPassed.length > 0 || passed < Number(args.min)) {
  console.error(
    `Expected at least ${args.min} passing test(s) named "${args.title}": ${passed} passed, ${notPassed.length} skipped or failed, ${found.length} found.`,
  );
  process.exit(1);
}
console.log(`${passed} test(s) named "${args.title}" ran and passed.`);
