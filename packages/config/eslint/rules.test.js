import path from 'node:path';
import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';
import ledgerWrites from './rules/ledger-writes.js';
import moduleLayers from './rules/module-layers.js';
import noRoleChecks from './rules/no-role-checks.js';

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({ languageOptions: { ecmaVersion: 2024, sourceType: 'module' } });

describe('AD-03 no role checks outside policy', () => {
  tester.run('no-role-checks', noRoleChecks, {
    valid: [
      { code: "if (policy.can(actor, 'company.update')) {}" },
      { code: "const membership = { role: 'caretaker' };" },
      { code: "if (status === 'active') {}" },
    ],
    invalid: [
      { code: "if (actor.role === 'agency_admin') {}", errors: [{ messageId: 'roleCheck' }] },
      { code: "if ('owner' !== m.role) {}", errors: [{ messageId: 'roleCheck' }] },
      { code: 'switch (actor.role) { default: }', errors: [{ messageId: 'roleCheck' }] },
      { code: "if (actor.roles.includes('accountant')) {}", errors: [{ messageId: 'roleCheck' }] },
      {
        code: "if (['owner', 'adviser'].includes(actor.role)) {}",
        errors: [{ messageId: 'roleCheck' }],
      },
      { code: "if (actor?.role == 'caretaker') {}", errors: [{ messageId: 'roleCheck' }] },
    ],
  });
});

describe('PLATFORM module layers', () => {
  const root = '/repo/packages/server/src';
  const options = [
    {
      root,
      allowed: {
        audit: [],
        policy: ['identity'],
        identity: ['audit'],
        approvals: ['policy', 'audit'],
      },
    },
  ];
  tester.run('module-layers', moduleLayers, {
    valid: [
      {
        code: "import { x } from '../audit/audit.service';",
        filename: path.join(root, 'identity/identity.service.ts'),
        options,
      },
      {
        code: "import { x } from '../core/db';",
        filename: path.join(root, 'audit/audit.service.ts'),
        options,
      },
      {
        code: "import { x } from './local';",
        filename: path.join(root, 'audit/audit.service.ts'),
        options,
      },
    ],
    invalid: [
      {
        code: "import { x } from '../approvals/approvals.service';",
        filename: path.join(root, 'audit/audit.service.ts'),
        options,
        errors: [{ messageId: 'forbidden' }],
      },
      {
        code: "import { x } from '../ledger/ledger.service';",
        filename: path.join(root, 'policy/policy.service.ts'),
        options,
        errors: [{ messageId: 'unknown' }],
      },
    ],
  });
});

describe('AC-01 only the posting service writes the journal', () => {
  tester.run('ledger-writes', ledgerWrites, {
    valid: [
      { code: 'await tx.insert(schema.allocation).values(rows);' },
      { code: 'await tx.select().from(schema.journalLine);' },
      { code: "const q = 'select * from journal_line where lease_id = $1';" },
      { code: 'const q = `select sum(amount_minor) from journal_entry`;' },
    ],
    invalid: [
      {
        code: 'await tx.insert(schema.journalLine).values(lines);',
        errors: [{ messageId: 'ledgerWrite' }],
      },
      {
        code: 'await db.insert(journalEntry).values(entry);',
        errors: [{ messageId: 'ledgerWrite' }],
      },
      {
        code: "await client.query('INSERT INTO journal_line (id) VALUES ($1)', [id]);",
        errors: [{ messageId: 'ledgerWrite' }],
      },
      {
        code: 'await tx.execute(sql`insert into "public"."journal_entry" (id) values (${id})`);',
        errors: [{ messageId: 'ledgerWrite' }],
      },
    ],
  });
});
