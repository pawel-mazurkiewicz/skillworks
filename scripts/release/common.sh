#!/usr/bin/env bash
# common.sh — sourced by all macOS and Linux release scripts.
# Do not execute directly.
set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
ENV_FILE="$REPO_ROOT/.env.release"

if [[ ! -f "$ENV_FILE" ]]; then
  printf 'ERROR: .env.release not found at %s\n' "$ENV_FILE" >&2
  printf '       Copy scripts/release/.env.release.example to .env.release and fill in the values.\n' >&2
  exit 1
fi

# shellcheck source=/dev/null
set -a
source "$ENV_FILE"
set +a

log()     { printf '▶  %s\n' "$*"; }
success() { printf '✓  %s\n' "$*"; }
err()     { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

check_env() {
  local missing=()
  for var in "$@"; do
    [[ -z "${!var:-}" ]] && missing+=("$var")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    printf 'ERROR: Missing required env vars in .env.release:\n' >&2
    for v in "${missing[@]}"; do
      printf '  %s\n' "$v" >&2
    done
    exit 1
  fi
}

check_cmd() {
  command -v "$1" &>/dev/null || err "Required command not found: $1 — install it and try again"
}
