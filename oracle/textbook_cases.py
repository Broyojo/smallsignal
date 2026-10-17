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
    """Textbook hand-analysis form (r_o → ∞ for saturated devices, then
    g_mb → 0 unless that leaves a pure number), asserted equal to the
    solver's symbolic `simplified` (leading-order) result. None: the circuit
    has no r_o, so the simplified form must be the exact one."""


@dataclass
class Noise:
    """Input-referred white noise PSD at s → 0, as S_in = 4kT·thermal + 2q·shot
    (the solver's `noise.inputLowFreq` thermal and shot groups)."""
    hand: Callable[[], tuple[sp.Expr, sp.Expr]]
    """Hand KCL result: (thermal, shot)."""
    closed: Callable[[], tuple[sp.Expr, sp.Expr]] | None = None
    """Textbook closed form, when it is exact."""
    lead: Callable[[], tuple[sp.Expr, sp.Expr]] | None = None
    """Textbook hand-analysis form (r_o → ∞, g_mb → 0), asserted equal to the
    solver's `simplified` form. None: the exact form, with r_o → ∞ taken as a
    limit."""
    matched: dict[str, str] = field(default_factory=dict)


@dataclass
class Dist:
    """Memoryless distortion: v_out = a1·v_in + a2·v_in² + a3·v_in³ in terms
    of the devices' Taylor coefficients (the solver's `distortion`)."""
    netlist: str
    """Numeric netlist (distortion needs an operating point)."""
    nonlinear: list[str]
    hand: Callable[..., tuple[sp.Expr, sp.Expr, sp.Expr]]
    """Hand implicit-series result (a1, a2, a3); called with a `restrict`
    map that sets the Taylor coefficients the solver proved zero to zero."""
    closed: Callable[[], tuple] | None = None
    """Textbook closed form (a1, a2, a3), when exact."""
    hd2: Callable[[dict, float], float] | None = None
    """Textbook HD2 from the operating point (device dict) at amplitude A."""
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
    dist: Dist | None = None
    assume: list[tuple[str, str]] = field(default_factory=list)
    """Assumptions (element, term) passed as --ignore: each quantity's exact
    form must equal the limit of its hand KCL result (ro, rpi, an open R or L
    → ∞; gmb, an open C, a shorted R or L → 0; a shorted C → ∞), and
    `restored` lists the assumptions the solver must put back (per quantity,
    "M1:ro"), which the limit then leaves out."""
    restored: dict[str, list[str]] = field(default_factory=dict)


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


def sf_isrc(vin, inject):
    """Follower into an NMOS current source (M2, gate at AC ground)."""
    vo = sp.Symbol("vo")
    return solve([mos("M1", 0, vin, vo, 0) - mos("M2", vo, 0, 0) + inject], [vo], vo)


def stack(vin, inject):
    """Two NMOS on one gate: M2 (outer) on M1, whose drain is M2's source."""
    vx, vo = sp.symbols("vx vo")
    i1 = mos("M1", vx, vin, 0)
    i2 = mos("M2", vo, vin, vx, 0)
    return solve([i1 - i2, vo / RD + i2 - inject], [vx, vo], vo)


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


# --- distortion: implicit series of KCL with Taylor-expanded devices ---------
#
# I_D = gm·u_g + u_d/ro + gmb·u_b + Σ K_α·u^α over 2 ≤ |α| ≤ 3, with
# u_g = v_G − v_S, u_d = v_D − v_S, u_b = v_B − v_S and the solver's names
# (K2g_M1 = ½∂²I_D/∂v_GS², Kgd_M1, K2gd_M1 = ½∂³I_D/∂v_GS²∂v_DS, …).

MOS_MONOS = [(2, 0, 0), (1, 1, 0), (1, 0, 1), (0, 2, 0), (0, 1, 1), (0, 0, 2),
             (3, 0, 0), (2, 1, 0), (2, 0, 1), (1, 2, 0), (1, 1, 1), (1, 0, 2), (0, 3, 0), (0, 2, 1), (0, 1, 2), (0, 0, 3)]


def k_name(mono, name, vars=("g", "d", "b")):
    sub = "".join((str(x) if x > 1 else "") + v for x, v in zip(mono, vars) if x)
    return f"K{sub}_{name}"


def mos_nl(name, vd, vg, vs, vb=None, ro=True):
    ug, ud = vg - vs, vd - vs
    ub = 0 if vb is None else vb - vs
    i = sym(f"gm_{name}") * ug + (ud / sym(f"ro_{name}") if ro else 0)
    if vb is not None:
        i += sym(f"gmb_{name}") * ub
    for m in MOS_MONOS:
        i += sym(k_name(m, name)) * ug ** m[0] * ud ** m[1] * ub ** m[2]
    return i


def volterra_hand(build, unknowns, out, restrict=lambda e: e):
    """build(x) → KCL equations with v_in = x; (a1, a2, a3) of out.
    `restrict` maps each equation first (e.g. drops coefficients known to be
    zero), which keeps the series small."""
    x = sp.Symbol("x")
    c = {u: [sp.Symbol(f"c_{u}_{n}") for n in (1, 2, 3)] for u in unknowns}
    series = {u: sum(c[u][n - 1] * x**n for n in (1, 2, 3)) for u in unknowns}
    eqs = [sp.expand(restrict(e).subs(series, simultaneous=True)) for e in build(x)]
    sol: dict = {}
    for n in (1, 2, 3):
        lin = [sp.expand(e.coeff(x, n).subs(sol)) for e in eqs]
        s = sp.solve(lin, [c[u][n - 1] for u in unknowns], dict=True)
        assert len(s) == 1
        sol.update({k: sp.factor(sp.cancel(v)) for k, v in s[0].items()})
    o = sp.expand(out.subs(series, simultaneous=True))
    return tuple(sp.factor(sp.cancel(o.coeff(x, n).subs(sol))) for n in (1, 2, 3))


def cs_dist(restrict=lambda e: e):
    vo = sp.Symbol("vo")
    return volterra_hand(lambda x: [vo / sym("RD") + mos_nl("M1", vo, x, 0)], [vo], vo, restrict)


def degen_dist(restrict=lambda e: e):
    vo, vs = sp.symbols("vo vs")

    def build(x):
        i = mos_nl("M1", vo, x, vs)
        return [vo / sym("RD") + i, i - vs / sym("RS")]
    return volterra_hand(build, [vo, vs], vo, restrict)


def sf_dist(restrict=lambda e: e):
    vo = sp.Symbol("vo")
    return volterra_hand(lambda x: [mos_nl("M1", 0, x, vo) - vo / sym("RL")], [vo], vo, restrict)


def diffpair_dist(restrict=lambda e: e):
    v1, v2, vt = sp.symbols("v1 v2 vt")

    def build(x):
        i1, i2 = mos_nl("M1", v1, x, vt), mos_nl("M2", v2, 0, vt)
        return [v1 / sym("RD1") + i1, v2 / sym("RD2") + i2, i1 + i2]
    return volterra_hand(build, [v1, v2, vt], v1 - v2, restrict)


def ota5t_dist(restrict=lambda e: e):
    vx, vo, vt = sp.symbols("vx vo vt")

    def build(x):
        i1, i2 = mos_nl("M1", vx, x, vt), mos_nl("M2", vo, 0, vt)
        i3, i4 = mos_nl("M3", vx, vx, 0), mos_nl("M4", vo, vx, 0)
        return [i1 + i3, i2 + i4, i1 + i2]
    return volterra_hand(build, [vx, vo, vt], vo, restrict)


def ce_dist(restrict=lambda e: e):
    """I_C(v_BE, v_CE) and I_B(v_BE, v_CE) expanded likewise (KC…, KB…)."""
    vc = sp.Symbol("vc")

    def build(x):
        ube, uce = x, vc
        ic = sym("gm_Q1") * ube + uce / sym("ro_Q1")
        for a in range(4):
            for b in range(4 - a):
                if a + b >= 2:
                    ic += sym(k_name((a, b, 0), "Q1", ("be", "ce", "")).replace("K", "KC", 1)) * ube**a * uce**b
        return [vc / sym("RC") + ic]
    return volterra_hand(build, [vc], vc, restrict)


T_DEG = sym("gm_M1") * sym("RS")
T_SF = sym("gm_M1") * sym("RL")
K2G = sym("K2g_M1")
DIST_MODELS = ".model nm nmos (level=1 kp=200u vto=0.5 lambda=LAM)\n"


def dist_net(body: str, lam=0.0) -> str:
    return "d\n.options gmin=1e-18\n" + body + DIST_MODELS.replace("LAM", str(lam))


g, ro, gmb = sym("gm_M1"), sym("ro_M1"), sym("gmb_M1")
RD, RS, RL = sym("RD"), sym("RS"), sym("RL")
g2, ro1, ro2, gmb2 = sym("gm_M2"), sym("ro_M1"), sym("ro_M2"), sym("gmb_M2")

def rlc_load(node: str) -> sp.Expr:
    """Series R1-L1 into C1 ∥ RL: v(node) for node "a" or "out"."""
    va, vo = sp.symbols("va vo")
    il = (va - vo) / (s * sym("L1"))
    eqs = [(va - 1) / sym("R1") + il, -il + vo * s * sym("C1") + vo / sym("RL")]
    sol = sp.solve(eqs, [va, vo], dict=True)[0]
    return sp.simplify({"a": va, "out": vo}[node].subs(sol))


def rlc_gain():
    return rlc_load("out")


def rlc_gain_a():
    return rlc_load("a")


def assume_limit(e: sp.Expr, assume: list[tuple[str, str]]) -> sp.Expr:
    """The exact limit each assumption takes, one parameter at a time (each
    minor is multilinear in the parameters, so the order does not matter)."""
    for el, term in assume:
        kind = el[0].upper()
        if term in ("ro", "rpi", "rmu", "rbs", "rbd"):
            x, to = sym(f"{term}_{el}"), sp.oo
        elif term == "gmb":
            x, to = sym(f"gmb_{el}"), 0
        elif kind == "D":
            x, to = sym(f"rd_{el}"), (sp.oo if term == "open" else 0)
        else:
            x = sym(el)
            to = sp.oo if (term == "open") != (kind == "C") else 0
        if e != sp.oo:
            e = sp.limit(e, x, to)
    return sp.simplify(e)


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
        dist=Dist(dist_net("VDD vdd 0 5\nVIN in 0 DC 0.9 AC 1\nRD vdd out 5k\nM1 out in 0 0 nm W=10u L=1u\n", lam=0.05),
                  ["M1"], cs_dist),
    ),
    Case(
        "cs_degen_body",
        "cs degen\nVIN in 0\nVDD vdd 0\nRD vdd out\nM1 out in sn 0\nRS sn 0\n",
        "VIN", "out",
        gain=Quantity(degen_gain, closed=lambda: -g * RD * ro / (RD + RS + ro + (g + gmb) * RS * ro),
                      lead=lambda: -g * RD / (1 + g * RS)),
        rout=Quantity(degen_rout, closed=lambda: par(RD, ro + RS + (g + gmb) * ro * RS), lead=lambda: RD),
        noise=Noise(degen_noise, lead=lambda: (2 / (3 * g) + RS + (1 + g * RS)**2 / (g**2 * RD), 0)),
        dist=Dist(dist_net("VDD vdd 0 5\nVIN in 0 DC 1.0 AC 1\nRD vdd out 5k\nM1 out in sn sn nm W=10u L=1u\nRS sn 0 1k\n"),
                  ["M1"], degen_dist,
                  closed=lambda: (-g * RD / (1 + T_DEG), -K2G * RD / (1 + T_DEG)**3, 2 * K2G**2 * RS * RD / (1 + T_DEG)**5)),
    ),
    Case(
        "cg",
        "cg\nVIN in 0\nRS in src\nVB g 0\nVDD vdd 0\nRD vdd out\nM1 out g src 0\n",
        "VIN", "out",
        gain=Quantity(lambda: cg_gain_rin()[0], lead=lambda: g * RD / (1 + g * RS)),
        rin=Quantity(lambda: cg_gain_rin()[1], closed=lambda: RS + (ro + RD) / (1 + (g + gmb) * ro),
                     lead=lambda: RS + 1 / g),
    ),
    Case(
        "sf",
        "sf\nVDD vdd 0\nVIN in 0\nM1 vdd in out 0\nRL out 0\n",
        "VIN", "out",
        gain=Quantity(sf_gain, closed=lambda: g / (g + gmb + 1 / ro + 1 / RL), lead=lambda: g / (g + 1 / RL)),
        rin=Quantity(lambda: sp.oo),
        rout=Quantity(sf_rout, closed=lambda: par(1 / g, 1 / gmb, ro, RL), lead=lambda: par(1 / g, RL)),
        parallel=["gain", "rout"],
        numeric_netlist="sf\n.options gmin=1e-18\nVDD vdd 0 1.8\nVIN in 0 1.2\nM1 vdd in out 0 nm W=10u L=1u\nRL out 0 10k\n"
        ".model nm nmos (level=1 kp=200u vto=0.5 lambda=0.05 gamma=0.4)\n",
        noise=Noise(sf_noise, closed=lambda: (2 / (3 * g) + 1 / (g**2 * RL), 0)),
        dist=Dist(dist_net("VDD vdd 0 5\nVIN in 0 DC 1.3 AC 1\nM1 vdd in out out nm W=20u L=1u\nRL out 0 5k\n"),
                  ["M1"], sf_dist,
                  closed=lambda: (T_SF / (1 + T_SF), K2G * RL / (1 + T_SF)**3, -2 * K2G**2 * RL**2 / (1 + T_SF)**5)),
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
                      lead=lambda: -g * g2 * ro1 * ro2),
        rout=Quantity(lambda: cascode(0, 1, load_r=False), closed=lambda: ro1 + ro2 + (g2 + gmb2) * ro1 * ro2,
                      lead=lambda: g2 * ro1 * ro2),
    ),
    Case(
        "sf_isrc",
        "sf current-source load\nVDD vdd 0\nVIN in 0\nVB vb 0\nM1 vdd in out 0\nM2 out vb 0 0\n",
        "VIN", "out",
        # Without g_mb the gain would be the pure number 1: body effect alone
        # sets it, so it stays. Zout drops it.
        gain=Quantity(lambda: sf_isrc(1, 0), closed=lambda: g / (g + gmb + 1 / ro + 1 / ro2), lead=lambda: g / (g + gmb)),
        rout=Quantity(lambda: sf_isrc(0, 1), closed=lambda: par(1 / g, 1 / gmb, ro, ro2), lead=lambda: 1 / g),
    ),
    Case(
        "stack_shared_gate",
        "stacked nmos\nVDD vdd 0\nVIN in 0\nRD vdd out\nM2 out in x 0\nM1 x in 0 0\n",
        "VIN", "out",
        # M1 is in triode whenever M2 conducts: its r_o stays.
        gain=Quantity(lambda: stack(1, 0), lead=lambda: -g2 * RD * (1 + g * ro1) / (1 + g2 * ro1)),
        rout=Quantity(lambda: stack(0, 1), lead=lambda: RD),
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
        dist=Dist(dist_net("VDD vdd 0 5\nRD1 vdd o1 5k\nRD2 vdd o2 5k\nM1 o1 inp tail tail nm W=10u L=1u\n"
                           "M2 o2 inn tail tail nm W=10u L=1u\nITAIL tail 0 200u\nVID inp inn DC 0 AC 1\nVCM inn 0 1.2\n", lam=0.05),
                  ["M1", "M2"], diffpair_dist,
                  matched={"gm_M2": "gm_M1", "ro_M2": "ro_M1", "RD2": "RD1", **{k_name(m, "M2"): k_name(m, "M1") for m in MOS_MONOS}}),
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
        dist=Dist(dist_net("VDD vdd 0 3\nVIP inp 0 DC 1.2 AC 1\nVINN inn 0 1.2\nITAIL tail 0 100u\nM1 x inp tail tail nm W=10u L=1u\n"
                           "M2 out inn tail tail nm W=10u L=1u\nM3 x x vdd vdd pm W=20u L=1u\nM4 out x vdd vdd pm W=20u L=1u\n"
                           ".model pm pmos (level=1 kp=100u vto=-0.5 lambda=0.05)\n", lam=0.05),
                  ["M1", "M2", "M3", "M4"], ota5t_dist,
                  matched={"gm_M2": "gm_M1", "ro_M2": "ro_M1", "gm_M4": "gm_M3", "ro_M4": "ro_M3",
                           **{k_name(m, "M2"): k_name(m, "M1") for m in MOS_MONOS},
                           **{k_name(m, "M4"): k_name(m, "M3") for m in MOS_MONOS}}),
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
        dist=Dist("ce\n.options gmin=1e-18\nVCC vcc 0 5\nVIN in 0 DC 0.65 AC 1\nRC vcc c 2k\nQ1 c in 0 qn\n"
                  ".model qn npn (is=1e-16 bf=100 vaf=50)\n", ["Q1"], ce_dist,
                  # a2 also has the Early cross term K_{be ce}·gm·(ro ∥ RC)².
                closed=lambda: (-sym("gm_Q1") * par(sym("ro_Q1"), sym("RC")),
                                  -sym("KC2be_Q1") * par(sym("ro_Q1"), sym("RC"))
                                  + sym("KCbece_Q1") * sym("gm_Q1") * par(sym("ro_Q1"), sym("RC"))**2, None)),
    ),
    Case(
        "cs_square_law",
        "cs\nVIN in 0\nVDD vdd 0\nRD vdd out\nM1 out in 0 0\n",
        "VIN", "out",
        # λ = 0: a2/a1 = K2g/gm = 1/(2 Vov), so HD2 = A/(4 Vov), and a3 = 0.
        dist=Dist(dist_net("VDD vdd 0 5\nVIN in 0 DC 0.9 AC 1\nRD vdd out 5k\nM1 out in 0 0 nm W=10u L=1u\n"),
                  ["M1"], cs_dist, closed=lambda: (-g * RD, -K2G * RD, 0),
                  hd2=lambda dev, A: A / (4 * dev["vdsat"])),
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
    Case(
        "assume_cs_ro",
        "cs\nVIN in 0\nVDD vdd 0\nRD vdd out\nM1 out in 0 0\n",
        "VIN", "out",
        gain=Quantity(cs_rd_gain), rout=Quantity(cs_rd_rout),
        assume=[("M1", "ro")],
    ),
    Case(
        "assume_degen_gmb",
        "cs degen\nVIN in 0\nVDD vdd 0\nRD vdd out\nM1 out in sn 0\nRS sn 0\n",
        "VIN", "out",
        gain=Quantity(degen_gain), rout=Quantity(degen_rout),
        assume=[("M1", "gmb")],
    ),
    Case(
        "assume_cascode_ro",
        "cascode\nVIN in 0\nVB vb 0\nVDD vdd 0\nRD vdd out\nM1 x in 0 0\nM2 out vb x 0\n",
        "VIN", "out",
        gain=Quantity(lambda: cascode(1, 0)), rout=Quantity(lambda: cascode(0, 1)),
        assume=[("M1", "ro"), ("M2", "ro"), ("M2", "gmb")],
    ),
    Case(
        "assume_cascode_isrc_ro",
        "cascode ideal load\nVIN in 0\nVB vb 0\nVDD vdd 0\nIB vdd out\nM1 x in 0 0\nM2 out vb x 0\n",
        "VIN", "out",
        # Without both r_o the output node has no conductance: both are kept,
        # g_mb2 → 0 is applied.
        gain=Quantity(lambda: cascode(1, 0, load_r=False)), rout=Quantity(lambda: cascode(0, 1, load_r=False)),
        assume=[("M1", "ro"), ("M2", "ro"), ("M2", "gmb")],
        restored={"gain": ["M1:ro", "M2:ro"], "rout": ["M1:ro", "M2:ro"]},
    ),
    Case(
        "assume_ce_degen_rpi",
        "ce degen\nVCC vcc 0\nVIN in 0\nRC vcc c\nQ1 c in e\nRE e 0\n",
        "VIN", "c",
        gain=Quantity(ce_degen_gain),
        assume=[("Q1", "rpi"), ("Q1", "ro")],
    ),
    Case(
        "assume_ef_ro",
        "emitter follower\nVCC vcc 0\nVIN in 0\nQ1 vcc in e\nRE e 0\n",
        "VIN", "e",
        gain=Quantity(lambda: ef_all()[0]), rin=Quantity(lambda: ef_all()[1]), rout=Quantity(lambda: ef_all()[2]),
        assume=[("Q1", "ro")],
    ),
    Case(
        "assume_rlc_short_open",
        "rlc\nVIN in 0\nR1 in a\nL1 a out\nC1 out 0\nRL out 0\n",
        "VIN", "out",
        gain=Quantity(rlc_gain), assume=[("L1", "short"), ("RL", "open")],
    ),
    Case(
        "assume_rlc_c_short",
        "rlc\nVIN in 0\nR1 in a\nL1 a out\nC1 out 0\nRL out 0\n",
        "VIN", "a",
        gain=Quantity(rlc_gain_a), assume=[("C1", "short")],
    ),
]
