"""Evidence-based verdicts for fuzz mismatches in AC quantities (gain/rin/rout).

usage: uv run evidence.py <solver binary> <netlist.cir>... [--json out.json] [--jobs 8]

For every quantity failing the 1e-6 comparison, ngspice's small-signal
circuit is rebuilt independently from the netlist and ngspice's own device
linearization (indep.py, 60 digits), in three variants: full (as ngspice
simulates it), solverlike (only the junction / g_mu terms the solver keeps)
and solverlike_phys (plus the physical part, without gmin, of every term the
solver dropped). Then:

  OP_MISMATCH       operating points differ: decided by opcheck.py instead.
  PARAM_ILLCONDITIONED  ours != solverlike, but both gaps (ours, ngspice) are
                    within the double-precision floor S·eps·(N+10), where
                    S = max |dlnQ/dln p| over the device parameters: the
                    quantity is not determined by double-precision inputs. artifact
  SOLVER_STAMPS     ours != solverlike beyond that floor: the solver mis-stamps
                    or mis-linearizes what it does model.             BUG
  OMITTED_PHYSICS   solverlike_phys != ours: a dropped junction / g_mu carries
                    real (non-gmin) conductance that changes the result.  BUG
  NGSPICE_GMIN      ngspice == full, and ours == solverlike_phys: the whole
                    difference is ngspice's gmin on the dropped terms.  artifact
  NGSPICE_NUMERICS  ngspice != full (its printed value is not the exact solution
                    of its own circuit), ours == solverlike_phys, and the gap
                    is within the double-precision forward-error bound
                    κ₁(A)·eps·‖x‖/|x_k| of ngspice's system: the quantity is
                    not determined to 1e-6 in double precision.     artifact
  UNEXPLAINED       anything else (e.g. an ngspice gap beyond that bound).
A case's verdict is the worst over its failing quantities.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import indep
import mpverify
from prove import failures, solver

RTOL = 1e-6
ORDER = ["NGSPICE_NUMERICS", "PARAM_ILLCONDITIONED", "NGSPICE_GMIN", "OMITTED_PHYSICS", "SOLVER_STAMPS", "UNEXPLAINED"]


def as_c(x):
    if x is None:
        return None
    if x == math.inf or (hasattr(x, "imag") and indep.mp.isinf(x)) or (isinstance(x, complex) and not math.isfinite(abs(x))):
        return math.inf
    return complex(x)


def close(a, b, rtol=RTOL) -> bool:
    a, b = as_c(a), as_c(b)
    if a == math.inf or b == math.inf:
        # Infinite matches only an impedance beyond 1e15 (compare.py's rule).
        return (a == math.inf or abs(a) > 1e15) and (b == math.inf or abs(b) > 1e15)
    return abs(a - b) <= rtol * max(abs(a), abs(b)) + 1e-30


def fmt(x) -> str:
    x = as_c(x)
    return "inf" if x == math.inf else f"{x:.10g}"


def verdict(binary: str, cir: Path, allow_op: bool = False) -> dict:
    """allow_op: proceed although operating points differ (only when that
    difference is already proven gmin-level, see opcheck.py)."""
    side = json.loads(cir.with_suffix(".json").read_text())
    want = json.loads((cir.parent.parent / "e" / f"{cir.stem}.json").read_text())
    got = solver(binary, cir, side, float(mpverify.RUN_GMIN))
    if isinstance(got, str):
        return {"verdict": "UNEXPLAINED", "why": f"solver error: {got[:120]}"}
    fails = failures(got, want, side)
    if not allow_op and any("@" not in f for f in fails):
        # A different operating point means a different small-signal circuit:
        # AC evidence would compare unlike things (see opcheck.py).
        return {"verdict": "OP_MISMATCH", "why": next(f for f in fails if "@" not in f)[:150]}
    keys = sorted({f.split(":")[0] for f in fails if "@" in f})
    if not keys:
        return {"verdict": None, "why": "no AC failure"}
    kept = {p["name"] for p in got["params"]}
    full = indep.build_and_solve(cir, want, "full")
    like = indep.build_and_solve(cir, want, "solverlike", kept=kept)
    like_phys = indep.build_and_solve(cir, want, "solverlike_phys", kept=kept)
    per = {}
    for k in keys:
        q, f = k.split("@")
        r = got.get(q) or {}
        v = next((v for v in r.get("values", []) if math.isclose(v["f"], float(f), rel_tol=1e-9)), None)
        ours = math.inf if r.get("infinite") or v is None or v.get("re") is None else complex(v["re"], v["im"])
        w = next(w for w in want[q]["values"] if math.isclose(w["f"], float(f), rel_tol=1e-9))
        ng = math.inf if w.get("inf") or w.get("re") is None else complex(w["re"], w["im"])
        ex_full, ex_like, ex_phys = full[k], like[k], like_phys[k]
        detail = f"ours {fmt(ours)} ngspice {fmt(ng)} | exact: full {fmt(ex_full)} solverlike {fmt(ex_like)} +dropped-physics {fmt(ex_phys)}"
        # Conditioning: S = max |dlnQ/dlnp| over device parameters; inputs
        # carry about one ulp each, so no double-precision computation (ours
        # or ngspice's) pins Q better than S·2^-52·(N+10).
        tol, cond = RTOL, ""
        if not close(ours, ex_like):
            sens = float(indep.sensitivity(cir, want, k, "solverlike", kept))
            npar = sum(1 for d in want["op"]["devices"].values() for x in indep.DEVICE_KEYS if d.get(x))
            floor = sens * 2.0 ** -52 * (npar + 10)
            if floor > RTOL:
                tol, cond = floor, f" | ill-conditioned: S={sens:.3g}, floor {floor:.2e}"
        detail += cond
        if not close(ours, ex_like, tol):
            per[k] = ("SOLVER_STAMPS", detail)
        elif not close(ex_phys, ours, tol):
            per[k] = ("OMITTED_PHYSICS", detail)
        elif close(ex_full, ng, tol):
            per[k] = ("NGSPICE_GMIN" if close(ex_full, ng) or not close(ex_phys, ng, tol) else "PARAM_ILLCONDITIONED", detail)
        else:
            # ngspice's printed value is not the exact solution of its own
            # circuit: accept only if double precision can explain the gap.
            err = abs(as_c(ng) - as_c(ex_full)) / abs(as_c(ex_full)) if as_c(ng) != math.inf and as_c(ex_full) != math.inf else math.inf
            b = max(float(full[("bound", k)]), tol)
            detail += f" | ngspice error {err:.2e} vs double-precision bound {b:.2e}"
            per[k] = ("NGSPICE_NUMERICS" if err <= b else "UNEXPLAINED", detail)
        if cond and per[k][0] in ("NGSPICE_GMIN", "NGSPICE_NUMERICS") and not close(ours, ex_like):
            per[k] = (per[k][0], per[k][1] + " (ours vs exact within the conditioning floor)")
    worst = max((v[0] for v in per.values()), key=ORDER.index)
    return {"verdict": worst, "why": f"{next(k for k, v in per.items() if v[0] == worst)}: " +
            next(v[1] for v in per.values() if v[0] == worst), "keys": {k: v[0] for k, v in per.items()}}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("binary")
    ap.add_argument("netlists", nargs="+", type=Path)
    ap.add_argument("--json", type=Path)
    ap.add_argument("--jobs", type=int, default=8)
    args = ap.parse_args()

    def one(c):
        try:
            return str(c), verdict(args.binary, c)
        except Exception as exc:  # noqa: BLE001 - report every case
            return str(c), {"verdict": "UNEXPLAINED", "why": f"evidence error: {exc!r}"[:200]}

    with ThreadPoolExecutor(args.jobs) as ex:
        out = dict(ex.map(one, args.netlists))
    counts: dict = {}
    for v in out.values():
        counts[v["verdict"]] = counts.get(v["verdict"], 0) + 1
    for c, v in out.items():
        print(f"{Path(c).stem:24s} {v['verdict']}  {v['why'][:170]}")
    print(counts)
    if args.json:
        args.json.write_text(json.dumps(out, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
