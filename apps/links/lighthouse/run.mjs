// Lighthouse CI for the M11 page budgets (decision 8): `pnpm test:lighthouse` from the
// repository root, against a running stack (CI's e2e job starts one; locally, the e2e stack).
//
//   1. Collect: Playwright runs the *.lh.ts files here, which sign in where needed and run
//      Lighthouse on each page over 3G with a 4x slower CPU (three-g.ts, collect.ts).
//   2. Assert: `lhci assert` checks each group against its budgets (*.lighthouserc.json).
//   3. Report: `lhci upload --target=filesystem` writes the HTML reports, and a summary table goes
//      to .results/summary.md.
//
// It fails when collection fails or any error-level budget is missed.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const here = import.meta.dirname;
const app = path.resolve(here, '..');
const results = path.join(here, '.results');
const bin = (name) => path.join(app, 'node_modules', '.bin', name);
const GROUPS = ['links', 'tenant-first', 'tenant-repeat'];

rmSync(results, { recursive: true, force: true });
let failed = false;

const collect = spawnSync(bin('playwright'), ['test', '-c', 'lighthouse/playwright.config.ts'], {
  cwd: app,
  stdio: 'inherit',
});
if (collect.status !== 0) {
  console.error('Lighthouse collection failed.');
  failed = true;
}

for (const group of GROUPS) {
  const dir = path.join(results, group);
  if (!existsSync(path.join(dir, '.lighthouseci'))) {
    console.error(`No Lighthouse results for ${group}.`);
    failed = true;
    continue;
  }
  console.log(`\nBudgets: ${group}`);
  const assert = spawnSync(
    bin('lhci'),
    ['assert', `--config=${path.join(here, `${group}.lighthouserc.json`)}`],
    { cwd: dir, stdio: 'inherit' },
  );
  if (assert.status !== 0) failed = true;
  spawnSync(
    bin('lhci'),
    ['upload', '--target=filesystem', `--outputDir=${path.join(dir, 'report')}`],
    {
      cwd: dir,
      stdio: 'inherit',
    },
  );
}

/** Figures for the table (not money): a number with a fixed count of decimals. */
const decimals = (digits) =>
  new Intl.NumberFormat('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits });

// The summary: one row a page, as measured.
const file = path.join(results, 'measured.jsonl');
if (existsSync(file)) {
  const rows = readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const table = [
    '| Group | Page | Transferred | LCP | CLS | TBT |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
    ...rows.map(
      (r) =>
        `| ${r.group} | ${r.name} | ${decimals(0).format(r.bytes / 1000)} kB | ${decimals(2).format(r.lcpMs / 1000)} s | ${decimals(3).format(r.cls)} | ${decimals(0).format(r.tbtMs)} ms |`,
    ),
  ].join('\n');
  writeFileSync(path.join(results, 'summary.md'), `${table}\n`);
  console.log(`\n${table}\n`);
}
const reports = GROUPS.map((group) => path.join(results, group, 'report')).filter(existsSync);
for (const dir of reports) console.log(`Reports: ${dir} (${readdirSync(dir).length} files)`);
process.exit(failed ? 1 : 0);
