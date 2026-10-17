"""ngspice's small-signal circuit, rebuilt independently and solved at 60 digits.

Builds the MNA system straight from the netlist (not from the solver), with
ngspice's own operating-point linearization from expected/<name>.json:
MOS gm/gds/gmbs on the effective (mode-swapped) terminals plus the bulk
junctions gbs/gbd from ngspice's voltages (mos1load's formula); BJT gm, gpi,
go, gmu; diode gd. variant="full" is ngspice's circuit as simulated (with gmin
across every junction); variant="phys" removes those gmin terms, leaving the
physical device model. Every V source is its own branch (zeroed ones are 0 V
shorts), so no node merging is shared with the solver.
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path

import mpmath as mp

import spice
from run_ngspice import OPTIONS

GMIN = float(re.search(r"gmin=([^ ]+)", OPTIONS).group(1))
VT = mp.mpf("1.38064852e-23") * mp.mpf("300.15") / mp.mpf("1.6021766208e-19")
SUFFIX = [("meg", 1e6), ("mil", 25.4e-6), ("t", 1e12), ("g", 1e9), ("k", 1e3), ("m", 1e-3), ("u", 1e-6),
          ("n", 1e-9), ("p", 1e-12), ("f", 1e-15), ("a", 1e-18)]


def P(x) -> mp.mpf:
    """A device value: float (exact repr) or a full-precision string."""
    return mp.mpf(x) if isinstance(x, str) else mp.mpf(repr(x))


def num(tok: str) -> mp.mpf:
    m = re.match(r"^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)(.*)$", tok.strip())
    if not m:
        raise ValueError(f"bad number {tok!r}")
    rest = m.group(2).lower()
    for suf, mult in SUFFIX:
        if rest.startswith(suf):
            return mp.mpf(m.group(1)) * mp.mpf(repr(mult))
    return mp.mpf(m.group(1))


def model_params(text: str) -> dict[str, dict[str, float]]:
    out = {}
    for m in re.finditer(r"^\.model\s+(\S+)\s+\S+\s*\(?([^)\n]*)\)?", text, re.I | re.M):
        out[m.group(1).lower()] = {k.lower(): float(v) for k, v in re.findall(r"(\w+)=([-+\d.eE]+)", m.group(2))}
    return out


def build_and_solve(cir: Path, want: dict, variant: str = "full", dps: int = 60,
                    kept: set[str] | None = None, phys_kinds: tuple[str, ...] = ("mos", "bjt"),
                    want_system: bool = False):
    """variant: "full" (ngspice's circuit), "phys" (no gmin anywhere),
    "solverlike" (only the junction / g_mu terms in `kept`, the solver's own
    parameter names such as rbd_m1, rmu_q2, each as ngspice has it) or
    "solverlike_phys" (solverlike plus the physical part, without gmin, of
    every term the solver dropped)."""
    mp.mp.dps = dps
    kept = {k.lower() for k in (kept or set())}
    gmin_full = mp.mpf(repr(GMIN))

    def term(name: str, g_phys, g_gmin):
        """Conductance of an optional junction-type term under the variant.
        phys_kinds limits solverlike_phys to dropped MOS junctions ("mos",
        names r{bs,bd}_*) and/or dropped BJT g_mu ("bjt", rmu_*)."""
        if variant == "full":
            return g_phys + g_gmin
        if variant == "phys":
            return g_phys
        if name.lower() in kept:
            return g_phys + g_gmin
        kind = "bjt" if name.lower().startswith("rmu_") else "mos"
        return g_phys if variant == "solverlike_phys" and kind in phys_kinds else mp.mpf(0)
    text = cir.read_text()
    side = json.loads(cir.with_suffix(".json").read_text())
    net = spice.parse(text)
    models = model_params(text)
    gmin = mp.mpf(0) if variant == "phys" else gmin_full  # in always-modelled gpi / gd
    nodes = sorted({n for e in net.elements for n in e.nodes if n not in spice.GROUND})
    nidx = {n: i for i, n in enumerate(nodes)}
    ni = lambda n: None if n in spice.GROUND else nidx[n]
    branch_elems = [e for e in net.elements if e.kind in ("v", "e", "h", "l")]
    bidx = {e.name.lower(): len(nodes) + k for k, e in enumerate(branch_elems)}
    dim = len(nodes) + len(branch_elems)
    volt = {k.lower(): mp.mpf(repr(v)) for k, v in want["op"]["nodes"].items()}
    v = lambda n: mp.mpf(0) if n in spice.GROUND else volt[n.lower()]
    devs = {k.lower(): d for k, d in want["op"]["devices"].items()}
    inp = side["input"].lower()

    def system(s, mode: str):
        A = mp.matrix(dim, dim)
        b = mp.matrix(dim, 1)

        def add(r, c, x):
            if r is not None and c is not None:
                A[r, c] += x

        def adm(a, c, y):
            a, c = ni(a), ni(c)
            add(a, a, y); add(c, c, y); add(a, c, -y); add(c, a, -y)

        def vccs(p, n, cp, cn, g):
            p, n, cp, cn = ni(p), ni(n), ni(cp), ni(cn)
            add(p, cp, g); add(p, cn, -g); add(n, cp, -g); add(n, cn, g)

        for e in net.elements:
            k, t = e.kind, e.tokens
            if k == "r":
                adm(e.nodes[0], e.nodes[1], 1 / num(t[3]))
            elif k == "c":
                adm(e.nodes[0], e.nodes[1], s * num(t[3]))
            elif k == "g":
                vccs(*e.nodes[:4], num(t[5]))
            elif k == "f":
                r = bidx[t[3].lower()]
                add(ni(e.nodes[0]), r, num(t[4])); add(ni(e.nodes[1]), r, -num(t[4]))
            elif k == "i":
                if mode == "gain" and e.name.lower() == inp:
                    # SPICE current flows n+ -> source -> n-: 1 A into n-.
                    if ni(e.nodes[1]) is not None:
                        b[ni(e.nodes[1])] += 1
                    if ni(e.nodes[0]) is not None:
                        b[ni(e.nodes[0])] -= 1
            elif k in ("v", "e", "h", "l"):
                r = bidx[e.name.lower()]
                p, n = ni(e.nodes[0]), ni(e.nodes[1])
                add(p, r, 1); add(n, r, -1); add(r, p, 1); add(r, n, -1)
                if k == "v":
                    b[r] = 1 if (mode == "gain" and e.name.lower() == inp) else 0
                elif k == "e":
                    gain = num(t[5])
                    add(r, ni(e.nodes[2]), -gain); add(r, ni(e.nodes[3]), gain)
                elif k == "h":
                    add(r, bidx[t[3].lower()], -num(t[4]))
                else:
                    add(r, r, -s * num(t[3]))
            elif k == "m":
                d = devs[e.name.lower()]
                dn, gn, sn, bn = e.nodes
                ed, es = (sn, dn) if d["reverse"] else (dn, sn)
                vccs(ed, es, gn, es, P(d["gm"]))
                adm(ed, es, P(d["gds"]))
                vccs(ed, es, bn, es, P(d["gmb"]))
                mname = t[5].lower()
                tt = -1 if net.models.get(mname) == "pmos" else 1
                mult = next((float(x.split("=")[1]) for x in t[6:] if x.lower().startswith("m=")), 1.0)
                isat = mp.mpf(models.get(mname, {}).get("is", 1e-14)) * mult
                for other, which in ((sn, "bs"), (dn, "bd")):
                    vj = tt * (v(bn) - v(other))
                    phys = isat / VT * mp.exp(vj / VT) if vj > -3 * VT else mp.mpf(0)
                    adm(bn, other, term(f"r{which}_{e.name}", phys, gmin_full))
            elif k == "q":
                d = devs[e.name.lower()]
                c, bb, em = e.nodes[:3]
                gm = P(d["gm"])
                gpi = P(d["gpi"]) - mp.mpf(repr(GMIN)) + gmin
                gmu = term(f"rmu_{e.name}", P(d["gmu"]) - gmin_full, gmin_full)
                go = P(d["go"])
                vccs(c, em, bb, em, gm)
                adm(c, em, go)
                adm(bb, em, gpi)
                adm(bb, c, gmu)
            elif k == "d":
                d = devs[e.name.lower()]
                adm(e.nodes[0], e.nodes[1], P(d["gd"]) - mp.mpf(repr(GMIN)) + gmin)
            else:
                raise ValueError(f"unsupported element {e.name}")
        if mode == "rout":
            o, r_ = ni(side["output"]), ni(side["ref"]) if side.get("ref") else None
            if o is not None:
                b[o] += 1
            if r_ is not None:
                b[r_] -= 1
        return A, b

    if want_system:
        # system(s, mode): mode "gain" excites the input source, "rout" injects
        # 1 A at the output, anything else leaves every source at zero.
        return system, ni, bidx, net, side, models
    out: dict[str, object] = {}
    at = lambda x, n: x[ni(n)] if n is not None and ni(n) is not None else 0
    eps = mp.mpf(2) ** -52

    def bound(A, x, value):
        """Relative error a double-precision solve can make in `value`:
        κ₁(A)·eps·‖x‖∞/|value| (normwise forward-error bound)."""
        try:
            kappa = mp.norm(A, 1) * mp.norm(mp.inverse(A), 1)
        except ZeroDivisionError:
            return mp.inf
        xmax = max(abs(x[i]) for i in range(len(x)))
        return kappa * eps * xmax / abs(value) if value != 0 else mp.inf
    ref = side.get("ref")
    for f in side["freqs"]:
        s = mp.mpc(0, 2 * mp.pi * f)
        A, b = system(s, "gain")
        x = mp.lu_solve(A, b)
        out[f"gain@{f:g}"] = at(x, side["output"]) - at(x, ref)
        out[("bound", f"gain@{f:g}")] = bound(A, x, out[f"gain@{f:g}"])
        src = net.element(side["input"]) if hasattr(net, "element") else None
        if inp in bidx:
            ib = x[bidx[inp]]
            out[f"rin@{f:g}"] = -1 / ib if ib != 0 else mp.inf
            out[("bound", f"rin@{f:g}")] = bound(A, x, ib)
        else:
            e = next(e for e in net.elements if e.name.lower() == inp)
            out[f"rin@{f:g}"] = at(x, e.nodes[1]) - at(x, e.nodes[0])
            out[("bound", f"rin@{f:g}")] = bound(A, x, out[f"rin@{f:g}"])
        A, b = system(s, "rout")
        xo = mp.lu_solve(A, b)
        out[f"rout@{f:g}"] = at(xo, side["output"]) - at(xo, ref)
        out[("bound", f"rout@{f:g}")] = bound(A, xo, out[f"rout@{f:g}"])
    return out


DEVICE_KEYS = ("gm", "gds", "gmb", "gpi", "go", "gmu", "gd")


def sensitivity(cir: Path, want: dict, key: str, variant: str = "full", kept: set[str] | None = None) -> mp.mpf:
    """max over device parameters p of |d ln Q / d ln p| for quantity `key`,
    by 60-digit finite differences. A double-precision computation cannot fix
    Q to better than about this times eps (1.1e-16), whoever performs it."""
    base = build_and_solve(cir, want, variant, kept=kept)[key]
    if base == 0 or (hasattr(base, "real") and mp.isinf(base)):
        return mp.mpf(0)
    h = mp.mpf("1e-25")
    worst = mp.mpf(0)
    for dev, d in want["op"]["devices"].items():
        for k in DEVICE_KEYS:
            if k not in d or d[k] == 0:
                continue
            bumped = json.loads(json.dumps(want))
            bumped["op"]["devices"][dev][k] = float(d[k])  # same value; perturb below in mp
            q = build_and_solve(cir, _scaled(want, dev, k, 1 + h), variant, kept=kept)[key]
            worst = max(worst, abs((q - base) / base) / h)
    return worst


def _scaled(want: dict, dev: str, k: str, factor) -> dict:
    """want with one device parameter multiplied by an mp factor (kept as a
    string so no double rounding happens)."""
    w = json.loads(json.dumps(want))
    w["op"]["devices"][dev][k] = mp.nstr(mp.mpf(repr(want["op"]["devices"][dev][k])) * factor, 50)
    return w
