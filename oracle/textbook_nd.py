"""Textbook noise cases, derived by hand and checked against ngspice.

usage: uv run textbook_nd.py [-v] [names...]

Noise: each case writes KCL with explicit noise-current injections (channel
4kT·(2/3)·gm d–s, resistors 4kT/R, BJT shot 2q|Ic| c–e and 2q|Ib| b–e) and
sums |transfer|²·S per source. It is evaluated with the circuit's own
numbers (ngspice's operating point) and must match:
  - ngspice: noise output and input PSD at rtol 1e-9;
  - the quoted textbook closed form, where the textbook's assumptions hold
    (λ = 0, γ = 0, ro → ∞), exactly; elsewhere it is reported, not asserted.
The solver's own results are checked against hand derivations in textbook.py.
Constants are ngspice's: k = 1.38064852e-23, q = 1.6021766208e-19, T = 300.15 K.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import sympy as sp

import run_ngspice

K_B = 1.38064852e-23
Q_E = 1.6021766208e-19
TEMP = 300.15
KT4 = 4 * K_B * TEMP
VT = K_B * TEMP / Q_E
GMIN_LINE = ".options gmin=1e-18"  # hand forms leave junction leakage out


@dataclass
class NDCase:
    name: str
    netlist: str
    input: str
    output: str
    ref: str | None = None
    noise: Callable[[dict], tuple[float, float]] | None = None
    """(S_out, S_in) in V²/Hz from ngspice's operating point (hand KCL)."""
    noise_textbook: Callable[[dict], float] | None = None
    """Textbook input-referred PSD."""
    noise_textbook_exact: bool = False


def dev(want: dict, name: str) -> dict:
    return {k.lower(): v for k, v in want["op"]["devices"].items()}[name.lower()]


# --- noise, hand KCL --------------------------------------------------------

def lin_noise(eqs, unknowns, out, sources: dict[sp.Symbol, float], gain_eqs, gain_out) -> tuple[float, float]:
    """eqs: KCL with noise currents as symbols; sources: symbol -> PSD.
    Returns (S_out, S_in) with S_in = S_out / gain²."""
    sol = sp.solve(eqs, unknowns, dict=True)[0]
    vout = sp.expand(out.subs(sol))
    s_out = sum(float(sp.diff(vout, n)) ** 2 * S for n, S in sources.items())
    gsol = sp.solve(gain_eqs, unknowns, dict=True)[0]
    gain = float(gain_out.subs(gsol))
    return s_out, s_out / gain**2


def cs_noise(want):
    m = dev(want, "M1")
    gm, gds, RD = m["gm"], m["gds"], 10e3
    vo, i1, ir = sp.symbols("vo i1 ir")
    # Drain current gm·vgs + gds·vds + i1 (noise d→s); RD noise current ir out→vdd.
    eqs = [vo / RD + ir + gm * 0 + gds * vo + i1]
    geqs = [vo / RD + gm * 1 + gds * vo]
    return lin_noise(eqs, [vo], vo, {i1: KT4 * 2 / 3 * gm, ir: KT4 / RD}, geqs, vo)


def cs_noise_textbook(want):
    m = dev(want, "M1")
    gm, RD = m["gm"], 10e3
    return KT4 * 2 / 3 / gm + KT4 / (gm**2 * RD)


def degen_noise(want, RD=5e3, RS=1e3):
    m = dev(want, "M1")
    gm, gds, gmb = m["gm"], m["gds"], m["gmb"]
    vo, vs, i1, ird, irs = sp.symbols("vo vs i1 ird irs")
    def eqs(vin, n=True):
        idr = gm * (vin - vs) + gmb * (0 - vs) + gds * (vo - vs) + (i1 if n else 0)
        return [vo / RD + idr + (ird if n else 0), idr - vs / RS + (irs if n else 0)]
    return lin_noise(eqs(0), [vo, vs], vo, {i1: KT4 * 2 / 3 * gm, ird: KT4 / RD, irs: KT4 / RS},
                     eqs(1, False), vo)


def degen_noise_textbook(want, RD=5e3, RS=1e3):
    gm = dev(want, "M1")["gm"]
    return KT4 * 2 / 3 / gm + KT4 * RS + KT4 * (1 + gm * RS) ** 2 / (gm**2 * RD)


def sf_noise(want, RS=5e3):
    m = dev(want, "M1")
    gm, gds, gmb = m["gm"], m["gds"], m["gmb"]
    vo, i1, irs = sp.symbols("vo i1 irs")
    def eqs(vin, n=True):
        idr = gm * (vin - vo) + gmb * (0 - vo) + gds * (0 - vo) + (i1 if n else 0)
        return [idr - vo / RS + (irs if n else 0)]
    return lin_noise(eqs(0), [vo], vo, {i1: KT4 * 2 / 3 * gm, irs: KT4 / RS}, eqs(1, False), vo)


def sf_noise_textbook(want, RS=5e3):
    m = dev(want, "M1")
    gm = m["gm"]
    return (KT4 * 2 / 3 * gm + KT4 / RS) / gm**2


def diffpair_noise(want, RD=5e3):
    m1, m2 = dev(want, "M1"), dev(want, "M2")
    v1, v2, vt, i1, i2, r1, r2 = sp.symbols("v1 v2 vt i1 i2 r1 r2")
    def eqs(vin, n=True):
        d1 = m1["gm"] * (vin - vt) + m1["gmb"] * (0 - vt) + m1["gds"] * (v1 - vt) + (i1 if n else 0)
        d2 = m2["gm"] * (0 - vt) + m2["gmb"] * (0 - vt) + m2["gds"] * (v2 - vt) + (i2 if n else 0)
        return [v1 / RD + d1 + (r1 if n else 0), v2 / RD + d2 + (r2 if n else 0), d1 + d2]
    srcs = {i1: KT4 * 2 / 3 * m1["gm"], i2: KT4 * 2 / 3 * m2["gm"], r1: KT4 / RD, r2: KT4 / RD}
    return lin_noise(eqs(0), [v1, v2, vt], v2 - v1, srcs, eqs(1, False), v2 - v1)


def diffpair_noise_textbook(want, RD=5e3):
    gm = dev(want, "M1")["gm"]
    return 2 * (KT4 * 2 / 3 / gm + KT4 / (gm**2 * RD))


def ota_noise(want):
    m = {n: dev(want, n) for n in ("M1", "M2", "M3", "M4", "M5")}
    vx, vo, vt, *ns = sp.symbols("vx vo vt i1 i2 i3 i4 i5")
    i1, i2, i3, i4, i5 = ns
    def eqs(vin, n=True):
        nz = lambda x: x if n else 0
        d1 = m["M1"]["gm"] * (vin - vt) + m["M1"]["gmb"] * (0 - vt) + m["M1"]["gds"] * (vx - vt) + nz(i1)
        d2 = m["M2"]["gm"] * (0 - vt) + m["M2"]["gmb"] * (0 - vt) + m["M2"]["gds"] * (vo - vt) + nz(i2)
        d3 = m["M3"]["gm"] * vx + m["M3"]["gds"] * vx + nz(i3)          # into x, to vdd (AC 0)
        d4 = m["M4"]["gm"] * vx + m["M4"]["gds"] * vo + nz(i4)
        d5 = m["M5"]["gds"] * vt + nz(i5)                               # tail, gate AC 0
        return [d1 + d3, d2 + d4, d1 + d2 - d5]
    srcs = {i: KT4 * 2 / 3 * m[f"M{k}"]["gm"] for k, i in zip(range(1, 6), ns)}
    return lin_noise(eqs(0), [vx, vo, vt], vo, srcs, eqs(1, False), vo)


def ota_noise_textbook(want):
    gm1, gm3 = dev(want, "M1")["gm"], dev(want, "M3")["gm"]
    return 2 * KT4 * 2 / 3 / gm1 * (1 + gm3 / gm1)


def bjt_ce_noise(want, RB=1e3, RE=500.0, RC=4e3):
    q = dev(want, "Q1")
    gm, gpi, go = q["gm"], q["gpi"], q["go"]
    vb, ve, vc, ic_, ib_, rb, re_, rc = sp.symbols("vb ve vc icn ibn rbn ren rcn")
    def eqs(vin, n=True):
        nz = lambda x: x if n else 0
        ic = gm * (vb - ve) + go * (vc - ve) + nz(ic_)
        ib = gpi * (vb - ve) + nz(ib_)
        return [(vb - vin) / RB + ib + nz(rb), vc / RC + ic + nz(rc), ic + ib - ve / RE + nz(re_)]
    srcs = {ic_: 2 * Q_E * abs(q["ic"]), ib_: 2 * Q_E * abs(q["ib"]), rb: KT4 / RB, re_: KT4 / RE, rc: KT4 / RC}
    return lin_noise(eqs(0), [vb, ve, vc], vc, srcs, eqs(1, False), vc)


def bjt_ce_noise_textbook(want, RB=1e3, RE=500.0, RC=4e3):
    """Input-referred (β → ∞, ro → ∞): 4kT(RB+RE) + 2qIc·(1/gm + RE)²... the
    usual form 4kT·RB + 4kT·RE + 2kT/gm·(…) is an approximation; reported."""
    q = dev(want, "Q1")
    gm, beta = q["gm"], q["gm"] / q["gpi"]
    return KT4 * (RB + RE) + 2 * Q_E * abs(q["ic"]) / gm**2 + 2 * Q_E * abs(q["ib"]) * (RB + RE) ** 2 \
        + KT4 / RC * ((1 + gm * RE) / gm) ** 2


CASES: list[NDCase] = [
    NDCase("noise_cs_tb", "CS, resistor load\nVDD vdd 0 1.8\nVIN in 0 DC 0.8 AC 1\nRD vdd out 10k\nM1 out in 0 0 nch W=10u L=1u\n"
           ".model nch NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0.1)\n", "VIN", "out",
           noise=cs_noise, noise_textbook=cs_noise_textbook, noise_textbook_exact=True),
    NDCase("noise_degen_tb", "CS + RS, body effect\nVDD vdd 0 1.8\nVIN in 0 DC 1.0 AC 1\nRD vdd out 5k\nM1 out in s 0 nch W=10u L=1u\n"
           "RS s 0 1k\n.model nch NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0.1 GAMMA=0.4 PHI=0.7)\n", "VIN", "out",
           noise=degen_noise, noise_textbook=degen_noise_textbook),
    NDCase("noise_degen_ideal_tb", "CS + RS, lambda = gamma = 0\nVDD vdd 0 1.8\nVIN in 0 DC 1.0 AC 1\nRD vdd out 5k\n"
           "M1 out in s 0 nch W=10u L=1u\nRS s 0 1k\n.model nch NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0)\n", "VIN", "out",
           noise=degen_noise, noise_textbook=degen_noise_textbook, noise_textbook_exact=True),
    NDCase("noise_sf_tb", "Source follower, body effect\nVDD vdd 0 1.8\nVIN in 0 DC 1.3 AC 1\nM1 vdd in out 0 nch W=20u L=1u\n"
           "RS out 0 5k\n.model nch NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0.1 GAMMA=0.4 PHI=0.7)\n", "VIN", "out",
           noise=sf_noise, noise_textbook=sf_noise_textbook),
    NDCase("noise_diffpair_tb", "Diff pair, ideal tail, lambda = gamma = 0\nVDD vdd 0 1.8\nVCM cm 0 1.0\nVIN inp cm DC 0 AC 1\n"
           "M1 o1 inp tail 0 nch W=10u L=1u\nM2 o2 cm tail 0 nch W=10u L=1u\nITAIL tail 0 DC 200u\nRD1 vdd o1 5k\nRD2 vdd o2 5k\n"
           ".model nch NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0)\n", "VIN", "o2", "o1",
           noise=diffpair_noise, noise_textbook=diffpair_noise_textbook, noise_textbook_exact=True),
    NDCase("noise_ota_tb", "5T OTA\nVDD vdd 0 1.8\nVCM cm 0 1.0\nVIN inp cm DC 0 AC 1\nM1 x inp tail 0 nch W=10u L=1u\n"
           "M2 out cm tail 0 nch W=10u L=1u\nM3 x x vdd vdd pch W=20u L=1u\nM4 out x vdd vdd pch W=20u L=1u\n"
           "M5 tail vbn 0 0 nch W=10u L=1u\nVBN vbn 0 0.7\n.model nch NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0.1)\n"
           ".model pch PMOS (LEVEL=1 KP=80u VTO=-0.5 LAMBDA=0.1)\n", "VIN", "out",
           noise=ota_noise, noise_textbook=ota_noise_textbook),
    NDCase("noise_bjt_ce_tb", "BJT CE + RE + RB\nVCC vcc 0 10\nVIN in 0 DC 1.0 AC 1\nRB in b 1k\nQ1 c b e qn\nRE e 0 500\n"
           "RC vcc c 4k\n.model qn NPN (IS=1e-15 BF=100 VAF=50)\n", "VIN", "c",
           noise=bjt_ce_noise, noise_textbook=bjt_ce_noise_textbook),
]


def ngspice_run(case: NDCase) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        c = Path(tmp) / f"{case.name}.cir"
        title, _, body = case.netlist.partition("\n")
        c.write_text(f"{title}\n{GMIN_LINE}\n{body}.end\n")
        side = {"input": case.input, "output": case.output, "ref": case.ref, "freqs": [1000.0]}
        if case.noise:
            side["noise"] = {"freqs": [1000.0]}
        c.with_suffix(".json").write_text(json.dumps(side))
        with run_ngspice.options_override(run_ngspice.OPTIONS.replace("gmin=1e-15", "gmin=1e-18")):
            return run_ngspice.process(c, Path(tmp) / "e", None)


def rel(a, b):
    return abs(a - b) / max(abs(b), 1e-300)


def check(case: NDCase, verbose: bool) -> list[str]:
    fails, notes = [], []
    want = ngspice_run(case)
    if case.noise:
        s_out, s_in = case.noise(want)
        ng_out, ng_in = want["noise"]["output"][0]["v2"], want["noise"]["input"][0]["v2"]
        if rel(s_out, ng_out) > 1e-9 or rel(s_in, ng_in) > 1e-9:
            fails.append(f"noise hand vs ngspice: S_out {s_out:.9e}/{ng_out:.9e}, S_in {s_in:.9e}/{ng_in:.9e}")
        notes.append(f"S_in = {s_in:.6e} V²/Hz (ngspice {ng_in:.6e}, rel {rel(s_in, ng_in):.1e})")
        if case.noise_textbook:
            tb = case.noise_textbook(want)
            r = rel(tb, s_in)
            if case.noise_textbook_exact and r > 1e-9:
                fails.append(f"textbook S_in {tb:.9e} != hand {s_in:.9e} (rel {r:.1e})")
            notes.append(f"textbook S_in {tb:.6e}: rel {r:.1e} ({'exact' if case.noise_textbook_exact else 'approx'})")
    if verbose:
        for n in notes:
            print(f"    {n}")
    return fails


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-v", action="store_true")
    ap.add_argument("names", nargs="*")
    args = ap.parse_args()
    bad = 0
    cases = [c for c in CASES if not args.names or c.name in args.names]
    for case in cases:
        try:
            fails = check(case, args.v)
        except Exception as exc:  # noqa: BLE001 - report every case
            fails = [f"error: {exc!r}"[:300]]
        bad += bool(fails)
        print(f"{case.name:22s} {'pass' if not fails else 'FAIL'}")
        for f in fails:
            print(f"    {f}")
    print(f"\n{len(cases) - bad}/{len(cases)} noise textbook cases agree with ngspice")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
