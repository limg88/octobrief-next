#!/usr/bin/env bash
# Demo 04 — Fonti e alimentatori: ingest con token, feeder (file e cartella), Jira (finto), freschezza.
# Uso: bash demo/04-fonti/run.sh        (si ferma alla fine)
#      KEEP=1 bash demo/04-fonti/run.sh (lascia tutto acceso per la parte nel browser)
set -euo pipefail
cd "$(dirname "$0")/../.."
source demo/lib.sh

paola=.tmp/demo-04-paola.jar
marco=.tmp/demo-04-marco.jar
docs=.tmp/demo-04-docs
suffix="$(date +%H%M%S)"
project_name="Borea ${suffix}"
export LLM_FAKE_TRANSCRIPT="$PWD/.tmp/demo-04-modello.jsonl"

feeder() { node apps/feeder/src/cli.ts "$@" --server "$base"; }
sources() { call "$paola" GET "/projects/$slug/sources"; }
documents() { call "$paola" GET "/projects/$slug/documents"; }
worker_sql() {
  docker compose --env-file .env.local exec -T -e PGPASSWORD="$(grep '^WORKER_DB_PASSWORD=' .env.local | cut -d= -f2-)" postgres \
    psql -qtA -U octobrief_worker -d octobrief -c "$1" | tail -1 | tr -d ' '
}
# wait_until <description> <command that prints 0 when done>
wait_until() {
  for _ in $(seq 1 90); do
    [ "$(eval "$2")" = "0" ] && { ok "$1"; return; }
    sleep 1
  done
  fail "$1 (tempo scaduto)"
}

step "1/9 Prerequisiti, dipendenze e database (migrazione 0004: fonti, chiave dei segreti)"
check_prerequisites
prepare_database
rm -f "$LLM_FAKE_TRANSCRIPT"
grep -q '^SECRETS_KEY=' .env.local && ok "SECRETS_KEY presente in .env.local (generata da pnpm db:setup)"

step "2/9 Un Jira finto in locale (progetto sintetico BOR, 3 attività) e i documenti sintetici"
rm -f .tmp/demo-04-jira.url
node demo/04-fonti/fake-jira.ts .tmp/demo-04-jira.url >/dev/null &
jira_pid=$!
for _ in $(seq 1 30); do [ -s .tmp/demo-04-jira.url ] && break; sleep 0.2; done
export SOURCES_DEV_JIRA_URL="$(cat .tmp/demo-04-jira.url)"
echo "  Jira finto su $SOURCES_DEV_JIRA_URL"
rm -rf "$docs" && mkdir -p "$docs/cartella"
node tools/synthetic/src/cli.ts "$docs/sintetici" 1 >/dev/null
cp "$docs"/sintetici/SAL-*-2026-11-04.md "$docs"/sintetici/Verbale-*.docx "$docs/cartella/"
cat >"$docs/posta.json" <<'JSON'
{
  "dataAsOf": "2026-11-12T08:00:00Z",
  "documents": [
    {
      "externalId": "mail-AAMk-001",
      "version": "2026-11-10T09:12:00Z",
      "title": "RE: Budget Borea",
      "mediaType": "text/markdown",
      "text": "Da: Carla Cliente <carla.cliente@cliente.example>\nA: Paola Prova\nData: 10 novembre 2026\nOggetto: RE: Budget Borea\n\nIl budget approvato dal comitato resta di 890.000 euro.\nCarla Cliente deve confermare la data del collaudo entro venerdì.",
      "originAt": "2026-11-10T09:12:00Z",
      "url": "https://outlook.office.com/mail/id/AAMk-001",
      "people": [
        { "displayName": "Carla Cliente", "email": "carla.cliente@cliente.example", "untrusted": true }
      ]
    },
    {
      "externalId": "meeting-19:abc-002",
      "version": "2026-11-11T15:00:00Z",
      "title": "Allineamento settimanale Borea",
      "mediaType": "text/markdown",
      "text": "Riunione Teams dell'11 novembre 2026. Partecipanti: Paola Prova, Carla Cliente.\n\nCarla Cliente: il rischio principale resta il ritardo del fornitore.\nPaola Prova: la consegna del modulo è prevista per il 30 novembre 2026.",
      "originAt": "2026-11-11T15:00:00Z",
      "people": [
        { "displayName": "Carla Cliente", "email": "carla.cliente@cliente.example", "untrusted": true }
      ]
    }
  ]
}
JSON
ok "posta.json (una mail e una riunione sintetiche) e una cartella con 2 file"

step "3/9 Avvio di web, worker e issuer finto; Paola crea il progetto"
start_dev .tmp/demo-04.log
trap 'kill "$jira_pid" 2>/dev/null || true; [ "${KEEP:-0}" = "1" ] || kill -- -"$dev_pid" 2>/dev/null || true' EXIT
login paola "$paola"
login marco "$marco"
call "$paola" POST /projects "{\"name\":\"${project_name}\"}" >/dev/null
slug="$(call "$paola" GET /projects | node -pe "JSON.parse(require('fs').readFileSync(0)).projects.find(p=>p.name==='${project_name}').slug")"
project_id="$(call "$paola" GET "/projects/$slug" | field id)"
ok "progetto $slug"

step "4/9 Fonte «Microsoft 365»: il token dell'alimentatore si vede una volta sola"
created="$(call "$paola" POST "/projects/$slug/sources" '{"kind":"m365","name":"Posta e riunioni"}')"
mail_source="$(echo "$created" | field source.id)"
mail_token="$(echo "$created" | field ingestToken)"
echo "  fonte $mail_source · token ${mail_token:0:8}… (nel database c'è solo il suo SHA-256)"
expect "$(sources | node -pe 'JSON.stringify(JSON.parse(require("fs").readFileSync(0)).sources[0]).includes("obf_")')" "false" "l'elenco delle fonti non restituisce mai il token"

step "5/9 L'alimentatore consegna la posta (dal PC del PM, senza permessi Graph)"
OCTOBRIEF_FEEDER_TOKEN="$mail_token" feeder file --source "$mail_source" --path "$docs/posta.json" | sed 's/^/  /'
OCTOBRIEF_FEEDER_TOKEN="$mail_token" feeder file --source "$mail_source" --path "$docs/posta.json" | sed 's/^/  /'
ok "la seconda consegna non duplica nulla (stessa versione = invariato)"
expect "$(OCTOBRIEF_FEEDER_TOKEN=obf_sbagliato feeder file --source "$mail_source" --path "$docs/posta.json" 2>&1 | grep -c 'unauthorized')" "1" "con un token sbagliato l'alimentatore riceve 401"

step "6/9 Fonte «Cartella»: l'alimentatore legge una cartella del PC"
created="$(call "$paola" POST "/projects/$slug/sources" '{"kind":"files","name":"Cartella di progetto"}')"
OCTOBRIEF_FEEDER_TOKEN="$(echo "$created" | field ingestToken)" feeder folder --source "$(echo "$created" | field source.id)" --path "$docs/cartella" | sed 's/^/  /'
wait_until "tutti i documenti estratti, classificati e letti dal modello" \
  "call $paola GET /projects/$slug/knowledge | field progress.reading"
documents | node -e '
  const { documents } = JSON.parse(require("fs").readFileSync(0))
  for (const d of documents) {
    const at = d.originAt ? new Date(d.originAt).toLocaleString("it-IT", { timeZone: "Europe/Rome", dateStyle: "short", timeStyle: "short" }) : "non dichiarata"
    console.log(`  ${d.fileName}\n    da «${d.sourceName}» · data alla fonte ${at} · ${d.kind} · data del documento: ${new Date(d.documentDate).toLocaleDateString("it-IT", { timeZone: "Europe/Rome" })} (da ${d.dateSource})`)
  }'
expect "$(documents | node -pe 'JSON.parse(require("fs").readFileSync(0)).documents.filter(d=>d.sourceName).length')" "4" "4 documenti arrivati dalle fonti; mail e riunione portano la data del sistema di origine"

step "7/9 Le persone nominate dalle fonti non arrivano mai al modello"
expect "$(worker_sql "SELECT count(*) FROM project_people WHERE project_id = '$project_id' AND display_name = 'Carla Cliente' AND untrusted")" "1" "«Carla Cliente» (esterna) è registrata fra le persone del progetto"
expect "$(grep -c 'Carla' "$LLM_FAKE_TRANSCRIPT" || true)" "0" "nessun «Carla» in ciò che il modello ha ricevuto"
expect "$(call "$paola" GET "/projects/$slug/knowledge" | node -pe 'JSON.parse(require("fs").readFileSync(0)).facts.filter(f=>f.statement.startsWith("Carla Cliente")).length > 0')" "true" "nei fatti il nome è al suo posto"

step "8/9 Fonte «Jira»: credenziale verificata, cifrata, e lettura dal worker"
jira_body() { echo "{\"kind\":\"jira\",\"name\":\"Jira Borea\",\"config\":{\"site\":\"demo\",\"email\":\"octobrief@example.test\",\"readOnlyToken\":true},\"scope\":[\"BOR\"],\"secret\":\"$1\"}"; }
expect "$(call "$paola" POST "/projects/$slug/sources" "$(jira_body token-sbagliato)" | field reason)" "source_auth_failed" "con un token sbagliato la fonte non viene collegata"
created="$(call "$paola" POST "/projects/$slug/sources" "$(jira_body token-finto-demo)")"
jira_source="$(echo "$created" | field source.id)"
expect "$(echo "$created" | field "source.perimeter[0]")" "project:10001" "perimetro: solo il progetto BOR (l'altro progetto del Jira resta fuori)"
expect "$(worker_sql "SELECT (secret_ciphertext IS NOT NULL AND position('token-finto-demo'::bytea in secret_ciphertext) = 0) FROM sources WHERE id = '$jira_source'")" "t" "nel database la credenziale è cifrata (AES-256-GCM), mai in chiaro"
wait_until "il worker ha letto Jira" \
  "call $paola GET /projects/$slug/sources | node -pe 'JSON.parse(require(\"fs\").readFileSync(0)).sources.find(s=>s.kind===\"jira\").lastSyncAt ? 0 : 1'"
expect "$(worker_sql "SELECT count(*) FROM tracker_items WHERE source_id = '$jira_source'")" "3" "3 attività di Jira salvate come dati strutturati"
wait_until "l'export del backlog è stato elaborato" \
  "call $paola GET /projects/$slug/documents | node -pe 'JSON.parse(require(\"fs\").readFileSync(0)).documents.filter(d=>d.status===\"pending\").length'"
expect "$(documents | node -pe 'JSON.parse(require("fs").readFileSync(0)).documents.filter(d=>d.sourceName==="Jira Borea" && d.kind==="backlog_export").length')" "1" "l'export del backlog è un documento, classificato dal sistema"
sources | node -e '
  const { sources } = JSON.parse(require("fs").readFileSync(0))
  const at = (v) => v ? new Date(v).toLocaleString("it-IT", { timeZone: "Europe/Rome", dateStyle: "short", timeStyle: "short" }) : "mai"
  for (const s of sources) console.log(`  ${s.name} (${s.kind}) · documenti ${s.documentCount} · ultima consegna ${at(s.lastSyncAt)} · dati aggiornati al ${at(s.dataAsOf)}`)'

step "9/9 Permessi: chi non è membro non vede le fonti; il token si può rigenerare"
expect "$(call "$marco" GET "/projects/$slug/sources" | field error)" "not_found" "Marco (non membro) non vede le fonti: 404"
new_token="$(call "$paola" POST "/projects/$slug/sources/$mail_source/token" | field ingestToken)"
expect "$(OCTOBRIEF_FEEDER_TOKEN="$mail_token" feeder file --source "$mail_source" --path "$docs/posta.json" 2>&1 | grep -c 'unauthorized')" "1" "dopo la rigenerazione il vecchio token non vale più"
OCTOBRIEF_FEEDER_TOKEN="$new_token" feeder file --source "$mail_source" --path "$docs/posta.json" | sed 's/^/  /'

finish "Demo 04 completata. Nel browser: $base/projects/$slug/sources (copione, passi 10–12)"
