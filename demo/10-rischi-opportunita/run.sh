#!/usr/bin/env bash
# Demo 10 — Rischi e opportunità: una ricetta nuova, scritta come file, sui fatti della memoria.
# Uso: bash demo/10-rischi-opportunita/run.sh        (si ferma alla fine)
#      KEEP=1 bash demo/10-rischi-opportunita/run.sh (lascia tutto acceso per la parte nel browser)
set -euo pipefail
cd "$(dirname "$0")/../.."
source demo/lib.sh

paola=.tmp/demo-10-paola.jar
docs=.tmp/demo-10-docs
project_name="Borea $(date +%H%M%S)"

step "1/5 Prerequisiti, database e renderer isolato"
check_prerequisites
prepare_database
start_renderer

step "2/5 La ricetta è un file JSON, validato all'avvio"
node -e '
  const { recipe } = JSON.parse(require("fs").readFileSync("recipes/risks-and-opportunities.json", "utf8"))
  console.log(`  ${recipe.title} ${recipe.version} · per ${recipe.audience} · ${recipe.render.formats.join(", ")}`)
  for (const s of recipe.sections) console.log(`    ${s.title}: ${s.blocks.map((b) => b.kind).join(", ")}`)'

step "3/5 Avvio; i documenti del progetto diventano fatti (rischi, azioni, decisioni)"
rm -rf "$docs"
node tools/synthetic/src/cli.ts "$docs" 1 >/dev/null
cat >"$docs/Azioni-2026-11-06.txt" <<'NOTE'
Paola Prova deve inviare il piano di rientro al cliente entro il 20 novembre 2026.
Il comitato ha deciso di anticipare il collaudo del modulo di reportistica.
NOTE
start_dev .tmp/demo-10.log
login paola "$paola"
call "$paola" POST /projects "{\"name\":\"${project_name}\"}" >/dev/null
slug="$(call "$paola" GET /projects | node -pe "JSON.parse(require('fs').readFileSync(0)).projects.find(p=>p.name==='${project_name}').slug")"
for file in "$docs"/SAL-*-2026-11-04.md "$docs"/Nota-fornitore-*.txt "$docs/Azioni-2026-11-06.txt"; do upload "$paola" "$file" >/dev/null; done
wait_documents
call "$paola" GET "/projects/$slug/knowledge" | node -pe 'JSON.parse(require("fs").readFileSync(0)).facts.filter(f=>["risk","action","decision"].includes(f.kind)).map(f=>`  [${f.kind}] ${f.statement}`).join("\n")'

step "4/5 Rischi e opportunità: elenchi dai fatti, testi scritti sulle fonti"
run="$(start_run rischi-e-opportunita '{"period":{"type":"period","from":"2026-11-01","to":"2026-11-30"},"focus":{"type":"text","value":"Consegna del modulo di reportistica"}}')"
wait_run "$run" 'v.run.status === "ready" || v.run.status === "failed"' "bozza pronta"
show_findings "$run"
run_view "$run" | node -e '
  const v = JSON.parse(require("fs").readFileSync(0))
  for (const s of v.document.sections) for (const b of s.blocks) {
    if (b.kind === "list") console.log(`  ${b.title}: ${b.items.map((i) => i.cells[0].text).join(" · ") || "—"}`)
    if (b.kind === "text" && b.segments.length) console.log(`  ${b.title ?? s.title}: ${b.segments.map((g) => g.text).join(" ")}`)
  }'
expect "$(run_value "$run" 'v.document.sections.flatMap(s=>s.blocks).find(b=>b.id==="risks_list").items.length > 0')" "true" "i rischi dell'elenco vengono dai fatti della memoria, non dal modello"
expect "$(run_value "$run" 'JSON.stringify(v.document).includes("Ignora le istruzioni")')" "false" "la frase-istruzione della nota del fornitore non è entrata nel documento"

step "5/5 Approva e scarica il documento Word"
accept_all "$run" "Valutazione rivista dal PM."
approve_run "$run"
download_format "$run" docx .tmp/demo-10-rischi.docx
expect "$(head -c 2 .tmp/demo-10-rischi.docx)" "PK" "è un vero file Word"

finish "Demo 10 completata. Nel browser: $base/projects/$slug/deliverables"
