#!/usr/bin/env bash
# Demo 00 — Fondamenta: database, coda, worker e API sono in piedi e si parlano.
# Uso: bash demo/00-fondamenta/run.sh        (si ferma alla fine)
#      KEEP=1 bash demo/00-fondamenta/run.sh (lascia web e worker accesi per il browser)
set -euo pipefail
cd "$(dirname "$0")/../.."

step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(s),null,2)))'; }

step "1/6 Prerequisiti"
for tool in node pnpm docker curl; do
  command -v "$tool" >/dev/null || { echo "Manca $tool"; exit 1; }
done
echo "node $(node -v) · pnpm $(pnpm -v) · $(docker --version)"

step "2/6 Dipendenze"
pnpm install --frozen-lockfile --silent

step "3/6 Database di sviluppo (Postgres 17 + pgvector, ruoli, coda)"
pnpm --silent db:setup 2>&1 | tail -1

port="$(grep '^WEB_PORT=' .env.local | cut -d= -f2-)"
base="http://127.0.0.1:${port:-3310}"
mkdir -p .tmp
log=.tmp/demo-00.log

step "4/6 Avvio di web e worker (log in ${log})"
set -m
pnpm dev >"$log" 2>&1 &
dev_pid=$!
set +m
cleanup() { kill -- -"$dev_pid" 2>/dev/null || true; }
if [ "${KEEP:-0}" != "1" ]; then trap cleanup EXIT; fi

for _ in $(seq 1 90); do
  curl -sf "$base/api/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "$base/api/health" >/dev/null || { echo "Il web non risponde: vedi $log"; exit 1; }
echo "Web pronto su $base"

step "5/6 Stato del sistema: GET /api/health"
curl -s "$base/api/health" | json

step "6/6 Round trip web → coda → worker: POST /api/system/pings"
job_id="$(curl -s -X POST "$base/api/system/pings" | node -pe 'JSON.parse(require("fs").readFileSync(0)).jobId')"
echo "Ping accodato: $job_id"
status=""
for _ in $(seq 1 30); do
  status="$(curl -s "$base/api/system/pings/$job_id" | node -pe 'JSON.parse(require("fs").readFileSync(0)).status')"
  echo "  stato: $status"
  [ "$status" = "completed" ] && break
  sleep 1
done
[ "$status" = "completed" ] || { echo "Il worker non ha completato il ping: vedi $log"; exit 1; }
echo "Riga del worker nel log:"
grep '"ping received"' "$log" | tail -1

printf '\n\033[1;32m✔ Demo 00 completata.\033[0m Contratto API: %s/api/openapi.json\n' "$base"
if [ "${KEEP:-0}" = "1" ]; then
  echo "Web e worker restano accesi (pid gruppo $dev_pid). Apri $base — per fermare: kill -- -$dev_pid"
fi
