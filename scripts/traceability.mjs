#!/usr/bin/env node
// The traceability table (M11 plan 4.10; CLAUDE.md section 2: tests are named after the
// requirement they prove). Reads the JSON test reports CI keeps as artifacts, maps every MVP
// requirement ID in docs/requirements/mvp.json and every NFR tag to the test files that name it,
// with passed, failed and skipped counts, writes a markdown table, and exits 1 when an MVP ID has
// no passing test.
//
//   node scripts/traceability.mjs [--reports DIR]... [--out FILE] [--json FILE]
//                                 [--requirements FILE] [--root DIR] [--warn-only]
//
// Reports: Vitest's JSON reporter (one file per package), Jest's --json (apps/tenant) and
// Playwright's JSON reporter (web, links and tenant end to end). Each kind is recognised by its
// shape, so the files can sit anywhere under the report directories. Node built-ins only, so the
// CI job needs no install.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    reports: { type: 'string', multiple: true, default: ['reports'] },
    out: { type: 'string', default: 'traceability.md' },
    json: { type: 'string' },
    requirements: { type: 'string', default: 'docs/requirements/mvp.json' },
    root: { type: 'string', default: process.cwd() },
    'warn-only': { type: 'boolean', default: false },
  },
});

const root = path.resolve(args.root);
/** Requirement IDs (PR-01) and NFR tags (NFR-SEC) as they appear in test names. */
const ID_PATTERN = /\b(?:NFR-[A-Z0-9]+|[A-Z]{2}-\d{2})\b/g;

/** A path relative to the repository, whichever machine wrote the report. */
function repoPath(file) {
  const normalised = file.split(path.sep).join('/');
  const rootPrefix = `${root.split(path.sep).join('/')}/`;
  if (normalised.startsWith(rootPrefix)) return normalised.slice(rootPrefix.length);
  // A report from another checkout (CI's runner): from the workspace folder on.
  const match = /(?:^|\/)((?:apps|packages)\/[^/]+\/.+)$/.exec(normalised);
  return match ? match[1] : normalised;
}

function* jsonFiles(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* jsonFiles(full);
    else if (entry.endsWith('.json')) yield full;
  }
}

/** Vitest and Jest share a shape: testResults[] of files, each with assertionResults[]. */
function fromJestShape(report, kind) {
  const out = [];
  for (const file of report.testResults ?? []) {
    const name = repoPath(file.name ?? file.testFilePath ?? 'unknown');
    for (const a of file.assertionResults ?? []) {
      out.push({
        kind,
        file: name,
        title: [...(a.ancestorTitles ?? []), a.title].join(' > '),
        status: normaliseStatus(a.status),
      });
    }
    // A file that failed to load has no assertions; it still counts as one failure.
    if ((file.assertionResults ?? []).length === 0 && file.status === 'failed')
      out.push({
        kind,
        file: name,
        title: file.message ?? '(file failed to run)',
        status: 'failed',
      });
  }
  return out;
}

function fromPlaywright(report) {
  const out = [];
  const rootDir = report.config?.rootDir ?? '';
  const walk = (suite, titles) => {
    const here =
      suite.title && !suite.file?.endsWith(suite.title) ? [...titles, suite.title] : titles;
    for (const spec of suite.specs ?? []) {
      const file = repoPath(path.join(rootDir, spec.file ?? suite.file ?? ''));
      for (const test of spec.tests ?? [])
        out.push({
          kind: 'playwright',
          file,
          title: [...here, spec.title].join(' > '),
          status: playwrightStatus(test),
        });
    }
    for (const child of suite.suites ?? []) walk(child, here);
  };
  for (const suite of report.suites ?? []) walk(suite, []);
  return out;
}

function playwrightStatus(test) {
  // `expected` passed; `flaky` passed on a retry; `unexpected` failed; `skipped` did not run.
  if (test.status === 'expected' || test.status === 'flaky') return 'passed';
  if (test.status === 'skipped') return 'skipped';
  return 'failed';
}

function normaliseStatus(status) {
  if (status === 'passed') return 'passed';
  if (status === 'failed') return 'failed';
  // pending, skipped, todo, disabled
  return 'skipped';
}

function readReport(file) {
  let report;
  try {
    report = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { kind: 'unreadable', tests: [] };
  }
  if (Array.isArray(report?.suites) && report?.config)
    return { kind: 'playwright', tests: fromPlaywright(report) };
  if (Array.isArray(report?.testResults)) {
    // Vitest's reporter is Jest-compatible; its files carry absolute paths under apps/tenant only
    // when Jest wrote them.
    const tenant = report.testResults.some((r) => /\/apps\/tenant\//.test(r.name ?? ''));
    const kind = tenant ? 'jest' : 'vitest';
    return { kind, tests: fromJestShape(report, kind) };
  }
  return { kind: 'unknown', tests: [] };
}

// --- Collect ------------------------------------------------------------------------------------

const requirements = JSON.parse(readFileSync(path.resolve(root, args.requirements), 'utf8'));
const reports = [];
for (const dir of args.reports)
  for (const file of jsonFiles(path.resolve(dir))) reports.push({ file, ...readReport(file) });

const tests = reports.flatMap((r) => r.tests);
/** id -> { files: Map<file, {passed, failed, skipped}>, passed, failed, skipped } */
const byId = new Map();
for (const test of tests) {
  const ids = new Set(test.title.match(ID_PATTERN) ?? []);
  for (const id of ids) {
    const entry = byId.get(id) ?? { files: new Map(), passed: 0, failed: 0, skipped: 0 };
    const counts = entry.files.get(test.file) ?? { passed: 0, failed: 0, skipped: 0 };
    counts[test.status] += 1;
    entry[test.status] += 1;
    entry.files.set(test.file, counts);
    byId.set(id, entry);
  }
}

const empty = { files: new Map(), passed: 0, failed: 0, skipped: 0 };
const mvpRows = requirements.mvp.map((r) => ({ ...r, ...(byId.get(r.id) ?? empty) }));
// NFR tags may also name evidence that is not a test report: a script and the CI job or workflow
// that runs it, or a document people work through (mvp.json `evidence`). Each file must exist.
// Evidence never counts for an MVP requirement: those are read without it.
const nfrRows = requirements.nfr.map((r) => ({
  ...r,
  id: r.tag,
  ...(byId.get(r.tag) ?? empty),
  evidence: (r.evidence ?? []).map((e) => ({
    ...e,
    exists: existsSync(path.resolve(root, e.file)),
  })),
}));
const uncovered = mvpRows.filter((r) => r.passed === 0);
const evidenced = (r) => r.evidence.length > 0 && r.evidence.every((e) => e.exists);

// --- Write --------------------------------------------------------------------------------------

const cell = (text) => String(text).replaceAll('|', '\\|').replaceAll('\n', ' ');
const fileList = (files) =>
  [...files.keys()]
    .sort()
    .map((f) => `\`${f}\``)
    .join('<br>') || '—';
const status = (r) =>
  r.passed > 0
    ? r.failed > 0
      ? 'passing, with failures'
      : 'passing'
    : r.failed > 0
      ? '**failing**'
      : '**no test**';

/** An NFR tag: its tests first; with none passing, its evidence. */
const nfrStatus = (r) =>
  r.passed > 0 || r.failed > 0
    ? status(r)
    : evidenced(r)
      ? 'covered by evidence'
      : r.evidence.length > 0
        ? '**evidence missing**'
        : '**no test**';
const evidenceList = (r) =>
  r.evidence.map(
    (e) => `evidence: \`${e.file}\`${e.exists ? '' : ' (**missing**)'}, ${cell(e.runBy)}`,
  );
const nfrFiles = (r) =>
  [...(r.files.size > 0 ? [fileList(r.files)] : []), ...evidenceList(r)].join('<br>') || '—';
const nfrByStatus = nfrRows.reduce(
  (acc, r) => ({ ...acc, [nfrStatus(r)]: (acc[nfrStatus(r)] ?? 0) + 1 }),
  {},
);

const kinds = reports.reduce((acc, r) => ({ ...acc, [r.kind]: (acc[r.kind] ?? 0) + 1 }), {});
const commit = process.env.GITHUB_SHA ? ` at commit \`${process.env.GITHUB_SHA.slice(0, 7)}\`` : '';
const lines = [
  '# Traceability',
  '',
  `- **Generated:** ${new Date().toISOString()}${commit}, by \`scripts/traceability.mjs\` from CI's test reports.`,
  `- **Reports read:** ${reports.length} (${
    Object.entries(kinds)
      .map(([k, n]) => `${k} ${n}`)
      .join(', ') || 'none'
  }), holding ${tests.length} test results.`,
  `- **Requirements:** \`${args.requirements}\`. A test proves a requirement when its name (describe blocks and title) carries the ID (CLAUDE.md section 2).`,
  `- **MVP coverage:** ${mvpRows.length - uncovered.length} of ${mvpRows.length} MVP requirements have at least one passing test. Evidence other than tests never counts for them.`,
  `- **NFR coverage:** ${nfrRows.length} tags: ${Object.entries(nfrByStatus)
    .map(([k, n]) => `${n} ${k.replaceAll('*', '')}`)
    .join(
      ', ',
    )}. A tag with no passing test is covered by evidence when every evidence file it names exists (\`evidence\` in the requirements file).`,
  '',
  '## MVP requirements',
  '',
  '| ID | Title | Test files | Passed | Failed | Skipped | Status |',
  '| --- | --- | --- | ---: | ---: | ---: | --- |',
  ...mvpRows.map(
    (r) =>
      `| ${r.id} | ${cell(r.title)} | ${fileList(r.files)} | ${r.passed} | ${r.failed} | ${r.skipped} | ${status(r)} |`,
  ),
  '',
  '## Non-functional requirements (by tag)',
  '',
  '| Tag | Requirement | Test files and evidence | Passed | Failed | Skipped | Status |',
  '| --- | --- | --- | ---: | ---: | ---: | --- |',
  ...nfrRows.map(
    (r) =>
      `| ${r.id} | ${cell(`${r.area}: ${r.requirement}`)} | ${nfrFiles(r)} | ${r.passed} | ${r.failed} | ${r.skipped} | ${nfrStatus(r)} |`,
  ),
  '',
  '## MVP requirements without a passing test',
  '',
  ...(uncovered.length === 0 ? ['None.'] : uncovered.map((r) => `- ${r.id}: ${r.title}`)),
  '',
];
writeFileSync(path.resolve(args.out), lines.join('\n'));
if (args.json)
  writeFileSync(
    path.resolve(args.json),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        reports: reports.map((r) => ({
          file: repoPath(r.file),
          kind: r.kind,
          tests: r.tests.length,
        })),
        mvp: mvpRows.map((r) => ({
          id: r.id,
          passed: r.passed,
          failed: r.failed,
          skipped: r.skipped,
          files: [...r.files.keys()].sort(),
        })),
        nfr: nfrRows.map((r) => ({
          tag: r.id,
          status: nfrStatus(r).replaceAll('*', ''),
          passed: r.passed,
          failed: r.failed,
          skipped: r.skipped,
          files: [...r.files.keys()].sort(),
          evidence: r.evidence.map((e) => ({ file: e.file, runBy: e.runBy, exists: e.exists })),
        })),
        uncovered: uncovered.map((r) => r.id),
      },
      null,
      2,
    )}\n`,
  );

console.log(
  `traceability: ${reports.length} reports, ${tests.length} tests; ${mvpRows.length - uncovered.length}/${mvpRows.length} MVP IDs passing; table in ${args.out}`,
);
for (const r of nfrRows)
  if (r.passed === 0 && r.failed === 0 && r.evidence.length > 0)
    console.log(
      `${r.id}: ${nfrStatus(r).replaceAll('*', '')}; ${evidenceList(r)
        .map((e) => e.replaceAll('`', '').replaceAll('**', ''))
        .join('; ')}`,
    );
if (uncovered.length > 0) {
  console.error(
    `MVP IDs with no passing test (${uncovered.length}): ${uncovered.map((r) => r.id).join(', ')}`,
  );
  if (!args['warn-only']) process.exit(1);
}
