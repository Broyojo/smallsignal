"""Evidence for (or against) classifying a fuzz mismatch as an ngspice artifact.

usage: uv run prove.py <solver binary> <netlist.cir>... [--json out.json]

Two independent tests, each of which either proves the artifact claim or
reports it unproven (an unproven case must be treated as a solver bug):

gmin scaling
    ngspice adds gmin (here 1e-15 S) across every pn junction; the solver
    keeps the physical circuit (and only uses gmin as ngspice does inside DC
    junction currents). Both are rerun at gmin = 1e-18. A gmin-induced
    discrepancy must shrink in proportion (>= 50x) and pass the 1e-6
    comparison; where the solver says "infinite", ngspice's impedance must
    grow in proportion (>= 100x). Anything else is not explained by gmin.

absurd current (physical degeneracy)
    A device current above 1 A through a forward-biased (> 0.9 V) junction
    that is either directly between nodes forced by ideal voltage sources
    (ground, V, L at DC, E with forced controls) with I matching the junction
    law IS·exp(Vj/(N·Vt)), or on a path of junctions only (no resistor) between
    such nodes, or closing a loop made only of ideal voltage-type branches (V,
    E, H, L) and junctions: nothing but the exponential limits the current,
    so the circuit is not physical and no simulator's numbers mean anything.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import run_ngspice
import spice
from indep import model_params  # reads SPICE suffixes (KF=1f, TOX=100n)
from compare import Report, compare, is_inf

BASE_OPTIONS = run_ngspice.OPTIONS
VT = 1.38064852e-23 * 300.15 / 1.6021766208e-19


def options(gmin: float) -> str:
    return re.sub(r"gmin=[^ ]+", f"gmin={gmin:g}", BASE_OPTIONS)


def ngspice(cir: Path, side: dict, gmin: float) -> dict | None:
    try:
        with run_ngspice.options_override(options(gmin)), tempfile.TemporaryDirectory() as tmp:
            c = Path(tmp) / cir.name
            c.write_text(cir.read_text())
            c.with_suffix(".json").write_text(json.dumps(side))
            return run_ngspice.process(c, Path(tmp) / "e", None)
    except (run_ngspice.NgspiceError, KeyError, ValueError):
        return None


def solver(binary: str, cir: Path, side: dict, gmin: float) -> dict | str:
    title, _, body = cir.read_text().partition("\n")
    with tempfile.NamedTemporaryFile("w", suffix=".cir", delete=False) as f:
        f.write(f"{title}\n{options(gmin)}\n{body}")
        path = f.name
    out = side["output"] + (f":{side['ref']}" if side.get("ref") else "")
    args = [binary, "analyze", path, "--input", side["input"], "--output", out,
            "--freq", ",".join(repr(float(x)) for x in side["freqs"])]
    args += ["--rin"] if side.get("rin") else []
    args += ["--rout"] if side.get("rout") else []
    try:
        data = json.loads(subprocess.run(args, capture_output=True, text=True, timeout=120).stdout)
    finally:
        Path(path).unlink()
    return data.get("error", data) if "error" in data else data


def failures(got: dict, want: dict, side: dict) -> list[str]:
    rep = Report(1e-6, side.get("reference_limits"))
    compare(got, want, rep)
    return [f for f in rep.failures if ".region" not in f]


def lookup(res: dict, key: str, ours: bool):
    """Value of a compare.py failure key ('rin@78.2', 'V(n3)', 'q1.ic') in a result."""
    if "@" in key:
        q, f = key.split("@")
        quantity = res.get(q) or {}
        for v in quantity.get("values", []):
            if math.isclose(v["f"], float(f), rel_tol=1e-9):
                if is_inf(v) if not ours else (quantity.get("infinite") or v.get("re") is None):
                    return math.inf
                return complex(v["re"], v["im"])
        return None
    if key.startswith("V("):
        nodes = {k.lower(): v for k, v in res["op"]["nodes"].items()}
        return nodes.get(key[2:-1].lower())
    dev, field = key.split(".", 1)
    devs = {k.lower(): v for k, v in res["op"]["devices"].items()}
    return devs.get(dev.lower(), {}).get(field)


def gmin_scaling(binary: str, cir: Path, side: dict, op_only: bool = False) -> tuple[bool, str]:
    n1, o1 = ngspice(cir, side, 1e-15), solver(binary, cir, side, 1e-15)
    n2, o2 = ngspice(cir, side, 1e-18), solver(binary, cir, side, 1e-18)
    if not all(isinstance(x, dict) for x in (n1, o1, n2, o2)):
        return False, "a run failed at one of the gmin values"
    keys = sorted({f.split(":")[0] for f in failures(o1, n1, side) if not (op_only and "@" in f)})
    if not keys:
        return False, "no failure at gmin=1e-15 (cannot attribute)"
    still = {f.split(":")[0] for f in failures(o2, n2, side)}
    notes = []
    for k in keys:
        a1, b1, a2, b2 = (lookup(o1, k, True), lookup(n1, k, False), lookup(o2, k, True), lookup(n2, k, False))
        if None in (a1, b1, a2, b2):
            return False, f"{k}: missing value"
        if k not in still:
            notes.append(f"{k}: passes at gmin=1e-18")
            continue
        huge = any(x == math.inf or abs(x) >= 1e12 for x in (a1, b1, a2, b2))
        if huge:
            # Each side is either truly infinite or set by gmin (grows ~1/gmin).
            scales = lambda x1, x2: (x1 == math.inf and x2 == math.inf) or (
                x1 != math.inf and (x2 == math.inf or abs(x2) >= 100 * abs(x1)))
            if scales(a1, a2) and scales(b1, b2):
                fmt = lambda x: "inf" if x == math.inf else f"{abs(x):.3g}"
                notes.append(f"{k}: ours {fmt(a1)}->{fmt(a2)}, ngspice {fmt(b1)}->{fmt(b2)}")
                continue
            if math.inf in (a1, b1, a2, b2):
                return False, f"{k}: impedance not set by gmin (ours {a1}->{a2}, ngspice {b1}->{b2})"
        d1, d2 = abs(a1 - b1), abs(a2 - b2)
        if d2 <= d1 / 50:
            notes.append(f"{k}: |diff| {d1:.3g} -> {d2:.3g}")
            continue
        return False, f"{k}: |diff| {d1:.3g} -> {d2:.3g} does not scale with gmin"
    return True, "; ".join(notes)


def forced_nodes(net: spice.Netlist) -> set[str]:
    """Nodes whose DC voltage is fixed by ideal voltage sources alone."""
    fixed = {"0"}
    changed = True
    while changed:
        changed = False
        for e in net.elements:
            a, b = (e.nodes + [None, None])[:2]
            forcing = e.kind in ("v", "l") or (e.kind == "e" and {e.nodes[2], e.nodes[3]} <= fixed)
            if forcing and (a in fixed) != (b in fixed):
                fixed |= {a, b}
                changed = True
    return fixed


def absurd_current(cir: Path, side: dict) -> tuple[bool, str]:
    ref = ngspice(cir, side, 1e-15)
    if ref is None:
        return False, "ngspice failed"
    text = cir.read_text()
    net = spice.parse(text)
    params = model_params(text)
    fixed = forced_nodes(net)
    volt = {k.lower(): v for k, v in ref["op"]["nodes"].items()}
    v = lambda n: 0.0 if n in spice.GROUND else volt[n.lower()]
    # Junction edges of every device: current through them is limited only by
    # the exponential law unless a resistor-type element intervenes.
    jedges = []
    for e in net.elements:
        if e.kind == "q":
            c, bb, em = e.nodes[:3]
            jedges += [(bb, em, e.name), (bb, c, e.name)]
        elif e.kind == "d":
            jedges.append((e.nodes[0], e.nodes[1], e.name))
        elif e.kind == "m":
            d_, _, s_, b_ = e.nodes
            jedges += [(b_, s_, e.name), (b_, d_, e.name)]

    def ideal_loop(pa: str, pk: str, skip: tuple) -> bool:
        """pa and pk are joined by ideal voltage-type branches (V, E, H, and L,
        a DC short; ground counts as one node) and other junctions only, so
        the junction closes a loop with no resistor in it."""
        parent: dict[str, str] = {}

        def root(x: str) -> str:
            x = "0" if x in spice.GROUND else x
            parent.setdefault(x, x)
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        for e2 in net.elements:
            if e2.kind in ("v", "e", "h", "l"):
                parent[root(e2.nodes[0])] = root(e2.nodes[1])
        for a_, b_, nm in jedges:
            if (a_, b_, nm) != skip:
                parent[root(a_)] = root(b_)
        return root(pa) == root(pk)

    def reaches_forced(start: str, skip: tuple) -> bool:
        """start is forced, or connects to a forced node through junction
        edges only (not using `skip`)."""
        seen, todo = {start}, [start]
        while todo:
            n = todo.pop()
            if n in fixed or n in spice.GROUND:
                return True
            for a_, b_, nm in jedges:
                if (a_, b_, nm) == skip:
                    continue
                for x, y in ((a_, b_), (b_, a_)):
                    if x == n and y not in seen:
                        seen.add(y)
                        todo.append(y)
        return False

    for e in net.elements:
        d = ref["op"]["devices"].get(e.name.lower())
        if not d:
            continue
        current = max(abs(d.get(k, 0)) for k in ("id", "ic", "ib"))
        if e.kind == "m":
            # ngspice's @m[id] excludes the bulk junctions: take their current
            # from the junction law at ngspice's voltages.
            mn = e.tokens[5].lower()
            tt = -1 if net.models.get(mn) == "pmos" else 1
            isat = params.get(mn, {}).get("is", 1e-14)
            d_, _, s_, b_ = e.nodes
            for other in (s_, d_):
                vj = tt * (v(b_) - v(other))
                current = max(current, isat * math.exp(min(vj / VT, 700)))
        if current <= 1.0:
            continue
        mname = (e.tokens[4] if e.kind == "q" and len(e.nodes) == 3 else e.tokens[5] if e.kind in ("q", "m") else e.tokens[3]).lower()
        p = params.get(mname, {})
        t = -1 if net.models.get(mname) in ("pnp", "pmos") else 1
        if e.kind == "q":
            c, b, em = e.nodes[:3]
            junctions = [(b, em, "BE"), (b, c, "BC")]
            isat, n = p.get("is", 1e-16), 1.0
        elif e.kind == "d":
            junctions = [(e.nodes[0], e.nodes[1], "D")]
            isat, n = p.get("is", 1e-14), p.get("n", 1.0)
        else:
            d_, _, s_, b_ = e.nodes
            junctions = [(b_, s_, "BS"), (b_, d_, "BD")]
            isat, n = p.get("is", 1e-14), 1.0
        for pa, pk, label in junctions:
            vj = t * (v(pa) - v(pk))
            if vj < 0.9:
                continue
            law = isat * math.exp(min(vj / (n * VT), 700))
            ok_law = law > 0 and 0.1 <= current / law <= 10 or current > 1e3
            if law <= 1.0:
                continue  # this junction is not the one carrying the absurd current
            if pa in fixed and pk in fixed and ok_law:
                return True, (f"{e.name} {label} junction at {vj:.3f} V between source-forced nodes "
                              f"{pa},{pk}; I={current:.3g} A, IS·exp(Vj/NVt)={law:.3g} A")
            edge = (pa, pk, e.name)
            if ideal_loop(pa, pk, edge):
                return True, (f"{e.name} {label} junction forward-biased {vj:.3f} V in a loop of ideal "
                              f"voltage-type branches and junctions only (no resistor); I≈{law:.3g} A")
            if reaches_forced(pa, edge) and reaches_forced(pk, edge):
                return True, (f"{e.name} {label} junction at {vj:.3f} V on a junction-only path between "
                              f"ideal sources (no resistor limits it); I={current:.3g} A")
    return False, "no >1 A junction between source-forced nodes"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("binary")
    ap.add_argument("netlists", nargs="+", type=Path)
    ap.add_argument("--test", choices=["gmin", "absurd", "both"], default="both")
    ap.add_argument("--json", type=Path)
    args = ap.parse_args()
    out = {}
    for cir in args.netlists:
        side = json.loads(cir.with_suffix(".json").read_text())
        result = {}
        if args.test in ("gmin", "both"):
            result["gmin"] = gmin_scaling(args.binary, cir, side)
        if args.test in ("absurd", "both"):
            result["absurd"] = absurd_current(cir, side)
        out[str(cir)] = result
        print(cir.stem, {k: ("PROVEN" if ok else "unproven", why[:160]) for k, (ok, why) in result.items()})
    if args.json:
        args.json.write_text(json.dumps(out, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
