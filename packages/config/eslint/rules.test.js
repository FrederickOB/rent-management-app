import path from 'node:path';
import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';
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
