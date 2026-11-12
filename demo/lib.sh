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
  # A stack left on from an earlier demo would answer in place of this one, with its old code.
  if curl -s -o /dev/null "$base/api/health" 2>/dev/null; then
    fail "La porta di $base è già in uso: ferma lo stack precedente (il kill stampato alla fine di quella demo)"
  fi
  # A build cache left by a stack that was killed can make the browser reload without end.
  rm -rf apps/web/.next
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
  # The scripts describe the Italian interface: a language left on English by an earlier demo
  # (demo 01 switches it) would not match them.
  call "$2" PATCH /me '{"locale":"it"}' >/dev/null
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
    # $extra_pids: other processes a demo leaves on for the browser part (a fake Jira).
    echo "Web, worker e issuer finto restano accesi. Apri $base — per fermare: kill -- -$dev_pid ${extra_pids:-}"
  fi
}

# --- Deliverables: shared by the demos that run a recipe. They need $paola (cookie jar), $slug.

compose() { docker compose --env-file .env.local --profile renderer "$@"; }

# start_renderer: the isolated renderer of Word, PowerPoint and Excel files, on RENDERER_URL.
start_renderer() {
  export RENDERER_URL="http://127.0.0.1:${RENDERER_PORT:-5451}"
  compose up -d --build --wait renderer-gateway 2>&1 | tail -1
  ok "renderer pronto su $RENDERER_URL (rete interna senza uscita, utente non root, sola lettura)"
}
stop_renderer() { compose stop renderer-gateway renderer >/dev/null 2>&1 || true; }

# upload <jar> <file>: uploads a document and prints its id.
upload() {
  curl -s -b "$1" -H "origin: $base" -H "x-csrf-token: $(csrf "$1")" \
    -F "file=@$2" "$base/api/projects/$slug/documents" | field id
}
# wait_documents: until every uploaded document is extracted, classified and read by the model.
wait_documents() {
  for _ in $(seq 1 90); do
    reading="$(call "$paola" GET "/projects/$slug/knowledge" | field progress.reading)"
    [ "$reading" = "0" ] && return
    sleep 1
  done
  fail "documenti non ancora letti dopo 90 secondi"
}
# start_run <recipe slug> <parameters json>: starts a run and prints its id.
start_run() { call "$paola" POST "/projects/$slug/runs" "{\"recipeSlug\":\"$1\",\"parameters\":$2}" | field id; }
run_view() { call "$paola" GET "/projects/$slug/runs/$1"; }
# run_value <run id> <js expression on `v` (the run view)>
run_value() { run_view "$1" | node -pe "const v = JSON.parse(require('fs').readFileSync(0)); $2"; }
# wait_run <run id> <js condition on v> <description>
wait_run() {
  for _ in $(seq 1 90); do
    [ "$(run_value "$1" "$2")" = "true" ] && { ok "$3"; return; }
    sleep 1
  done
  fail "$3 (tempo scaduto: $(run_value "$1" 'v.run.status + "/" + v.run.errorCode + "/" + v.run.approval + "/" + v.run.approvalError'))"
}
show_findings() {
  run_view "$1" | node -e '
    const v = JSON.parse(require("fs").readFileSync(0))
    console.log(`  Revisione ${v.revision}: ${v.summary.checks} controlli, ${v.summary.open} anomalie aperte, ${v.summary.accepted} accettate, ${v.summary.warnings} avvisi`)
    for (const f of v.findings.filter((f) => f.kind === "anomaly")) {
      const where = [f.place.section, f.place.block].filter(Boolean).join(" › ")
      console.log(`    ${f.status === "open" ? "✘" : "✔"} [${f.class}${f.acceptable ? ", accettabile" : ""}] ${f.text} — ${where}${f.excerpt ? ` — «${f.excerpt}»` : ""}`)
    }'
}
# accept_finding <run id> <reason>: accepts the first open anomaly; prints the HTTP status.
accept_finding() {
  local body
  body="$(run_view "$1" | REASON="$2" node -pe 'const f = JSON.parse(require("fs").readFileSync(0)).findings.find(f=>f.status==="open"); JSON.stringify({ code: f.code, refKey: f.refKey, reason: process.env.REASON })')"
  curl -s -o /dev/null -w '%{http_code}' -b "$paola" -X POST -H "origin: $base" -H "x-csrf-token: $(csrf "$paola")" \
    -H 'content-type: application/json' -d "$body" "$base/api/projects/$slug/runs/$1/acceptances"
}
# accept_all <run id> <reason>: accepts every open anomaly that may be accepted.
accept_all() {
  for _ in $(seq 1 20); do
    [ "$(run_value "$1" 'v.findings.some(f=>f.status==="open" && f.acceptable)')" = "true" ] || return 0
    accept_finding "$1" "$2" >/dev/null
  done
}
# approve_run <run id>: asks the approval and waits for the files.
approve_run() {
  call "$paola" POST "/projects/$slug/runs/$1/approval" >/dev/null
  wait_run "$1" 'v.run.approval === "approved" || v.run.approval === "render_failed"' "file prodotti"
  expect "$(run_value "$1" 'v.run.approval')" "approved" "documento approvato"
  run_view "$1" | node -pe 'JSON.parse(require("fs").readFileSync(0)).files.map(f=>`  ${f.fileName} (${f.audience}, ${f.sizeBytes} byte)`).join("\n")'
}
# download <run id> <file id> <target>: saves a file of an approved run; prints the HTTP status.
download() {
  curl -s -b "$paola" -o "$3" -w '%{http_code}' "$base/api/projects/$slug/runs/$1/files/$2"
}
# download_format <run id> <format> <target>: the first file of that format.
download_format() {
  local id
  id="$(run_value "$1" "v.files.find(f=>f.format==='$2').id")"
  expect "$(download "$1" "$id" "$3")" "200" "scaricato $3"
}

