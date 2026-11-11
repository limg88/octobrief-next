-- Idempotent role and extension setup.
-- Usage: psql -v app_password=... -v worker_password=... -f db-setup-roles.sql
-- Run as the owner. Two login roles without privileges of their own: octobrief_app (web) and
-- octobrief_worker (worker). Migrations grant each one what it needs.
\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'octobrief_app') AS create_app_role \gset
\if :create_app_role
  CREATE ROLE octobrief_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD :'app_password';
\else
  ALTER ROLE octobrief_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD :'app_password';
\endif

SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'octobrief_worker') AS create_worker_role \gset
\if :create_worker_role
  CREATE ROLE octobrief_worker LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD :'worker_password';
\else
  ALTER ROLE octobrief_worker LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD :'worker_password';
\endif

SELECT format('GRANT CONNECT ON DATABASE %I TO octobrief_app, octobrief_worker', current_database()) \gexec
SELECT format('REVOKE TEMP ON DATABASE %I FROM PUBLIC', current_database()) \gexec
GRANT USAGE ON SCHEMA public TO octobrief_app, octobrief_worker;

-- English server messages whatever the cluster locale: errors are mapped by SQLSTATE.
ALTER ROLE octobrief_app SET lc_messages = 'C';
ALTER ROLE octobrief_worker SET lc_messages = 'C';
