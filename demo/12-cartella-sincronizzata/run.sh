#!/usr/bin/env bash
# Demo 12 — Cartella sincronizzata: Octobrief legge una cartella di file Markdown con
# intestazione dati (Jira e Microsoft 365 sintetici), sia direttamente sia inviata dal PC.
# Uso: bash demo/12-cartella-sincronizzata/run.sh        (si ferma alla fine)
#      KEEP=1 bash demo/12-cartella-sincronizzata/run.sh (lascia tutto acceso per il browser)
set -euo pipefail
cd "$(dirname "$0")/../.."
source demo/lib.sh

paola=.tmp/demo-12-paola.jar
suffix="$(date +%H%M%S)"
project_name="Borea ${suffix}"
# The only place the server may read synchronized folders from, and the folder of this project.
export SYNC_FOLDERS_ROOT="$PWD/.tmp/demo-12-sync"
folder="$SYNC_FOLDERS_ROOT/borea-${suffix}"
export LLM_FAKE_TRANSCRIPT="$PWD/.tmp/demo-12-modello.jsonl"

sources() { call "$paola" GET "/projects/$slug/sources"; }
worker_sql() {
  docker compose --env-file .env.local exec -T -e PGPASSWORD="$(grep '^WORKER_DB_PASSWORD=' .env.local | cut -d= -f2-)" postgres \
    psql -qtA -U octobrief_worker -d octobrief -c "$1" | tail -1 | tr -d ' '
}
# source_id <kind>: the id of the source of that kind in the current project.
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
connect_folder() { call "$paola" POST "/projects/$slug/sources" "{\"kind\":\"$1\",\"name\":\"$2\",\"feed\":\"folder\",\"folderPath\":\"$3\"}"; }
dashboard_values() {
  run_value "$1" 'v.document.sections.flatMap(s=>s.blocks).filter(b=>b.kind==="value").slice(0,3).map(b=>b.label+": "+b.cell.text).join(" | ")'
}
parameters='{"period":{"type":"period","from":"2026-10-01","to":"2026-10-31"},
 "bug_type":{"type":"text","value":"Bug"},"cr_type":{"type":"text","value":"Change Request"},
 "open_states":{"type":"rows","rows":[{"state":"To Do"},{"state":"In Progress"}]},
 "closed_states":{"type":"rows","rows":[{"state":"Done"}]},
 "for_client":{"type":"choice","value":"no"}}'

step "1/8 Prerequisiti, database (migrazione 0007) e una cartella sincronizzata sintetica"
check_prerequisites
prepare_database
forget_old_trackers
rm -rf "$SYNC_FOLDERS_ROOT" "$LLM_FAKE_TRANSCRIPT"
node demo/12-cartella-sincronizzata/make-folder.ts "$folder" | sed 's/^/  /'
(cd "$folder" && find . -type f | sort | sed 's/^/    /')

step "2/8 Un file della cartella: testo leggibile sotto un'intestazione con i dati"
sed -n '1,9p' "$folder/jira/BOR-1.md" | cut -c1-110 | sed 's/^/    /'
echo "    …"
sed -n '/^---$/,$p' "$folder/jira/BOR-1.md" | sed '1,/^---$/d' | sed 's/^/    /'

step "3/8 Avvio; Paola collega la cartella: una fonte per sistema, del tipo vero"
start_dev .tmp/demo-12.log
login paola "$paola"
call "$paola" POST /projects "{\"name\":\"${project_name}\"}" >/dev/null
slug="$(call "$paola" GET /projects | node -pe "JSON.parse(require('fs').readFileSync(0)).projects.find(p=>p.name==='${project_name}').slug")"
project_id="$(call "$paola" GET "/projects/$slug" | field id)"
expect "$(connect_folder jira "Jira (cartella sincronizzata)" /etc | field reason)" "folder_not_allowed" "una cartella fuori da SYNC_FOLDERS_ROOT è rifiutata"
expect "$(connect_folder jira "Jira (cartella sincronizzata)" "$folder" | field source.feed)" "folder" "fonte Jira alimentata dalla cartella (nessuna credenziale)"
expect "$(connect_folder m365 "Microsoft 365 (cartella sincronizzata)" "$folder" | field ingestToken)" "null" "fonte Microsoft 365 alimentata dalla cartella (nessun token)"

step "4/8 Il worker legge la cartella: attività come dati, mail e riunione come documenti"
wait_read jira ""
wait_read m365 ""
wait_documents
expect "$(worker_sql "SELECT count(*) FROM tracker_items WHERE project_id = '$project_id' AND removed_at IS NULL")" "6" "6 attività di Jira salvate come dati strutturati"
expect "$(call "$paola" GET "/projects/$slug/documents" | node -pe 'JSON.parse(require("fs").readFileSync(0)).documents.length')" "2" "2 documenti in memoria: la mail e la riunione"
expect "$(call "$paola" GET "/projects/$slug/knowledge" | node -pe 'JSON.parse(require("fs").readFileSync(0)).facts.some(f=>f.statement.includes("890.000"))')" "true" "il fatto sul budget viene dalla mail"
expect "$(grep -c 'Carla' "$LLM_FAKE_TRANSCRIPT" || true)" "0" "le persone dell'intestazione non arrivano al modello"
sources | node -e '
  for (const s of JSON.parse(require("fs").readFileSync(0)).sources)
    console.log(`  ${s.name} · ${s.kind} · ${s.feed} · dati aggiornati al ${s.dataAsOf}`)'

step "5/8 I deliverable funzionano come con Jira collegato: dashboard bug e CR"
run="$(start_run dashboard-bug-cr "$parameters")"
wait_run "$run" 'v.run.status === "ready" || v.run.status === "failed"' "bozza della dashboard pronta"
expect "$(dashboard_values "$run")" "Bug e CR nel tracker: 5 | Aperti: 3 | Chiusi: 2" "i numeri vengono dai file della cartella"

step "6/8 La cartella cambia (un bug chiuso, una storia tolta): «Leggi ora» e i dati seguono"
node demo/12-cartella-sincronizzata/make-folder.ts "$folder" second-pass | sed 's/^/  /'
before="$(now_iso)"
call "$paola" POST "/projects/$slug/sources/$(source_id jira)/sync" >/dev/null
wait_read jira "$before"
expect "$(worker_sql "SELECT record->>'status' FROM tracker_items WHERE project_id = '$project_id' AND external_id = '1'")" "Done" "BOR-1 ora è chiuso"
expect "$(worker_sql "SELECT count(*) FROM tracker_items WHERE project_id = '$project_id' AND removed_at IS NOT NULL")" "1" "BOR-6, tolto alla fonte, è segnato come rimosso"
run2="$(start_run dashboard-bug-cr "$parameters")"
wait_run "$run2" 'v.run.status === "ready" || v.run.status === "failed"' "nuova bozza della dashboard"
expect "$(dashboard_values "$run2")" "Bug e CR nel tracker: 5 | Aperti: 2 | Chiusi: 3" "la dashboard segue la cartella"

step "7/8 Stessa cartella, altro progetto: inviata dal PC con il token della fonte (server on-prem)"
remote_name="Borea remoto ${suffix}"
call "$paola" POST /projects "{\"name\":\"${remote_name}\"}" >/dev/null
remote="$(call "$paola" GET /projects | node -pe "JSON.parse(require('fs').readFileSync(0)).projects.find(p=>p.name==='${remote_name}').slug")"
created="$(call "$paola" POST "/projects/$remote/sources" '{"kind":"jira","name":"Jira (inviato dal PC)","feed":"push"}')"
expect "$(echo "$created" | field source.feed)" "push" "fonte Jira alimentata dal PC: il token si vede una volta sola"
OCTOBRIEF_FEEDER_TOKEN="$(echo "$created" | field ingestToken)" node addons/sync/src/cli.ts folder \
  --server "$base" --source "$(echo "$created" | field source.id)" --path "$folder" --system jira | sed 's/^/  /'
remote_id="$(call "$paola" GET "/projects/$remote" | field id)"
expect "$(worker_sql "SELECT count(*) FROM tracker_items WHERE project_id = '$remote_id'")" "5" "5 attività arrivate via HTTPS, senza che il server veda la cartella"

step "8/8 Riepilogo delle fonti"
sources | node -e '
  for (const s of JSON.parse(require("fs").readFileSync(0)).sources)
    console.log(`  ${s.name} · ${s.kind} · ${s.feed}${s.folderPath ? " · " + s.folderPath : ""} · ultima lettura ${s.lastSyncAt}`)'

finish "Demo 12 completata. Nel browser: $base/projects/$slug/sources (copione, passi 9–11)"
