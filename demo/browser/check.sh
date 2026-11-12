#!/usr/bin/env bash
# Runs a demo with KEEP=1, follows the browser part of its COPIONE in a real browser (Playwright),
# then stops what the demo left on. Needs `pnpm exec playwright install chromium` once.
# Usage: bash demo/browser/check.sh <NN> [<NN> …]     (01–12; no argument = all)
set -uo pipefail
cd "$(dirname "$0")/../.."
mkdir -p .tmp/browser
failed=0

stop_demo() {
  local line
  line="$(grep -o 'per fermare: kill .*' "$1" | tail -1 | sed 's/per fermare: //')"
  [ -z "$line" ] || eval "$line" 2>/dev/null
  sleep 2
}
address() { grep -o "http://127.0.0.1:3310/projects/[a-z0-9-]*/$2" "$1" | tail -1; }

check() {
  local n="$1" dir log url
  dir="$(basename "$(ls -d demo/"$n"-*/)")"
  log=".tmp/browser/$n.log"
  printf '\n== %s\n' "$dir"
  KEEP=1 bash "demo/$dir/run.sh" >"$log" 2>&1 || { echo "  ✘ la parte automatica non è riuscita: $log"; failed=1; stop_demo "$log"; return; }
  case "$n" in
    01) node demo/browser/01.ts ;;
    02 | 03) node "demo/browser/$n.ts" "$(address "$log" memory)" ;;
    04) node demo/browser/04.ts "$(address "$log" sources)" ;;
    05) node demo/browser/05.ts "$(address "$log" ask)" ;;
    06) node demo/browser/06.ts "$(address "$log" deliverables)" ;;
    07) node demo/browser/deliverables.ts "$(address "$log" deliverables)" "Verbale da trascritto" "Approvato" "Fonti" ;;
    08) node demo/browser/deliverables.ts "$(address "$log" deliverables)" "3 anomalie aperte" "interno.xlsx" ;;
    09)
      url="$(address "$log" deliverables)"
      node demo/browser/deliverables.ts "$url" "Approvato" && node demo/browser/09.ts "$url"
      ;;
    10) node demo/browser/deliverables.ts "$(address "$log" deliverables)" "Rischi e opportunità" "Conoscenza di progetto" ;;
    12) node demo/browser/12.ts "$(address "$log" sources)" ;;
    11) node demo/browser/11.ts "https://localhost:8443/projects/$(grep -o 'progetto aurora-[0-9]*' "$log" | head -1 | cut -d' ' -f2)" ;;
    *) echo "  nessuna parte nel browser" ;;
  esac || failed=1
  if [ "$n" = "11" ]; then
    OCTOBRIEF_PROJECT=octobrief-demo-11 OCTOBRIEF_ENV_FILE="$PWD/.tmp/demo-11.env" \
      OCTOBRIEF_EXTRA_COMPOSE="$PWD/deploy/compose.demo.yml" bash deploy/octobrief.sh down -v >/dev/null 2>&1
  else
    stop_demo "$log"
  fi
}

[ $# -gt 0 ] || set -- 01 02 03 04 05 06 07 08 09 10 11 12
for n in "$@"; do check "$n"; done
exit "$failed"
