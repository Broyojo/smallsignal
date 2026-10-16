"""Shrink a failing netlist by deleting element lines while the failure persists.

usage: uv run minimize.py <netlist.cir> --kind nan|nonconv|acmismatch|opmismatch [--out regressions/<name>]

The sidecar <netlist>.json supplies input/output/freqs. The input source line
and model cards are never removed. Failure kinds:
  nan         solver returns non-finite gain/rin/rout values (no ngspice needed)
  nonconv     solver reports DC non-convergence while ngspice converges
  acmismatch  operating points agree but some AC value differs (rtol 1e-6),
              ignoring gmin-level impedances (>= 1e12 ohm or infinite)
  bulkfwd     acmismatch while the solver warns of a forward-biased bulk junction
  opmismatch  some operating-point value differs (rtol 1e-6)
Writes <out>.cir, <out>.json and, for ngspice-backed kinds, expected/<name>.json.
The CLI is $SMALLSIGNAL_BIN.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

import run_ngspice
from compare import Report, compare, run_cli

HERE = Path(__file__).resolve().parent


def ours(text: str, side: dict) -> dict | str:
    with tempfile.TemporaryDirectory() as tmp:
        cir = Path(tmp) / "m.cir"
        cir.write_text(text)
        try:
            return run_cli([os.environ["SMALLSIGNAL_BIN"]], cir, side)
        except RuntimeError as exc:
            return str(exc)


def reference(text: str, side: dict) -> dict | None:
    with tempfile.TemporaryDirectory() as tmp:
        cir = Path(tmp) / "m.cir"
        cir.write_text(text)
        cir.with_suffix(".json").write_text(json.dumps(side))
        try:
            return run_ngspice.process(cir, Path(tmp) / "e", None)
        except (run_ngspice.NgspiceError, KeyError, ValueError):
            return None


def sane(ref: dict) -> bool:
    return all(abs(d.get(k, 0)) < 1.0 for d in ref["op"]["devices"].values() for k in ("id", "ic", "ib"))


def failing(kind: str, text: str, side: dict) -> bool:
    got = ours(text, side)
    if kind == "nan":
        if isinstance(got, str):
            return False
        return any(v.get("re") is None and not v.get("inf")
                   for q in ("gain", "rin", "rout") for v in (got.get(q) or {}).get("values", [])
                   if not (got.get(q) or {}).get("infinite"))
    if kind == "nonconv":
        if not (isinstance(got, str) and "converge" in got):
            return False
        ref = reference(text, side)
        return ref is not None and sane(ref)
    if isinstance(got, str):
        return False
    ref = reference(text, side)
    if ref is None or not sane(ref):
        return False
    rep = Report(1e-6)
    compare(got, ref, rep)
    numeric = [f for f in rep.failures if ".region" not in f]
    op = [f for f in numeric if "@" not in f]
    if kind == "opmismatch":
        return bool(op)
    real = [f for f in numeric if "@" in f and not gmin_level(f)]
    if kind == "bulkfwd" and not any("forward biased" in w for w in got.get("warnings", [])):
        return False
    return bool(real) and not op


def gmin_level(failure: str) -> bool:
    """An impedance set by ngspice's gmin (1e-15 S) leakage, which the solver omits."""
    if not failure.startswith(("rin", "rout")):
        return False
    if "infinite" in failure:
        return True
    want = failure.split("want ", 1)[1].split(";")[0].strip()
    try:
        return abs(complex(want)) >= 1e12
    except ValueError:
        return False


def protected(line: str, side: dict) -> bool:
    head = line.split()[0].lower() if line.split() else ""
    return head.startswith(".") or head == side["input"].lower()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("netlist", type=Path)
    ap.add_argument("--kind", required=True, choices=["nan", "nonconv", "acmismatch", "bulkfwd", "opmismatch"])
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()
    side = json.loads(args.netlist.with_suffix(".json").read_text())
    lines = args.netlist.read_text().splitlines()
    title, body = lines[0], [l for l in lines[1:] if l.strip() and l.strip().lower() != ".end"]
    text = lambda b: "\n".join([title, *b, ".end"]) + "\n"
    if not failing(args.kind, text(body), side):
        print("does not fail as given", file=sys.stderr)
        return 1
    changed = True
    while changed:
        changed = False
        for i in range(len(body) - 1, -1, -1):
            if protected(body[i], side):
                continue
            trial = body[:i] + body[i + 1:]
            if failing(args.kind, text(trial), side):
                body = trial
                changed = True
    # Drop model cards no element uses.
    used = {tok.lower() for l in body if not l.startswith(".") for tok in l.split()[1:]}
    body = [l for l in body if not l.lower().startswith(".model") or l.split()[1].lower() in used]
    final = text(body)
    print(final)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.with_suffix(".cir").write_text(final)
        side = {**side, "description": f"minimized fuzz regression ({args.kind}) from {args.netlist.name}"}
        args.out.with_suffix(".json").write_text(json.dumps(side, indent=1) + "\n")
        if args.kind != "nan":
            run_ngspice.process(args.out.with_suffix(".cir"), args.out.parent / "expected", None)
    return 0


if __name__ == "__main__":
    sys.exit(main())
