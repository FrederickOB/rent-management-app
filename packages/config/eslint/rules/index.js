import ledgerWrites from './ledger-writes.js';
import moduleLayers from './module-layers.js';
import noRoleChecks from './no-role-checks.js';

export const rentPlugin = {
  meta: { name: 'eslint-plugin-rent' },
  rules: {
    'no-role-checks': noRoleChecks,
    'module-layers': moduleLayers,
    'ledger-writes': ledgerWrites,
  },
};
