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


def P(x) -> mp.mpf:
    """A device value: float (exact repr) or a full-precision string."""
    return mp.mpf(x) if isinstance(x, str) else mp.mpf(repr(x))


def num(tok: str) -> mp.mpf:
    """A netlist number (spice.decimal: exact, then at mp precision)."""
    return mp.mpf(str(spice.decimal(tok)))


def model_params(text: str) -> dict[str, dict[str, float]]:
    """{model: {param: value}}, values with SPICE suffixes (KF=1f, TOX=100n).
    Cards are read as the parser's logical lines, so parameters on `+`
    continuation lines count (and comments do not), and tokenized as the
    solver does (netlist.rs): parentheses and commas separate, so
    `(KP=1m,KF=1f)` is two parameters."""
    out = {}
    for line in spice.parse(text).model_lines:
        m = re.match(r"\.model\s+(\S+?)\s+([A-Za-z]+)(.*)$", line, re.I)
        if not m:
            continue
        params = {}
        for k, v in re.findall(r"(\w+)\s*=\s*(\S+)", re.sub(r"[(),]", " ", m.group(3))):
            try:
                params[k.lower()] = float(num(v))
            except ValueError:
                continue
        out[m.group(1).lower()] = params
    return out


def build_and_solve(cir: Path, want: dict, variant: str = "full", dps: int = 60,
                    kept: set[str] | None = None, phys_kinds: tuple[str, ...] = ("mos", "bjt"),
                    want_system: bool = False, drop: set[tuple[str, str]] | None = None,
                    miller: list[tuple[str, str | None]] | None = None, kvalues: dict | None = None):
    """variant: "full" (ngspice's circuit), "phys" (no gmin anywhere),
    "solverlike" (only the junction / g_mu terms in `kept`, the solver's own
    parameter names such as rbd_m1, rmu_q2, each as ngspice has it) or
    "solverlike_phys" (solverlike plus the physical part, without gmin, of
    every term the solver dropped).

    drop: assumptions as (element, term) pairs, the solver's `assume`
    vocabulary, each taken to its limit at the same operating point: a
    device's ro (gds, go), gmb, rpi (gpi), rmu (gmu), rbs, rbd conductance
    left out (gmin included); an element "open" left out (an inductor's
    branch carries no current) or "short" replaced by a 0 V branch.

    miller: capacitances as (element, term), term None for a capacitor
    itself, each replaced by C(1 - K) from a to ground and C(K - 1)/K from b
    to ground, K = v(b)/v(a) of this rebuild at s = 0 under the gain
    excitation (a, b as the solver orients them: a capacitor so |K| >= 1,
    a device's capacitance gate/base first), or kvalues["e:term"] when
    given. out[("miller", "e:term")] is K."""
    mp.mp.dps = dps
    mill: dict = {(e.lower(), t or None): None for e, t in (miller or [])}
    ks: dict | None = None
    kept = {k.lower() for k in (kept or set())}
    drop = {(e.lower(), t) for e, t in (drop or set())}
    dropped = lambda e, t: (e.name.lower(), t) in drop
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
    # ngspice ran at the sidecar's gmin when it sets one.
    gmin_full = mp.mpf(repr(float(side.get("gmin", GMIN))))
    net = spice.parse(text)
    models = model_params(text)
    gmin = mp.mpf(0) if variant == "phys" else gmin_full  # in always-modelled gpi / gd
    nodes = sorted({n for e in net.elements for n in e.nodes if n not in spice.GROUND})
    nidx = {n: i for i, n in enumerate(nodes)}
    ni = lambda n: None if n in spice.GROUND else nidx[n] if n in nidx else nidx[n.lower()]
    branch_elems = [e for e in net.elements if e.kind in ("v", "e", "h", "l") or dropped(e, "short")]
    bidx = {e.name.lower(): len(nodes) + k for k, e in enumerate(branch_elems)}
    dim = len(nodes) + len(branch_elems)
    volt = {k.lower(): mp.mpf(repr(v)) for k, v in want["op"]["nodes"].items()}
    v = lambda n: mp.mpf(0) if n in spice.GROUND else volt[n.lower()]
    devs = {k.lower(): d for k, d in want["op"]["devices"].items()}
    inp = side["input"].lower()
    # Gain excitation: the input alone, or with inputNeg the pair driven
    # ±1/2 (differential) or both +1 (common), as the solver and the ngspice
    # reference drive them.
    excite = {inp: mp.mpf(1)}
    if side.get("inputNeg"):
        half = mp.mpf("0.5")
        neg = side["inputNeg"].lower()
        excite = ({inp: half, neg: -half} if (side.get("mode") or "differential") == "differential"
                  else {inp: mp.mpf(1), neg: mp.mpf(1)})

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

        def cap(e, term, a_, b_, value):
            """A capacitance from a_ to b_, or under `miller` its split:
            C(1 - K) from a to ground and C(K - 1)/K from b to ground (none
            before K is known, which is solved at s = 0, where both vanish)."""
            key = (e.name.lower(), term)
            if key not in mill:
                adm(a_, b_, s * value)
                return
            mill[key] = (a_, b_, value)
            if ks is not None:
                K, (oa, ob) = ks[key]
                adm(oa, "0", s * value * (1 - K))
                adm(ob, "0", s * value * (K - 1) / K)

        for e in net.elements:
            k, t = e.kind, e.tokens
            if dropped(e, "short"):
                # A 0 V branch: v(a) = v(b), any current.
                r = bidx[e.name.lower()]
                p, n = ni(e.nodes[0]), ni(e.nodes[1])
                add(p, r, 1); add(n, r, -1); add(r, p, 1); add(r, n, -1)
                continue
            if dropped(e, "open"):
                if k == "l":
                    add(bidx[e.name.lower()], bidx[e.name.lower()], 1)
                continue
            if k == "r":
                adm(e.nodes[0], e.nodes[1], 1 / num(t[3]))
            elif k == "c":
                cap(e, None, e.nodes[0], e.nodes[1], num(t[3]))
            elif k == "g":
                vccs(*e.nodes[:4], num(t[5]))
            elif k == "f":
                r = bidx[t[3].lower()]
                add(ni(e.nodes[0]), r, num(t[4])); add(ni(e.nodes[1]), r, -num(t[4]))
            elif k == "i":
                w = excite.get(e.name.lower(), 0) if mode == "gain" else 0
                if w:
                    # SPICE current flows n+ -> source -> n-: w A into n-.
                    if ni(e.nodes[1]) is not None:
                        b[ni(e.nodes[1])] += w
                    if ni(e.nodes[0]) is not None:
                        b[ni(e.nodes[0])] -= w
            elif k in ("v", "e", "h", "l"):
                r = bidx[e.name.lower()]
                p, n = ni(e.nodes[0]), ni(e.nodes[1])
                add(p, r, 1); add(n, r, -1); add(r, p, 1); add(r, n, -1)
                if k == "v":
                    b[r] = excite.get(e.name.lower(), 0) if mode == "gain" else 0
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
                if not dropped(e, "ro"):
                    adm(ed, es, P(d["gds"]))
                if not dropped(e, "gmb"):
                    vccs(ed, es, bn, es, P(d["gmb"]))
                mname = t[5].lower()
                tt = -1 if net.models.get(mname) == "pmos" else 1
                mult = next((float(x.split("=")[1]) for x in t[6:] if x.lower().startswith("m=")), 1.0)
                isat = mp.mpf(models.get(mname, {}).get("is", 1e-14)) * mult
                for other, which in ((sn, "bs"), (dn, "bd")):
                    if dropped(e, f"r{which}"):
                        continue
                    vj = tt * (v(bn) - v(other))
                    phys = isat / VT * mp.exp(vj / VT) if vj > -3 * VT else mp.mpf(0)
                    adm(bn, other, term(f"r{which}_{e.name}", phys, gmin_full))
                # ngspice's capacitances at this bias (pz.py), on the
                # physical terminals as mos1acld stamps them.
                caps = d.get("caps") or {}
                for a_, b_, key in ((gn, sn, "cgs"), (gn, dn, "cgd"), (gn, bn, "cgb"), (bn, dn, "cbd"),
                                    (bn, sn, "cbs")):
                    if caps.get(key) and not dropped(e, key):
                        cap(e, key, a_, b_, P(caps[key]))
            elif k == "q":
                d = devs[e.name.lower()]
                c, bb, em = e.nodes[:3]
                gm = P(d["gm"])
                gpi = P(d["gpi"]) - gmin_full + gmin
                gmu = term(f"rmu_{e.name}", P(d["gmu"]) - gmin_full, gmin_full)
                go = P(d["go"])
                vccs(c, em, bb, em, gm)
                if not dropped(e, "ro"):
                    adm(c, em, go)
                if not dropped(e, "rpi"):
                    adm(bb, em, gpi)
                if not dropped(e, "rmu"):
                    adm(bb, c, gmu)
                caps = d.get("caps") or {}
                if caps:
                    if not dropped(e, "cpi"):
                        cap(e, "cpi", bb, em, P(caps["cpi"]))
                    if not dropped(e, "cmu"):
                        cap(e, "cmu", bb, c, P(caps["cmu"]))
                    # The substrate (ground when not given) ends at the
                    # collector (vertical, the NPN default) or base (lateral).
                    sub = e.nodes[3] if len(e.nodes) == 4 else "0"
                    mname = (t[5] if len(e.nodes) == 4 else t[4]).lower()
                    subs = models.get(mname, {}).get("subs", 1 if net.models.get(mname) == "npn" else -1)
                    if not dropped(e, "ccs"):
                        cap(e, "ccs", sub, c if subs > 0 else bb, P(caps["csub"]))
                    # bjtacld's geqcb = −C_x: s·geqcb·v_bc from base to emitter.
                    vccs(bb, em, bb, c, -s * P(caps["cx"]))
            elif k == "d":
                d = devs[e.name.lower()]
                adm(e.nodes[0], e.nodes[1], P(d["gd"]) - gmin_full + gmin)
                if (d.get("caps") or {}).get("cj") and not dropped(e, "cj"):
                    cap(e, "cj", e.nodes[0], e.nodes[1], P(d["caps"]["cj"]))
            else:
                raise ValueError(f"unsupported element {e.name}")
        if mode == "rout":
            o, r_ = ni(side["output"]), ni(side["ref"]) if side.get("ref") else None
            if o is not None:
                b[o] += 1
            if r_ is not None:
                b[r_] -= 1
        return A, b

    at = lambda x, n: x[ni(n)] if n is not None and ni(n) is not None else 0
    if mill:
        # K at s = 0, where every capacitance (split or not) is open.
        A0, b0 = system(mp.mpf(0), "gain")
        x0 = mp.lu_solve(A0, b0)
        ks = {}
        for key, found in mill.items():
            if found is None:
                raise ValueError(f"miller: no capacitance {key}")
            a_, b_, _ = found
            va, vb = at(x0, a_), at(x0, b_)
            if key[1] is None and abs(va) > abs(vb):
                a_, b_, va, vb = b_, a_, vb, va
            fixed = (kvalues or {}).get(f"{key[0]}:{key[1] or ''}")
            ks[key] = (vb / va if fixed is None else fixed, (a_, b_))
    if want_system == "poles":
        return poles(system, dim)
    if want_system:
        # system(s, mode): mode "gain" excites the input source, "rout" injects
        # 1 A at the output, anything else leaves every source at zero.
        return system, ni, bidx, net, side, models
    out: dict[str, object] = {}
    for (mel, mterm), (K, _) in (ks or {}).items():
        out[("miller", f"{mel}:{mterm or ''}")] = K
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


def poles(system, dim: int) -> list[mp.mpc]:
    """Finite roots (Hz) of det(G + sC) of the circuit with every source
    zeroed: with A = G + σC regular, each eigenvalue λ ≠ 0 of A⁻¹C gives
    s = σ − 1/λ (λ = 0 is a root at infinity)."""
    G, _ = system(mp.mpf(0), "zero")
    C = (system(mp.mpf(1), "zero")[0] - G)
    sigma = mp.mpf("1e3") * 2 * mp.pi
    A = G + sigma * C
    if dim == 0:
        return []
    M = mp.inverse(A) * C
    lam = mp.eig(M, left=False, right=False)
    big = max((abs(x) for x in lam), default=mp.mpf(0))
    return sorted(((sigma - 1 / x) / (2 * mp.pi) for x in lam if abs(x) > mp.mpf(10) ** (-40) * big),
                  key=lambda z: (abs(z), mp.im(z)))


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
