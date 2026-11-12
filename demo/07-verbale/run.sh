#!/usr/bin/env bash
# Demo 07 — Verbale da trascritto: i testi li scrive un agente che legge il trascritto con pochi strumenti.
# Uso: bash demo/07-verbale/run.sh        (si ferma alla fine)
#      KEEP=1 bash demo/07-verbale/run.sh (lascia tutto acceso per la parte nel browser)
set -euo pipefail
cd "$(dirname "$0")/../.."
source demo/lib.sh

paola=.tmp/demo-07-paola.jar
docs=.tmp/demo-07-docs
project_name="Aurora $(date +%H%M%S)"
export LLM_FAKE_TRANSCRIPT="$PWD/.tmp/demo-07-modello.jsonl"

step "1/6 Prerequisiti, database e renderer isolato"
check_prerequisites
prepare_database
rm -f "$LLM_FAKE_TRANSCRIPT"
start_renderer

step "2/6 Avvio; Paola carica il trascritto sintetico di una riunione"
rm -rf "$docs"
node demo/06-deliverable/sal-data.ts "$docs" >/dev/null
start_dev .tmp/demo-07.log
trap '[ "${KEEP:-0}" = "1" ] || { kill -- -"$dev_pid" 2>/dev/null || true; stop_renderer; }' EXIT
login paola "$paola"
call "$paola" POST /projects "{\"name\":\"${project_name}\"}" >/dev/null
slug="$(call "$paola" GET /projects | node -pe "JSON.parse(require('fs').readFileSync(0)).projects.find(p=>p.name==='${project_name}').slug")"
transcript="$(upload "$paola" "$(ls "$docs"/Trascrizione-*.vtt)")"
wait_documents
expect "$(call "$paola" GET "/projects/$slug/documents" | field 'documents[0].kind')" "transcript" "il file .vtt è riconosciuto come trascritto"
sed -n '3,6p;8,10p;16,18p' "$docs"/Trascrizione-*.vtt | sed 's/^/  │ /'

step "3/6 Verbale: ogni testo è scritto da un agente che cerca, legge il trascritto e cita il punto"
run="$(start_run verbale-da-trascritto "{\"transcript\":{\"type\":\"evidence_selection\",\"evidenceIds\":[\"$transcript\"]},\"for_client\":{\"type\":\"choice\",\"value\":\"no\"}}")"
wait_run "$run" 'v.run.status === "ready" || v.run.status === "failed"' "bozza del verbale pronta"
run_view "$run" | node -e '
  const v = JSON.parse(require("fs").readFileSync(0))
  for (const s of v.document.sections) for (const b of s.blocks) {
    if (b.kind !== "text" || b.segments.length === 0) continue
    console.log(`  ${s.title}${b.title ? " › " + b.title : ""}: ${b.segments.map((g) => g.text + " [" + g.sources.join(",") + "]").join(" ")}`)
  }'
expect "$(run_value "$run" 'v.document.sections.flatMap(s=>s.blocks).filter(b=>b.kind==="text" && b.segments.length>0).length >= 4')" "true" "data, partecipanti, decisione e azione vengono dal trascritto, ciascuna con la sua nota"

step "4/6 Strumenti limitati: l'agente ha solo cercato e letto, e non ha mai visto un nome"
node -e '
  const calls = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").map((l) => JSON.parse(l))
    .filter((l) => l.kind === "chat").flatMap((l) => l.messages).filter((m) => m.role === "assistant" && m.toolCalls)
    .flatMap((m) => m.toolCalls.map((c) => c.name))
  const counts = {}; for (const c of calls) counts[c] = (counts[c] ?? 0) + 1
  console.log("  Strumenti chiamati dall'"'"'agente:", JSON.stringify(counts))' "$LLM_FAKE_TRANSCRIPT"
expect "$(grep -c 'Paola\|Luca Inventato\|Elena Cliente' "$LLM_FAKE_TRANSCRIPT" || true)" "0" "nessun nome dei partecipanti in ciò che il modello ha ricevuto"
expect "$(run_value "$run" 'JSON.stringify(v.document).includes("Luca Inventato")')" "true" "nel verbale i nomi sono al loro posto"

step "5/6 Controlli, accettazione motivata e approvazione"
show_findings "$run"
accept_all "$run" "Responsabile e scadenza sono nel punto citato del trascritto: verificato a mano."
expect "$(run_value "$run" 'v.approvable')" "true" "nessuna anomalia aperta"
approve_run "$run"

step "6/6 Il verbale in Word, prodotto dal renderer isolato"
download_format "$run" docx .tmp/demo-07-verbale.docx
expect "$(head -c 2 .tmp/demo-07-verbale.docx)" "PK" "è un vero file Word (archivio OOXML)"
download_format "$run" md .tmp/demo-07-verbale.md
grep -v '^$' .tmp/demo-07-verbale.md | sed -n '1,16p' | sed 's/^/  │ /'

finish "Demo 07 completata. Nel browser: $base/projects/$slug/deliverables"
