# Shared helpers for the demo scripts (sourced, not executed).
# Requires: the repository root as current directory.

step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }
ok() { printf '  \033[32m✔\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✘ %s\033[0m\n' "$1"; exit 1; }
# expect <actual> <expected> <what it proves>: stops the demo when the check fails.
expect() { if [ "$1" = "$2" ]; then ok "$3"; else fail "$3 (atteso '$2', ottenuto '$1')"; fi; }
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(s),null,2)))'; }
field() { node -pe "JSON.parse(require('fs').readFileSync(0)).$1"; }

check_prerequisites() {
  for tool in node pnpm docker curl; do
    command -v "$tool" >/dev/null || fail "Manca $tool"
  done
  echo "node $(node -v) · pnpm $(pnpm -v) · $(docker --version)"
}

prepare_database() {
  pnpm install --frozen-lockfile --silent
  pnpm --silent db:setup 2>&1 | grep -v NOTICE | tail -2
  port="$(grep '^WEB_PORT=' .env.local | cut -d= -f2-)"
  base="http://127.0.0.1:${port:-3310}"
  mkdir -p .tmp
}

# start_dev <log>: web + worker + fake issuer in their own process group; stopped on exit
# unless KEEP=1.
start_dev() {
  log="$1"
  set -m
  pnpm dev >"$log" 2>&1 &
  dev_pid=$!
  set +m
  if [ "${KEEP:-0}" != "1" ]; then trap 'kill -- -"$dev_pid" 2>/dev/null || true' EXIT; fi
  for _ in $(seq 1 90); do
    curl -sf "$base/api/health" >/dev/null 2>&1 && break
    sleep 1
  done
  curl -sf "$base/api/health" >/dev/null || fail "Il web non risponde: vedi $log"
  echo "Web pronto su $base (log in $log)"
}

# login <fake person> <cookie jar>: the real OpenID Connect redirects, followed by curl.
login() {
  rm -f "$2"
  curl -s -c "$2" -b "$2" -L -o /dev/null "$base/api/auth/login?login_hint=$1&return_to=/"
  curl -sf -b "$2" "$base/api/me" >/dev/null || fail "Accesso di $1 non riuscito"
}

csrf() { curl -s -b "$1" "$base/api/me" | field csrfToken; }

# call <jar> <method> <path> [json body]: authenticated API call with the CSRF token.
call() {
  local jar="$1" method="$2" path="$3" body="${4:-}"
  local args=(-s -b "$jar" -X "$method" -H "origin: $base" -H "x-csrf-token: $(csrf "$jar")")
  [ -n "$body" ] && args+=(-H 'content-type: application/json' -d "$body")
  curl "${args[@]}" "$base/api$path"
}

finish() {
  printf '\n\033[1;32m✔ %s\033[0m\n' "$1"
  if [ "${KEEP:-0}" = "1" ]; then
    echo "Web, worker e issuer finto restano accesi. Apri $base — per fermare: kill -- -$dev_pid"
  fi
}
