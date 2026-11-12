#!/usr/bin/env bash
# Demo 08 — Stima dei costi: i conti li fa (e li controlla) il codice, il modello scrive solo le note.
# Uso: bash demo/08-stima-costi/run.sh        (si ferma alla fine)
#      KEEP=1 bash demo/08-stima-costi/run.sh (lascia tutto acceso per la parte nel browser)
set -euo pipefail
cd "$(dirname "$0")/../.."
source demo/lib.sh

paola=.tmp/demo-08-paola.jar
project_name="Aurora $(date +%H%M%S)"

# estimate <cost of the second activity>: the values a PM types in the form of the estimate.
estimate() {
  cat <<JSON
{"scope":{"type":"text","value":"Nuovo modulo di reportistica"},
 "estimate_date":{"type":"date","day":"2026-11-12"},
 "roles":{"type":"rows","rows":[{"role":"Analista","rate":500},{"role":"Sviluppatore","rate":400}]},
 "activities":{"type":"rows","rows":[
   {"phase":"Analisi","activity":"Requisiti","role":"Analista","days":10,"cost":5000},
   {"phase":"Sviluppo","activity":"Report","role":"Sviluppatore","days":20,"cost":$1}]},
 "phases":{"type":"rows","rows":[{"phase":"Analisi","days":10,"cost":5000},{"phase":"Sviluppo","days":20,"cost":8000}]},
 "contingency_pct":{"type":"number","value":10},
 "contingency_amount":{"type":"number","value":1300},
 "total":{"type":"number","value":14300}}
JSON
}

step "1/5 Prerequisiti, database e renderer isolato"
check_prerequisites
prepare_database
start_renderer

step "2/5 Avvio e progetto"
start_dev .tmp/demo-08.log
trap '[ "${KEEP:-0}" = "1" ] || { kill -- -"$dev_pid" 2>/dev/null || true; stop_renderer; }' EXIT
login paola "$paola"
call "$paola" POST /projects "{\"name\":\"${project_name}\"}" >/dev/null
slug="$(call "$paola" GET /projects | node -pe "JSON.parse(require('fs').readFileSync(0)).projects.find(p=>p.name==='${project_name}').slug")"
ok "progetto $slug"

step "3/5 Una stima con un errore di somma: i controlli della ricetta lo trovano"
wrong="$(start_run cost-estimate "$(estimate 9000)")"
wait_run "$wrong" 'v.run.status === "ready" || v.run.status === "failed"' "bozza pronta"
show_findings "$wrong"
expect "$(run_value "$wrong" 'v.findings.filter(f=>f.status==="open").length')" "3" "tre controlli della ricetta segnalano che i conti non tornano (costo di fase, contingenza, totale)"
expect "$(run_value "$wrong" 'v.approvable')" "false" "finché restano aperti, la stima non è approvabile: si corregge il dato o si motiva l'eccezione"

step "4/5 La stima corretta: tariffe per giorni, subtotali per fase, contingenza e totale tornano"
run="$(start_run cost-estimate "$(estimate 8000)")"
wait_run "$run" 'v.run.status === "ready" || v.run.status === "failed"' "bozza pronta"
show_findings "$run"
run_view "$run" | node -e '
  const v = JSON.parse(require("fs").readFileSync(0))
  for (const b of v.document.sections.flatMap((s) => s.blocks).filter((b) => b.kind === "value")) {
    console.log(`  ${b.label}: ${b.cell.text ?? "—"}`)
  }'
accept_all "$run" "Verificato con il responsabile commerciale."
expect "$(run_value "$run" 'v.approvable')" "true" "nessuna anomalia aperta"

step "5/5 Approva: documento interno, in Markdown e in Excel"
approve_run "$run"
expect "$(run_value "$run" 'v.files.every(f=>f.audience==="internal")')" "true" "solo file per uso interno: la ricetta non ha una versione per il cliente"
download_format "$run" xlsx .tmp/demo-08-stima.xlsx
expect "$(head -c 2 .tmp/demo-08-stima.xlsx)" "PK" "è un vero file Excel"

finish "Demo 08 completata. Nel browser: $base/projects/$slug/deliverables"
