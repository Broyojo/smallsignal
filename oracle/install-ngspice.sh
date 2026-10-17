#!/usr/bin/env bash
# Build ngspice from source into a prefix: the oracle's reference results
# were made with ngspice-47, and distributions ship older releases (Ubuntu
# 24.04's ngspice-42 prints no .disto results).
#   oracle/install-ngspice.sh [prefix]     # default ~/.local/ngspice
set -euo pipefail
version=47
prefix="${1:-$HOME/.local/ngspice}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
curl -sSfL --retry 5 --retry-all-errors -o "$work/ngspice.tar.gz" \
  "https://sourceforge.net/projects/ngspice/files/ng-spice-rework/$version/ngspice-$version.tar.gz/download"
tar -xzf "$work/ngspice.tar.gz" -C "$work"
cd "$work/ngspice-$version"
./configure --prefix="$prefix" --with-x=no --disable-debug \
  >/dev/null
make -j"$(getconf _NPROCESSORS_ONLN)" >/dev/null
make install >/dev/null
"$prefix/bin/ngspice" --version | head -2
