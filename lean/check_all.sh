#!/usr/bin/env bash
# Regenerate the Lean certificates for the oracle corpus and check them all,
# together with the general MNA theorem (Smallsignal/Mna.lean).
#   lean/check_all.sh            # every corpus circuit
#   lean/check_all.sh nmos_cs …  # selected circuits (NAME@M1:ro: with assumptions)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(dirname "$here")"
cargo build -q --locked --release -p smallsignal-cli --manifest-path "$repo/Cargo.toml"
if [ "$#" -gt 0 ]; then
  names=("$@")
else
  names=()
  # A circuit over the term budget (sidecar "tooLarge") has no exact form.
  for f in "$repo"/oracle/corpus/*.cir; do
    grep -q '"tooLarge": true' "${f%.cir}.json" || names+=("$(basename "$f" .cir)")
  done
  # Assumed element lists: r_o taken to infinity, a capacitor shorted.
  names+=("nmos_cs@M1:ro" "rlc_lowpass@C1:short")
fi
rm -f "$here"/Certs/*.lean
python3 "$here/gen_cert.py" "${names[@]}"
cd "$here"
# Fetch Mathlib's prebuilt cache (~5 GB) only when no built Mathlib is present.
if [ ! -d .lake/packages/mathlib/.lake/build/lib/lean/Mathlib ]; then
  lake exe cache get
fi
lake build Smallsignal Certs
