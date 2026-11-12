#!/usr/bin/env bash
# Demo 11 — Deploy on-prem: l'installazione di produzione (immagini, Caddy con HTTPS, database
# senza porte pubblicate) da zero in locale, poi backup, perdita dei dati e ripristino.
# Uso: bash demo/11-deploy/run.sh        (alla fine toglie contenitori e volumi della demo)
#      KEEP=1 bash demo/11-deploy/run.sh (lascia tutto acceso per la parte nel browser)
set -euo pipefail
cd "$(dirname "$0")/../.."
source demo/lib.sh

export OCTOBRIEF_PROJECT=octobrief-demo-11
export OCTOBRIEF_ENV_FILE="$PWD/.tmp/demo-11.env"
export OCTOBRIEF_EXTRA_COMPOSE="$PWD/deploy/compose.demo.yml"
https_port="${DEMO_HTTPS_PORT:-8443}"
issuer_port="${DEMO_ISSUER_PORT:-4321}"
base="https://localhost:${https_port}"
paola=.tmp/demo-11-paola.jar
docs=.tmp/demo-11-docs
backup_dir="$PWD/.tmp/demo-11-backup"
project_name="Aurora $(date +%H%M%S)"
octobrief() { bash deploy/octobrief.sh "$@"; }
# The certificate comes from Caddy's own authority, which this machine does not know.
curl() { command curl -k "$@"; }
wait_web() {
  for _ in $(seq 1 60); do curl -sf "$base/api/health" >/dev/null 2>&1 && return; sleep 1; done
  fail "il web non risponde su $base"
}
wait_issuer() {
  for _ in $(seq 1 30); do
    curl -sf "http://127.0.0.1:${issuer_port}/.well-known/openid-configuration" >/dev/null 2>&1 && return
    sleep 1
  done
  fail "l'issuer finto non risponde"
}
blob_count() { octobrief compose exec -T worker sh -c 'find /data/blobs -type f | wc -l' | tr -d ' \r'; }
# published_ports <service>: the host ports it publishes, summed (0 = none).
published_ports() { octobrief ps "$1" --format '{{range .Publishers}}{{.PublishedPort}} {{end}}' | tr ' ' '\n' | awk '{ sum += $1 } END { print sum + 0 }'; }
project_count() { call "$paola" GET /projects | node -pe 'JSON.parse(require("fs").readFileSync(0)).projects.length'; }

step "1/7 Prerequisiti e file d'ambiente con segreti generati (mai stampati)"
for tool in docker curl node openssl; do command -v "$tool" >/dev/null || fail "Manca $tool"; done
mkdir -p .tmp
rm -rf "$OCTOBRIEF_ENV_FILE" "$backup_dir" "$docs"
SITE_HOST=localhost HTTPS_PORT="$https_port" HTTPS_BIND=127.0.0.1 \
  OIDC_ISSUER="http://127.0.0.1:${issuer_port}" OIDC_ALLOW_INSECURE_ISSUER=true \
  OIDC_CLIENT_ID=octobrief-demo OIDC_CLIENT_SECRET="$(openssl rand -hex 24)" \
  ADMIN_EMAILS=alba.amministratrice@example.test \
  bash deploy/init-env.sh "$OCTOBRIEF_ENV_FILE" | sed 's/^/  /'
echo "FAKE_OIDC_PORT=${issuer_port}" >>"$OCTOBRIEF_ENV_FILE"
# GNU stat first: on Linux `stat -f` describes the filesystem instead of failing.
expect "$(stat -c '%a' "$OCTOBRIEF_ENV_FILE" 2>/dev/null || stat -f '%Lp' "$OCTOBRIEF_ENV_FILE")" "600" "il file d'ambiente è leggibile solo dal proprietario"

step "2/7 Da zero: immagini, database, ruoli, migrazioni, web, worker, renderer e Caddy"
octobrief down -v --remove-orphans >/dev/null 2>&1 || true
# With KEEP=1 the installation stays on, but only if the demo succeeded.
trap 'code=$?; { [ "${KEEP:-0}" = "1" ] && [ "$code" -eq 0 ]; } || octobrief down -v --remove-orphans >/dev/null 2>&1 || true' EXIT
octobrief up 2>&1 | tail -3
wait_web
wait_issuer
octobrief ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}' | sed 's/^/  /'

step "3/7 Solo HTTPS è pubblicato: database e renderer non hanno porte, e il renderer non ha uscita"
expect "$(curl -s "$base/api/health" | field status)" "up" "il web risponde in HTTPS dietro Caddy"
expect "$(published_ports postgres)" "0" "Postgres non pubblica nessuna porta"
expect "$(published_ports renderer)" "0" "il renderer non pubblica nessuna porta"
expect "$(octobrief compose exec -T renderer python -c "import socket; socket.create_connection(('1.1.1.1', 443), 2)" >/dev/null 2>&1 && echo esce || echo chiuso)" "chiuso" "dal renderer non si esce verso la rete"
expect "$(octobrief compose exec -T web sh -c 'id -u')" "1000" "il web gira con un utente non root"
expect "$(octobrief compose exec -T web sh -c 'env | grep -c "WORKER\|POSTGRES_PASSWORD\|OWNER" || true')" "0" "il web non conosce le credenziali del worker né del proprietario del database"

step "4/7 Accesso (issuer finto), progetto, documenti e una domanda"
login paola "$paola"
call "$paola" POST /projects "{\"name\":\"${project_name}\"}" >/dev/null
slug="$(call "$paola" GET /projects | node -pe "JSON.parse(require('fs').readFileSync(0)).projects.find(p=>p.name==='${project_name}').slug")"
octobrief compose exec -T worker sh -c 'rm -rf /tmp/docs && node tools/synthetic/src/cli.ts /tmp/docs 1 >/dev/null && tar -C /tmp/docs -cf - .' >.tmp/demo-11-docs.tar
mkdir -p "$docs" && tar -C "$docs" -xf .tmp/demo-11-docs.tar
for file in "$docs"/SAL-*-2026-11-04.md "$docs"/Nota-fornitore-*.txt; do upload "$paola" "$file" >/dev/null; done
wait_documents
ok "progetto $slug: documenti letti dal worker"
question_id="$(call "$paola" POST "/projects/$slug/questions" '{"text":"Qual è il budget complessivo del progetto?"}' | field id)"
curl -sN --max-time 60 -b "$paola" "$base/api/projects/$slug/questions/$question_id/events" >/dev/null || true
call "$paola" GET "/projects/$slug/questions/$question_id" | node -e '
  const { answer } = JSON.parse(require("fs").readFileSync(0))
  for (const s of answer.segments) console.log(`  • ${s.text} — ${s.sources.map((x) => (x.verified ? "✔ " : "✘ ") + x.title).join(" | ")}`)
  if (!answer.segments.length || !answer.segments.every((s) => s.sources.every((x) => x.verified))) process.exit(1)' \
  || fail "risposta senza fonti verificate"
ok "risposta con fonti verificate, attraverso Caddy (avanzamento in streaming compreso)"

step "5/7 Backup: dump del database e archivio dei file caricati"
blobs_before="$(blob_count)"
octobrief backup "$backup_dir" | sed 's/^/  /'
ls -l "$backup_dir" | awk 'NR>1 {print "  " $NF " (" $5 " byte)"}'

step "6/7 Perdita dei dati: volumi cancellati e installazione rifatta, vuota"
octobrief down -v >/dev/null 2>&1
octobrief up >/dev/null 2>&1
wait_web
wait_issuer
login paola "$paola"
expect "$(project_count)" "0" "nessun progetto: i dati non ci sono più"

step "7/7 Ripristino dal backup"
octobrief restore "$backup_dir" | sed 's/^/  /'
# The demo issuer lives in the network namespace of the web container, which has just restarted.
octobrief compose restart fake-oidc >/dev/null 2>&1
wait_web
wait_issuer
login paola "$paola"
expect "$(call "$paola" GET /projects | node -pe "JSON.parse(require('fs').readFileSync(0)).projects.some(p=>p.slug==='${slug}')")" "true" "il progetto $slug è tornato"
expect "$(blob_count)" "$blobs_before" "i file caricati sono tornati ($blobs_before)"
expect "$(call "$paola" GET "/projects/$slug/questions" | node -pe 'JSON.parse(require("fs").readFileSync(0)).questions.length')" "1" "la domanda di Paola è nel suo storico"

printf '\n\033[1;32m✔ %s\033[0m\n' "Demo 11 completata."
if [ "${KEEP:-0}" = "1" ]; then
  echo "L'installazione resta accesa: apri $base (certificato dell'autorità interna di Caddy: il browser chiede conferma)."
  echo "Per fermare e cancellare: OCTOBRIEF_PROJECT=$OCTOBRIEF_PROJECT OCTOBRIEF_ENV_FILE=$OCTOBRIEF_ENV_FILE OCTOBRIEF_EXTRA_COMPOSE=$OCTOBRIEF_EXTRA_COMPOSE bash deploy/octobrief.sh down -v"
fi
