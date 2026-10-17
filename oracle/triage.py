"""Evidence-based triage of fuzz failures.

usage: uv run triage.py <solver binary> [--dir fuzz] [--jobs 10] [--json out.json]

Every failure gets a verdict backed by a check that can fail, not by a pattern:

  solver error (no result)
    DEGENERATE        prove.py: a junction carrying > 1 A closes a loop of ideal
                      voltage-type branches and junctions only, or sits between
                      source-forced nodes, following the junction law: not a
                      physical circuit.                               artifact
    SOLVER_ERROR      otherwise (ngspice converged on a physical circuit). BUG
  operating point differs
    MULTISTABLE       opcheck.py: ngspice seeded at our solution converges to it,
                      and op + AC then match (or their AC gap is itself proven
                      an artifact).                                   artifact
    GMIN_OP           opcheck.py: the op gap vanishes at gmin = 1e-18 in both
                      simulators, and any AC gap is proven an artifact. artifact
    OP_BUG            otherwise.                                      BUG
  AC differs (operating points agree)
    NGSPICE_NUMERICS  evidence.py: the exact (60-digit) solution of ngspice's own,
                      independently rebuilt circuit differs from ngspice's printed
                      value within its double-precision bound, and equals ours.
    NGSPICE_GMIN      evidence.py: the whole gap is ngspice's gmin on terms the
                      solver omits.
    PARAM_ILLCONDITIONED  evidence.py: both gaps within the parameter-rounding
                      floor S·eps·(N+10).                  (all three: artifact)
    OMITTED_PHYSICS   evidence.py: a dropped junction / g_mu carries real
                      conductance that changes the result.             BUG
    SOLVER_STAMPS     evidence.py: the solver's own linearized circuit differs
                      from an independent stamping of it.              BUG
  REGION_LABEL        only a region name differs.                     cosmetic

The pattern bucket of the earlier triage (by failure text) is kept beside the
verdict for cross-reference.
"""

from __future__ import annotations

import argparse
import collections
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import evidence
import opcheck
import prove
from prove import failures, solver

ARTIFACTS = {"DEGENERATE", "MULTISTABLE", "GMIN_OP", "NGSPICE_NUMERICS", "NGSPICE_GMIN", "PARAM_ILLCONDITIONED"}


def pattern_bucket(got, want: dict, fails: list[str]) -> str:
    """The earlier, text-based bucket (kept only for cross-reference)."""
    if isinstance(got, str):
        return "ERR " + ("dc-nonconv" if "converge" in got else "singular" if "singular" in got else got[:30])
    non_label = [f for f in fails if ".region" not in f]
    if not non_label:
        return "label-only"
    if any("forward biased" in w for w in got.get("warnings", [])):
        return "bulk junction forward biased"
    op = [f for f in non_label if "@" not in f]
    if op:
        vals = [abs(float(m)) for f in op for m in re.findall(r"want ([-\d.e+]+)", f)]
        return "op: tiny-magnitude" if vals and max(vals) < 1e-6 else "op: other"
    if all(f.startswith(("rin", "rout")) and ("infinite" in f or _mag(f) > 1e12) for f in non_label):
        return "impedance >=1e12"
    return "ac: other"


def _mag(f: str) -> float:
    try:
        return abs(complex(f.split("want ", 1)[1].split(";")[0].strip()))
    except (IndexError, ValueError):
        return 0.0


def triage_one(binary: str, cir: Path) -> dict:
    side = json.loads(cir.with_suffix(".json").read_text())
    want = json.loads((cir.parent.parent / "e" / f"{cir.stem}.json").read_text())
    got = solver(binary, cir, side, 1e-15)
    fails = [] if isinstance(got, str) else failures(got, want, side)
    if not isinstance(got, str) and not fails:
        from compare import Report, compare
        rep = Report(1e-6, side.get("reference_limits"))
        compare(got, want, rep)
        if not rep.failures:
            return {"verdict": "PASS"}
        return {"verdict": "REGION_LABEL", "why": rep.failures[0], "bucket": "label-only"}
    bucket = pattern_bucket(got, want, fails)
    if isinstance(got, str):
        ok, why = prove.absurd_current(cir, side)
        return {"verdict": "DEGENERATE" if ok else "SOLVER_ERROR", "why": why if ok else f"{got[:80]}; {why}", "bucket": bucket}
    if any("@" not in f for f in fails):
        r = opcheck.check(binary, cir)
        v = r["verdict"]
        if v == "MULTISTABLE" and "AC evidence" in r["why"] and not any(a in r["why"] for a in ARTIFACTS - {"MULTISTABLE"}):
            v = "OP_BUG"
        return {"verdict": v if v in ARTIFACTS else "OP_BUG", "why": r["why"], "bucket": bucket}
    r = evidence.verdict(binary, cir)
    return {"verdict": r["verdict"], "why": r["why"], "bucket": bucket}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("binary")
    ap.add_argument("--dir", type=Path, default=Path("fuzz"))
    ap.add_argument("--jobs", type=int, default=10)
    ap.add_argument("--json", type=Path)
    args = ap.parse_args()
    cases = sorted(p for batch in sorted(args.dir.iterdir()) for p in (batch / "c").glob("*.cir")
                   if (batch / "e" / f"{p.stem}.json").exists())

    def one(c):
        try:
            return str(c), triage_one(args.binary, c)
        except Exception as exc:  # noqa: BLE001 - every case must get a verdict
            return str(c), {"verdict": "TRIAGE_ERROR", "why": repr(exc)[:200], "bucket": "?"}

    with ThreadPoolExecutor(args.jobs) as ex:
        out = dict(ex.map(one, cases))
    verdicts = collections.Counter(v["verdict"] for v in out.values())
    print(f"{len(out)} circuits")
    for k, n in verdicts.most_common():
        kind = "pass" if k == "PASS" else "artifact (proven)" if k in ARTIFACTS else "cosmetic" if k == "REGION_LABEL" else "BUG"
        print(f"{n:5d}  {k:22s} {kind}")
    cross = collections.Counter((v.get("bucket"), v["verdict"]) for v in out.values() if v["verdict"] != "PASS")
    print("\npattern bucket -> verdict")
    for (b, v), n in sorted(cross.items(), key=lambda kv: (str(kv[0][0]), -kv[1])):
        print(f"  {str(b):32s} {v:22s} {n}")
    bugs = {c: v for c, v in out.items() if v["verdict"] not in ARTIFACTS | {"PASS", "REGION_LABEL"}}
    if bugs:
        print("\nbugs:")
        for c, v in bugs.items():
            print(f"  {Path(c).stem:22s} {v['verdict']:16s} {v['why'][:150]}")
    if args.json:
        args.json.write_text(json.dumps(out, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
