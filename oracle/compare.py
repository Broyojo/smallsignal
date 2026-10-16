"""Compare the smallsignal CLI against ngspice reference results.

usage: uv run compare.py [--corpus DIR] [--expected DIR] [--rtol R] [-v] [names...]

The CLI is $SMALLSIGNAL_BIN if set, else target/release/smallsignal after a
`cargo build --release -p smallsignal-cli`, else `cargo run -q --release -p
smallsignal-cli --`. Each circuit's sidecar JSON supplies --input/--output/--freq.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path

from run_ngspice import OPTIONS

HERE = Path(__file__).resolve().parent
REPO = HERE.parent

# Absolute floors per quantity, so exact zeros and ngspice's gmin (1e-15 S) noise don't fail.
ATOL = {"v": 1e-9, "i": 1e-13, "g": 1e-13, "gain": 1e-12, "z": 1e-9}
MOS_KEYS = {"id": "i", "vgs": "v", "vds": "v", "vbs": "v", "gm": "g", "gds": "g", "gmb": "g"}
BJT_KEYS = {"ic": "i", "ib": "i", "vbe": "v", "vce": "v", "gm": "g", "gpi": "g", "go": "g"}
DIODE_KEYS = {"id": "i", "gd": "g"}
INF_THRESHOLD = 1e15


def cli_command() -> list[str]:
    env = os.environ.get("SMALLSIGNAL_BIN")
    if env:
        return shlex.split(env)
    build = subprocess.run(["cargo", "build", "-q", "--release", "-p", "smallsignal-cli"], cwd=REPO,
                           capture_output=True, text=True)
    binary = REPO / "target" / "release" / "smallsignal"
    if build.returncode == 0 and binary.exists():
        return [str(binary)]
    return ["cargo", "run", "-q", "--release", "-p", "smallsignal-cli", "--"]


def with_options(cir: Path) -> Path:
    """Copy of the netlist with the same .options (gmin etc.) ngspice ran with."""
    title, _, body = cir.read_text().partition("\n")
    tmp = tempfile.NamedTemporaryFile("w", suffix=".cir", delete=False)
    tmp.write(f"{title}\n{OPTIONS}\n{body}")
    tmp.close()
    return Path(tmp.name)


def run_cli(cmd: list[str], cir: Path, side: dict) -> dict:
    out = side["output"] + (f":{side['ref']}" if side.get("ref") else "")
    net = with_options(cir)
    args = [*cmd, "analyze", str(net), "--input", side["input"], "--output", out, "--verify"]
    if side.get("freqs"):
        args += ["--freq", ",".join(repr(float(f)) for f in side["freqs"])]
    if side.get("rin"):
        args.append("--rin")
    if side.get("rout"):
        args.append("--rout")
    try:
        proc = subprocess.run(args, cwd=REPO, capture_output=True, text=True, timeout=120)
    finally:
        net.unlink()
    if proc.returncode != 0:
        msg = (proc.stderr or proc.stdout).strip().splitlines()
        raise RuntimeError(f"CLI exit {proc.returncode}: {msg[-1] if msg else ''}")
    data = json.loads(proc.stdout)
    if "error" in data:
        raise RuntimeError(f"CLI error: {data['error']}")
    # The solver's own exact checks must hold too: KCL identity and the
    # symbolic-vs-numeric cross-check of every quantity.
    if not data.get("verify", {}).get("kcl", False):
        raise RuntimeError("CLI KCL identity check failed")
    for q in ("gain", "rin", "rout"):
        check = data.get(q, {}).get("check", {})
        if not check.get("ok", True):
            raise RuntimeError(f"CLI {q}: symbolic vs numeric mismatch {check.get('maxRelDiff', 0):.2e}")
    return data


class Report:
    def __init__(self, rtol: float):
        self.rtol = rtol
        self.failures: list[str] = []
        self.worst = 0.0

    def real(self, what: str, got, want: float, kind: str):
        if got is None:
            self.failures.append(f"{what}: missing")
            return
        err = abs(float(got) - want)
        tol = self.rtol * abs(want) + ATOL[kind]
        self.worst = max(self.worst, err / (abs(want) + ATOL[kind]))
        if not err <= tol:
            self.failures.append(f"{what}: got {got:.12g}, want {want:.12g}")

    def complex(self, what: str, got: dict | None, want: dict, kind: str):
        if got is None:
            self.failures.append(f"{what}: missing")
            return
        if want.get("inf"):
            if not is_inf(got):
                self.failures.append(f"{what}: want infinite, got {got}")
            return
        if is_inf(got):
            self.failures.append(f"{what}: got infinite, want {want['re']:.6g}{want['im']:+.6g}j")
            return
        g = complex(got["re"], got["im"])
        w = complex(want["re"], want["im"])
        err = abs(g - w)
        tol = self.rtol * abs(w) + ATOL[kind]
        self.worst = max(self.worst, err / (abs(w) + ATOL[kind]))
        if not err <= tol:
            self.failures.append(f"{what}: got {g:.10g}, want {w:.10g}")


def is_inf(v: dict) -> bool:
    if v.get("inf"):
        return True
    re_, im_ = v.get("re"), v.get("im")
    if re_ is None or isinstance(re_, str) or isinstance(im_, str):
        return True
    return not math.isfinite(re_) or not math.isfinite(im_) or abs(complex(re_, im_)) > INF_THRESHOLD


def lower_keys(d: dict) -> dict:
    return {str(k).lower(): v for k, v in (d or {}).items()}


def by_freq(values: list[dict] | None, f: float) -> dict | None:
    for v in values or []:
        if math.isclose(float(v.get("f", math.nan)), f, rel_tol=1e-9):
            return v
    return None


def compare(got: dict, want: dict, rep: Report):
    gnodes = lower_keys(got.get("op", {}).get("nodes"))
    for n, v in want["op"]["nodes"].items():
        rep.real(f"V({n})", gnodes.get(n), v, "v")
    gdevs = lower_keys(got.get("op", {}).get("devices"))
    for name, w in want["op"]["devices"].items():
        g = lower_keys(gdevs.get(name))
        if not g:
            rep.failures.append(f"{name}: missing from op.devices")
            continue
        keys = {"nmos": MOS_KEYS, "pmos": MOS_KEYS, "npn": BJT_KEYS, "pnp": BJT_KEYS}.get(w["type"], DIODE_KEYS)
        for k, kind in keys.items():
            rep.real(f"{name}.{k}", g.get(k), w[k], kind)
        if "region" in w and "region" in g and g["region"] != w["region"]:
            rep.failures.append(f"{name}.region: got {g['region']}, want {w['region']}")
    for q, kind in (("gain", "gain"), ("rin", "z"), ("rout", "z")):
        if q not in want:
            continue
        gq = got.get(q) or {}
        for w in want[q]["values"]:
            rep.complex(f"{q}@{w['f']:g}", by_freq(gq.get("values"), w["f"]), w, kind)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", type=Path, default=HERE / "corpus")
    ap.add_argument("--expected", type=Path, default=HERE / "expected")
    ap.add_argument("--rtol", type=float, default=1e-6)
    ap.add_argument("-v", "--verbose", action="store_true", help="list every failing quantity")
    ap.add_argument("names", nargs="*")
    args = ap.parse_args()

    cmd = cli_command()
    wants = sorted(args.expected.glob("*.json"))
    if args.names:
        wants = [w for w in wants if w.stem in args.names]
    passed = 0
    print(f"{'circuit':28s} {'status':6s} {'worst rel err':>13s}  detail")
    for wpath in wants:
        want = json.loads(wpath.read_text())
        cir = (args.corpus / want["netlist"]).resolve()  # the CLI runs from the repo root
        side = json.loads(cir.with_suffix(".json").read_text())
        rep = Report(args.rtol)
        try:
            compare(run_cli(cmd, cir, side), want, rep)
        except (RuntimeError, json.JSONDecodeError, subprocess.TimeoutExpired, OSError) as exc:
            print(f"{wpath.stem:28s} {'ERROR':6s} {'':>13s}  {str(exc)[:100]}")
            continue
        if rep.failures:
            detail = "; ".join(rep.failures if args.verbose else rep.failures[:2])
            more = "" if args.verbose or len(rep.failures) <= 2 else f" (+{len(rep.failures) - 2} more)"
            print(f"{wpath.stem:28s} {'FAIL':6s} {rep.worst:13.2e}  {detail}{more}")
        else:
            passed += 1
            print(f"{wpath.stem:28s} {'pass':6s} {rep.worst:13.2e}")
    print(f"\n{passed}/{len(wants)} passed (rtol={args.rtol:g})")
    return 0 if passed == len(wants) else 1


if __name__ == "__main__":
    sys.exit(main())
