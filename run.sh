#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

person="${1:-}"
mode="${2:-live}"

case "$person" in
  me|partner) ;;
  *) echo "Uso: ./run.sh me|partner [audit|live]"; exit 1 ;;
esac

case "$mode" in
  audit|live) ;;
  *) echo "Modo no válido: $mode (audit|live)"; exit 1 ;;
esac

if [[ ! -f .env ]]; then
  echo "Falta .env. Copia .env.example y rellénalo."
  exit 1
fi

if grep -qE '^(ME|PARTNER)_(FIRST_NAME|LAST_NAME|BIRTH_DATE)=$' .env; then
  echo "Hay campos vacíos en .env:"
  grep -nE '^(ME|PARTNER)_(FIRST_NAME|LAST_NAME|BIRTH_DATE)=$' .env
  exit 1
fi

extra=()
[[ "${RESUME:-0}" == "1" ]] && extra+=(--resume)
[[ -n "${STEP:-}" ]] && extra+=(--step="$STEP")

exec xvfb-run -a npm run run -- --person="$person" --mode="$mode" "${extra[@]}"
