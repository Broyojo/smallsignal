"""Evidence for operating-point mismatches between the solver and ngspice.

usage: uv run opcheck.py <solver binary> <netlist.cir>... [--json out.json]

  MULTISTABLE   ngspice, started at the solver's operating point (.nodeset),
                converges to it: both are valid DC solutions of a multistable
                circuit. The solver's whole result is then compared again
                against that ngspice run (op and AC).               artifact*
  GMIN_OP       the op discrepancy shrinks >= 50x when gmin goes 1e-15 ->
                1e-18 in both simulators (it is gmin's own current). artifact
  OP_GMIN_AC_UNPROVEN  op is gmin-explained but an AC difference is not (see
                evidence.py on that case).
  OP_BUG        neither.                                              BUG
* plus whatever the re-comparison against the matching ngspice solution finds.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

import run_ngspice
from prove import failures, gmin_scaling, solver


def ngspice_from(cir: Path, side: dict, nodes: dict[str, float], out_dir: Path) -> dict | None:
    """ngspice run started at the given node voltages; writes c/ and e/ under out_dir."""
    text = cir.read_text().rstrip().splitlines()
    body = [l for l in text if l.strip().lower() != ".end"]
    seed = ".nodeset " + " ".join(f"v({n})={v!r}" for n, v in nodes.items())
    c = out_dir / "c" / cir.name
    c.parent.mkdir(parents=True, exist_ok=True)
    c.write_text("\n".join([*body, seed, ".end"]) + "\n")
    c.with_suffix(".json").write_text(json.dumps(side))
    try:
        return run_ngspice.process(c, out_dir / "e", None)
    except (run_ngspice.NgspiceError, KeyError, ValueError):
        return None


def check(binary: str, cir: Path) -> dict:
    side = json.loads(cir.with_suffix(".json").read_text())
    want = json.loads((cir.parent.parent / "e" / f"{cir.stem}.json").read_text())
    got = solver(binary, cir, side, 1e-15)
    if isinstance(got, str):
        return {"verdict": "SOLVER_ERROR", "why": got[:120]}
    op_fail = [f for f in failures(got, want, side) if "@" not in f]
    if not op_fail:
        return {"verdict": None, "why": "operating points agree"}
    with tempfile.TemporaryDirectory() as tmp:
        ref2 = ngspice_from(cir, side, got["op"]["nodes"], Path(tmp))
        if ref2 is not None:
            op2 = [f for f in failures(got, ref2, side) if "@" not in f]
            if not op2:
                rest = failures(got, ref2, side)
                after = "and op + AC then match" if not rest else f"then AC differs: {rest[0][:90]}"
                if rest:
                    import evidence
                    ev = evidence.verdict(binary, Path(tmp) / "c" / cir.name)
                    after += f" -> AC evidence {ev['verdict']}: {ev['why'][:120]}"
                return {"verdict": "MULTISTABLE", "why": f"ngspice seeded at our op converges to it ({op_fail[0][:70]}); {after}"}
    ok, why = gmin_scaling(binary, cir, side, op_only=True)
    if ok:
        ac = [f for f in failures(got, want, side) if "@" in f]
        note = ""
        if ac:
            # AC at the shifted bias: same gmin test on the AC keys alone.
            ok_ac, why_ac = gmin_scaling(binary, cir, side)
            note = f" | AC: {'gmin-explained' if ok_ac else 'NOT gmin-explained'}: {why_ac[:120]}"
            if not ok_ac:
                import evidence
                ev = evidence.verdict(binary, cir, allow_op=True)
                note += f" | AC evidence: {ev['verdict']}: {ev['why'][:200]}"
                if ev["verdict"] not in ("NGSPICE_NUMERICS", "NGSPICE_GMIN", "PARAM_ILLCONDITIONED", None):
                    return {"verdict": "OP_GMIN_AC_UNPROVEN", "why": why + note}
        return {"verdict": "GMIN_OP", "why": why + note}
    return {"verdict": "OP_BUG", "why": f"{op_fail[0][:100]}; gmin test: {why[:100]}"}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("binary")
    ap.add_argument("netlists", nargs="+", type=Path)
    ap.add_argument("--json", type=Path)
    args = ap.parse_args()
    out = {}
    for c in args.netlists:
        try:
            out[str(c)] = check(args.binary, c)
        except Exception as exc:  # noqa: BLE001 - report every case
            out[str(c)] = {"verdict": "OP_BUG", "why": f"opcheck error {exc!r}"[:150]}
        print(f"{c.stem:24s} {out[str(c)]['verdict']}  {out[str(c)]['why'][:220]}")
    if args.json:
        args.json.write_text(json.dumps(out, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
