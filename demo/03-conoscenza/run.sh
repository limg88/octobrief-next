#!/usr/bin/env bash
# Demo 03 — Conoscenza: fatti con citazioni verificate, contraddizioni, pseudonimizzazione, vettori.
# Uso: bash demo/03-conoscenza/run.sh        (si ferma alla fine)
#      KEEP=1 bash demo/03-conoscenza/run.sh (lascia tutto acceso per la parte nel browser)
set -euo pipefail
cd "$(dirname "$0")/../.."
source demo/lib.sh

paola=.tmp/demo-03-paola.jar
marco=.tmp/demo-03-marco.jar
docs=.tmp/demo-03-docs
suffix="$(date +%H%M%S)"
project_name="Borea ${suffix}"
# What the (fake) model receives, one JSON line per call: the proof that no name reaches it.
export LLM_FAKE_TRANSCRIPT="$PWD/.tmp/demo-03-modello.jsonl"

upload() {
  curl -s -b "$1" -H "origin: $base" -H "x-csrf-token: $(csrf "$1")" \
    -F "file=@$2" "$base/api/projects/$slug/documents" >/dev/null
}

knowledge() { call "$paola" GET "/projects/$slug/knowledge"; }

# Waits until every uploaded document has been read by the model.
wait_reading() {
  for _ in $(seq 1 90); do
    reading="$(knowledge | field progress.reading)"
    [ "$reading" = "0" ] && break
    sleep 1
  done
  expect "$reading" "0" "tutti i documenti letti"
}

show_facts() {
  knowledge | node -e '
    const { facts } = JSON.parse(require("fs").readFileSync(0))
    for (const f of facts) {
      const flag = f.state === "contested" ? "  ⚠ in contraddizione" : ""
      console.log(`  [${f.kind}] ${f.statement}${f.value ? ` → ${f.value}` : ""}${flag}`)
      for (const s of f.sources) console.log(`      «${s.excerpt}» (${s.fileName}, ${JSON.stringify(s.locator)})`)
    }'
}

# count_facts <js predicate on f>: how many facts satisfy it.
count_facts() { knowledge | node -pe "JSON.parse(require('fs').readFileSync(0)).facts.filter(f=>$1).length"; }

worker_sql() {
  docker compose --env-file .env.local exec -T -e PGPASSWORD="$(grep '^WORKER_DB_PASSWORD=' .env.local | cut -d= -f2-)" postgres \
    psql -qtA -U octobrief_worker -d octobrief -c "$1" | tail -1 | tr -d ' '
}

step "1/9 Prerequisiti, dipendenze e database (migrazione 0003: fatti, fonti, vettori)"
check_prerequisites
prepare_database
rm -f "$LLM_FAKE_TRANSCRIPT"

step "2/9 Documenti sintetici (nessun dato reale) e una nota con il nome di una persona"
rm -rf "$docs"
node tools/synthetic/src/cli.ts "$docs" 1 >/dev/null
sal="$(ls "$docs"/SAL-*-2026-11-04.md)"
sal2="$(ls "$docs"/SAL-*-rev2-*.md)"
note="$(ls "$docs"/Nota-fornitore-*.txt)"
actions="$docs/Azioni-2026-11-06.txt"
cat >"$actions" <<'NOTE'
Paola Prova deve inviare il piano di rientro al cliente entro il 20 novembre 2026.
Per conferme scrivere a paola.prova@example.test.
NOTE
ls -1 "$sal" "$sal2" "$note" "$actions" | sed 's/^/  /'

step "3/9 Avvio di web, worker (modello finto) e issuer finto; Paola crea il progetto"
start_dev .tmp/demo-03.log
login paola "$paola"
login marco "$marco"
call "$paola" POST /projects "{\"name\":\"${project_name}\"}" >/dev/null
slug="$(call "$paola" GET /projects | node -pe "JSON.parse(require('fs').readFileSync(0)).projects.find(p=>p.name==='${project_name}').slug")"
ok "progetto $slug (Marco non è membro)"

step "4/9 Tre documenti: il worker li estrae, li classifica e il modello li legge"
for file in "$sal" "$note" "$actions"; do upload "$paola" "$file"; done
wait_reading
show_facts

step "5/9 Citazioni verificate: ogni brano citato è scritto così nel documento"
verified="$(knowledge | node -e '
  const { facts } = JSON.parse(require("fs").readFileSync(0))
  console.log(JSON.stringify(facts.flatMap(f => f.sources.map(s => [s.documentId, s.excerpt]))))')"
missing=0
total=0
while IFS=$'\t' read -r document_id excerpt; do
  total=$((total + 1))
  call "$paola" GET "/projects/$slug/documents/$document_id" \
    | EXCERPT="$excerpt" node -e '
      const { chunks } = JSON.parse(require("fs").readFileSync(0))
      process.exit(chunks.some(c => c.text.includes(process.env.EXCERPT)) ? 0 : 1)' || missing=$((missing + 1))
done < <(node -e 'for (const [d, e] of JSON.parse(process.argv[1])) console.log(`${d}\t${e}`)' "$verified")
expect "$missing" "0" "$total citazioni su $total trovate parola per parola nel testo estratto"
expect "$(count_facts 'f.statement.includes("Ignora")')" "0" "la frase «Ignora le istruzioni…» della nota non è diventata un fatto"

step "6/9 Pseudonimizzazione: il modello non ha mai visto nomi né email"
expect "$(grep -c 'Paola' "$LLM_FAKE_TRANSCRIPT" || true)" "0" "nessun «Paola» in ciò che il modello ha ricevuto"
expect "$(grep -c 'example.test' "$LLM_FAKE_TRANSCRIPT" || true)" "0" "nessuna email in ciò che il modello ha ricevuto"
echo "  Il modello ha letto: $(grep -o '\[PERSONA_1\] deve inviare[^"\\]*' "$LLM_FAKE_TRANSCRIPT" | head -1)"
expect "$(count_facts 'f.statement.startsWith("Paola Prova deve inviare")')" "1" "nel fatto salvato il nome è tornato al suo posto"

step "7/9 Vettori: ogni brano ha il suo embedding (codificatore finto, 1024 dimensioni)"
project_id="$(call "$paola" GET "/projects/$slug" | field id)"
expect "$(worker_sql "SELECT count(*) FILTER (WHERE embedding IS NULL) FROM document_chunks WHERE project_id = '$project_id'")" "0" "nessun brano senza vettore"
echo "  $(worker_sql "SELECT count(*) || '·brani,·codificatore·' || min(encoder) || ',·dimensioni·' || min(vector_dims(embedding)) FROM document_chunks WHERE project_id = '$project_id'" | tr '·' ' ')"

step "8/9 Una revisione del SAL dice un budget diverso: la contraddizione resta visibile"
upload "$paola" "$sal2"
wait_reading
show_facts | grep -A1 'economics' || true
expect "$(count_facts 'f.kind==="economics" && f.state==="contested"')" "2" "due budget, entrambi «in contraddizione», nessuno scelto in silenzio"
expect "$(count_facts 'f.kind==="status" && f.sources.length===2')" "1" "l'avanzamento, uguale nei due SAL, è un solo fatto con due fonti"

step "9/9 Permessi ed eliminazione"
expect "$(call "$marco" GET "/projects/$slug/knowledge" | field error)" "not_found" "Marco (non membro) non vede i fatti: 404"
sal2_id="$(call "$paola" GET "/projects/$slug/documents" | node -pe 'JSON.parse(require("fs").readFileSync(0)).documents.find(d=>d.fileName.includes("rev2")).id')"
call "$paola" DELETE "/projects/$slug/documents/$sal2_id" >/dev/null
expect "$(count_facts 'f.kind==="economics"')/$(count_facts 'f.state==="contested"')" "1/0" "eliminata la revisione: resta un solo budget, non più in contraddizione"

finish "Demo 03 completata. Nel browser: $base/projects/$slug/memory (copione, passi 10–12)"
