-- Cluster bootstrap: roles and the application database. Idempotent.
-- Run as a superuser: by the Compose init, by CI, and before the first migration elsewhere.
-- Passwords here are for local development only; deployed environments set them from the
-- secrets manager (CLAUDE.md section 10).

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rent_owner') THEN
    CREATE ROLE rent_owner LOGIN PASSWORD 'rent_owner_dev' NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rent_app') THEN
    CREATE ROLE rent_app LOGIN PASSWORD 'rent_app_dev' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  -- Owns the narrow SECURITY DEFINER system functions of ADR-002 (membership lookup at sign-in,
  -- scheduler company list, company onboarding, outbox claim). It cannot log in, and the
  -- application role never becomes it; only those functions run with its rights.
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rent_system') THEN
    CREATE ROLE rent_system NOLOGIN BYPASSRLS;
  END IF;
  -- Holds INSERT on journal tables from M4a (ADR-003). The application switches to it with
  -- SET LOCAL ROLE inside the posting transaction only.
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ledger_writer') THEN
    CREATE ROLE ledger_writer NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

-- rent_app may become ledger_writer (SET ROLE) but does not inherit its privileges, so outside
-- the posting service it cannot write the journal (ADR-003; M4a). Re-running this updates the
-- options of an existing grant.
GRANT ledger_writer TO rent_app WITH INHERIT FALSE, SET TRUE;
-- Lets migrations hand function ownership to rent_system.
GRANT rent_system TO rent_owner;

SELECT 'CREATE DATABASE rent OWNER rent_owner'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'rent') \gexec

REVOKE ALL ON DATABASE rent FROM PUBLIC;
-- M11 review R2 F4: no TEMPORARY, so no temporary table can shadow one a database check reads.
GRANT CONNECT ON DATABASE rent TO rent_app;
REVOKE TEMPORARY ON DATABASE rent FROM rent_app;
