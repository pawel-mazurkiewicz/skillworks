#!/usr/bin/env bash
# Xcode 27 beta linker workaround — see .cargo/config.toml for the full story.
#
# Cargo passes neither `[build].rustflags` nor the `RUSTFLAGS` env var to *host*
# proc-macro builds when an explicit `--target` is used (e.g. the
# universal-apple-darwin release build). That leaves proc-macros like
# ctor-proc-macro / serde_derive / tauri_macros linked with chained fixups that
# the beta linker mis-aligns, so dlopen rejects them at build time:
#
#   error[E0463]: can't find crate for `ctor_proc_macro`
#   ... (mis-aligned LINKEDIT string pool)
#
# A RUSTC_WRAPPER runs for *every* rustc invocation — host and target — so it is
# the only place the `-no_fixup_chains` flag reliably reaches the host
# proc-macros. The flag is appended only to real compilations (those with
# `--crate-name`) so cargo's version/feature probes are left untouched.
#
# Remove this (and its export in common.sh) once a non-beta Command Line Tools /
# Xcode with a fixed linker is in use.
set -euo pipefail
rustc="$1"
shift
for arg in "$@"; do
  if [[ "$arg" == "--crate-name" ]]; then
    exec "$rustc" "$@" -Clink-arg=-Wl,-no_fixup_chains
  fi
done
exec "$rustc" "$@"
