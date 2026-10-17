"""Check the solver's symbolic results against hand-derived textbook formulas.

usage: uv run textbook.py [-v] [names...]

For each case in textbook_cases.py:
- the solver runs on a value-less netlist (symbolic mode), and its exact
  num/den must equal the hand KCL result as a rational-function identity;
- a textbook closed form, when given, must equal the hand KCL result too
  (this checks the hand derivation itself);
- a textbook approximation, when given, is reported numerically;
- the solver's symbolic `simplified` form (leading order as r_o → ∞) must
  equal the case's textbook hand-analysis form (`lead`) exactly, or equal the
  exact form when the circuit has no r_o;
- numeric-mode runs must render the expected ∥ notation and agree with the
  hand formula evaluated at the solver's own operating-point values. Their
  netlists set gmin = 1e-18: the solver keeps junction leakage (gmin) in the
  exact model wherever it moves a result by more than 1e-9, and hand formulas
  leave it out.
The CLI is $SMALLSIGNAL_BIN if set, else target/release/smallsignal.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import sympy as sp

from textbook_cases import CASES, Case, Quantity, s

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def cli() -> list[str]:
    env = os.environ.get("SMALLSIGNAL_BIN")
    return [env] if env else [str(REPO / "target" / "release" / "smallsignal")]


def run(netlist: str, case: Case, extra: list[str]) -> dict:
    with tempfile.NamedTemporaryFile("w", suffix=".cir", delete=False) as f:
        f.write(netlist)
        path = f.name
    try:
        out = case.output + (f":{case.ref}" if case.ref else "")
        args = [*cli(), "analyze", path, "--input", case.input, "--output", out, *extra]
        if case.input_neg:
            args += ["--input-neg", case.input_neg]
        if case.mode:
            args += ["--mode", case.mode]
        if case.match:
            args += ["--match", ";".join(",".join(g) for g in case.match)]
        for q in ("rin", "rout"):
            if getattr(case, q):
                args.append(f"--{q}")
        proc = subprocess.run(args, capture_output=True, text=True, timeout=120)
    finally:
        os.unlink(path)
    data = json.loads(proc.stdout)
    if "error" in data:
        raise RuntimeError(data["error"])
    return data


def parse(expr: str) -> sp.Expr:
    names = {n: sp.Symbol(n) for n in IDENT.findall(expr)}
    names["s"] = s
    return sp.parse_expr(expr.replace("^", "**"), local_dict=names, evaluate=True)


def ours(q: dict, form: str = "exact") -> sp.Expr:
    if q.get("infinite"):
        return sp.oo
    e = q[form]
    if e.get("num") is None:
        raise RuntimeError("exact expression too large to compare")
    return parse(e["num"]) / parse(e["den"])


def identical(a: sp.Expr, b: sp.Expr) -> bool:
    if a == sp.oo or b == sp.oo:
        return a == b
    return sp.cancel(sp.together(a - b)) == 0


def subs_matched(e: sp.Expr, matched: dict[str, str]) -> sp.Expr:
    if e == sp.oo:
        return e
    return e.subs({sp.Symbol(k): sp.Symbol(v) for k, v in matched.items()}, simultaneous=True)


# Typical values for reporting textbook approximations.
TYPICAL = {"gm": 1e-3, "gmb": 2e-4, "ro": 5e4, "rpi": 1e5, "R": 1e4, "C": 1e-12, "L": 1e-6, "E": 100.0}


def typical(sym: sp.Symbol) -> float:
    n = sym.name
    for prefix in ("gmb", "gm", "rpi", "ro"):
        if n.startswith(prefix + "_"):
            return TYPICAL[prefix]
    return TYPICAL.get(n[0], 1e4)


def check_case(case: Case, verbose: bool) -> list[str]:
    fails: list[str] = []
    notes: list[str] = []
    data = run(case.netlist, case, ["--symbolic"])
    for qname in ("gain", "rin", "rout"):
        q: Quantity | None = getattr(case, qname)
        if q is None:
            continue
        hand = subs_matched(sp.sympify(q.hand()), q.matched)
        got = subs_matched(ours(data[qname]), q.matched)
        if not identical(got, hand):
            fails.append(f"{qname}: solver {sp.simplify(got)}  !=  hand {sp.simplify(hand)}")
        if q.closed is not None:
            closed = subs_matched(sp.sympify(q.closed()), q.matched)
            if not identical(closed, hand):
                fails.append(f"{qname}: textbook closed form {closed} != hand KCL {hand} (derivation slip)")
        if got != sp.oo:
            simp = data[qname]["simplified"]
            lead = subs_matched(ours(data[qname], "simplified"), q.matched)
            if q.lead is not None:
                want = subs_matched(sp.sympify(q.lead()), q.matched)
                if not identical(lead, want):
                    fails.append(f"{qname}: leading order {sp.simplify(lead)}  !=  textbook {sp.simplify(want)}")
            elif not simp.get("same"):
                fails.append(f"{qname}: no r_o, but the leading order differs from the exact form: {lead}")
            notes.append(f"{qname}: simplified = {simp['latex']}")
        if q.approx is not None and got != sp.oo:
            vals = {x: typical(x) for x in got.free_symbols | sp.sympify(q.approx()).free_symbols if x != s}
            ratio = float((got / q.approx()).subs(vals).subs(s, 0))
            notes.append(f"{qname}: exact/approx = {ratio:.4f} at typical values")
    if case.noise is not None:
        fails += check_noise(case, notes)
    if case.name.startswith("miller"):
        num = sp.numer(sp.together(ours(data["gain"])))
        zeros = sp.solve(num, s)
        want = sp.Symbol("gm_M1") / sp.Symbol("CGD")
        if not any(sp.simplify(z - want) == 0 for z in zeros):
            fails.append(f"gain zero: {zeros}, want gm/Cgd")
    if case.numeric_netlist:
        nd = run(case.numeric_netlist, case, ["--freq", "1e3,1e6"])
        values = {sp.Symbol(p["name"]): p["value"] for p in nd["params"]}
        for qname in case.parallel:
            latex = nd[qname]["exact"]["latex"]
            if "\\parallel" not in latex:
                fails.append(f"numeric {qname}: latex lacks \\parallel: {latex}")
        for qname in ("gain", "rin", "rout"):
            q = getattr(case, qname)
            if q is None or nd[qname].get("infinite"):
                continue
            hand = sp.sympify(q.hand())
            for v in nd[qname]["values"]:
                h = complex(hand.subs(values).subs(s, 2j * sp.pi * v["f"]).evalf())
                g = complex(v["re"], v["im"])
                if abs(h - g) > 1e-9 * max(abs(h), 1e-30):
                    fails.append(f"numeric {qname}@{v['f']:g}: solver {g} vs hand {h}")
    if verbose:
        for n in notes:
            print(f"    {n}")
    return fails


def noise_pair(form: dict) -> tuple[sp.Expr, sp.Expr]:
    """(thermal, shot) from the solver's inputLowFreq form."""
    part = lambda p: parse(p["num"]) / parse(p["den"]) if p else sp.Integer(0)  # noqa: E731
    return part(form.get("thermal")), part(form.get("shot"))


def check_noise(case: Case, notes: list[str]) -> list[str]:
    fails: list[str] = []
    nq = case.noise
    data = run(case.netlist, case, ["--symbolic", "--noise"])
    lf = data["noise"]["inputLowFreq"]
    m = lambda pair: tuple(subs_matched(sp.sympify(x), nq.matched) for x in pair)  # noqa: E731
    hand = m(nq.hand())
    got = m(noise_pair(lf["exact"]))
    for k, what in enumerate(("4kT", "2q")):
        if not identical(got[k], hand[k]):
            fails.append(f"noise {what}: solver {sp.simplify(got[k])}  !=  hand {sp.simplify(hand[k])}")
    if nq.closed is not None:
        closed = m(nq.closed())
        for k, what in enumerate(("4kT", "2q")):
            if not identical(closed[k], hand[k]):
                fails.append(f"noise {what}: textbook closed form {closed[k]} != hand KCL {hand[k]} (derivation slip)")
    simp = m(noise_pair(lf["simplified"]))
    if nq.lead is not None:
        want = m(nq.lead())
    else:
        want = tuple(sp.limit(h.subs({x: x / sp.Symbol("eps") for x in h.free_symbols if x.name.startswith("ro_")}),
                              sp.Symbol("eps"), 0) for h in hand)
    for k, what in enumerate(("4kT", "2q")):
        if not identical(simp[k], want[k]):
            fails.append(f"noise {what} leading order: solver {sp.simplify(simp[k])}  !=  textbook {sp.simplify(want[k])}")
    notes.append(f"noise: S_in = {lf['simplified']['latex']}")
    return fails


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-v", action="store_true")
    ap.add_argument("names", nargs="*")
    args = ap.parse_args()
    cases = [c for c in CASES if not args.names or c.name in args.names]
    bad = 0
    for case in cases:
        try:
            fails = check_case(case, args.v)
        except Exception as exc:  # noqa: BLE001 - report every case
            fails = [f"error: {exc}"]
        status = "pass" if not fails else "FAIL"
        bad += bool(fails)
        print(f"{case.name:18s} {status}")
        for f in fails:
            print(f"    {f}")
    print(f"\n{len(cases) - bad}/{len(cases)} textbook cases passed")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
