#!/usr/bin/env bash
# Build ngspice from source into a prefix: the oracle's reference results
# were made with ngspice-47, and distributions ship older releases (Ubuntu
# 24.04's ngspice-42 prints no .disto results).
#   oracle/install-ngspice.sh [prefix]     # default ~/.local/ngspice
set -euo pipefail
version=47
# SHA-256 of ngspice-47.tar.gz; its MD5 matches the one SourceForge lists.
sha256=894e649651f1838a14095e5a5439e7d3aa63e87ede14d283173fda4fcdef675f
prefix="${1:-$HOME/.local/ngspice}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
curl -sSfL --retry 5 --retry-all-errors -o "$work/ngspice.tar.gz" \
  "https://sourceforge.net/projects/ngspice/files/ng-spice-rework/$version/ngspice-$version.tar.gz/download"
# Build nothing that is not the reviewed release.
if command -v sha256sum >/dev/null; then
  echo "$sha256  $work/ngspice.tar.gz" | sha256sum -c --quiet
else
  echo "$sha256  $work/ngspice.tar.gz" | shasum -a 256 -c --quiet
fi
tar -xzf "$work/ngspice.tar.gz" -C "$work"
cd "$work/ngspice-$version"
./configure --prefix="$prefix" --with-x=no --disable-debug \
  >/dev/null
make -j"$(getconf _NPROCESSORS_ONLN)" >/dev/null
make install >/dev/null
"$prefix/bin/ngspice" --version | head -2
