#!/usr/bin/env bash
# Demo 02 — Documenti: caricamento, estrazione del testo, classificazione, RLS, eliminazione.
# Uso: bash demo/02-documenti/run.sh        (si ferma alla fine)
#      KEEP=1 bash demo/02-documenti/run.sh (lascia tutto acceso per la parte nel browser)
set -euo pipefail
cd "$(dirname "$0")/../.."
source demo/lib.sh

paola=.tmp/demo-02-paola.jar
marco=.tmp/demo-02-marco.jar
docs=.tmp/demo-02-docs
suffix="$(date +%H%M%S)"
project_name="Aurora ${suffix}"

# upload <jar> <file>: multipart upload with the CSRF token.
upload() {
  curl -s -b "$1" -H "origin: $base" -H "x-csrf-token: $(csrf "$1")" \
    -F "file=@$2" "$base/api/projects/$slug/documents"
}

table() {
  call "$paola" GET "/projects/$slug/documents" | node -e '
    const { documents } = JSON.parse(require("fs").readFileSync(0))
    for (const d of documents) {
      const date = d.documentDate ? `${new Date(d.documentDate).toLocaleDateString("it-IT", { timeZone: "Europe/Rome" })} (da ${d.dateSource})` : "-"
      const todo = d.uncertain.length ? ` · da confermare: ${d.uncertain.join(", ")}` : ""
      console.log(`  ${d.fileName}\n    ${d.status} · ${d.kind} · ${d.audience} (${d.audienceSource}) · ${date} · brani: ${d.chunkCount}${todo}`)
    }'
}

step "1/8 Prerequisiti, dipendenze e database (migrazione 0002: documenti + RLS)"
check_prerequisites
prepare_database
blob_dir="$(grep '^BLOB_DIR=' .env.local | cut -d= -f2-)"

step "2/8 Documenti sintetici (nessun dato reale): progetto generato dal seme 1"
rm -rf "$docs"
node tools/synthetic/src/cli.ts "$docs" 1
sal="$(ls "$docs"/SAL-*-2026-11-04.md)"
minutes="$(ls "$docs"/Verbale-*.docx)"
note="$(ls "$docs"/Nota-fornitore-*.txt)"
ls -1 "$sal" "$minutes" "$note" | sed 's/^/  /'

step "3/8 Avvio di web, worker e issuer finto; Paola crea il progetto"
start_dev .tmp/demo-02.log
login paola "$paola"
login marco "$marco"
call "$paola" POST /projects "{\"name\":\"${project_name}\"}" >/dev/null
slug="$(call "$paola" GET /projects | node -pe "JSON.parse(require('fs').readFileSync(0)).projects.find(p=>p.name==='${project_name}').slug")"
ok "progetto $slug (Marco non è membro)"

step "4/8 Paola carica 3 documenti (Markdown, Word, testo)"
for file in "$sal" "$minutes" "$note"; do
  upload "$paola" "$file" | node -pe 'const d=JSON.parse(require("fs").readFileSync(0)); `  ${d.fileName} → ${d.status}`'
done
expect "$(upload "$paola" "$sal" | field error)" "conflict" "lo stesso file due volte: 409"

step "5/8 Il worker estrae il testo (processo isolato) e classifica con regole"
for _ in $(seq 1 60); do
  pending="$(call "$paola" GET "/projects/$slug/documents" | node -pe 'JSON.parse(require("fs").readFileSync(0)).documents.filter(d=>d.status==="pending").length')"
  [ "$pending" = "0" ] && break
  sleep 1
done
expect "$pending" "0" "tutti i documenti elaborati"
table

step "6/8 Testo estratto del verbale Word, con la posizione di ogni brano"
minutes_id="$(call "$paola" GET "/projects/$slug/documents" | node -pe 'JSON.parse(require("fs").readFileSync(0)).documents.find(d=>d.fileName.endsWith(".docx")).id')"
call "$paola" GET "/projects/$slug/documents/$minutes_id" | node -pe '
  JSON.parse(require("fs").readFileSync(0)).chunks.map(c=>`  [${JSON.stringify(c.locator)}] ${c.text.replace(/\n/g," / ")}`).join("\n")'

step "7/8 Il PM corregge la classificazione; le regole proteggono i dati"
sal_id="$(call "$paola" GET "/projects/$slug/documents" | node -pe 'JSON.parse(require("fs").readFileSync(0)).documents.find(d=>d.fileName.startsWith("SAL-")).id')"
expect "$(call "$paola" PATCH "/projects/$slug/documents/$sal_id" '{"audience":"client"}' | field audienceSource)" "pm" "destinatari del SAL: cliente, scelto dal PM"
expect "$(call "$marco" GET "/projects/$slug/documents" | field error)" "not_found" "Marco (non membro) non vede i documenti: 404"
db_rows() {
  docker compose --env-file .env.local exec -T -e PGPASSWORD="$(grep '^APP_DB_PASSWORD=' .env.local | cut -d= -f2-)" postgres \
    psql -qtA -U octobrief_app -d octobrief -c "$1" | tail -1 | tr -d ' '
}
paola_id="$(curl -s -b "$paola" "$base/api/me" | field user.id)"
expect "$(db_rows "SELECT count(*) FROM documents")" "0" "RLS nel database: il ruolo web senza utente non vede righe"
expect "$(db_rows "BEGIN; SELECT set_config('app.user_id', '$paola_id', true); SELECT count(*) FROM documents d JOIN projects p ON p.id = d.project_id WHERE p.slug = '$slug'; COMMIT;")" "3" "come Paola vede i 3 documenti del progetto"

step "8/8 Eliminazione: documento, testo e file spariscono"
note_id="$(call "$paola" GET "/projects/$slug/documents" | node -pe 'JSON.parse(require("fs").readFileSync(0)).documents.find(d=>d.fileName.startsWith("Nota-")).id')"
project_id="$(call "$paola" GET "/projects/$slug" | field id)"
before="$(ls "$blob_dir/$project_id" | wc -l | tr -d ' ')"
expect "$(curl -s -o /dev/null -w '%{http_code}' -b "$paola" -X DELETE -H "origin: $base" -H "x-csrf-token: $(csrf "$paola")" "$base/api/projects/$slug/documents/$note_id")" "204" "DELETE: 204"
after="$(ls "$blob_dir/$project_id" | wc -l | tr -d ' ')"
expect "${before}→${after}" "3→2" "file rimosso da BLOB_DIR"
echo "  Conservazione: il worker elimina ogni ora i documenti più vecchi di RETENTION_DAYS (ora $(grep '^RETENTION_DAYS=' .env.local | cut -d= -f2-) giorni)."

finish "Demo 02 completata. Nel browser: $base/projects/$slug/memory (copione, passi 9–12)"
