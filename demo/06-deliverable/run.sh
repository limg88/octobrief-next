#!/usr/bin/env bash
# Demo 06 — Deliverable: SAL economico e Mail al cliente, dai dati al file approvato.
# Uso: bash demo/06-deliverable/run.sh        (si ferma alla fine)
#      KEEP=1 bash demo/06-deliverable/run.sh (lascia tutto acceso per la parte nel browser)
set -euo pipefail
cd "$(dirname "$0")/../.."
source demo/lib.sh

paola=.tmp/demo-06-paola.jar
marco=.tmp/demo-06-marco.jar
docs=.tmp/demo-06-docs
suffix="$(date +%H%M%S)"
project_name="Aurora ${suffix}"
# The fake model puts a figure no source holds in the first text of a first draft: an anomaly
# to find, a change to ask, the anomaly gone.
export LLM_FAKE_INVENT_IN_DRAFTS=true

step "1/9 Prerequisiti, database (migrazione 0006) e renderer isolato (Python, senza rete)"
check_prerequisites
prepare_database
start_renderer

step "2/9 Progetto sintetico: ordine, fatture e i valori che il PM scrive nel modulo del SAL"
rm -rf "$docs"
names="$(node demo/06-deliverable/sal-data.ts "$docs")"
order_file="$(echo "$names" | field order)"
invoice_1="$(echo "$names" | field 'invoices[0]')"
invoice_2="$(echo "$names" | field 'invoices[1]')"
echo "  ordine: $order_file · fatture: $invoice_1, $invoice_2"

step "3/9 Avvio; Paola crea il progetto e carica ordine e fatture"
start_dev .tmp/demo-06.log
login paola "$paola"
login marco "$marco"
call "$paola" POST /projects "{\"name\":\"${project_name}\"}" >/dev/null
slug="$(call "$paola" GET /projects | node -pe "JSON.parse(require('fs').readFileSync(0)).projects.find(p=>p.name==='${project_name}').slug")"
order_id="$(upload "$paola" "$docs/$order_file")"
invoice_1_id="$(upload "$paola" "$docs/$invoice_1")"
invoice_2_id="$(upload "$paola" "$docs/$invoice_2")"
for _ in $(seq 1 60); do
  pending="$(call "$paola" GET "/projects/$slug/documents" | node -pe 'JSON.parse(require("fs").readFileSync(0)).documents.filter(d=>d.status==="pending").length')"
  [ "$pending" = "0" ] && break
  sleep 1
done
call "$paola" GET "/projects/$slug/documents" | node -pe 'JSON.parse(require("fs").readFileSync(0)).documents.map(d=>`  ${d.fileName} → ${d.kind} (${d.audience})`).join("\n")'
expect "$(call "$paola" GET "/projects/$slug/documents" | node -pe 'JSON.parse(require("fs").readFileSync(0)).documents.find(d=>d.fileName.startsWith("Ordine-")).kind')" "purchase_order" "l'ordine è riconosciuto come ordine d'acquisto (prerequisito del SAL)"

step "4/9 Catalogo delle ricette"
call "$paola" GET /recipes | node -pe 'JSON.parse(require("fs").readFileSync(0)).recipes.map(r=>`  ${r.title} (${r.slug}) → ${r.formats.join(", ")} · per ${r.audience}`).join("\n")'

step "5/9 SAL economico: il codice raccoglie i dati, il modello scrive un solo testo, i controlli giudicano"
parameters="$(sed -e "s/ORDER/$order_id/" -e "s/INVOICE_1/$invoice_1_id/" -e "s/INVOICE_2/$invoice_2_id/" "$docs/sal-parameters.json")"
sal="$(call "$paola" POST "/projects/$slug/runs" "{\"recipeSlug\":\"sal-economico\",\"parameters\":$parameters}" | field id)"
wait_run "$sal" 'v.run.status === "ready" || v.run.status === "failed"' "bozza del SAL pronta"
expect "$(run_value "$sal" 'v.run.status')" "ready" "il SAL è in attesa del giudizio del PM"
show_findings "$sal"
run_view "$sal" | node -e '
  const v = JSON.parse(require("fs").readFileSync(0))
  const values = v.document.sections.flatMap((s) => s.blocks).filter((b) => b.kind === "value")
  for (const b of values.slice(0, 6)) console.log(`  ${b.label}: ${b.cell?.text ?? "—"}`)'
expect "$(run_value "$sal" 'v.approvable')" "false" "con un'anomalia aperta il SAL non è approvabile"
expect "$(curl -s -o /dev/null -w '%{http_code}' -b "$paola" -X POST -H "origin: $base" -H "x-csrf-token: $(csrf "$paola")" "$base/api/projects/$slug/runs/$sal/approval")" "409" "e l'approvazione viene rifiutata: 409"

step "6/9 Chiedi modifica: il testo con il numero inventato viene riscritto"
slot="$(run_value "$sal" 'v.findings.find(f=>f.status==="open" && f.slot).slot')"
call "$paola" POST "/projects/$slug/runs/$sal/changes" "{\"slots\":[\"$slot\"],\"request\":\"Togli la cifra che non viene dai documenti.\"}" >/dev/null
wait_run "$sal" 'v.revision === 2 && v.run.status === "ready"' "seconda revisione pronta (solo il testo «${slot}» è stato riscritto)"
show_findings "$sal"
expect "$(run_value "$sal" 'v.findings.some(f=>f.text.includes("123.456"))')" "false" "la cifra inventata non c'è più"

step "7/9 Accetta con motivazione ciò che il PM può accettare (il warehouse non è collegato)"
expect "$(accept_finding "$sal" "ok")" "400" "una motivazione di due lettere non basta: 400"
expect "$(accept_finding "$sal" "Il DWSI non è collegato a questo progetto: i residui si controllano a mano sul modulo.")" "200" "anomalia accettata, con la motivazione che resta agli atti"
show_findings "$sal"
expect "$(run_value "$sal" 'v.approvable')" "true" "nessuna anomalia aperta: il SAL è approvabile"

step "8/9 Approva: i file per il cliente, in Markdown e in Excel dal modulo SAL"
expect "$(call "$marco" POST "/projects/$slug/runs/$sal/approval" | field error)" "not_found" "Marco (non membro) non può approvare: 404"
call "$paola" POST "/projects/$slug/runs/$sal/approval" >/dev/null
wait_run "$sal" 'v.run.approval === "approved" || v.run.approval === "render_failed"' "file prodotti"
expect "$(run_value "$sal" 'v.run.approval')" "approved" "SAL approvato"
run_view "$sal" | node -pe 'JSON.parse(require("fs").readFileSync(0)).files.map(f=>`  ${f.fileName} (${f.audience}, ${f.sizeBytes} byte)`).join("\n")'
xlsx_id="$(run_value "$sal" 'v.files.find(f=>f.format==="xlsx" && f.audience==="client").id')"
expect "$(download "$sal" "$xlsx_id" .tmp/demo-06-sal-cliente.xlsx)" "200" "scaricato .tmp/demo-06-sal-cliente.xlsx"
expect "$(head -c 2 .tmp/demo-06-sal-cliente.xlsx)" "PK" "è un vero file Excel (archivio OOXML), prodotto dal renderer isolato"
md_id="$(run_value "$sal" 'v.files.find(f=>f.format==="md").id')"
download "$sal" "$md_id" .tmp/demo-06-sal-cliente.md >/dev/null
sed -n '1,14p' .tmp/demo-06-sal-cliente.md | sed 's/^/  │ /'

step "9/9 Mail al cliente: stesso motore, altra ricetta (solo Markdown)"
mail_body='{"recipeSlug":"mail-cliente","parameters":{"communication_type":{"type":"choice","value":"decision_request"},"facts":{"type":"text","value":"Il collaudo del modulo è previsto per il 30 novembre 2026."},"request":{"type":"text","value":"Confermare la data del collaudo"},"request_owner":{"type":"text","value":"Responsabile del cliente"},"request_due":{"type":"date","day":"2026-11-20"}}}'
mail="$(call "$paola" POST "/projects/$slug/runs" "$mail_body" | field id)"
wait_run "$mail" 'v.run.status === "ready" || v.run.status === "failed"' "bozza della mail pronta"
show_findings "$mail"
slot="$(run_value "$mail" 'v.findings.find(f=>f.status==="open" && f.slot).slot')"
call "$paola" POST "/projects/$slug/runs/$mail/changes" "{\"slots\":[\"$slot\"],\"request\":\"Niente cifre senza fonte.\"}" >/dev/null
wait_run "$mail" 'v.revision === 2 && v.run.status === "ready"' "oggetto riscritto"
call "$paola" POST "/projects/$slug/runs/$mail/approval" >/dev/null
wait_run "$mail" 'v.run.approval === "approved"' "mail approvata"
mail_md="$(run_value "$mail" 'v.files.find(f=>f.audience==="client").id')"
download "$mail" "$mail_md" .tmp/demo-06-mail.md >/dev/null
sed 's/^/  │ /' .tmp/demo-06-mail.md | head -24

call "$paola" GET "/projects/$slug/runs" | node -pe 'JSON.parse(require("fs").readFileSync(0)).runs.map(r=>`  ${r.recipeTitle}: ${r.status}${r.approval ? " · " + r.approval : ""}`).join("\n")'
expect "$(call "$paola" GET "/projects/$slug/runs" | node -pe 'JSON.parse(require("fs").readFileSync(0)).runs.filter(r=>r.approval==="approved").length')" "2" "due deliverable approvati"

finish "Demo 06 completata. Nel browser: $base/projects/$slug/deliverables (copione, passi 10–12)"
