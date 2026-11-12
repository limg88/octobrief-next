#!/usr/bin/env bash
# Demo 13 — Addon di sincronizzazione: Jira, Azure DevOps e Microsoft 365 (tutti finti) scritti
# periodicamente in una cartella di file Markdown, che Octobrief legge o riceve dal PC.
# Uso: bash demo/13-addon-sync/run.sh        (si ferma alla fine)
#      KEEP=1 bash demo/13-addon-sync/run.sh (lascia tutto acceso per la parte nel browser)
set -euo pipefail
cd "$(dirname "$0")/../.."
source demo/lib.sh

paola=.tmp/demo-13-paola.jar
suffix="$(date +%H%M%S)"
project_name="Borea ${suffix}"
work="$PWD/.tmp/demo-13-${suffix}"
export SYNC_FOLDERS_ROOT="$work/sync"
folder="$SYNC_FOLDERS_ROOT/borea"
config="$work/borea.json"
secrets="$work/borea.env"
export LLM_FAKE_TRANSCRIPT="$work/modello.jsonl"

addon() { node addons/sync/src/cli.ts "$@"; }
sources() { call "$paola" GET "/projects/$slug/sources"; }
worker_sql() {
  docker compose --env-file .env.local exec -T -e PGPASSWORD="$(grep '^WORKER_DB_PASSWORD=' .env.local | cut -d= -f2-)" postgres \
    psql -qtA -U octobrief_worker -d octobrief -c "$1" | tail -1 | tr -d ' '
}
source_id() { sources | node -pe "JSON.parse(require('fs').readFileSync(0)).sources.find(s=>s.kind==='$1').id"; }
# wait_read <kind> <after ISO>: until the worker has read the source after that moment.
wait_read() {
  for _ in $(seq 1 60); do
    read_at="$(sources | node -pe "JSON.parse(require('fs').readFileSync(0)).sources.find(s=>s.kind==='$1').lastSyncAt ?? ''")"
    [ -n "$read_at" ] && [ "$read_at" \> "$2" ] && return
    sleep 1
  done
  fail "la fonte $1 non è stata letta"
}
now_iso() { node -pe 'new Date().toISOString()'; }
tomorrow() { node -pe 'new Date(Date.now() + 20 * 3600 * 1000).toISOString().slice(0, 10)'; }
listing() { (cd "$folder" && find . -type f -not -path './.octobrief-sync/*' | sort | sed 's/^/    /'); }
count_files() { find "$folder/$1" -type f -name "$2" | wc -l | tr -d ' '; }

step "1/9 Prerequisiti, database e i sistemi finti: Jira, Azure DevOps e un «Claude» con Microsoft 365"
check_prerequisites
prepare_database
forget_old_trackers
mkdir -p "$work"
node demo/13-addon-sync/fake-systems.ts "$work/sistemi.url" >/dev/null &
extra_pids="$!"
for _ in $(seq 1 30); do [ -s "$work/sistemi.url" ] && break; sleep 0.2; done
export SOURCES_DEV_JIRA_URL="$(sed -n 1p "$work/sistemi.url")" SOURCES_DEV_ADO_URL="$(sed -n 2p "$work/sistemi.url")"
echo "  Jira finto su $SOURCES_DEV_JIRA_URL · Azure DevOps finto su $SOURCES_DEV_ADO_URL"

step "2/9 La configurazione dell'addon: un file JSON senza segreti, e un file .env privato"
addon init "$work/esempio.json" | sed 's/^/  /'
sed -n '1,12p' "$work/esempio.json" | sed 's/^/    /'
echo "    …"
cat >"$config" <<JSON
{
  "folder": "$folder",
  "everyMinutes": 30,
  "since": "01/10/2026",
  "envFile": "$secrets",
  "jira": { "site": "demo.atlassian.net", "email": "octobrief@example.test", "tokenEnv": "JIRA_TOKEN", "projects": ["BOR"] },
  "ado": { "organization": "contoso", "project": "Borea", "patEnv": "ADO_PAT", "patExpiresOn": "$(tomorrow)" },
  "m365": { "keywords": ["Borea", "carla.cliente@cliente.example"], "teams": { "channels": ["Borea/Generale"] }, "claude": "$PWD/demo/13-addon-sync/fake-claude.sh" }
}
JSON
(umask 077; printf 'JIRA_TOKEN=token-finto-demo\nADO_PAT=pat-finto-demo\n' >"$secrets")
expect "$(grep -c 'finto' "$config" || true)" "0" "nessun segreto nella configurazione: solo i nomi delle variabili"

step "3/9 Controllo: configurazione, accessi e scadenza del PAT di Azure DevOps (domani)"
addon check --config "$config" | sed 's/^/  /'
expect "$(addon check --config "$config" | grep -c 'accesso riuscito')" "2" "Jira e Azure DevOps accettano le credenziali"
expect "$(addon check --config "$config" | grep -c 'ATTENZIONE: Il PAT')" "1" "il PAT in scadenza è segnalato un giorno prima"

step "4/9 Prima passata: dal 1° ottobre 2026 a oggi, in una cartella ordinata"
addon pull --once --config "$config" | sed 's/^/  /'
listing
expect "$(count_files jira 'bor-*.md')" "3" "3 attività di Jira: BOR-4, ferma da agosto, è prima della data di inizio"
expect "$(count_files ado '1*.md')" "2" "2 elementi di Azure DevOps"
expect "$(count_files m365 '*.md')" "2" "una mail e una riunione da Microsoft 365, lette tramite Claude"
sed 's/^/    /' "$folder/_stato.md"

step "5/9 Octobrief legge la cartella: una fonte per sistema"
start_dev "$work/dev.log"
login paola "$paola"
call "$paola" POST /projects "{\"name\":\"${project_name}\"}" >/dev/null
slug="$(call "$paola" GET /projects | node -pe "JSON.parse(require('fs').readFileSync(0)).projects.find(p=>p.name==='${project_name}').slug")"
project_id="$(call "$paola" GET "/projects/$slug" | field id)"
for kind in jira ado m365; do
  call "$paola" POST "/projects/$slug/sources" "{\"kind\":\"$kind\",\"name\":\"$kind (cartella sincronizzata)\",\"feed\":\"folder\",\"folderPath\":\"$folder\"}" >/dev/null
done
for kind in jira ado m365; do wait_read "$kind" ""; done
wait_documents
expect "$(worker_sql "SELECT count(*) FROM tracker_items WHERE project_id = '$project_id'")" "5" "5 attività come dati strutturati (3 di Jira, 2 di Azure DevOps)"
expect "$(call "$paola" GET "/projects/$slug/knowledge" | node -pe 'JSON.parse(require("fs").readFileSync(0)).facts.some(f=>f.statement.includes("890.000"))')" "true" "il fatto sul budget viene dalla mail"
expect "$(grep -c 'Carla' "$LLM_FAKE_TRANSCRIPT" || true)" "0" "le persone lette da Claude restano nascoste al modello di Octobrief"

step "6/9 Le fonti cambiano (un bug chiuso su Jira, un elemento nuovo su Azure DevOps): seconda passata"
kill -USR2 "$extra_pids"
sleep 1
addon pull --once --config "$config" | sed 's/^/  /'
before="$(now_iso)"
for kind in jira ado; do call "$paola" POST "/projects/$slug/sources/$(source_id "$kind")/sync" >/dev/null; done
for kind in jira ado; do wait_read "$kind" "$before"; done
expect "$(worker_sql "SELECT record->>'status' FROM tracker_items WHERE project_id = '$project_id' AND record->>'key' = 'BOR-1'")" "Done" "BOR-1 ora è chiuso anche in Octobrief"
expect "$(worker_sql "SELECT count(*) FROM tracker_items WHERE project_id = '$project_id'")" "6" "il nuovo elemento di Azure DevOps è arrivato"

step "7/9 Una data di inizio precedente recupera il periodo mancante"
addon pull --once --config "$config" --since 2026-08-01 | sed 's/^/  /'
expect "$(count_files jira 'bor-*.md')" "4" "con --since 2026-08-01 arriva anche BOR-4"

step "8/9 In modo periodico: ogni N minuti, finché non lo si ferma"
# Node itself in the background: killing the subshell of a function would leave it running.
node addons/sync/src/cli.ts pull --config "$config" --every 1 >"$work/periodico.log" 2>&1 &
periodic=$!
for _ in $(seq 1 40); do grep -q 'm365:' "$work/periodico.log" && break; sleep 0.5; done
{ kill "$periodic" && wait "$periodic"; } 2>/dev/null || true
sed 's/^/  /' "$work/periodico.log"
expect "$(grep -c 'Ogni 1 minuti' "$work/periodico.log")" "1" "l'addon resta acceso e ripete la passata all'intervallo scelto"

step "9/9 Server on-prem: la stessa cartella inviata dal PC con «push»"
remote_name="Borea remoto ${suffix}"
call "$paola" POST /projects "{\"name\":\"${remote_name}\"}" >/dev/null
remote="$(call "$paola" GET /projects | node -pe "JSON.parse(require('fs').readFileSync(0)).projects.find(p=>p.name==='${remote_name}').slug")"
push_sources=""
for kind in jira ado m365; do
  created="$(call "$paola" POST "/projects/$remote/sources" "{\"kind\":\"$kind\",\"name\":\"$kind (inviato dal PC)\",\"feed\":\"push\"}")"
  variable="OCTOBRIEF_TOKEN_$(echo "$kind" | tr '[:lower:]' '[:upper:]')"
  (umask 077; printf '%s=%s\n' "$variable" "$(echo "$created" | field ingestToken)" >>"$secrets")
  push_sources="${push_sources}${push_sources:+, }\"$kind\": { \"id\": \"$(echo "$created" | field source.id)\", \"tokenEnv\": \"$variable\" }"
done
node -e '
  const fs = require("fs")
  const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
  config.push = { server: process.argv[2], sources: JSON.parse(`{${process.argv[3]}}`) }
  fs.writeFileSync(process.argv[1], JSON.stringify(config, null, 2))' "$config" "$base" "$push_sources"
addon push --once --config "$config" | sed 's/^/  /'
remote_id="$(call "$paola" GET "/projects/$remote" | field id)"
expect "$(worker_sql "SELECT count(*) FROM tracker_items WHERE project_id = '$remote_id'")" "7" "7 attività arrivate via HTTP al secondo progetto, senza che il server veda la cartella"

finish "Demo 13 completata. Nel browser: $base/projects/$slug/sources (copione, passi 10–12)"
