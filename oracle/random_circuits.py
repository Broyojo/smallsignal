"""Generate random circuits (plus ngspice reference results) for fuzz comparison.

usage: uv run random_circuits.py [--seed S] [--count N] [--kind linear|mos|bjt|mixed]
                                 [--out random] [--expected expected_random]
then:  uv run compare.py --corpus random --expected expected_random

Every node gets a resistor path to ground (or to a supply), so the DC operating
point exists. Voltage sources and inductors never form a loop. Transistor circuits
are rejection-sampled: a candidate is kept only if ngspice converges and every
device sits clearly inside one region (no reverse mode, >= 50 mV from a region
boundary, BJTs forward-active), so the two solvers can't disagree over a
borderline bias.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sys
import tempfile
from pathlib import Path

import run_ngspice
import spice

HERE = Path(__file__).resolve().parent
MARGIN = 0.05

NCH = ".model nch NMOS (LEVEL=1 KP={kp} VTO={vto} LAMBDA={lam} GAMMA={gamma} PHI=0.7)"
PCH = ".model pch PMOS (LEVEL=1 KP={kp} VTO=-{vto} LAMBDA={lam} GAMMA={gamma} PHI=0.7)"
QN = ".model qn NPN (IS={is_} BF={bf} VAF={vaf})"
QP = ".model qp PNP (IS={is_} BF={bf} VAF={vaf})"


def logu(rng: random.Random, lo: float, hi: float) -> float:
    return math.exp(rng.uniform(math.log(lo), math.log(hi)))


def fmt(x: float) -> str:
    return f"{x:.4g}"


class DSU:
    """Union-find over nodes joined by voltage sources and inductors (no loops allowed)."""

    def __init__(self):
        self.parent: dict[str, str] = {}

    def find(self, a: str) -> str:
        self.parent.setdefault(a, a)
        while self.parent[a] != a:
            self.parent[a] = self.parent[self.parent[a]]
            a = self.parent[a]
        return a

    def try_union(self, a: str, b: str) -> bool:
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return False
        self.parent[ra] = rb
        return True


class Builder:
    def __init__(self, rng: random.Random):
        self.rng = rng
        self.lines: list[str] = []
        self.models: list[str] = []
        self.count: dict[str, int] = {}
        self.vloop = DSU()
        self.fresh = 0

    def name(self, kind: str) -> str:
        self.count[kind] = self.count.get(kind, 0) + 1
        return f"{kind}{self.count[kind]}"

    def node(self) -> str:
        self.fresh += 1
        return f"m{self.fresh}"

    def add(self, kind: str, *fields) -> str:
        n = self.name(kind)
        self.lines.append(" ".join([n, *map(str, fields)]))
        return n

    def vsource_ok(self, a: str, b: str) -> bool:
        return a != b and self.vloop.try_union(a, b)

    def resistor_tree(self, nodes: list[str], anchors: list[str], lo=100.0, hi=1e6):
        order = nodes[:]
        self.rng.shuffle(order)
        placed = anchors[:]
        for n in order:
            self.add("R", n, self.rng.choice(placed), fmt(logu(self.rng, lo, hi)))
            placed.append(n)

    def text(self, title: str) -> str:
        return "\n".join([title, *self.lines, *self.models, ".end"]) + "\n"


def linear(rng: random.Random) -> tuple[str, dict]:
    b = Builder(rng)
    internal = [f"n{i}" for i in range(1, rng.randint(2, 7) + 1)]
    nodes = ["in", *internal]
    use_i = rng.random() < 0.2
    if use_i:
        b.add("I", "0", "in", "DC 0 AC 1")
    else:
        b.vsource_ok("in", "0")
        b.add("V", "in", "0", "DC 0 AC 1")
    b.resistor_tree(nodes, ["0"])
    resistors = [l for l in b.lines if l.startswith("R")]
    all_nodes = ["0", *nodes]
    for _ in range(rng.randint(0, 2 * len(internal))):
        kind = rng.choice("RRCCLGEFH")
        p, q = rng.sample(all_nodes, 2)
        if kind == "R":
            b.add("R", p, q, fmt(logu(rng, 100, 1e6)))
        elif kind == "C":
            b.add("C", p, q, fmt(logu(rng, 1e-13, 1e-8)))
        elif kind == "L":
            if b.vsource_ok(p, q):
                b.add("L", p, q, fmt(logu(rng, 1e-9, 1e-3)))
        elif kind == "G":
            c1, c2 = rng.sample(all_nodes, 2)
            b.add("G", p, q, c1, c2, fmt(rng.choice([-1, 1]) * logu(rng, 1e-5, 1e-2)))
        elif kind == "E":
            c1, c2 = rng.sample(all_nodes, 2)
            if b.vsource_ok(p, q):
                b.add("E", p, q, c1, c2, fmt(rng.choice([-1, 1]) * logu(rng, 0.1, 100)))
        else:  # F or H: put a 0 V sense source in series with an existing resistor
            if not resistors:
                continue
            line = rng.choice(resistors)
            resistors.remove(line)
            idx = b.lines.index(line)
            rname, a, z, val = line.split()
            m = b.node()
            b.lines[idx] = f"{rname} {a} {m} {val}"
            b.vsource_ok(m, z)
            sense = b.add("V", m, z, "DC 0")
            if kind == "F":
                b.add("F", p, q, sense, fmt(rng.choice([-1, 1]) * logu(rng, 0.1, 10)))
            elif b.vsource_ok(p, q):
                b.add("H", p, q, sense, fmt(rng.choice([-1, 1]) * logu(rng, 10, 1e5)))
    out = rng.choice(internal)
    ref = rng.choice([n for n in all_nodes if n not in (out, "0")]) if rng.random() < 0.2 else None
    side = {"input": "I1" if use_i else "V1", "output": out, "ref": ref,
            "freqs": sorted(fmt_f(logu(rng, 10, 1e9)) for _ in range(3)),
            "rin": True, "rout": True, "description": "random linear circuit"}
    return b.text("random linear circuit"), side


def fmt_f(f: float) -> float:
    return float(f"{f:.6g}")


def transistor(rng: random.Random, kind: str) -> tuple[str, dict]:
    b = Builder(rng)
    supply = round(rng.uniform(1.5, 3.3), 2) if kind == "mos" else round(rng.uniform(3, 10), 1)
    internal = [f"n{i}" for i in range(1, rng.randint(1, 5) + 1)]
    b.vsource_ok("vdd", "0")
    b.add("V", "vdd", "0", f"DC {supply}")
    vin_dc = round(rng.uniform(0.2, 0.8) * supply, 3)
    b.vsource_ok("in", "0")
    b.add("V", "in", "0", f"DC {vin_dc} AC 1")
    b.resistor_tree(internal, ["0", "vdd"], 200, 2e5)
    pool = ["0", "vdd", "in", *internal]
    ndev = rng.randint(1, 4)
    used_models = set()
    terminals: list[str] = []
    for i in range(ndev):
        dkind = kind if kind != "mixed" else rng.choice(["mos", "bjt"])
        pol = rng.choice(["n", "p"])
        if dkind == "mos":
            d, s = rng.sample(pool, 2)
            g = "in" if i == 0 and "in" not in (d, s) else rng.choice(pool)
            terminals += [d, s]
            body = "0" if pol == "n" else "vdd"
            model = "nch" if pol == "n" else "pch"
            b.add("M", d, g, s, body, model, f"W={fmt(logu(rng, 1, 50))}u", f"L={fmt(rng.choice([0.5, 1, 2]))}u")
        else:
            c, e = rng.sample(pool, 2)
            base = "in" if i == 0 and "in" not in (c, e) else rng.choice([n for n in pool if n not in (c, e)])
            terminals += [c, e]
            model = "qn" if pol == "n" else "qp"
            b.add("Q", c, base, e, model)
        used_models.add(model)
    for _ in range(rng.randint(0, len(internal))):
        p, q = rng.sample(pool, 2)
        b.add("C", p, q, fmt(logu(rng, 1e-14, 1e-11)))
    mos_par = dict(kp=fmt(logu(rng, 50e-6, 400e-6)), vto=fmt(rng.uniform(0.3, 0.7)),
                   lam=fmt(rng.uniform(0, 0.2)), gamma=fmt(rng.choice([0, rng.uniform(0.2, 0.6)])))
    bjt_par = dict(is_=fmt(logu(rng, 1e-16, 1e-14)), bf=fmt(rng.uniform(50, 300)), vaf=fmt(rng.uniform(20, 150)))
    templates = {"nch": NCH, "pch": PCH, "qn": QN, "qp": QP}
    for m in sorted(used_models):
        b.models.append(templates[m].format(**(mos_par if m in ("nch", "pch") else bjt_par)))
    out = rng.choice([n for n in terminals if n in internal] or internal)
    side = {"input": "V2", "output": out, "ref": None,
            "freqs": sorted(fmt_f(logu(rng, 10, 1e9)) for _ in range(3)),
            "rin": True, "rout": True, "description": f"random {kind} circuit"}
    return b.text(f"random {kind} circuit"), side


def nontrivial(result: dict) -> bool:
    """Reject circuits whose output never sees the input (gain exactly or nearly 0)."""
    return any(v.get("inf") or abs(complex(v["re"], v["im"])) > 1e-6 for v in result["gain"]["values"])


def clearly_biased(result: dict) -> bool:
    for d in result["op"]["devices"].values():
        if d["type"] in ("nmos", "pmos"):
            if d["reverse"] or d["vov"] < MARGIN or abs(abs(d["vds"]) - d["vov"]) < MARGIN:
                return False
        elif d["type"] in ("npn", "pnp"):
            t = 1 if d["type"] == "npn" else -1
            vbe, vbc = t * d["vbe"], t * (d["vbe"] - d["vce"])
            if d["region"] != "forward-active" or vbe < 0.5 or vbc > -0.1:
                return False
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--count", type=int, default=20)
    ap.add_argument("--kind", choices=["linear", "mos", "bjt", "mixed"], default="linear")
    ap.add_argument("--out", type=Path, default=HERE / "random")
    ap.add_argument("--expected", type=Path, default=HERE / "expected_random")
    ap.add_argument("--max-tries", type=int, default=2000, help="per kept circuit")
    args = ap.parse_args()
    rng = random.Random(args.seed)
    args.out.mkdir(parents=True, exist_ok=True)
    kept = 0
    tries = 0
    while kept < args.count:
        tries += 1
        if tries > args.max_tries * args.count:
            print(f"gave up after {tries} tries", file=sys.stderr)
            return 1
        text, side = linear(rng) if args.kind == "linear" else transistor(rng, args.kind)
        name = f"{args.kind}_{args.seed}_{kept:03d}"
        cir = args.out / f"{name}.cir"
        cir.write_text(text)
        cir.with_suffix(".json").write_text(json.dumps(side, indent=1) + "\n")
        try:
            with tempfile.TemporaryDirectory() as tmp:
                result = run_ngspice.process(cir, Path(tmp), None)
        except (run_ngspice.NgspiceError, KeyError, ValueError):
            continue
        if not clearly_biased(result) or not nontrivial(result):
            continue
        run_ngspice.process(cir, args.expected, None)
        kept += 1
    for d in (args.out, args.expected):
        for stale in d.glob(f"{args.kind}_{args.seed}_*"):
            if int(stale.stem.split("_")[-1]) >= kept:
                stale.unlink()
    print(f"kept {kept} {args.kind} circuits after {tries} candidates -> {args.out}, {args.expected}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
