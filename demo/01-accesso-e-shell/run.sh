#!/usr/bin/env bash
# Demo 01 — Accesso e shell: login OpenID Connect, sessioni, CSRF, ruoli, progetti e membri.
# Uso: bash demo/01-accesso-e-shell/run.sh        (si ferma alla fine)
#      KEEP=1 bash demo/01-accesso-e-shell/run.sh (lascia tutto acceso per la parte nel browser)
set -euo pipefail
cd "$(dirname "$0")/../.."
source demo/lib.sh

paola=.tmp/demo-01-paola.jar
marco=.tmp/demo-01-marco.jar
admin=.tmp/demo-01-admin.jar
suffix="$(date +%H%M%S)"
project_name="Portale Clienti ${suffix}"

step "1/7 Prerequisiti, dipendenze e database"
check_prerequisites
prepare_database

step "2/7 Avvio di web, worker e issuer OpenID Connect finto (al posto di Entra ID)"
start_dev .tmp/demo-01.log

step "3/7 Senza sessione Studio rimanda al login"
code="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$base/projects/qualsiasi")"
echo "  GET /projects/qualsiasi → $code"
expect "$(curl -s -o /dev/null -w '%{http_code}' "$base/api/projects")" "401" "API senza sessione: 401"

step "4/7 Login di Paola (PM) e di Marco (PM) con il flusso OIDC completo (PKCE, state, nonce)"
login paola "$paola"
login marco "$marco"
curl -s -b "$paola" "$base/api/me" | node -pe 'const m=JSON.parse(require("fs").readFileSync(0)); `  ${m.user.displayName} · ruolo ${m.user.role} · lingua ${m.user.locale}`'
ok "sessioni salvate sul DB solo come hash; cookie HttpOnly + SameSite=Lax"

step "5/7 Paola crea un progetto e aggiunge Marco"
call "$paola" POST /projects "{\"name\":\"${project_name}\",\"client\":\"ACME Sintetica\"}" | json
slug="$(call "$paola" GET /projects | node -pe "JSON.parse(require('fs').readFileSync(0)).projects.find(p=>p.name==='${project_name}').slug")"
expect "$(call "$marco" GET "/projects/$slug" | field error)" "not_found" "prima: Marco non vede il progetto (404)"
call "$paola" POST "/projects/$slug/members" '{"email":"marco.esempio@example.test"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).members.map(m=>`  ${m.displayName} (${m.role})`).join("\n")'
expect "$(call "$marco" GET "/projects/$slug" | field memberRole)" "member" "dopo: Marco lo vede come membro"
expect "$(call "$marco" POST "/projects/$slug/members" '{"email":"paola.prova@example.test"}' | field error)" "forbidden" "Marco non può gestire i membri (403)"

step "6/7 Difese: CSRF, origine, ruoli"
no_token="$(curl -s -o /dev/null -w '%{http_code}' -b "$paola" -X POST -H 'content-type: application/json' -d '{"name":"x"}' "$base/api/projects")"
expect "$no_token" "403" "POST senza token CSRF: 403"
expect "$(call "$paola" POST /system/pings | field error)" "forbidden" "diagnostica riservata agli admin: PM → 403"
login admin "$admin"
expect "$(call "$admin" POST /system/pings | node -pe 'typeof JSON.parse(require("fs").readFileSync(0)).jobId')" "string" "Alba (admin da ADMIN_EMAILS) accoda il ping"
expect "$(call "$admin" GET /projects | node -pe "JSON.parse(require('fs').readFileSync(0)).projects.some(p=>p.slug==='${slug}')")" "true" "l'admin vede tutti i progetti"

step "7/7 Lingua e logout"
call "$paola" PATCH /me '{"locale":"en"}' >/dev/null
expect "$(curl -s -b "$paola" "$base/api/me" | field user.locale)" "en" "Paola passa all'inglese (salvato sul suo profilo)"
call "$paola" PATCH /me '{"locale":"it"}' >/dev/null
curl -s -b "$paola" -c "$paola" -X POST -H "origin: $base" "$base/api/auth/logout" | json
expect "$(curl -s -o /dev/null -w '%{http_code}' -b "$paola" "$base/api/me")" "401" "sessione revocata sul server"

finish "Demo 01 completata. Nel browser: $base (copione, passi 8–12)"
