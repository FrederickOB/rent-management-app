import path from 'node:path';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { rentPlugin } from './rules/index.js';

/**
 * Module map for packages/server (docs/architecture.md section 2). Each module lists the
 * modules it may import besides `core`. Later milestones add their modules here.
 */
export const MODULE_MAP = {
  audit: [],
  rules: [],
  identity: ['audit'],
  documents: ['audit', 'rules'],
  policy: ['identity'],
  approvals: ['policy', 'audit', 'identity'],
  companies: ['policy', 'audit', 'documents', 'identity', 'rules'],
  portfolio: ['companies', 'documents', 'rules', 'audit', 'policy'],
  // M3 (plan 4.1): e-signing in layer 2, tenancy in layer 4, the messaging core in layer 7.
  esign: ['documents', 'audit'],
  tenancy: [
    'portfolio',
    'esign',
    'approvals',
    'rules',
    'companies',
    'policy',
    'documents',
    'audit',
    'identity',
  ],
  messaging: ['tenancy', 'esign', 'companies', 'identity', 'audit', 'policy'],
  // M4a (plan 4.1): the ledger in layer 1 (it audits each entry), billing in layer 5.
  ledger: ['audit'],
  billing: [
    'tenancy',
    'ledger',
    'approvals',
    'rules',
    'documents',
    'policy',
    'audit',
    'companies',
    'portfolio',
    'identity',
  ],
  // M4b (plan 4.1): provider payments in layer 6, above billing; it sends through messaging.
  payments: [
    'billing',
    'tenancy',
    'ledger',
    'approvals',
    'messaging',
    'esign',
    'documents',
    'rules',
    'policy',
    'audit',
    'companies',
    'portfolio',
    'identity',
  ],
  // M5 (plan section 5): tax in layer 6, above billing; it registers its hooks with billing's
  // engine, and queues its messages through core.
  tax: [
    'billing',
    'tenancy',
    'ledger',
    'approvals',
    'documents',
    'rules',
    'policy',
    'audit',
    'companies',
    'portfolio',
    'identity',
  ],
};

const DB_DRIVERS = [
  'pg',
  'pg-pool',
  'postgres',
  'drizzle-orm/node-postgres',
  'drizzle-orm/postgres-js',
];
const PROVIDER_SDKS = [
  '@aws-sdk/*',
  'nodemailer',
  'expo-server-sdk',
  'twilio',
  '@paystack/*',
  'flutterwave*',
  'smile-identity-core',
  '@smile_id/*',
];
const DOMAIN_FORBIDDEN = [
  'node:*',
  'fs',
  'path',
  'http',
  'https',
  'net',
  'crypto',
  'child_process',
  'pg',
  'pg-boss',
  'drizzle-orm',
  'drizzle-orm/*',
  '@nestjs/*',
  'better-auth',
  'better-auth/*',
  '@rent/db',
  '@rent/db/*',
  '@rent/server',
  '@rent/server/*',
  '@rent/integrations',
  '@rent/integrations/*',
];

const noFloatMoney = {
  'no-restricted-globals': [
    'error',
    {
      name: 'parseFloat',
      message: 'Money is integer pesewas. Use packages/domain/money (CLAUDE.md section 4).',
    },
  ],
  'no-restricted-properties': [
    'error',
    {
      object: 'Number',
      property: 'parseFloat',
      message: 'Money is integer pesewas. Use packages/domain/money.',
    },
    {
      object: 'Math',
      property: 'round',
      message: 'Rounding happens only in packages/domain/money.',
    },
    { property: 'toFixed', message: 'Format money with packages/domain/money, never toFixed.' },
  ],
};

/** @param {{ repoRoot: string }} options */
export function createConfig({ repoRoot }) {
  return tseslint.config(
    {
      ignores: [
        '**/node_modules/**',
        '**/dist/**',
        '**/.next/**',
        '**/.expo/**',
        '**/web-build/**',
        '**/coverage/**',
        '**/.turbo/**',
        '**/next-env.d.ts',
        '**/playwright-report/**',
        '**/test-results/**',
        'packages/db/migrations/**',
        'apps/tenant/ios/**',
        'apps/tenant/android/**',
      ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
      languageOptions: {
        globals: { ...globals.node },
        parserOptions: { projectService: true, tsconfigRootDir: repoRoot },
      },
      plugins: { rent: rentPlugin },
      rules: {
        '@typescript-eslint/no-floating-promises': 'error',
        '@typescript-eslint/no-misused-promises': [
          'error',
          { checksVoidReturn: { attributes: false } },
        ],
        '@typescript-eslint/await-thenable': 'error',
        '@typescript-eslint/consistent-type-imports': [
          'error',
          { fixStyle: 'separate-type-imports' },
        ],
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
        ],
        'rent/no-role-checks': 'error',
        'rent/ledger-writes': 'error',
        'no-restricted-imports': [
          'error',
          {
            paths: DB_DRIVERS.map((name) => ({
              name,
              message: 'Use the company-scoped helpers in @rent/db (CLAUDE.md section 5).',
            })),
            patterns: [
              {
                group: PROVIDER_SDKS,
                message: 'Provider SDKs live only in packages/integrations (CLAUDE.md section 8).',
              },
            ],
          },
        ],
        ...noFloatMoney,
      },
    },
    {
      files: ['**/*.{js,mjs,cjs}'],
      ...tseslint.configs.disableTypeChecked,
    },
    {
      // CommonJS config files that Expo, Metro, Babel and Jest load with require().
      files: ['**/*.cjs', 'apps/tenant/*.js'],
      languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
      rules: { '@typescript-eslint/no-require-imports': 'off' },
    },
    {
      // Decorators make NestJS constructor parameters look unused to the linter.
      files: ['packages/server/**/*.ts', 'apps/api/**/*.ts', 'apps/worker/**/*.ts'],
      rules: { '@typescript-eslint/consistent-type-imports': 'off' },
    },
    {
      // The posting service is the one writer of the journal (ADR-003); the rule's own tests name it.
      files: ['packages/server/src/ledger/**/*.ts', 'packages/config/eslint/**/*.js'],
      rules: { 'rent/ledger-writes': 'off' },
    },
    {
      files: ['packages/server/src/**/*.ts'],
      rules: {
        'rent/module-layers': [
          'error',
          { root: path.join(repoRoot, 'packages/server/src'), allowed: MODULE_MAP },
        ],
      },
    },
    {
      // The database package and the core DB module own the driver.
      files: ['packages/db/**/*.ts', 'packages/server/src/core/db/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: PROVIDER_SDKS,
                message: 'Provider SDKs live only in packages/integrations.',
              },
            ],
          },
        ],
      },
    },
    {
      files: ['packages/integrations/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: DB_DRIVERS.map((name) => ({
              name,
              message: 'Adapters do not touch the database.',
            })),
          },
        ],
      },
    },
    {
      files: ['packages/domain/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: DOMAIN_FORBIDDEN,
                message:
                  'packages/domain is pure: no I/O and no infrastructure imports (CLAUDE.md section 3).',
              },
            ],
          },
        ],
      },
    },
    {
      files: ['packages/domain/src/money/**/*.ts'],
      rules: { 'no-restricted-globals': 'off', 'no-restricted-properties': 'off' },
    },
    {
      files: [
        'packages/domain/src/policy/**/*.ts',
        'packages/server/src/policy/**/*.ts',
        'packages/config/eslint/**/*.js',
      ],
      rules: { 'rent/no-role-checks': 'off' },
    },
    {
      files: ['**/*.tsx'],
      plugins: { 'react-hooks': reactHooks },
      languageOptions: { globals: { ...globals.browser } },
      rules: {
        'react-hooks/rules-of-hooks': 'error',
        'react-hooks/exhaustive-deps': 'error',
      },
    },
    prettier,
  );
}
