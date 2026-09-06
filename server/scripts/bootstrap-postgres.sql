-- ============================================================================
-- SageStack — local Postgres bootstrap  (ARCHITECTURE_PLAN.md Phase 1)
--
-- IDEMPOTENT. Safe to run against a fresh instance, or against a half-created
-- database, or repeatedly. Run as a SUPERUSER — every step below needs it.
--
--   & "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -p 5433 -f server\scripts\bootstrap-postgres.sql
--
-- You will be prompted for the postgres superuser password.
--
-- Verified on this machine (2026-09-06): PostgreSQL 18.4 on port 5433, pgvector
-- 0.8.6 available. If pgvector is NOT available for your instance, install it
-- first — ask_cooter's scripts/install-pgvector.ps1 copies a locally-built
-- vector.dll into the PostgreSQL tree (pgvector ships no Windows binaries).
--
-- Afterwards, put this in server/.env :
--
--   KB_STORE=postgres
--   DATABASE_URL=postgresql://sage:sage@localhost:5433/sagestack
--
-- CHANGE THE PASSWORD BELOW and in .env together if you want something other
-- than 'sage'. This is a local, single-operator dev database.
-- ============================================================================

\set ON_ERROR_STOP on

-- --- Role -------------------------------------------------------------------
-- Created if absent. The password is set unconditionally so it is always known
-- and always matches DATABASE_URL — this deliberately overwrites whatever was
-- set before. Edit both places if you want a different one.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sage') THEN
    CREATE ROLE sage LOGIN PASSWORD 'sage';
    RAISE NOTICE 'created role sage';
  ELSE
    RAISE NOTICE 'role sage already exists — resetting its password';
  END IF;
END $$;

ALTER ROLE sage WITH LOGIN PASSWORD 'sage';

-- --- Database ---------------------------------------------------------------
-- CREATE DATABASE cannot run inside a DO block (no transaction), so generate
-- the statement and let psql execute it via \gexec only when it is needed.
SELECT 'CREATE DATABASE sagestack OWNER sage'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'sagestack')
\gexec

-- Ownership is deliberately NOT transferred. postgres can stay the owner —
-- sage only needs privileges, not ownership, and a non-owning app role cannot
-- DROP the database. Schemas sage creates are owned by sage, so dropSubject's
-- DROP SCHEMA ... CASCADE still works.

-- --- Inside the database ----------------------------------------------------
\connect sagestack

-- Extensions are enabled PER DATABASE, not per instance. pgvector being
-- available on this server (and enabled in other databases) does not enable it
-- here — a fresh database always starts without it.
CREATE EXTENSION IF NOT EXISTS vector;

-- The two grants the store driver actually needs:
--   CREATE on the database -> create one schema per subject
--   CREATE on public       -> create sagestack_subjects / sagestack_sessions
-- The second is required because PostgreSQL 15 revoked the historic default
-- that let any role create objects in public. On PG15+ this is not optional.
GRANT CREATE, CONNECT ON DATABASE sagestack TO sage;
GRANT USAGE, CREATE ON SCHEMA public TO sage;

-- --- Verify -----------------------------------------------------------------
SELECT current_database()                                   AS database,
       pg_get_userbyid(datdba)                              AS owner,
       (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS pgvector
FROM pg_database WHERE datname = current_database();
