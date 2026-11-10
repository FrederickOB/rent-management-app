import { sql, withCompany, withSystem, type Database } from '@rent/db';
import type { AuditService } from '../audit/audit.service';
import type { PersonAccounts } from '../identity/person-accounts';
import { hasPassword, personForEmail } from './invitations';

export interface PlatformBootstrapInput {
  /** The platform's display and sender name. */
  readonly name: string;
  readonly legalName: string;
  /** The first platform admin's email; their name is the platform's until they change it. */
  readonly email: string;
  readonly adminName?: string;
  /**
   * Adds this person as another platform admin when one exists already (review BE-27: the
   * command's `--add-admin`). Without it, a run for a new person is refused once a platform admin
   * exists; a run for an existing platform admin stays idempotent.
   */
  readonly addAdmin?: boolean;
}

/** Refused: a platform admin exists already and the run did not ask to add another. */
export class PlatformAdminExistsError extends Error {
  override readonly name = 'PlatformAdminExistsError';
  constructor() {
    super(
      'A platform admin exists already. To add another, run the command again with --add-admin.',
    );
  }
}

export interface PlatformBootstrapResult {
  readonly platformCompanyId: string;
  readonly companyCreated: boolean;
  readonly personCreated: boolean;
  readonly membershipCreated: boolean;
  readonly invitationSent: boolean;
}

export interface PlatformBootstrapDeps {
  readonly accounts: Pick<PersonAccounts, 'create'>;
  readonly audit: Pick<AuditService, 'append'>;
  /** Sends the set-password invitation (invitationSender). */
  readonly invite: (email: string) => Promise<void>;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Makes a new deployment's platform (M10 decision 14; `pnpm platform:bootstrap`): the platform
 * company, unless one exists, which brings its platform book (app.create_company_book), and its
 * first platform admin, invited by email to set a password. Idempotent: a second run creates
 * nothing, and sends the invitation again only while the admin has not set a password. Once a
 * platform admin exists, a run for anyone else is refused (PlatformAdminExistsError) unless it
 * asks to add one (`addAdmin`). The demo seed can call it too. Throws a plain Error for bad input;
 * never logs the email.
 */
export async function bootstrapPlatform(
  database: Database,
  deps: PlatformBootstrapDeps,
  input: PlatformBootstrapInput,
): Promise<PlatformBootstrapResult> {
  const name = input.name.trim();
  const legalName = input.legalName.trim();
  const email = input.email.trim().toLowerCase();
  if (name.length < 2 || name.length > 200) throw new Error('The name is 2 to 200 characters');
  if (legalName.length < 2 || legalName.length > 200)
    throw new Error('The legal name is 2 to 200 characters');
  if (!EMAIL.test(email)) throw new Error('The email address is not valid');

  // One bootstrap at a time, so two runs never make two platform companies.
  const { id: platformCompanyId, created: companyCreated } = await withSystem(
    database,
    {},
    async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended('platform:bootstrap', 0))`,
      );
      const existing = await tx.execute<{ id: string | null }>(
        sql`select app.platform_company_id() as id`,
      );
      const found = existing.rows[0]?.id ?? null;
      if (found) return { id: found, created: false };
      const made = await tx.execute<{ id: string }>(
        sql`select app.create_company(null, 'platform', ${legalName}, ${name}, 'GH', 'Africa/Accra',
              ${name}, '{}'::jsonb) as id`,
      );
      return { id: made.rows[0]!.id, created: true };
    },
  );

  // Review BE-27: the command never quietly adds a second platform admin. A run for someone who
  // is a platform admin already stays idempotent.
  if (!input.addAdmin) {
    const admins = await withCompany(
      database,
      { companyId: platformCompanyId, actorKind: 'system' },
      (tx) =>
        tx.execute<{ others: number; same: number }>(
          sql`select count(*) filter (where lower(p.email) <> ${email})::int as others,
                count(*) filter (where lower(p.email) = ${email})::int as same
              from membership m join person p on p.id = m.person_id
              where m.company_id = ${platformCompanyId}::uuid and m.role = 'platform_admin'
                and m.status in ('invited', 'active')`,
        ),
    );
    const { others = 0, same = 0 } = admins.rows[0] ?? {};
    if (same === 0 && others > 0) throw new PlatformAdminExistsError();
  }

  const person = await personForEmail(database, deps.accounts, {
    name: input.adminName?.trim() || `${name} admin`,
    email,
  });

  const membershipCreated = await withCompany(
    database,
    { companyId: platformCompanyId, personId: person.personId, actorKind: 'system' },
    async (tx) => {
      const existing = await tx.execute<{ id: string }>(
        sql`select id from membership
            where company_id = ${platformCompanyId}::uuid and person_id = ${person.personId}::uuid
              and status in ('invited', 'active')`,
      );
      if (existing.rows.length > 0) return false;
      const inserted = await tx.execute<{ id: string }>(
        sql`insert into membership (company_id, person_id, role)
            values (${platformCompanyId}::uuid, ${person.personId}::uuid, 'platform_admin')
            returning id`,
      );
      const membershipId = inserted.rows[0]!.id;
      await deps.audit.append(tx, {
        companyId: platformCompanyId,
        action: 'membership.invited',
        recordType: 'membership',
        recordId: membershipId,
        data: { role: 'platform_admin', via: 'platform.bootstrap' },
      });
      if (companyCreated)
        await deps.audit.append(tx, {
          companyId: platformCompanyId,
          action: 'platform.bootstrapped',
          recordType: 'company',
          recordId: platformCompanyId,
          data: {},
        });
      return true;
    },
  );

  const invitationSent = !(await hasPassword(database, person.personId));
  if (invitationSent) await deps.invite(email);
  return {
    platformCompanyId,
    companyCreated,
    personCreated: person.created,
    membershipCreated,
    invitationSent,
  };
}
