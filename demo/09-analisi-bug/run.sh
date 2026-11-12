#!/usr/bin/env bash
# Demo 09 — Analisi bug e CR: i conteggi vengono dal tracker (Jira finto), mai dal modello.
# Uso: bash demo/09-analisi-bug/run.sh        (si ferma alla fine)
#      KEEP=1 bash demo/09-analisi-bug/run.sh (lascia tutto acceso per la parte nel browser)
set -euo pipefail
cd "$(dirname "$0")/../.."
source demo/lib.sh

paola=.tmp/demo-09-paola.jar
project_name="Borea $(date +%H%M%S)"

step "1/6 Prerequisiti, database, renderer isolato e un Jira finto (3 bug, 2 CR, 1 storia)"
check_prerequisites
prepare_database
forget_old_trackers
start_renderer
rm -f .tmp/demo-09-jira.url
node demo/09-analisi-bug/fake-jira.ts .tmp/demo-09-jira.url >/dev/null &
jira_pid=$!
# With KEEP=1 the fake Jira stays on too: the browser part needs it.
extra_pids="$jira_pid"
for _ in $(seq 1 30); do [ -s .tmp/demo-09-jira.url ] && break; sleep 0.2; done
export SOURCES_DEV_JIRA_URL="$(cat .tmp/demo-09-jira.url)"
echo "  Jira finto su $SOURCES_DEV_JIRA_URL"

step "2/6 Avvio; Paola collega Jira e il worker lo legge"
start_dev .tmp/demo-09.log
login paola "$paola"
call "$paola" POST /projects "{\"name\":\"${project_name}\"}" >/dev/null
slug="$(call "$paola" GET /projects | node -pe "JSON.parse(require('fs').readFileSync(0)).projects.find(p=>p.name==='${project_name}').slug")"
call "$paola" POST "/projects/$slug/sources" '{"kind":"jira","name":"Jira Borea","config":{"site":"demo","email":"octobrief@example.test","readOnlyToken":true},"scope":["BOR"],"secret":"token-finto-demo"}' >/dev/null
for _ in $(seq 1 60); do
  synced="$(call "$paola" GET "/projects/$slug/sources" | node -pe 'JSON.parse(require("fs").readFileSync(0)).sources[0].lastSyncAt ? "si" : "no"')"
  [ "$synced" = "si" ] && break
  sleep 1
done
expect "$synced" "si" "il worker ha letto le attività di Jira (dati strutturati, non documenti)"

step "3/6 Dashboard bug e CR del mese di ottobre"
parameters='{"period":{"type":"period","from":"2026-10-01","to":"2026-10-31"},
 "bug_type":{"type":"text","value":"Bug"},"cr_type":{"type":"text","value":"Change Request"},
 "open_states":{"type":"rows","rows":[{"state":"To Do"},{"state":"In Progress"}]},
 "closed_states":{"type":"rows","rows":[{"state":"Done"}]},
 "for_client":{"type":"choice","value":"no"}}'
run="$(start_run dashboard-bug-cr "$parameters")"
wait_run "$run" 'v.run.status === "ready" || v.run.status === "failed"' "bozza della dashboard pronta"
expect "$(run_value "$run" 'v.run.status')" "ready" "dashboard in attesa del giudizio del PM"
run_view "$run" | node -e '
  const v = JSON.parse(require("fs").readFileSync(0))
  const blocks = v.document.sections.flatMap((s) => s.blocks)
  for (const b of blocks.filter((b) => b.kind === "value")) console.log(`  ${b.label}: ${b.cell.text ?? "—"}`)
  for (const id of ["perimeter_by_type", "open_items"]) {
    const t = blocks.find((b) => b.id === id)
    if (!t) continue
    console.log(`  ${t.title ?? id}:`)
    for (const r of t.rows.slice(0, 6)) console.log(`    ${r.cells.map((c) => c.text ?? "—").join(" · ")}`)
  }'

step "4/6 I numeri sono del tracker: la storia non è né bug né CR e resta fuori"
expect "$(run_value "$run" 'JSON.stringify(v.document).includes("Pagina dei report")')" "false" "la storia BOR-6 non compare nella dashboard"
expect "$(run_value "$run" 'JSON.stringify(v.document).includes("Il report mensile non si apre")')" "true" "il bug aperto BOR-1 è nell'elenco degli aperti"

step "5/6 Controlli, accettazione motivata e approvazione"
show_findings "$run"
accept_all "$run" "Conteggi confrontati con la bacheca di Jira."
expect "$(run_value "$run" 'v.approvable')" "true" "nessuna anomalia aperta"
approve_run "$run"

step "6/6 La dashboard in Excel"
download_format "$run" xlsx .tmp/demo-09-dashboard.xlsx
expect "$(head -c 2 .tmp/demo-09-dashboard.xlsx)" "PK" "è un vero file Excel"

finish "Demo 09 completata. Nel browser: $base/projects/$slug/deliverables"
