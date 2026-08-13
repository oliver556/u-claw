#!/bin/sh
set -eu

: "${ACTIVATION_DATABASE_URL:?ACTIVATION_DATABASE_URL is required}"
: "${ACTIVATION_MIGRATION_ROLE:?ACTIVATION_MIGRATION_ROLE is required}"
: "${ACTIVATION_MIGRATION_PASSWORD:?ACTIVATION_MIGRATION_PASSWORD is required}"
: "${ACTIVATION_APP_ROLE:?ACTIVATION_APP_ROLE is required}"
: "${ACTIVATION_APP_PASSWORD:?ACTIVATION_APP_PASSWORD is required}"

for role_name in "$ACTIVATION_MIGRATION_ROLE" "$ACTIVATION_APP_ROLE"; do
    case "$role_name" in
        ''|*[!A-Za-z0-9_.-]*) echo "role names must be non-empty and contain only A-Z, a-z, 0-9, _, ., or -" >&2; exit 2 ;;
    esac
done
if [ "$ACTIVATION_MIGRATION_ROLE" = "$ACTIVATION_APP_ROLE" ]; then
    echo "migration and application roles must differ" >&2
    exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
migration_dir="$script_dir/../migrations"

if command -v sha256sum >/dev/null 2>&1; then
    checksum_file() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
    checksum_file() { shasum -a 256 "$1" | awk '{print $1}'; }
else
    echo "sha256sum or shasum is required" >&2
    exit 2
fi

checksum_001=$(checksum_file "$migration_dir/001_initial.sql")
checksum_002=$(checksum_file "$migration_dir/002_lifecycle.sql")
checksum_003=$(checksum_file "$migration_dir/003_admin.sql")

psql "$ACTIVATION_DATABASE_URL" -X --set=ON_ERROR_STOP=1 \
    --set=migration_role="$ACTIVATION_MIGRATION_ROLE" \
    --set=app_role="$ACTIVATION_APP_ROLE" <<SQL
\getenv migration_password ACTIVATION_MIGRATION_PASSWORD
\getenv app_password ACTIVATION_APP_PASSWORD
SELECT format(
    'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION',
    :'migration_role', :'migration_password'
) WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'migration_role') \gexec
SELECT format(
    'ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION',
    :'migration_role', :'migration_password'
) \gexec
SELECT format(
    'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION',
    :'app_role', :'app_password'
) WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'app_role') \gexec
SELECT format(
    'ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION',
    :'app_role', :'app_password'
) \gexec

SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'migration_role') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'app_role') \gexec
SELECT format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database()) \gexec
SELECT format('REVOKE TEMPORARY ON DATABASE %I FROM %I', current_database(), :'app_role') \gexec
SELECT format('REVOKE %I FROM %I', :'migration_role', :'app_role') \gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('REVOKE CREATE ON SCHEMA public FROM %I', :'app_role') \gexec
SELECT format('ALTER SCHEMA public OWNER TO %I', :'migration_role') \gexec
SELECT format('GRANT USAGE, CREATE ON SCHEMA public TO %I', :'migration_role') \gexec
SELECT format('ALTER TABLE %I.%I OWNER TO %I', n.nspname, c.relname, :'migration_role')
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
\gexec
SELECT format('ALTER SEQUENCE %I.%I OWNER TO %I', n.nspname, c.relname, :'migration_role')
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'S'
\gexec
SELECT format('ALTER VIEW %I.%I OWNER TO %I', n.nspname, c.relname, :'migration_role')
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'v'
\gexec
SELECT format('ALTER MATERIALIZED VIEW %I.%I OWNER TO %I', n.nspname, c.relname, :'migration_role')
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'm'
\gexec
SELECT format('ALTER FOREIGN TABLE %I.%I OWNER TO %I', n.nspname, c.relname, :'migration_role')
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'f'
\gexec
SELECT format('SET ROLE %I', :'migration_role') \gexec

BEGIN;
SELECT pg_advisory_xact_lock(6143838160184756551);
CREATE TABLE IF NOT EXISTS schema_migrations (
    version BIGINT PRIMARY KEY CHECK (version > 0),
    checksum BYTEA NOT NULL CHECK (octet_length(checksum) = 32),
    applied_at TIMESTAMPTZ NOT NULL
);

SELECT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = 1 AND checksum <> decode('$checksum_001', 'hex')
) AS checksum_mismatch_001 \gset
\if :checksum_mismatch_001
    \echo 'migration 1 checksum mismatch'
    \quit 1
\endif
SELECT NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 1) AS apply_001 \gset
\if :apply_001
    \i $migration_dir/001_initial.sql
    INSERT INTO schema_migrations(version, checksum, applied_at)
    VALUES (1, decode('$checksum_001', 'hex'), now());
\endif

SELECT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = 2 AND checksum <> decode('$checksum_002', 'hex')
) AS checksum_mismatch_002 \gset
\if :checksum_mismatch_002
    \echo 'migration 2 checksum mismatch'
    \quit 1
\endif
SELECT NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 2) AS apply_002 \gset
\if :apply_002
    \i $migration_dir/002_lifecycle.sql
    INSERT INTO schema_migrations(version, checksum, applied_at)
    VALUES (2, decode('$checksum_002', 'hex'), now());
\endif

SELECT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = 3 AND checksum <> decode('$checksum_003', 'hex')
) AS checksum_mismatch_003 \gset
\if :checksum_mismatch_003
    \echo 'migration 3 checksum mismatch'
    \quit 1
\endif
SELECT NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 3) AS apply_003 \gset
\if :apply_003
    \i $migration_dir/003_admin.sql
    INSERT INTO schema_migrations(version, checksum, applied_at)
    VALUES (3, decode('$checksum_003', 'hex'), now());
\endif
COMMIT;
RESET ROLE;

SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'app_role') \gexec
SELECT format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I',
    :'app_role'
) \gexec
SELECT format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO %I', :'app_role') \gexec
SELECT format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
    :'migration_role', :'app_role'
) \gexec
SELECT format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I',
    :'migration_role', :'app_role'
) \gexec

SELECT (
    has_database_privilege(:'app_role', current_database(), 'CREATE')
    OR has_database_privilege(:'app_role', current_database(), 'TEMPORARY')
    OR has_schema_privilege(:'app_role', 'public', 'CREATE')
    OR pg_has_role(:'app_role', :'migration_role', 'MEMBER')
    OR EXISTS (
        SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_roles r ON r.oid = c.relowner
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
          AND r.rolname = :'app_role'
    )
) AS app_has_ddl \gset
\if :app_has_ddl
    \echo 'application role unexpectedly has DDL privilege'
    \quit 1
\endif
SQL
