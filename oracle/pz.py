"""Device capacitances and pole/zero references.

ngspice computes every device capacitance in its MODEINITSMSIG load, so
they are printed after an `ac` run (they are 0 after `op` alone): MOS
@m[cgs], [cgd], [cgb] (with overlap), [cbd], [cbs]; BJT @q[cpi], [cmu] plus
[cbx] (the two XCJC parts of C_mu, one node here), [csub], and [cexbc], the
transcapacitance geqcb (s·geqcb·v_bc from base to emitter); diode @d[cd].

The gain's poles and zeros are the roots of det(G + sC) and of the bordered
determinant det([[G + sC, b], [wᵀ, 0]]) (the Cramer numerator of
V(out) − V(ref)), on indep.py's 60-digit rebuild of ngspice's own
linearized circuit with ngspice's capacitances, without cancelling common
factors: the eigenvalues λ of (G + σC)⁻¹C at 100 digits give the finite
roots s = σ − 1/λ; an infinite root has λ within rounding of 0 (below
1e-18 of the largest, where every finite root of a circuit up to 1e15 Hz is
above 1e-12). ngspice's own .pz confirms them where it works (small
circuits; on a 741 it returns repeated garbage), to PZ_AGREEMENT.
"""

from __future__ import annotations

import math
from pathlib import Path

import mpmath as mp

# Per device kind: (ngspice parameter, solver op.caps key, sign).
CAP_PARAMS = {
    "m": [("cgs", "cgs"), ("cgd", "cgd"), ("cgb", "cgb"), ("cbd", "cbd"), ("cbs", "cbs")],
    "q": [("cpi", "cpi"), ("cmu", "cmu"), ("cbx", "cmu"), ("csub", "csub"), ("cexbc", "cx")],
    "d": [("cd", "cj")],
}

# ngspice .pz against the 100-digit roots: its Muller iteration converges to
# about 1e-10 on the corpus; a root off by more is not confirmation.
PZ_AGREEMENT = 1e-6


def print_lines(net) -> list[str]:
    """ngspice commands printing every device capacitance (after an ac)."""
    out = []
    for e in net.elements:
        for p, _ in CAP_PARAMS.get(e.kind, []):
            out.append(f"print @{e.name}[{p}]")
    return out


def device_caps(net, values: dict) -> dict[str, dict[str, float]]:
    """{device: {cgs: …}} in the solver's op.caps keys from ngspice's
    printed values (C_mu = cmu + cbx, C_x = −cexbc); devices whose
    capacitances are all 0 are left out."""
    out = {}
    for e in net.elements:
        caps: dict[str, float] = {}
        for p, key in CAP_PARAMS.get(e.kind, []):
            v = values.get(f"@{e.name}[{p}]")
            if v is None:
                raise KeyError(f"ngspice printed no value for @{e.name}[{p}]")
            v = float(v.real if isinstance(v, complex) else v)
            caps[key] = caps.get(key, 0.0) + (-v if p == "cexbc" else v)
        if any(v != 0 for v in caps.values()):
            out[e.name] = caps
    return out


def _roots(G, C, dps: int = 100) -> list[mp.mpc]:
    """Finite roots of det(G + sC) (rad/s), from the eigenvalues of
    (G + σC)⁻¹C at shifts σ until G + σC is regular."""
    mp.mp.dps = dps
    n = G.rows
    gn = max(abs(G[i, j]) for i in range(n) for j in range(n))
    cn = max((abs(C[i, j]) for i in range(n) for j in range(n)), default=0)
    if cn == 0:
        return []
    scale = gn / cn
    for k in (0.737, -1.913, 3.17, -0.31):
        sigma = mp.mpf(k) * scale
        try:
            M = mp.inverse(G + sigma * C) * C
        except ZeroDivisionError:
            continue
        lam = mp.eig(M, left=False, right=False)
        big = max(abs(x) for x in lam)
        if big == 0:
            return []
        return [sigma - 1 / x for x in lam if abs(x) > mp.mpf("1e-18") * big]
    raise ValueError("no regular shift for the pencil")


def reference(cir: Path, want: dict) -> dict:
    """{poles, zeros} of the gain in Hz ({re, im}), from the rebuild."""
    import indep  # noqa: PLC0415 - indep imports run_ngspice, which imports this module

    system, ni, _, net, side, _ = indep.build_and_solve(cir, want, want_system=True)
    mp.mp.dps = 100
    A0, b = system(mp.mpf(0), "gain")
    A1, _ = system(mp.mpf(1), "gain")
    n = A0.rows
    G, C = A0, A1 - A0
    poles = _roots(G, C)
    # Bordered: [[A, b], [wᵀ, 0]] with w = e_out − e_ref.
    Gb, Cb = mp.matrix(n + 1, n + 1), mp.matrix(n + 1, n + 1)
    for i in range(n):
        for j in range(n):
            Gb[i, j], Cb[i, j] = G[i, j], C[i, j]
        Gb[i, n] = b[i]
    for node, w in ((side["output"], 1), (side.get("ref"), -1)):
        if node is not None and ni(node.lower()) is not None:
            Gb[n, ni(node.lower())] += w
    zeros = _roots(Gb, Cb)
    hz = lambda r: {"re": float(r.real / (2 * mp.pi)), "im": float(r.imag / (2 * mp.pi))}
    order = lambda rs: sorted(rs, key=lambda r: (float(abs(r)), float(r.imag)))
    return {"poles": [hz(r) for r in order(poles)], "zeros": [hz(r) for r in order(zeros)]}


def parse_ngspice(text: str) -> list[dict]:
    """The roots one ngspice pz run (pol or zer) prints with `print all`,
    pole(k) / zero(k) or, for a lone root, all (rad/s), as Hz."""
    import re  # noqa: PLC0415

    return [{"re": float(m.group(1)) / (2 * math.pi), "im": float(m.group(2)) / (2 * math.pi)}
            for m in re.finditer(r"^\s*(?:pole\(\d+\)|zero\(\d+\)|all)\s*=\s*(\S+),\s*(\S+)\s*$", text, re.M)]


def unmatched(got: list[dict], want: list[dict], rtol: float) -> tuple[list[dict], list[dict]]:
    """Pairs roots one-to-one, each with the nearest unused one within
    rtol·|root| (+1e-12 Hz): the leftovers of each side."""
    used = [False] * len(want)
    left = []
    for g in sorted(got, key=lambda r: math.hypot(r["re"], r["im"])):
        gz = complex(g["re"], g["im"])
        best, bd = None, math.inf
        for i, w in enumerate(want):
            if used[i]:
                continue
            d = abs(gz - complex(w["re"], w["im"]))
            if d <= rtol * max(abs(gz), abs(complex(w["re"], w["im"]))) + 1e-12 and d < bd:
                best, bd = i, d
        if best is None:
            left.append(g)
        else:
            used[best] = True
    return left, [w for i, w in enumerate(want) if not used[i]]


def check(got: dict, want: dict, rtol: float) -> list[str]:
    """Problems with `got`'s poles and zeros against `want`'s: every root of
    got must pair with one of want; a root of want got lacks is allowed only
    as a cancelled factor (a pole and a zero of want, equal, both missing)."""
    problems = []
    gp, wp = unmatched(got.get("poles") or [], want["poles"], rtol)
    gz, wz = unmatched(got.get("zeros") or [], want["zeros"], rtol)
    for kind, extra in (("pole", gp), ("zero", gz)):
        for r in extra:
            problems.append(f"{kind} {r['re']:.10g}{r['im']:+.10g}j Hz: not in the reference")
    left_p, left_z = unmatched(wp, wz, rtol)
    for kind, missing in (("pole", left_p), ("zero", left_z)):
        for r in missing:
            problems.append(f"{kind} {r['re']:.10g}{r['im']:+.10g}j Hz: missing (and not cancelled)")
    return problems
