/**
 * Founder decision D4 (M11): the CLI beside the console's recovery buttons, for an incident or when
 * the console is unreachable. Run it only after the identity check in
 * docs/runbooks/lost-authenticator.md.
 *
 *   pnpm identity:recover reset-two-factor --operator you@platform.example \
 *     --reason "Lost phone; identity checked by video call against ID, ticket 812"
 *   pnpm identity:recover revoke-sessions --person 0193... --operator ... --reason "..."
 *
 * - The operator (`--operator`, their own email) must be an active platform admin, as for the
 *   incident commands, and proves it with their current authenticator code (RECOVER_OPERATOR_CODE
 *   or a prompt; accepted once). They act as that platform admin would in the console. The OS user
 *   and host it ran on are recorded with the event (M11 review B4).
 * - The person is named by id (`--person`) or by email. The email is read from RECOVER_EMAIL or
 *   asked for at a prompt, never taken from the command line, so it stays out of shell history.
 *   `--email` still works for scripts, with a warning.
 * - A database named `rent` is refused unless --allow-rent-database is given (an incident on that
 *   database itself), as the ops commands refuse it.
 * - The reason and the operator are recorded in the platform's audit chain. Nothing personal is
 *   printed: ids and counts only.
 */
import { hostname, userInfo } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { createDatabase, eq, schema, withSystem } from '@rent/db';
import { InMemoryStorage } from '@rent/integrations';
import { AuditService } from '../src/audit/audit.service';
import { systemClock } from '../src/core/clock';
import { loadConfig } from '../src/core/config';
import { AccountRecoveryService } from '../src/identity/account-recovery';
import { StepUpVerifier } from '../src/identity/step-up';
import { ALLOW_RENT_FLAG, refusalFor } from '../src/ops/cli-guard';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    person: { type: 'string' },
    email: { type: 'string' },
    reason: { type: 'string' },
    operator: { type: 'string' },
    [ALLOW_RENT_FLAG]: { type: 'boolean', default: false },
  },
});

const fail = (message: string): never => {
  console.error(message);
  process.exit(2);
};

// The guard comes before anything reads the configuration or connects.
const refusal = refusalFor(process.env.DATABASE_URL, values[ALLOW_RENT_FLAG] === true);
if (refusal) fail(`identity:recover refused: ${refusal}`);

const command = positionals[0];
if (command !== 'reset-two-factor' && command !== 'revoke-sessions')
  fail(
    'Usage: identity:recover reset-two-factor|revoke-sessions [--person <id>] --reason "..." --operator <your platform admin email>',
  );
if (!values.reason?.trim()) fail('--reason is required: the reason and the identity check made.');
if (!values.operator?.trim()) fail('--operator is required: your platform admin email.');

async function ask(question: string): Promise<string> {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await prompt.question(question);
  } finally {
    prompt.close();
  }
}

/** The person's email, from the environment or a prompt; `--email` only with a warning. */
async function targetEmail(): Promise<string> {
  if (values.email) {
    console.warn(
      'Warning: --email puts the address in your shell history. Use RECOVER_EMAIL or the prompt.',
    );
    return values.email;
  }
  if (process.env.RECOVER_EMAIL) return process.env.RECOVER_EMAIL;
  return ask('Email of the person to recover: ');
}

const config = loadConfig();
const database = createDatabase(config.DATABASE_URL, {
  max: 2,
  applicationName: 'rent-identity-recover',
});
try {
  let personId = values.person ?? null;
  if (!personId) {
    const address = (await targetEmail()).trim().toLowerCase();
    const [row] = await withSystem(database, {}, (tx) =>
      tx
        .select({ id: schema.person.id })
        .from(schema.person)
        .where(eq(schema.person.email, address)),
    );
    personId = row?.id ?? null;
  }
  if (!personId) fail('No person with that id or email.');
  // The audit append writes no files; anchoring (which uses storage) is the nightly job's.
  const audit = new AuditService(database, new InMemoryStorage(), systemClock);
  const recovery = new AccountRecoveryService(
    database,
    audit,
    systemClock,
    new StepUpVerifier(database, config, audit, undefined, systemClock),
  );
  const operatorCode =
    process.env.RECOVER_OPERATOR_CODE ?? (await ask('Your current authenticator code: '));
  const by = {
    kind: 'cli' as const,
    operatorEmail: values.operator!,
    operatorCode,
    origin: { osUser: userInfo().username, host: hostname() },
  };
  const result =
    command === 'reset-two-factor'
      ? await recovery.resetTwoFactor(by, personId!, values.reason!)
      : await recovery.revokeAllSessions(by, personId!, values.reason!);
  console.log(
    `Done for person ${result.personId}: ${result.sessionsRevoked} session(s) ended${
      result.twoFactorReset ? ', two-factor removed (they enrol again at next sign-in)' : ''
    }.`,
  );
} catch (error) {
  const code = (error as { code?: string }).code;
  fail(
    code === 'not_a_platform_admin'
      ? 'Refused: --operator must be an active platform admin.'
      : code === 'operator_code'
        ? 'Refused: that is not a current code from your authenticator app.'
        : `Failed: ${(error as Error).message}`,
  );
} finally {
  await database.close();
}
