#!/usr/bin/env bash
# Build and serve the editor exactly as Pages deploys it, to review a change
# before it is merged.
#   pnpm smallsignal:preview        # the current checkout
#   pnpm smallsignal:preview 12     # pull request #12 of this fork
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
need() {
  command -v "$1" >/dev/null || { echo "Needs $1. $2" >&2; exit 1; }
}
need cargo "Install Rust: https://rustup.rs"
need wasm-pack "Install it: cargo install wasm-pack"
need pnpm "Install it: corepack enable"
rustup target list --installed 2>/dev/null | grep -q wasm32-unknown-unknown ||
  rustup target add wasm32-unknown-unknown
if [ "$#" -gt 0 ]; then
  repo="$(git remote get-url origin | sed -E 's#^.*github\.com[:/]##; s#\.git$##')"
  gh pr checkout "$1" --repo "$repo"
fi
wasm-pack build crates/smallsignal-wasm --target web --release \
  --out-dir ../../packages/small-signal/wasm
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile
pnpm --filter "@icm/editor^..." --if-present build
ICM_BASE=/smallsignal/ ICM_STATIC_PAGES=1 pnpm --filter @icm/editor build
port="${PORT:-4180}"
echo "Open http://127.0.0.1:$port/smallsignal/"
cd apps/editor
exec pnpm exec vite preview --outDir dist --base /smallsignal/ \
  --host 127.0.0.1 --port "$port" --strictPort
