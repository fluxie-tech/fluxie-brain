#!/bin/sh
# Runs once on first container start, as the postgres superuser.
# Creates the schema-owner role, the DML-only app role, and both databases.
set -eu

psql -v ON_ERROR_STOP=1 -U postgres \
  -v migrator_pw="$FLUXIE_MIGRATOR_PASSWORD" -v app_pw="$FLUXIE_APP_PASSWORD" <<'SQL'
create role fluxie_migrator login password :'migrator_pw';
create role fluxie_app login password :'app_pw';
SQL

for db in fluxie_brain fluxie_brain_test; do
  psql -v ON_ERROR_STOP=1 -U postgres -v db="$db" <<'SQL'
create database :"db" owner fluxie_migrator;
revoke all on database :"db" from public;
grant connect on database :"db" to fluxie_app;
SQL
  psql -v ON_ERROR_STOP=1 -U postgres -d "$db" <<'SQL'
-- pgvector is not a trusted extension, so the superuser installs it here.
create extension if not exists vector;
revoke all on schema public from public;
grant usage on schema public to fluxie_app;
alter default privileges for role fluxie_migrator in schema public
  grant select, insert, update, delete on tables to fluxie_app;
alter default privileges for role fluxie_migrator in schema public
  grant usage, select on sequences to fluxie_app;
SQL
done
