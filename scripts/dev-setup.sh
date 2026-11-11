#!/usr/bin/env bash
# Starts the development Postgres (127.0.0.1:5450), creates the roles and applies migrations.
# Generates .env.local on first run. Never prints secrets. Safe to run again.
set -euo pipefail
cd "$(dirname "$0")/.."

touch .env.local
chmod 600 .env.local

add_env_key() {
  local key="$1" value="$2"
  if ! grep -q "^${key}=" .env.local; then
    (umask 077; printf '%s=%s\n' "${key}" "${value}" >> .env.local)
    echo "Added ${key} to .env.local"
  fi
}
read_env_key() { grep "^$1=" .env.local | cut -d= -f2- || true; }

add_env_key POSTGRES_PASSWORD "$(openssl rand -hex 16)"
add_env_key APP_DB_PASSWORD "$(openssl rand -hex 16)"
add_env_key WORKER_DB_PASSWORD "$(openssl rand -hex 16)"
owner_pw="$(read_env_key POSTGRES_PASSWORD)"
app_pw="$(read_env_key APP_DB_PASSWORD)"
worker_pw="$(read_env_key WORKER_DB_PASSWORD)"
add_env_key DATABASE_OWNER_URL "postgres://octobrief_owner:${owner_pw}@127.0.0.1:5450/octobrief"
add_env_key DATABASE_URL "postgres://octobrief_app:${app_pw}@127.0.0.1:5450/octobrief"
add_env_key DATABASE_WORKER_URL "postgres://octobrief_worker:${worker_pw}@127.0.0.1:5450/octobrief"
add_env_key WEB_PORT "3310"

docker compose --env-file .env.local up -d --wait

docker compose --env-file .env.local exec -T postgres \
  psql -q -U octobrief_owner -d octobrief -v ON_ERROR_STOP=1 \
  -v "app_password=${app_pw}" -v "worker_password=${worker_pw}" \
  < scripts/db-setup-roles.sql

pnpm --silent db:migrate

echo "Postgres ready on 127.0.0.1:5450"
