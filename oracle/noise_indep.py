"""ngspice's noise, recomputed independently at 60 digits.

usage: uv run noise_indep.py <netlist.cir> [--expected e/<name>.json]

Every noise source ngspice models is placed as a current between its nodes in
the independent rebuild of ngspice's linearized circuit (indep.py, with
ngspice's own operating point), and its output power spectral density is
|Z_out,source|²·S_source, with ngspice's formulas (ngspice-47 resnoi.c,
mos1noi.c, bjtnoi.c, dionoi.c):
  resistor        S = 4kT/R                           (thermal)
  MOS level 1     S = 4kT·(2/3)·|gm|                  (channel thermal, d–s,
                                                       on the mode-swapped terminals)
                  S = KF·gm² / (Cox·W·Leff·f^AF)       (flicker, d–s; measured, see
                      below: ngspice-47's level 1 is NOT SPICE2's KF·Id^AF/(f·Cox·Leff²);
                      AF is the frequency exponent and Cox = 3.9·ε0/TOX, TOX = 1e-7 m
                      by default, Leff = L − 2·LD)
  BJT             S = 2q·|Ic| (c–e), 2q·|Ib| (b–e)    (shot)
                  S = KF·|Ib|^AF / f (b–e)            (flicker)
  diode           S = 2q·|Id|, KF·|Id|^AF / f         (shot, flicker)
k = 1.38064852e-23, q = 1.6021766208e-19, T = 300.15 K (ngspice's constants).
The output is compared to ngspice's per-source and total densities.

The MOS flicker form was established by controlled probes (W, L, LD, TOX, KP,
VTO, LAMBDA, KF, AF and f varied one at a time): S ∝ gm²·KF/(W·Leff·Cox·f^AF)
with no other factor, matching ngspice to 1e-15 on the noise corpus.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import mpmath as mp

import indep
import spice

K = mp.mpf("1.38064852e-23")
Q = mp.mpf("1.6021766208e-19")
T = mp.mpf("300.15")
EPS_OX = mp.mpf("3.9") * mp.mpf("8.854214871e-12")  # ngspice: 3.9 * 8.854214871e-12 F/m
TOX_DEFAULT = mp.mpf("1e-7")


def sources(net, want, models, f):
    """(element, source, node_a, node_b, S) for every noise source."""
    out = []
    devs = {k.lower(): d for k, d in want["op"]["devices"].items()}
    for e in net.elements:
        k, t = e.kind, e.tokens
        if k == "r":
            out.append((e.name, "thermal", e.nodes[0], e.nodes[1], 4 * K * T / indep.num(t[3])))
        elif k == "m":
            d = devs[e.name.lower()]
            dn, _, sn, _ = e.nodes
            ed, es = (sn, dn) if d["reverse"] else (dn, sn)
            out.append((e.name, "id", ed, es, 4 * K * T * mp.mpf(2) / 3 * abs(indep.P(d["gm"]))))
            mp_ = models.get(t[5].lower(), {})
            kf, af = mp.mpf(mp_.get("kf", 0)), mp.mpf(mp_.get("af", 1))
            if kf:
                geo = {x.split("=")[0].lower(): indep.num(x.split("=")[1]) for x in t[6:] if "=" in x}
                width = geo.get("w", mp.mpf("1e-4")) * geo.get("m", 1)
                leff = geo.get("l", mp.mpf("1e-4")) - 2 * mp.mpf(mp_.get("ld", 0))
                cox = EPS_OX / mp.mpf(mp_.get("tox", TOX_DEFAULT))
                gm = abs(indep.P(d["gm"]))
                out.append((e.name, "1overf", ed, es, kf * gm**2 / (cox * width * leff * mp.power(f, af))))
        elif k == "q":
            d = devs[e.name.lower()]
            c, b, em = e.nodes[:3]
            out.append((e.name, "ic", c, em, 2 * Q * abs(indep.P(d["ic"]))))
            out.append((e.name, "ib", b, em, 2 * Q * abs(indep.P(d["ib"]))))
            mname = (t[4] if len(e.nodes) == 3 else t[5]).lower()
            mp_ = models.get(mname, {})
            kf, af = mp.mpf(mp_.get("kf", 0)), mp.mpf(mp_.get("af", 1))
            if kf:
                out.append((e.name, "1overf", b, em, kf * mp.exp(af * mp.log(abs(indep.P(d["ib"])))) / f))
        elif k == "d":
            d = devs[e.name.lower()]
            out.append((e.name, "id", e.nodes[0], e.nodes[1], 2 * Q * abs(indep.P(d["id"]))))
    return out


def noise(cir: Path, want: dict, freqs: list[float]) -> dict:
    system, ni, bidx, net, side, models = indep.build_and_solve(cir, want, "full", want_system=True)
    out_n, ref_n = side["output"], side.get("ref")
    res = {"output": [], "input": [], "contributors": {}}
    for f in freqs:
        s = mp.mpc(0, 2 * mp.pi * f)
        A, _ = system(s, "none")
        at = lambda x, n: x[ni(n)] if n is not None and ni(n) is not None else 0
        total = mp.mpf(0)
        for elem, src, a, b, S in sources(net, want, models, mp.mpf(f)):
            rhs = mp.matrix(A.rows, 1)
            if ni(a) is not None:
                rhs[ni(a)] += 1
            if ni(b) is not None:
                rhs[ni(b)] -= 1
            x = mp.lu_solve(A, rhs)
            z = at(x, out_n) - at(x, ref_n)
            p = abs(z) ** 2 * S
            total += p
            res["contributors"].setdefault((elem.lower(), src), []).append({"f": f, "v2": p})
        Ag, bg = system(s, "gain")
        xg = mp.lu_solve(Ag, bg)
        gain = at(xg, out_n) - at(xg, ref_n)
        res["output"].append({"f": f, "v2": total})
        res["input"].append({"f": f, "v2": total / abs(gain) ** 2 if gain != 0 else mp.inf})
    return res


def integrated(cir: Path, want: dict, f_low: float, f_high: float, dps: int = 30) -> dict:
    """∫ S_out df and ∫ S_in df over [f_low, f_high] by adaptive quadrature in
    log f (one panel per decade) of the exact 60-digit PSD. S_in = S_out/|H|²."""
    system, ni, bidx, net, side, models = indep.build_and_solve(cir, want, "full", want_system=True)
    mp.mp.dps = dps
    out_n, ref_n = side["output"], side.get("ref")
    at = lambda x, n: x[ni(n)] if n is not None and ni(n) is not None else 0
    src_list = None

    def psd(f):
        nonlocal src_list
        s = mp.mpc(0, 2 * mp.pi * f)
        A, _ = system(s, "none")
        total = mp.mpf(0)
        for elem, src, a, b, S in sources(net, want, models, f):
            rhs = mp.matrix(A.rows, 1)
            if ni(a) is not None:
                rhs[ni(a)] += 1
            if ni(b) is not None:
                rhs[ni(b)] -= 1
            x = mp.lu_solve(A, rhs)
            total += abs(at(x, out_n) - at(x, ref_n)) ** 2 * S
        Ag, bg = system(s, "gain")
        xg = mp.lu_solve(Ag, bg)
        gain = at(xg, out_n) - at(xg, ref_n)
        return total, total / abs(gain) ** 2

    lo, hi = mp.log10(f_low), mp.log10(f_high)
    edges = [lo + (hi - lo) * k / max(1, int(mp.ceil(hi - lo))) for k in range(int(mp.ceil(hi - lo)) + 1)]
    ln10 = mp.log(10)
    out_v2 = in_v2 = mp.mpf(0)
    for a_, b_ in zip(edges, edges[1:]):
        out_v2 += mp.quad(lambda u: psd(mp.power(10, u))[0] * mp.power(10, u) * ln10, [a_, b_])
        in_v2 += mp.quad(lambda u: psd(mp.power(10, u))[1] * mp.power(10, u) * ln10, [a_, b_])
    return {"fLow": f_low, "fHigh": f_high, "outputV2": float(out_v2), "inputV2": float(in_v2)}


def compare(ind: dict, ng: dict) -> list[tuple[str, float]]:
    """(label, relative difference) for totals and every ngspice contributor."""
    rows = []
    for q in ("output", "input"):
        for a, b in zip(ind[q], ng[q]):
            rows.append((f"{q}@{a['f']:g}", float(abs(a["v2"] - b["v2"]) / max(b["v2"], 1e-300))))
    have = {(c["element"], c["source"]): c["values"] for c in ng["contributors"]}
    for (elem, src), vals in ind["contributors"].items():
        ngv = have.get((elem, src))
        if ngv is None:
            rows.append((f"{elem}.{src}: not in ngspice", math.inf))
            continue
        for a, b in zip(vals, ngv):
            denom = max(b["v2"], 1e-300)
            rows.append((f"{elem}.{src}@{a['f']:g}", float(abs(a["v2"] - b["v2"]) / denom) if b["v2"] or a["v2"] else 0.0))
    for (elem, src), vals in have.items():
        if src != "total" and (elem, src) not in ind["contributors"] and any(v["v2"] > 0 for v in vals):
            rows.append((f"{elem}.{src}: ngspice-only source", math.inf))
    return rows


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("netlist", type=Path)
    ap.add_argument("--expected", type=Path)
    args = ap.parse_args()
    exp = args.expected or args.netlist.parent.parent / "expected" / f"{args.netlist.stem}.json"
    want = json.loads(exp.read_text())
    freqs = [v["f"] for v in want["noise"]["output"]]
    rows = compare(noise(args.netlist, want, freqs), want["noise"])
    worst = max(r for _, r in rows)
    for label, r in rows:
        print(f"  {label:28s} {r:.2e}")
    print(f"worst relative difference vs ngspice: {worst:.2e}")
    return 0 if worst < 1e-6 else 1


if __name__ == "__main__":
    sys.exit(main())
