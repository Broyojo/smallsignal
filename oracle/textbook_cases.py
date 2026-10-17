"""Textbook small-signal cases, derived by hand from KCL, independent of the solver.

Each case is a value-less netlist (so the solver answers symbolically) plus, for
each requested quantity, the hand result as a SymPy expression built from
first-principles node equations. Some cases also carry the closed form quoted in
textbooks; textbook.py checks that the closed form equals the KCL result, so a
slip in either derivation shows up.

Small-signal conventions (the same as hand analysis):
- Supplies and DC sources other than the input are AC ground (V) or open (I).
- MOSFET: current into the drain = gm·vgs + gmb·vbs + vds/ro. gmb exists only
  when the body is wired to a different node than the source.
- BJT: ic = gm·vbe + vce/ro, ib = vbe/rpi.
- The input source gives a unit excitation (1 V, or 1 A for an I source).
- Solver symbol names: gm_M1, ro_M1, gmb_M1, gm_Q1, rpi_Q1, ro_Q1, and
  element names for R/C/L/E/G/F/H; s is the Laplace variable.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

import sympy as sp

s = sp.Symbol("s")


def sym(name: str) -> sp.Symbol:
    return sp.Symbol(name)


def mos(name: str, vd, vg, vs, vb=None, ideal=False):
    """Drain current (into d, out of s). vb=None means body tied to source.
    ideal: r_o = ∞ (the hand-analysis limit)."""
    gm, ro = sym(f"gm_{name}"), sym(f"ro_{name}")
    i = gm * (vg - vs) + (0 if ideal else (vd - vs) / ro)
    if vb is not None:
        i += sym(f"gmb_{name}") * (vb - vs)
    return i


def bjt(name: str, vc, vb, ve):
    """(ic, ib) into collector and base."""
    gm, rpi, ro = sym(f"gm_{name}"), sym(f"rpi_{name}"), sym(f"ro_{name}")
    return gm * (vb - ve) + (vc - ve) / ro, (vb - ve) / rpi


def par(*rs):
    return 1 / sum(1 / r for r in rs)


def solve(eqs, unknowns, target):
    sol = sp.solve(eqs, unknowns, dict=True)
    assert len(sol) == 1, f"hand KCL system has {len(sol)} solutions"
    return sp.simplify(target.subs(sol[0]))


@dataclass
class Quantity:
    hand: Callable[[], sp.Expr]
    """Hand KCL result."""
    closed: Callable[[], sp.Expr] | None = None
    """Textbook closed form, when it is exact."""
    matched: dict[str, str] = field(default_factory=dict)
    """Symbol renames applied to both sides before comparing (matched pairs)."""
    approx: Callable[[], sp.Expr] | None = None
    """Textbook approximation, reported numerically, not asserted."""
    lead: Callable[[], sp.Expr] | None = None
    """Textbook hand-analysis form (r_o → ∞), asserted equal to the solver's
    symbolic `simplified` (leading-order) result. None: the circuit has no
    r_o, so the simplified form must be the exact one."""


@dataclass
class Noise:
    """Input-referred white noise PSD at s → 0, as S_in = 4kT·thermal + 2q·shot
    (the solver's `noise.inputLowFreq` thermal and shot groups)."""
    hand: Callable[[], tuple[sp.Expr, sp.Expr]]
    """Hand KCL result: (thermal, shot)."""
    closed: Callable[[], tuple[sp.Expr, sp.Expr]] | None = None
    """Textbook closed form, when it is exact."""
    lead: Callable[[], tuple[sp.Expr, sp.Expr]] | None = None
    """Textbook hand-analysis form (r_o → ∞), asserted equal to the solver's
    `simplified` form. None: the exact form, with r_o → ∞ taken as a limit."""
    matched: dict[str, str] = field(default_factory=dict)


@dataclass
class Case:
    name: str
    netlist: str
    input: str
    output: str
    ref: str | None = None
    gain: Quantity | None = None
    rin: Quantity | None = None
    rout: Quantity | None = None
    parallel: list[str] = field(default_factory=list)
    """Quantities whose numeric-mode latex must use the ∥ notation."""
    input_neg: str | None = None
    """Second input source (differential or common-mode drive)."""
    mode: str | None = None
    match: list[list[str]] = field(default_factory=list)
    """Matched element groups passed to the solver."""
    numeric_netlist: str | None = None
    """Same circuit with values, for the numeric-mode checks."""
    noise: Noise | None = None


# --- hand derivations -------------------------------------------------------

def cs_rd_gain():
    vo = sp.Symbol("vo")
    return solve([vo / sym("RD") + mos("M1", vo, 1, 0)], [vo], vo)


def cs_rd_rout():
    vo = sp.Symbol("vo")
    return solve([vo / sym("RD") + mos("M1", vo, 0, 0) - 1], [vo], vo)


def degen_gain():
    vo, vs = sp.symbols("vo vs")
    i = mos("M1", vo, 1, vs, 0)
    return solve([vo / sym("RD") + i, i - vs / sym("RS")], [vo, vs], vo)


def degen_rout():
    vo, vs = sp.symbols("vo vs")
    i = mos("M1", vo, 0, vs, 0)
    return solve([vo / sym("RD") + i - 1, i - vs / sym("RS")], [vo, vs], vo)


def cg_gain_rin():
    vo, vs = sp.symbols("vo vs")
    i = mos("M1", vo, 0, vs, 0)
    eqs = [vo / sym("RD") + i, (1 - vs) / sym("RS") + i]
    sol = sp.solve(eqs, [vo, vs], dict=True)[0]
    gain = sp.simplify(vo.subs(sol))
    rin = sp.simplify(1 / ((1 - vs) / sym("RS")).subs(sol))
    return gain, rin


def sf_gain():
    vo = sp.Symbol("vo")
    return solve([mos("M1", 0, 1, vo, 0) - vo / sym("RL")], [vo], vo)


def sf_rout():
    vo = sp.Symbol("vo")
    return solve([mos("M1", 0, 0, vo, 0) + 1 - vo / sym("RL")], [vo], vo)


def cascode(vin, inject, load_r=True):
    vx, vo = sp.symbols("vx vo")
    i1 = mos("M1", vx, vin, 0)
    i2 = mos("M2", vo, 0, vx, 0)
    out = i2 - inject + (vo / sym("RD") if load_r else 0)
    return solve([out, i2 - i1], [vx, vo], vo)


def pmos_load_gain():
    vo = sp.Symbol("vo")
    # M2: d=out, g=bp (AC 0), s=vdd (AC 0), body = source.
    return solve([mos("M1", vo, 1, 0) + mos("M2", vo, 0, 0)], [vo], vo)


def diffpair_mos():
    v1, v2, vt = sp.symbols("v1 v2 vt")
    i1 = mos("M1", v1, 1, vt, 0)
    i2 = mos("M2", v2, 0, vt, 0)
    eqs = [v1 / sym("RD1") + i1, v2 / sym("RD2") + i2, i1 + i2]
    return solve(eqs, [v1, v2, vt], v1 - v2)


def ota5t_gain():
    vx, vo, vt = sp.symbols("vx vo vt")
    i1 = mos("M1", vx, 1, vt, 0)
    i2 = mos("M2", vo, 0, vt, 0)
    i3 = mos("M3", vx, vx, 0)  # diode-connected PMOS, source at vdd (AC 0)
    i4 = mos("M4", vo, vx, 0)
    return solve([i1 + i3, i2 + i4, i1 + i2], [vx, vo, vt], vo)


def ce_degen_gain():
    vc, ve = sp.symbols("vc ve")
    ic, ib = bjt("Q1", vc, 1, ve)
    return solve([vc / sym("RC") + ic, ic + ib - ve / sym("RE")], [vc, ve], vc)


def ef_all():
    ve = sp.Symbol("ve")
    ic, ib = bjt("Q1", 0, 1, ve)
    sol = sp.solve([ic + ib - ve / sym("RE")], [ve], dict=True)[0]
    gain = sp.simplify(ve.subs(sol))
    rin = sp.simplify((1 / ib).subs(sol))
    vr = sp.Symbol("vr")
    icr, ibr = bjt("Q1", 0, 0, vr)
    rout = solve([icr + ibr + 1 - vr / sym("RE")], [vr], vr)
    return gain, rin, rout


def diffpair_bjt():
    v1, v2, vt = sp.symbols("v1 v2 vt")
    ic1, ib1 = bjt("Q1", v1, 1, vt)
    ic2, ib2 = bjt("Q2", v2, 0, vt)
    eqs = [v1 / sym("RC1") + ic1, v2 / sym("RC2") + ic2, ic1 + ib1 + ic2 + ib2]
    return solve(eqs, [v1, v2, vt], v1 - v2)


def miller(with_cl: bool, ideal=False):
    vg, vo = sp.symbols("vg vo")
    cgd = sym("CGD")
    eqs = [
        (vg - 1) / sym("RS") + (vg - vo) * s * cgd,
        vo / sym("RD") + (vo - vg) * s * cgd + mos("M1", vo, vg, 0, ideal=ideal) + (vo * s * sym("CL") if with_cl else 0),
    ]
    return solve(eqs, [vg, vo], vo)


def diffpair_mos_dm():
    """Two sources: v(inp) = +1/2, v(inn) = −1/2."""
    v1, v2, vt = sp.symbols("v1 v2 vt")
    half = sp.Rational(1, 2)
    i1 = mos("M1", v1, half, vt, 0)
    i2 = mos("M2", v2, -half, vt, 0)
    eqs = [v1 / sym("RD1") + i1, v2 / sym("RD2") + i2, i1 + i2]
    return solve(eqs, [v1, v2, vt], v1 - v2)


def ota5t_dm():
    vx, vo, vt = sp.symbols("vx vo vt")
    half = sp.Rational(1, 2)
    i1 = mos("M1", vx, half, vt, 0)
    i2 = mos("M2", vo, -half, vt, 0)
    i3 = mos("M3", vx, vx, 0)
    i4 = mos("M4", vo, vx, 0)
    return solve([i1 + i3, i2 + i4, i1 + i2], [vx, vo, vt], vo)


def diffpair_bjt_dm():
    v1, v2, vt = sp.symbols("v1 v2 vt")
    half = sp.Rational(1, 2)
    ic1, ib1 = bjt("Q1", v1, half, vt)
    ic2, ib2 = bjt("Q2", v2, -half, vt)
    eqs = [v1 / sym("RC1") + ic1, v2 / sym("RC2") + ic2, ic1 + ib1 + ic2 + ib2]
    return solve(eqs, [v1, v2, vt], v1 - v2)


def diffpair_bjt_rin_dm():
    """Both input sources open; 1 A into inp, out of inn."""
    vp, vn, v1, v2, vt = sp.symbols("vp vn v1 v2 vt")
    ic1, ib1 = bjt("Q1", v1, vp, vt)
    ic2, ib2 = bjt("Q2", v2, vn, vt)
    eqs = [ib1 - 1, ib2 + 1, v1 / sym("RC1") + ic1, v2 / sym("RC2") + ic2, ic1 + ib1 + ic2 + ib2]
    return solve(eqs, [vp, vn, v1, v2, vt], vp - vn)


def vcvs_inverting():
    vn, vo = sp.symbols("vn vo")
    eqs = [(vn - 1) / sym("R1") + (vn - vo) / sym("R2"), vo + sym("E1") * vn]
    return solve(eqs, [vn, vo], vo)


def transimpedance():
    v = sp.Symbol("v")
    return solve([v / sym("R1") + v * s * sym("C1") - 1], [v], v)


def rlc():
    va, vo = sp.symbols("va vo")
    # Inductor branch current from a to out: (va - vo)/(sL).
    il = (va - vo) / (s * sym("L1"))
    eqs = [(va - 1) / sym("R1") + il, -il + vo * s * sym("C1")]
    return solve(eqs, [va, vo], vo)


# --- noise: hand KCL with explicit noise-current injections -----------------
#
# Each source is a current n_k in parallel with its element (MOSFET channel
# d–s, resistor, BJT c–e and b–e), with PSD 4kT·(1/R), 4kT·(2/3)·gm, 2q·I_C,
# 2q·I_B. With out = H·v_in + Σ Z_k·n_k from one linear solve,
# S_in = Σ S_k (Z_k/H)², split into its 4kT and 2q parts.

def noise_hand(build, unknowns, out, sources):
    """build(vin, n) → KCL equations, n[name] the injected current symbol;
    sources: [(name, "thermal" | "shot", PSD factor)]."""
    vin = sp.Symbol("vin")
    n = {name: sp.Symbol(f"n_{name}") for name, _, _ in sources}
    sol = sp.solve(build(vin, n), unknowns, dict=True)
    assert len(sol) == 1
    o = sp.expand(out.subs(sol[0]))
    h = sp.diff(o, vin)
    parts = {"thermal": 0, "shot": 0}
    for name, kind, factor in sources:
        parts[kind] += factor * (sp.diff(o, n[name]) / h) ** 2
    return sp.simplify(parts["thermal"]), sp.simplify(parts["shot"])


def mos_n(name, vd, vg, vs, vb=None):
    return lambda n: mos(name, vd, vg, vs, vb) + n[name]


TWO3 = sp.Rational(2, 3)


def cs_rd_noise():
    vo = sp.Symbol("vo")
    return noise_hand(
        lambda vin, n: [vo / sym("RD") + n["RD"] + mos("M1", vo, vin, 0) + n["M1"]],
        [vo], vo, [("RD", "thermal", 1 / sym("RD")), ("M1", "thermal", TWO3 * sym("gm_M1"))])


def degen_noise():
    vo, vs = sp.symbols("vo vs")

    def build(vin, n):
        i = mos("M1", vo, vin, vs, 0) + n["M1"]
        return [vo / sym("RD") + n["RD"] + i, i - vs / sym("RS") - n["RS"]]
    return noise_hand(build, [vo, vs], vo, [("RD", "thermal", 1 / sym("RD")), ("RS", "thermal", 1 / sym("RS")),
                                             ("M1", "thermal", TWO3 * sym("gm_M1"))])


def sf_noise():
    vo = sp.Symbol("vo")
    return noise_hand(
        lambda vin, n: [mos("M1", 0, vin, vo, 0) + n["M1"] - vo / sym("RL") - n["RL"]],
        [vo], vo, [("RL", "thermal", 1 / sym("RL")), ("M1", "thermal", TWO3 * sym("gm_M1"))])


def diffpair_noise():
    v1, v2, vt = sp.symbols("v1 v2 vt")

    def build(vin, n):
        i1 = mos("M1", v1, vin, vt, 0) + n["M1"]
        i2 = mos("M2", v2, 0, vt, 0) + n["M2"]
        return [v1 / sym("RD1") + n["RD1"] + i1, v2 / sym("RD2") + n["RD2"] + i2, i1 + i2]
    return noise_hand(build, [v1, v2, vt], v1 - v2,
                      [("RD1", "thermal", 1 / sym("RD1")), ("RD2", "thermal", 1 / sym("RD2")),
                       ("M1", "thermal", TWO3 * sym("gm_M1")), ("M2", "thermal", TWO3 * sym("gm_M2"))])


def ota5t_noise():
    vx, vo, vt = sp.symbols("vx vo vt")

    def build(vin, n):
        i1 = mos("M1", vx, vin, vt, 0) + n["M1"]
        i2 = mos("M2", vo, 0, vt, 0) + n["M2"]
        i3 = mos("M3", vx, vx, 0) + n["M3"]
        i4 = mos("M4", vo, vx, 0) + n["M4"]
        return [i1 + i3, i2 + i4, i1 + i2]
    return noise_hand(build, [vx, vo, vt], vo,
                      [(m, "thermal", TWO3 * sym(f"gm_{m}")) for m in ("M1", "M2", "M3", "M4")])


def ce_noise():
    vc = sp.Symbol("vc")

    def build(vin, n):
        ic, _ = bjt("Q1", vc, vin, 0)
        return [vc / sym("RC") + n["RC"] + ic + n["QC"]]
    return noise_hand(build, [vc], vc, [("RC", "thermal", 1 / sym("RC")), ("QC", "shot", sym("IC_Q1"))])


def ce_degen_noise(lead=False):
    vc, ve = sp.symbols("vc ve")

    def build(vin, n):
        ic, ib = bjt("Q1", vc, vin, ve)
        if lead:
            ic = ic.subs(sym("ro_Q1"), sp.oo)
        ic, ib = ic + n["QC"], ib + n["QB"]
        return [vc / sym("RC") + n["RC"] + ic, ic + ib - ve / sym("RE") - n["RE"]]
    return noise_hand(build, [vc, ve], vc,
                      [("RC", "thermal", 1 / sym("RC")), ("RE", "thermal", 1 / sym("RE")),
                       ("QC", "shot", sym("IC_Q1")), ("QB", "shot", sym("IB_Q1"))])


g, ro, gmb = sym("gm_M1"), sym("ro_M1"), sym("gmb_M1")
RD, RS, RL = sym("RD"), sym("RS"), sym("RL")
g2, ro1, ro2, gmb2 = sym("gm_M2"), sym("ro_M1"), sym("ro_M2"), sym("gmb_M2")

CASES: list[Case] = [
    Case(
        "cs_rd",
        "cs\nVIN in 0\nVDD vdd 0\nRD vdd out\nM1 out in 0 0\n",
        "VIN", "out",
        gain=Quantity(cs_rd_gain, closed=lambda: -g * par(ro, RD), lead=lambda: -g * RD),
        rin=Quantity(lambda: sp.oo),
        rout=Quantity(cs_rd_rout, closed=lambda: par(ro, RD), lead=lambda: RD),
        parallel=["gain", "rout"],
        # gmin 1e-18: the hand formula has no junction leakage (see textbook.py).
        numeric_netlist="cs\n.options gmin=1e-18\nVIN in 0 DC 0.7\nVDD vdd 0 1.8\nRD vdd out 10k\nM1 out in 0 0 nm W=10u L=1u\n"
        ".model nm nmos (level=1 kp=200u vto=0.5 lambda=0.05)\n",
        noise=Noise(cs_rd_noise, closed=lambda: (2 / (3 * g) + 1 / (g**2 * RD), 0)),
    ),
    Case(
        "cs_degen_body",
        "cs degen\nVIN in 0\nVDD vdd 0\nRD vdd out\nM1 out in sn 0\nRS sn 0\n",
        "VIN", "out",
        gain=Quantity(degen_gain, closed=lambda: -g * RD * ro / (RD + RS + ro + (g + gmb) * RS * ro),
                      lead=lambda: -g * RD / (1 + (g + gmb) * RS)),
        rout=Quantity(degen_rout, closed=lambda: par(RD, ro + RS + (g + gmb) * ro * RS), lead=lambda: RD),
        noise=Noise(degen_noise, lead=lambda: (2 / (3 * g) + RS * (g + gmb)**2 / g**2 + (1 + (g + gmb) * RS)**2 / (g**2 * RD), 0)),
    ),
    Case(
        "cg",
        "cg\nVIN in 0\nRS in src\nVB g 0\nVDD vdd 0\nRD vdd out\nM1 out g src 0\n",
        "VIN", "out",
        gain=Quantity(lambda: cg_gain_rin()[0], lead=lambda: (g + gmb) * RD / (1 + (g + gmb) * RS)),
        rin=Quantity(lambda: cg_gain_rin()[1], closed=lambda: RS + (ro + RD) / (1 + (g + gmb) * ro),
                     lead=lambda: RS + 1 / (g + gmb)),
    ),
    Case(
        "sf",
        "sf\nVDD vdd 0\nVIN in 0\nM1 vdd in out 0\nRL out 0\n",
        "VIN", "out",
        gain=Quantity(sf_gain, closed=lambda: g / (g + gmb + 1 / ro + 1 / RL), lead=lambda: g / (g + gmb + 1 / RL)),
        rin=Quantity(lambda: sp.oo),
        rout=Quantity(sf_rout, closed=lambda: par(1 / g, 1 / gmb, ro, RL), lead=lambda: par(1 / g, 1 / gmb, RL)),
        parallel=["gain", "rout"],
        numeric_netlist="sf\n.options gmin=1e-18\nVDD vdd 0 1.8\nVIN in 0 1.2\nM1 vdd in out 0 nm W=10u L=1u\nRL out 0 10k\n"
        ".model nm nmos (level=1 kp=200u vto=0.5 lambda=0.05 gamma=0.4)\n",
        noise=Noise(sf_noise, closed=lambda: (2 / (3 * g) + 1 / (g**2 * RL), 0)),
    ),
    Case(
        "cascode_rd",
        "cascode\nVIN in 0\nVB vb 0\nVDD vdd 0\nRD vdd out\nM1 x in 0 0\nM2 out vb x 0\n",
        "VIN", "out",
        gain=Quantity(lambda: cascode(1, 0), lead=lambda: -g * RD),
        rout=Quantity(lambda: cascode(0, 1), closed=lambda: par(RD, ro1 + ro2 + (g2 + gmb2) * ro1 * ro2), lead=lambda: RD),
    ),
    Case(
        "cascode_isrc",
        "cascode ideal load\nVIN in 0\nVB vb 0\nVDD vdd 0\nIB vdd out\nM1 x in 0 0\nM2 out vb x 0\n",
        "VIN", "out",
        gain=Quantity(lambda: cascode(1, 0, load_r=False), closed=lambda: -g * ro1 * (1 + (g2 + gmb2) * ro2),
                      lead=lambda: -g * (g2 + gmb2) * ro1 * ro2),
        rout=Quantity(lambda: cascode(0, 1, load_r=False), closed=lambda: ro1 + ro2 + (g2 + gmb2) * ro1 * ro2,
                      lead=lambda: (g2 + gmb2) * ro1 * ro2),
    ),
    Case(
        "cs_pmos_load",
        "cs pmos load\nVDD vdd 0\nVIN in 0\nVBP bp 0\nM1 out in 0 0\nM2 out bp vdd vdd\n",
        "VIN", "out",
        gain=Quantity(pmos_load_gain, closed=lambda: -g * par(ro1, ro2), lead=lambda: -g * par(ro1, ro2)),
        rout=Quantity(lambda: par(ro1, ro2), lead=lambda: par(ro1, ro2)),
    ),
    Case(
        "diffpair_mos",
        "nmos diff pair\nVDD vdd 0\nRD1 vdd o1\nRD2 vdd o2\nM1 o1 inp tail 0\nM2 o2 inn tail 0\nITAIL tail 0\n"
        "VID inp inn\nVCM inn 0\n",
        "VID", "o1", ref="o2", match=[["M1", "M2"], ["RD1", "RD2"]],
        gain=Quantity(diffpair_mos, closed=lambda: -g * par(ro, RD), lead=lambda: -g * RD,
                      matched={"gm_M2": "gm_M1", "ro_M2": "ro_M1", "gmb_M2": "gmb_M1", "RD2": "RD", "RD1": "RD"}),
        noise=Noise(diffpair_noise, closed=lambda: (2 * (2 / (3 * g) + 1 / (g**2 * RD)), 0),
                    matched={"gm_M2": "gm_M1", "ro_M2": "ro_M1", "gmb_M2": "gmb_M1", "RD2": "RD", "RD1": "RD"}),
    ),
    Case(
        "ota_5t",
        "5T OTA\nVDD vdd 0\nVIP inp 0\nVINN inn 0\nITAIL tail 0\nM1 x inp tail 0\nM2 out inn tail 0\n"
        "M3 x x vdd vdd\nM4 out x vdd vdd\n",
        "VIP", "out", match=[["M1", "M2"], ["M3", "M4"]],
        gain=Quantity(ota5t_gain, approx=lambda: g * par(ro2, sym("ro_M4")), lead=lambda: g * par(ro, sym("ro_M3")),
                      matched={"gm_M2": "gm_M1", "ro_M2": "ro_M1", "gmb_M2": "gmb_M1", "gm_M4": "gm_M3", "ro_M4": "ro_M3"}),
        noise=Noise(ota5t_noise, lead=lambda: (2 * TWO3 / g * (1 + sym("gm_M3") / g), 0),
                    matched={"gm_M2": "gm_M1", "ro_M2": "ro_M1", "gmb_M2": "gmb_M1", "gm_M4": "gm_M3", "ro_M4": "ro_M3"}),
    ),
    Case(
        "ce_degen",
        "ce degen\nVCC vcc 0\nVIN in 0\nRC vcc c\nQ1 c in e\nRE e 0\n",
        "VIN", "c",
        gain=Quantity(ce_degen_gain,
                      approx=lambda: -sym("gm_Q1") * sym("RC") / (1 + sym("gm_Q1") * sym("RE")),
                      # r_o → ∞ only (finite β): −gm RC / (1 + gm RE + RE/rπ).
                      lead=lambda: -sym("gm_Q1") * sym("RC") / (1 + sym("gm_Q1") * sym("RE") + sym("RE") / sym("rpi_Q1"))),
        noise=Noise(ce_degen_noise, lead=lambda: ce_degen_noise(lead=True)),
    ),
    Case(
        "ce",
        "ce\nVCC vcc 0\nVIN in 0\nRC vcc c\nQ1 c in 0\n",
        "VIN", "c",
        noise=Noise(ce_noise, closed=lambda: (1 / (sym("gm_Q1")**2 * sym("RC")), sym("IC_Q1") / sym("gm_Q1")**2)),
    ),
    Case(
        "ef",
        "emitter follower\nVCC vcc 0\nVIN in 0\nQ1 vcc in e\nRE e 0\n",
        "VIN", "e",
        gain=Quantity(lambda: ef_all()[0],
                      lead=lambda: (1 + sym("gm_Q1") * sym("rpi_Q1")) * sym("RE")
                      / (sym("rpi_Q1") + (1 + sym("gm_Q1") * sym("rpi_Q1")) * sym("RE"))),
        rin=Quantity(lambda: ef_all()[1],
                     closed=lambda: sym("rpi_Q1") + (1 + sym("gm_Q1") * sym("rpi_Q1")) * par(sym("ro_Q1"), sym("RE")),
                     lead=lambda: sym("rpi_Q1") + (1 + sym("gm_Q1") * sym("rpi_Q1")) * sym("RE")),
        rout=Quantity(lambda: ef_all()[2],
                      closed=lambda: par(1 / sym("gm_Q1"), sym("rpi_Q1"), sym("ro_Q1"), sym("RE")),
                      lead=lambda: par(1 / sym("gm_Q1"), sym("rpi_Q1"), sym("RE"))),
    ),
    Case(
        "diffpair_bjt",
        "bjt diff pair\nVCC vcc 0\nRC1 vcc o1\nRC2 vcc o2\nQ1 o1 inp tail\nQ2 o2 inn tail\nITAIL tail 0\n"
        "VID inp inn\nVCM inn 0\n",
        "VID", "o1", ref="o2", match=[["Q1", "Q2"], ["RC1", "RC2"]],
        gain=Quantity(diffpair_bjt, closed=lambda: -sym("gm_Q1") * par(sym("ro_Q1"), sym("RC")),
                      lead=lambda: -sym("gm_Q1") * sym("RC"),
                      matched={"gm_Q2": "gm_Q1", "ro_Q2": "ro_Q1", "rpi_Q2": "rpi_Q1", "RC2": "RC", "RC1": "RC"}),
    ),
    Case(
        "miller",
        "cs miller\nVIN in 0\nRS in g\nVDD vdd 0\nRD vdd out\nM1 out g 0 0\nCGD g out\n",
        "VIN", "out",
        gain=Quantity(lambda: miller(False), lead=lambda: miller(False, ideal=True)),
    ),
    Case(
        "miller_cl",
        "cs miller + CL\nVIN in 0\nRS in g\nVDD vdd 0\nRD vdd out\nM1 out g 0 0\nCGD g out\nCL out 0\n",
        "VIN", "out",
        gain=Quantity(lambda: miller(True), lead=lambda: miller(True, ideal=True)),
    ),
    Case(
        "rc",
        "rc\nVIN in 0\nR1 in out\nC1 out 0\n",
        "VIN", "out",
        gain=Quantity(lambda: 1 / (1 + s * sym("R1") * sym("C1"))),
    ),
    Case(
        "rlc",
        "rlc\nVIN in 0\nR1 in a\nL1 a out\nC1 out 0\n",
        "VIN", "out",
        gain=Quantity(rlc, closed=lambda: 1 / (1 + s * sym("R1") * sym("C1") + s**2 * sym("L1") * sym("C1"))),
    ),
    Case(
        "vcvs_inverting",
        "vcvs inverting amp\nVIN in 0\nR1 in n\nR2 n out\nE1 out 0 0 n\n",
        "VIN", "out",
        gain=Quantity(vcvs_inverting, closed=lambda: -sym("E1") * sym("R2") / (sym("R1") + sym("R2") + sym("E1") * sym("R1"))),
    ),
    Case(
        "transimpedance",
        "current input\nI1 0 in\nR1 in 0\nC1 in 0\n",
        "I1", "in",
        gain=Quantity(transimpedance, closed=lambda: sym("R1") / (1 + s * sym("R1") * sym("C1"))),
    ),
    Case(
        "diffpair_mos_dm",
        "nmos diff pair, two sources\nVDD vdd 0\nRD1 vdd o1\nRD2 vdd o2\nM1 o1 inp tail 0\nM2 o2 inn tail 0\nITAIL tail 0\n"
        "VIP inp 0\nVINN inn 0\n",
        "VIP", "o1", ref="o2", input_neg="VINN", mode="differential", match=[["M1", "M2"], ["RD1", "RD2"]],
        gain=Quantity(diffpair_mos_dm, closed=lambda: -g * par(ro, RD), lead=lambda: -g * RD,
                      matched={"gm_M2": "gm_M1", "ro_M2": "ro_M1", "gmb_M2": "gmb_M1", "RD2": "RD", "RD1": "RD"}),
    ),
    Case(
        "ota_5t_dm",
        "5T OTA, two sources\nVDD vdd 0\nVIP inp 0\nVINN inn 0\nITAIL tail 0\nM1 x inp tail 0\nM2 out inn tail 0\n"
        "M3 x x vdd vdd\nM4 out x vdd vdd\n",
        "VIP", "out", input_neg="VINN", mode="differential", match=[["M1", "M2"], ["M3", "M4"]],
        gain=Quantity(ota5t_dm, lead=lambda: g * par(ro, sym("ro_M3")),
                      matched={"gm_M2": "gm_M1", "ro_M2": "ro_M1", "gmb_M2": "gmb_M1", "gm_M4": "gm_M3", "ro_M4": "ro_M3"}),
    ),
    Case(
        "diffpair_bjt_dm",
        "bjt diff pair, two sources\nVCC vcc 0\nRC1 vcc o1\nRC2 vcc o2\nQ1 o1 inp tail\nQ2 o2 inn tail\nITAIL tail 0\n"
        "VIP inp 0\nVINN inn 0\n",
        "VIP", "o1", ref="o2", input_neg="VINN", mode="differential", match=[["Q1", "Q2"], ["RC1", "RC2"]],
        gain=Quantity(diffpair_bjt_dm, closed=lambda: -sym("gm_Q1") * par(sym("ro_Q1"), sym("RC")),
                      lead=lambda: -sym("gm_Q1") * sym("RC"),
                      matched={"gm_Q2": "gm_Q1", "ro_Q2": "ro_Q1", "rpi_Q2": "rpi_Q1", "RC2": "RC", "RC1": "RC"}),
        rin=Quantity(diffpair_bjt_rin_dm, closed=lambda: 2 * sym("rpi_Q1"), lead=lambda: 2 * sym("rpi_Q1"),
                     matched={"gm_Q2": "gm_Q1", "ro_Q2": "ro_Q1", "rpi_Q2": "rpi_Q1", "RC2": "RC", "RC1": "RC"}),
    ),
]
