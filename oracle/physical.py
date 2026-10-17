"""Is an ngspice operating point physically meaningful?

A circuit is rejected (by the generators) or not used as a reference (by the
minimizer) when any junction current exceeds 1 A: a junction forward-biased
straight from ideal sources, where only the exponential limits the current
and no simulator's numbers mean anything. ngspice's @m[id] leaves out the MOS
bulk junctions, so those currents come from the junction law at ngspice's
node voltages (mos1load: IS·M·(exp(V/Vt) − 1)).
"""

from __future__ import annotations

import math
import re

import spice

VT = 1.38064852e-23 * 300.15 / 1.6021766208e-19
MAX_CURRENT = 1.0


def model_params(text: str) -> dict[str, dict[str, float]]:
    out = {}
    for m in re.finditer(r"^\.model\s+(\S+)\s+\S+\s*\(?([^)\n]*)\)?", text, re.I | re.M):
        out[m.group(1).lower()] = {k.lower(): float(v) for k, v in re.findall(r"(\w+)=([-+\d.eE]+)", m.group(2))}
    return out


def max_junction_current(result: dict, text: str) -> float:
    """Largest device or MOS bulk-junction current in an ngspice result."""
    worst = max((abs(d.get(k, 0)) for d in result["op"]["devices"].values() for k in ("id", "ic", "ib")), default=0.0)
    net = spice.parse(text)
    params = model_params(text)
    volt = {k.lower(): v for k, v in result["op"]["nodes"].items()}
    v = lambda n: 0.0 if n in spice.GROUND else volt[n.lower()]
    for e in net.elements:
        if e.kind != "m":
            continue
        mname = e.tokens[5].lower()
        t = -1 if net.models.get(mname) == "pmos" else 1
        mult = next((float(x.split("=")[1]) for x in e.tokens[6:] if x.lower().startswith("m=")), 1.0)
        isat = params.get(mname, {}).get("is", 1e-14) * mult
        d, _, s, b = e.nodes
        for other in (s, d):
            worst = max(worst, isat * math.expm1(min(t * (v(b) - v(other)) / VT, 700)))
    return worst


def physical(result: dict, text: str) -> bool:
    return max_junction_current(result, text) <= MAX_CURRENT
