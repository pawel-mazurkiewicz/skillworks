#!/usr/bin/env bash
# common.sh — sourced by all macOS and Linux release scripts.
# Do not execute directly.
set -euo pipefail

# Define helper functions first (needed for error handling)
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

# Ensure Rust toolchain is in PATH (Homebrew rustup installation). PATH setup
# only — cargo presence is validated by the build scripts (release-macos.sh /
# release-linux.sh), not here, so release creation (create-release.sh) can run
# on a machine without Rust installed.
if [[ "$(uname)" == "Darwin" ]]; then
  # Add Homebrew paths to PATH if not already present
  for dir in /opt/homebrew/bin /opt/homebrew/opt/rustup/bin; do
    case ":$PATH:" in
      *":$dir:"*) ;;
      *) export PATH="$dir:$PATH" ;;
    esac
  done
fi

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"

# macOS Xcode 27 beta linker workaround. `--target` (universal) builds do not
# pass rustflags to host proc-macros, so they get chained-fixup dylibs the beta
# linker mis-aligns ("can't find crate for ctor_proc_macro"). A RUSTC_WRAPPER is
# the only thing that reaches every rustc invocation. Remove once a non-beta
# Command Line Tools / Xcode linker is in use. See scripts/release/rustc-wrapper.sh.
if [[ "$(uname)" == "Darwin" ]]; then
  _rustc_wrapper="$REPO_ROOT/scripts/release/rustc-wrapper.sh"
  if [[ -x "$_rustc_wrapper" && -z "${RUSTC_WRAPPER:-}" ]]; then
    export RUSTC_WRAPPER="$_rustc_wrapper"
  fi
fi

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
