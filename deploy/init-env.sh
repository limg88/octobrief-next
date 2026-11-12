#!/usr/bin/env bash
# Writes the env file of an installation (default deploy/.env) with fresh secrets.
# Keys already in the file are kept: safe to run again. Never prints a secret.
# Usage: SITE_HOST=octobrief.example.internal deploy/init-env.sh [env file]
set -euo pipefail
cd "$(dirname "$0")"

env_file="${1:-.env}"
touch "$env_file"
chmod 600 "$env_file"

add_env_key() {
  local key="$1" value="$2"
  if ! grep -q "^${key}=" "$env_file"; then
    printf '%s=%s\n' "$key" "$value" >>"$env_file"
    echo "Added ${key}"
  fi
}

site_host="${SITE_HOST:-localhost}"
https_port="${HTTPS_PORT:-443}"
public_url="https://${site_host}"
[ "$https_port" = "443" ] || public_url="${public_url}:${https_port}"

add_env_key SITE_HOST "$site_host"
add_env_key HTTPS_PORT "$https_port"
add_env_key HTTPS_BIND "${HTTPS_BIND:-0.0.0.0}"
add_env_key PUBLIC_URL "$public_url"
add_env_key CADDY_TLS "${CADDY_TLS:-internal}"
add_env_key OIDC_ISSUER "${OIDC_ISSUER:-}"
add_env_key OIDC_CLIENT_ID "${OIDC_CLIENT_ID:-}"
add_env_key OIDC_CLIENT_SECRET "${OIDC_CLIENT_SECRET:-}"
add_env_key OIDC_ALLOW_INSECURE_ISSUER "${OIDC_ALLOW_INSECURE_ISSUER:-false}"
add_env_key ADMIN_EMAILS "${ADMIN_EMAILS:-}"
add_env_key POSTGRES_PASSWORD "$(openssl rand -hex 24)"
add_env_key APP_DB_PASSWORD "$(openssl rand -hex 24)"
add_env_key WORKER_DB_PASSWORD "$(openssl rand -hex 24)"
add_env_key SECRETS_KEY "$(openssl rand -base64 32)"
add_env_key RETENTION_DAYS "${RETENTION_DAYS:-365}"
add_env_key LLM_BACKEND "${LLM_BACKEND:-fake}"
add_env_key EMBEDDING_BACKEND "${EMBEDDING_BACKEND:-fake}"

echo "Env file ready: $(cd "$(dirname "$env_file")" && pwd)/$(basename "$env_file")"
