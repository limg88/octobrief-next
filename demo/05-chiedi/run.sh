#!/usr/bin/env bash
# Demo 05 — Chiedi: ricerca ibrida, risposta verificata frase per frase, contraddizioni, storico.
# Uso: bash demo/05-chiedi/run.sh        (si ferma alla fine)
#      KEEP=1 bash demo/05-chiedi/run.sh (lascia tutto acceso per la parte nel browser)
set -euo pipefail
cd "$(dirname "$0")/../.."
source demo/lib.sh

paola=.tmp/demo-05-paola.jar
marco=.tmp/demo-05-marco.jar
docs=.tmp/demo-05-docs
suffix="$(date +%H%M%S)"
project_name="Borea ${suffix}"
export LLM_FAKE_TRANSCRIPT="$PWD/.tmp/demo-05-modello.jsonl"

upload() {
  curl -s -b "$1" -H "origin: $base" -H "x-csrf-token: $(csrf "$1")" \
    -F "file=@$2" "$base/api/projects/$slug/documents" >/dev/null
}

# ask <text>: asks, follows the progress events until the answer is ready, sets $question_id.
ask() {
  question_id="$(call "$paola" POST "/projects/$slug/questions" "$(node -e 'console.log(JSON.stringify({ text: process.argv[1] }))' "$1")" | field id)"
  echo "  Domanda: $1"
  curl -sN --max-time 60 -b "$paola" "$base/api/projects/$slug/questions/$question_id/events" \
    | grep '^data:' | node -e '
      const phases = require("fs").readFileSync(0, "utf8").trim().split("\n").map((line) => JSON.parse(line.slice(5)).phase)
      console.log(`  Avanzamento (eventi dal server): ${phases.join(" → ")}`)'
}
answer() { call "$paola" GET "/projects/$slug/questions/$question_id"; }

show_answer() {
  answer | node -e '
    const { answer } = JSON.parse(require("fs").readFileSync(0))
    const day = (iso) => iso ? new Date(iso).toLocaleDateString("it-IT", { timeZone: "Europe/Rome" }) : "data non nota"
    const chip = (s) => `${s.verified ? "✔" : "✘ " + s.reason} ${s.title} · ${day(s.sourceDate)}`
    for (const s of answer.segments) {
      console.log(`  • ${s.text ?? "[frase sospesa: " + s.suspendedReason + "]"}`)
      console.log(`      [${s.nature} · ${s.freshness}${s.warning ? " · " + s.warning : ""}] ${s.sources.map(chip).join(" | ")}`)
    }
    for (const c of answer.contradictions) {
      console.log(`  ⚠ Contraddizione su «${c.subject}»:`)
      for (const side of c.sides) console.log(`      - ${side.value}  (${chip(side.source)})`)
    }
    for (const a of answer.absences) console.log(`  ? Manca: ${a.question} — ${a.proposal}`)
    console.log(`  Controlli: ${answer.checks.total}, anomalie: ${answer.checks.anomalies}`)'
}
# answer_value <js expression on `a` (the answer)>
answer_value() { answer | node -pe "const a = JSON.parse(require('fs').readFileSync(0)).answer; $1"; }

step "1/8 Prerequisiti, dipendenze e database (migrazione 0005: indice del testo, domande)"
check_prerequisites
prepare_database
rm -f "$LLM_FAKE_TRANSCRIPT"

step "2/8 Documenti sintetici: due SAL in disaccordo sul budget, una nota del fornitore, una nota di azioni"
rm -rf "$docs"
node tools/synthetic/src/cli.ts "$docs" 1 >/dev/null
actions="$docs/Azioni-2026-11-06.txt"
cat >"$actions" <<'NOTE'
Paola Prova deve inviare il piano di rientro al cliente entro il 20 novembre 2026.
Per conferme scrivere a paola.prova@example.test.
NOTE
ok "4 documenti pronti"

step "3/8 Avvio, progetto e lettura dei documenti (estrazione, fatti, vettori)"
start_dev .tmp/demo-05.log
login paola "$paola"
login marco "$marco"
call "$paola" POST /projects "{\"name\":\"${project_name}\"}" >/dev/null
slug="$(call "$paola" GET /projects | node -pe "JSON.parse(require('fs').readFileSync(0)).projects.find(p=>p.name==='${project_name}').slug")"
for file in "$docs"/SAL-*-2026-11-04.md "$docs"/SAL-*-rev2-*.md "$docs"/Nota-fornitore-*.txt "$actions"; do upload "$paola" "$file"; done
for _ in $(seq 1 90); do
  reading="$(call "$paola" GET "/projects/$slug/knowledge" | field progress.reading)"
  [ "$reading" = "0" ] && break
  sleep 1
done
expect "$reading" "0" "progetto $slug: 4 documenti letti"

step "4/8 Una domanda sul budget: risposta citata e contraddizione in evidenza"
ask "Qual è il budget complessivo del progetto?"
show_answer
expect "$(answer_value 'a.contradictions.length')" "1" "la contraddizione fra i due SAL è riportata con entrambi i lati"
expect "$(answer_value 'a.contradictions[0].sides.map(s=>s.source.verified).join()')" "true,true" "ogni lato cita una fonte verificata"
expect "$(answer_value 'a.segments.every(s=>s.text!==null && s.sources.every(x=>x.verified))')" "true" "ogni frase è sostenuta da fonti lette e verificate"

step "5/8 Verifica frase per frase: un numero inventato dal modello viene sospeso"
ask "Qual è il budget complessivo del progetto? #inventa"
show_answer
expect "$(answer_value 'a.segments[0].text === null')" "true" "la frase con «123.456 euro» (mai letto in nessuna fonte) non viene mostrata"
expect "$(answer_value 'a.checks.anomalies > 0')" "true" "l'anomalia è contata fra i controlli"

step "6/8 Persone: il modello non vede i nomi, la risposta sì"
ask "Chi deve inviare il piano di rientro al cliente?"
show_answer
expect "$(answer_value 'a.segments.some(s=>(s.text ?? "").includes("Paola Prova"))')" "true" "nella risposta c'è «Paola Prova»"
expect "$(grep -c 'Paola' "$LLM_FAKE_TRANSCRIPT" || true)" "0" "nessun «Paola» in ciò che il modello ha ricevuto (domande e letture comprese)"

step "7/8 Una domanda senza risposta nelle fonti: il sistema lo dice, non inventa"
ask "Quanti giorni di ferie restano al gruppo?"
show_answer
expect "$(answer_value 'a.segments.length + "/" + a.absences.length')" "0/1" "nessuna frase, una segnalazione di cosa manca"

step "8/8 Storico e permessi"
expect "$(call "$paola" GET "/projects/$slug/questions" | node -pe 'JSON.parse(require("fs").readFileSync(0)).questions.length')" "4" "le 4 domande di Paola sono nel suo storico"
expect "$(call "$marco" GET "/projects/$slug/questions" | field error)" "not_found" "Marco (non membro) non vede il progetto: 404"
call "$paola" POST "/projects/$slug/members" '{"email":"marco.esempio@example.test"}' >/dev/null
expect "$(call "$marco" GET "/projects/$slug/questions" | node -pe 'JSON.parse(require("fs").readFileSync(0)).questions.length')" "0" "Marco, ora membro, non vede le domande di Paola: ognuno ha il suo storico"
expect "$(call "$marco" GET "/projects/$slug/questions/$question_id" | field error)" "not_found" "né può aprirne una per id: 404"

finish "Demo 05 completata. Nel browser: $base/projects/$slug/ask (copione, passi 9–11)"
