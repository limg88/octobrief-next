#!/usr/bin/env bash
# Demo 00 — Fondamenta: database, coda, worker e API sono in piedi e si parlano.
# Uso: bash demo/00-fondamenta/run.sh        (si ferma alla fine)
#      KEEP=1 bash demo/00-fondamenta/run.sh (lascia tutto acceso per il browser)
set -euo pipefail
cd "$(dirname "$0")/../.."
source demo/lib.sh

step "1/5 Prerequisiti"
check_prerequisites

step "2/5 Dipendenze e database (Postgres 17 + pgvector, ruoli, coda, schema)"
prepare_database

step "3/5 Avvio di web, worker e issuer di accesso finto"
start_dev .tmp/demo-00.log

step "4/5 Stato del sistema: GET /api/health"
curl -s "$base/api/health" | json

step "5/5 Round trip web → coda → worker (riservato agli admin)"
jar=.tmp/demo-00-admin.jar
login admin "$jar"
job_id="$(call "$jar" POST /system/pings | field jobId)"
echo "Ping accodato: $job_id"
status=""
for _ in $(seq 1 30); do
  status="$(call "$jar" GET "/system/pings/$job_id" | field status)"
  echo "  stato: $status"
  [ "$status" = "completed" ] && break
  sleep 1
done
[ "$status" = "completed" ] || fail "Il worker non ha completato il ping: vedi $log"
echo "Riga del worker nel log:"
grep '"ping received"' "$log" | tail -1

finish "Demo 00 completata. Contratto API: $base/api/openapi.json"
