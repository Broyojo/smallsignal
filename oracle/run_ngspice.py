"""Run ngspice on corpus circuits and write reference results.

usage: uv run run_ngspice.py [--corpus DIR] [--out DIR] [--keep DIR] [names...]

For each <name>.cir with a <name>.json sidecar, writes <out>/<name>.json with the
operating point, small-signal device parameters, and complex gain / zin / zout at
the sidecar's frequencies. Quantities follow plan/contract.md:
  gain = V(out) - V(ref) per unit AC on the input source
  zin  = impedance seen by the input source looking into the circuit
  zout = impedance at (out, ref) with every independent source AC-zeroed
Operating-point voltages/currents are physical (not ngspice's type-normalized
PMOS/PNP values): vgs = V(g) - V(s), id = current into the drain terminal, etc.
"""

from __future__ import annotations

import argparse
import contextlib
import contextvars
import json
import math
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import spice

HERE = Path(__file__).resolve().parent
OPTIONS = ".options reltol=1e-9 abstol=1e-15 vntol=1e-12 gmin=1e-15 itl1=1000 itl2=1000"
# Per-thread override (the evidence tools run ngspice from several threads
# with different gmin values; a shared global would race).
_OPTIONS_OVERRIDE: contextvars.ContextVar[str | None] = contextvars.ContextVar("ngspice_options", default=None)


def current_options() -> str:
    return _OPTIONS_OVERRIDE.get() or OPTIONS


@contextlib.contextmanager
def options_override(options: str):
    """Run ngspice with `options` in this thread only."""
    token = _OPTIONS_OVERRIDE.set(options)
    try:
        yield
    finally:
        _OPTIONS_OVERRIDE.reset(token)

MOS_PARAMS = ["id", "gm", "gds", "gmbs", "vgs", "vds", "vbs", "von", "vdsat"]
BJT_PARAMS = ["ic", "ib", "gm", "gpi", "gmu", "go", "vbe", "vbc"]
DIODE_PARAMS = ["id", "gd"]

LINE = re.compile(r"^(\S+)\s+=\s+(\S+)\s*$")


class NgspiceError(RuntimeError):
    pass


def ngspice_version() -> str:
    out = subprocess.run(["ngspice", "--version"], capture_output=True, text=True).stdout
    m = re.search(r"ngspice-(\S+)", out)
    return m.group(1) if m else "unknown"


NGSPICE_TIMEOUT_S = 30


def run_deck(deck: str, keep: Path | None, tag: str) -> dict[str, complex | float]:
    return parse_values(run_deck_text(deck, keep, tag))


def run_deck_text(deck: str, keep: Path | None, tag: str) -> str:
    """Run a deck; return ngspice's output, raising on its error messages."""
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / f"{tag}.cir"
        path.write_text(deck)
        if keep:
            keep.mkdir(parents=True, exist_ok=True)
            (keep / f"{tag}.cir").write_text(deck)
        try:
            # ngspice can loop forever on some pathological circuits.
            proc = subprocess.run(["ngspice", "-b", str(path)], capture_output=True, text=True, cwd=tmp,
                                  timeout=NGSPICE_TIMEOUT_S)
        except subprocess.TimeoutExpired as exc:
            raise NgspiceError(f"{tag}: ngspice timed out after {NGSPICE_TIMEOUT_S}s") from exc
    text = proc.stdout + proc.stderr
    if keep:
        (keep / f"{tag}.log").write_text(text)
    errors = [l for l in text.splitlines() if re.search(r"\berror\b|singular|no convergence|timestep too small", l, re.I)]
    if errors:
        raise NgspiceError(f"{tag}: " + "; ".join(errors[:5]))
    return text


def parse_values(text: str) -> dict[str, complex | float]:
    values: dict[str, complex | float] = {}
    for line in text.splitlines():
        m = LINE.match(line.strip())
        if not m:
            continue
        name, val = m.group(1).lower(), m.group(2)
        try:
            if "," in val:
                re_, im_ = val.split(",")
                values[name] = complex(float(re_), float(im_))
            else:
                values[name] = float(val)
        except ValueError:
            continue
    return values


def control(lines: list[str]) -> list[str]:
    return [current_options(), ".control", "set numdgt=15", *lines, ".endc", ".end"]


def excitation(side: dict) -> tuple[str | None, str | None, dict[str, str] | None]:
    """(inputNeg, mode, per-source AC specs) for a two-source input: the
    differential mode drives ±1/2 (so v_in+ − v_in− = 1), the common mode
    drives both with 1."""
    neg = side.get("inputNeg")
    if not neg:
        return None, None, None
    mode = side.get("mode") or "differential"
    pos = side["input"].lower()
    if mode == "differential":
        return neg, mode, {pos: "0.5", neg.lower(): "0.5 180"}
    return neg, mode, {pos: "1", neg.lower(): "1"}


def op_and_ac(net: spice.Netlist, side: dict, keep: Path | None, name: str) -> dict:
    inp = net.element(side["input"])
    neg_name, mode, ac = excitation(side)
    neg = net.element(neg_name) if neg_name else None
    out, ref = side["output"], side.get("ref")
    freqs = side.get("freqs", [])
    nodes = net.nodes()
    lines = ["op"]
    lines += [f"print v({n})" for n in nodes]
    for e in net.elements:
        params = {"m": MOS_PARAMS, "q": BJT_PARAMS, "d": DIODE_PARAMS}.get(e.kind, [])
        lines += [f"print @{e.name}[{p}]" for p in params]
    for e in net.elements:
        if e.kind == "v":
            lines.append(f"print i({e.name})")
    for k, f in enumerate(freqs):
        lines.append(f"ac lin 1 {f!r} {f!r}")
        lines.append(f"let gk{k} = {spice.vexpr(out, ref)}")
        lines.append(f"print gk{k}")
        if neg is not None:
            if inp.kind == "v" and mode == "common":
                lines.append(f"let ik{k} = i({inp.name})+i({neg.name})")
                lines.append(f"print ik{k}")
        elif inp.kind == "v":
            lines.append(f"let vk{k} = {spice.vexpr(inp.nodes[0], inp.nodes[1])}")
            lines.append(f"let ik{k} = i({inp.name})")
            lines.append(f"print vk{k}")
            lines.append(f"print ik{k}")
        else:
            # Current leaves an I source at its n- node and returns at n+.
            lines.append(f"let vk{k} = {spice.vexpr(inp.nodes[1], inp.nodes[0])}")
            lines.append(f"print vk{k}")
    deck = spice.render(net, inp.name, ac=ac) + "\n".join(control(lines)) + "\n"
    v = run_deck(deck, keep, name)

    def get(key: str):
        if key not in v:
            raise NgspiceError(f"{name}: ngspice printed no value for {key}")
        return v[key]

    volt = {n: get(f"v({n})") for n in nodes}

    def vn(n: str) -> float:
        return 0.0 if n in spice.GROUND else volt[n]

    devices: dict[str, dict] = {}
    for e in net.elements:
        if e.kind == "m":
            mtype = net.models[e.tokens[5].lower()]
            t = 1 if mtype == "nmos" else -1
            p = {k: get(f"@{e.name}[{k}]") for k in MOS_PARAMS}
            d, g, s, b = e.nodes
            vds_n, vgs_n = p["vds"], p["vgs"]
            if vds_n >= 0:
                vov, vde, reverse = vgs_n - t * p["von"], vds_n, False
            else:
                vov, vde, reverse = (vgs_n - vds_n) - t * p["von"], -vds_n, True
            region = "cutoff" if vov <= 0 else ("saturation" if vde >= vov else "triode")
            devices[e.name] = {
                "type": mtype,
                "region": region,
                "reverse": reverse,
                "id": t * p["id"],
                "vgs": vn(g) - vn(s),
                "vds": vn(d) - vn(s),
                "vbs": vn(b) - vn(s),
                "vov": vov,
                "gm": p["gm"],
                "gds": p["gds"],
                "gmb": p["gmbs"],
            }
        elif e.kind == "q":
            model = e.tokens[4] if len(e.nodes) == 3 else e.tokens[5]
            mtype = net.models[model.lower()]
            t = 1 if mtype == "npn" else -1
            p = {k: get(f"@{e.name}[{k}]") for k in BJT_PARAMS}
            c, b, em = e.nodes[:3]
            vbe_n, vbc_n = t * (vn(b) - vn(em)), t * (vn(b) - vn(c))
            on_e, on_c = vbe_n > 0.4, vbc_n > 0.4
            region = {(True, False): "forward-active", (True, True): "saturation",
                      (False, True): "reverse-active", (False, False): "cutoff"}[(on_e, on_c)]
            devices[e.name] = {
                "type": mtype,
                "region": region,
                # Unlike MOS id, ngspice reports BJT ic/ib as physical terminal currents.
                "ic": p["ic"],
                "ib": p["ib"],
                "vbe": vn(b) - vn(em),
                "vce": vn(c) - vn(em),
                "gm": p["gm"],
                "gpi": p["gpi"],
                "go": p["go"],
                "gmu": p["gmu"],
            }
        elif e.kind == "d":
            devices[e.name] = {"type": "diode", "id": get(f"@{e.name}[id]"), "gd": get(f"@{e.name}[gd]"),
                               "vd": vn(e.nodes[0]) - vn(e.nodes[1])}

    branch = {e.name: get(f"i({e.name})") for e in net.elements if e.kind == "v"}
    gain, zin = [], []
    for k, f in enumerate(freqs):
        g = complex(get(f"gk{k}"))
        gain.append(cval(f, g))
        if neg is not None:
            if inp.kind == "v" and mode == "common":
                # Both inputs at 1 V: Z = 1 / (total current into the circuit).
                i_into = -complex(get(f"ik{k}"))
                zin.append(cval(f, 1 / i_into if abs(i_into) > 0 else None))
            continue
        vk = complex(get(f"vk{k}"))
        if inp.kind == "v":
            # ngspice's i(V) flows into the + terminal, so the circuit draws -i(V).
            i_into = -complex(get(f"ik{k}"))
            zin.append(cval(f, vk / i_into if abs(i_into) > 0 else None))
        else:
            zin.append(cval(f, vk))
    return {"nodes": volt, "devices": devices, "vsource_currents": branch}, gain, zin


def zout(net: spice.Netlist, side: dict, keep: Path | None, name: str) -> list[dict]:
    out, ref = side["output"], side.get("ref") or "0"
    freqs = side.get("freqs", [])
    lines = []
    for k, f in enumerate(freqs):
        lines.append(f"ac lin 1 {f!r} {f!r}")
        lines.append(f"let zk{k} = {spice.vexpr(out, ref)}")
        lines.append(f"print zk{k}")
    # ITEST flows from ref through the source into `out`.
    taken = spice.reserved_names(net)
    itest = spice.fresh_name(taken, "ITEST__")
    deck = spice.render(net, None, [f"{itest} {ref} {out} DC 0 AC 1"], taken=taken) + "\n".join(control(lines)) + "\n"
    v = run_deck(deck, keep, name + ".zout")
    return [cval(f, complex(v[f"zk{k}"])) for k, f in enumerate(freqs)]


def zin_differential(net: spice.Netlist, side: dict, keep: Path | None, name: str) -> list[dict]:
    """Impedance between the two inputs' + nodes with both sources open."""
    inp, neg = net.element(side["input"]), net.element(side["inputNeg"])
    p1, p2 = inp.nodes[0], neg.nodes[0]
    freqs = side.get("freqs", [])
    lines = []
    for k, f in enumerate(freqs):
        lines.append(f"ac lin 1 {f!r} {f!r}")
        lines.append(f"let zk{k} = {spice.vexpr(p1, p2)}")
        lines.append(f"print zk{k}")
    taken = spice.reserved_names(net)
    izin = spice.fresh_name(taken, "IZIN__")
    deck = spice.render(net, None, [f"{izin} {p2} {p1} DC 0 AC 1"], ac={},
                        open_sources=(inp.name, neg.name), taken=taken) + "\n".join(control(lines)) + "\n"
    v = run_deck(deck, keep, name + ".zin")
    out = []
    for k, f in enumerate(freqs):
        z = complex(v[f"zk{k}"])
        # A port the circuit leaves open reads as the two opening inductors in
        # series (2·jωL): that is an infinite impedance, not a measurement.
        z_open = 2 * 2 * math.pi * f * float(spice.OPEN_L)
        out.append(cval(f, None if abs(z) > 1e-3 * z_open else z))
    return out


def noise_input(net: spice.Netlist, side: dict) -> tuple[str, str]:
    """(netlist text, input source name) for .noise. A two-source input
    (inputNeg) becomes one new source VNIN__ (AC 1) driving both through
    noiseless controlled sources with the solver's weights: ±1/2 in
    differential mode, +1 each in common mode, so ngspice's input-referred
    noise divides by the same gain. A V input gets a VCVS in series, an I
    input a VCCS in parallel (same direction). Every synthetic node and
    element name avoids the netlist's own (spice.fresh_name)."""
    neg = side.get("inputNeg")
    if not neg:
        return spice.render(net, side["input"]), side["input"]
    pos, neg = side["input"].lower(), neg.lower()
    differential = (side.get("mode") or "differential") == "differential"
    weight = {pos: 0.5, neg: -0.5} if differential else {pos: 1.0, neg: 1.0}
    taken = spice.reserved_names(net)
    src, nin = spice.fresh_name(taken, "VNIN__"), spice.fresh_name(taken, "nin__")
    lines = [net.title, f"{src} {nin} 0 DC 0 AC 1"]
    for e in net.elements:
        w = weight.get(e.name)
        if e.kind not in "vi":
            lines.append(" ".join(e.tokens))
        elif w is None:
            lines.append(spice.source_line(e, None))
        elif e.kind == "v":
            mid = spice.fresh_name(taken, f"{e.name}__in")
            lines.append(f"{e.tokens[0]} {e.tokens[1]} {mid} DC {spice.source_dc(e)}")
            lines.append(f"{spice.fresh_name(taken, f'E__{e.name}')} {mid} {e.tokens[2]} {nin} 0 {w!r}")
        else:
            lines.append(spice.source_line(e, None))
            lines.append(f"{spice.fresh_name(taken, f'G__{e.name}')} {e.tokens[1]} {e.tokens[2]} {nin} 0 {w!r}")
    lines += net.model_lines + net.other_lines
    return "\n".join(lines) + "\n", src


# The noise sources ngspice-47 names per element kind in `set noisedetail`
# (onoise_<element>_<source>).
NOISE_SOURCES = {"r": ("thermal", "1overf"), "m": ("id", "1overf", "rd", "rs"),
                 "q": ("ic", "ib", "1overf", "rb", "rc", "re"), "d": ("id", "rs", "1overf", "idsw", "rsw", "1overfsw")}


def noise_name_clashes(net: spice.Netlist) -> list[str]:
    """Elements named like another element's noise source: onoise_r1_thermal
    is both R1's thermal noise and R1_thermal's total, so neither can be
    told apart."""
    names = {e.name for e in net.elements}
    return [f"{e.name}_{s} (element) and {e.name}'s {s} noise"
            for e in net.elements for s in NOISE_SOURCES.get(e.kind, ()) if f"{e.name}_{s}" in names]


def split_contributor(body: str, names: list[str]) -> tuple[str, str]:
    """(element, source) of onoise_<body>; element names may contain
    underscores, so the longest element name that prefixes the body wins."""
    for n in sorted(names, key=len, reverse=True):
        if body == n:
            return n, "total"
        if body.startswith(n + "_"):
            return n, body[len(n) + 1:]
    elem, _, source = body.partition("_")
    return elem, source or "total"


def noise(net: spice.Netlist, side: dict, keep: Path | None, name: str) -> dict:
    """ngspice .noise at the sidecar's noise frequencies (default: freqs).

    ngspice prints spectral *densities* (V/√Hz, or A/√Hz input-referred for an
    I-source input); they are squared here, so every value is a power spectral
    density in V²/Hz (A²/Hz). With inputNeg the input is the pair (see
    noise_input). `set noisedetail` adds one vector per element
    (onoise_<element>) and per noise source of it (onoise_<element>_<source>:
    NOISE_SOURCES), each the output-referred density that source alone
    produces. Element names that make those vectors ambiguous are rejected
    (noise_name_clashes).
    """
    spec = side["noise"] if isinstance(side.get("noise"), dict) else {}
    freqs = spec.get("freqs") or side.get("freqs", [])
    out, ref = side["output"], side.get("ref")
    if clashes := noise_name_clashes(net):
        raise NgspiceError(f"{name}: ngspice gives these the same noise vector, rename one: {'; '.join(clashes)}")
    netlist, src = noise_input(net, side)
    vout = f"v({out},{ref})" if ref else f"v({out})"
    lines = ["set noisedetail"]
    for k, f in enumerate(freqs):
        lines += [f"echo @@noise {k}", f"noise {vout} {src} lin 1 {f!r} {f!r} 1", "print all", f"echo @@end {k}"]
    deck = netlist + "\n".join(control(lines)) + "\n"
    names = [e.name for e in net.elements]
    text = run_deck_text(deck, keep, name + ".noise")
    output, inputs, contrib = [], [], {}
    for k, f in enumerate(freqs):
        block = text.split(f"@@noise {k}", 1)[1].split(f"@@end {k}", 1)[0]
        vals = parse_values(block)
        output.append({"f": f, "v2": float(vals["onoise_spectrum"]) ** 2})
        inputs.append({"f": f, "v2": float(vals["inoise_spectrum"]) ** 2})
        for key, v in vals.items():
            if not key.startswith("onoise_") or key == "onoise_spectrum":
                continue
            elem, source = split_contributor(key[len("onoise_"):], names)
            kind = elem[:1]
            if elem in names and source != "total" and source not in NOISE_SOURCES.get(kind, ()):
                raise NgspiceError(f"{name}: unknown ngspice noise source {key}")
            contrib.setdefault((elem, source), []).append({"f": f, "v2": float(v) ** 2})
    result = {
        "units": "V^2/Hz (input: V^2/Hz for a V-source input, A^2/Hz for an I source)",
        "output": output,
        "input": inputs,
        "contributors": [{"element": e, "source": s_, "values": vals_} for (e, s_), vals_ in sorted(contrib.items())],
    }
    if spec.get("band"):
        result["integrated"] = noise_band(net, side, spec["band"], keep, name)
    return result


def noise_band(net: spice.Netlist, side: dict, band: list[float], keep: Path | None, name: str) -> dict:
    """∫ PSD df over band, from ngspice's own spectrum (NOT ngspice's
    onoise_total/inoise_total, which are percent-level inaccurate): log-spaced
    sweeps at 100 and 200 points/decade, trapezoid in ln f, Richardson-
    extrapolated (error ∝ h²). The oracle's reference is the adaptive 60-digit
    quadrature of the independently rebuilt PSD (noise_indep.integrated),
    filled in by process(); both must agree."""
    out, ref = side["output"], side.get("ref")
    netlist, src = noise_input(net, side)
    vout = f"v({out},{ref})" if ref else f"v({out})"
    f_low, f_high = band

    def sweep(ppd: int) -> tuple[float, float]:
        # The swept run leaves the integrated plot (noise2) current; the
        # spectrum is noise1 (one sweep per deck).
        lines = [f"noise {vout} {src} dec {ppd} {f_low!r} {f_high!r}", "setplot noise1",
                 "print onoise_spectrum inoise_spectrum"]
        deck = netlist + "\n".join(control(lines)) + "\n"
        text = run_deck_text(deck, keep, f"{name}.band{ppd}")
        rows = [tuple(float(x) for x in m.groups()) for m in
                re.finditer(r"^\d+\s+(\S+)\s+(\S+)\s+(\S+)\s*$", text, re.M)]
        def trap(col):
            tot = 0.0
            for (f0, *a0), (f1, *a1) in zip(rows, rows[1:]):
                y0, y1 = a0[col] ** 2 * f0, a1[col] ** 2 * f1  # S·f, integrated over ln f
                tot += 0.5 * (y0 + y1) * math.log(f1 / f0)
            return tot
        return trap(0), trap(1)

    o1, i1 = sweep(100)
    o2, i2 = sweep(200)
    return {"fLow": f_low, "fHigh": f_high,
            "ngspice_trapezoid": {"outputV2": o2 + (o2 - o1) / 3, "inputV2": i2 + (i2 - i1) / 3,
                                  "richardson_correction": abs(o2 - o1) / 3 / o2}}


# Integrated noise: the independent 60-digit quadrature must agree with the
# Richardson-extrapolated trapezoid of ngspice's spectrum (~1e-10 measured on
# the corpus) before it is written as the reference.
AGREEMENT_RTOL = 1e-6


def cval(f: float, z: complex | None) -> dict:
    if z is None or not (math.isfinite(z.real) and math.isfinite(z.imag)):
        return {"f": f, "re": None, "im": None, "inf": True}
    return {"f": f, "re": z.real, "im": z.imag}


def process(cir: Path, out_dir: Path, keep: Path | None) -> dict:
    side = json.loads(cir.with_suffix(".json").read_text())
    net = spice.parse(cir.read_text())
    name = cir.stem
    op, gain, zin = op_and_ac(net, side, keep, name)
    result = {
        "name": name,
        "netlist": cir.name,
        "input": side["input"],
        "output": side["output"],
        "ref": side.get("ref"),
        "freqs": side.get("freqs", []),
        "generator": {"tool": "ngspice", "version": ngspice_version(), "options": current_options()},
        "op": op,
        "gain": {"values": gain},
    }
    for k in ("inputNeg", "mode", "match"):
        if side.get(k):
            result[k] = side[k]
    if side.get("rin"):
        if side.get("inputNeg") and (side.get("mode") or "differential") == "differential":
            zin = zin_differential(net, side, keep, name)
        result["rin"] = {"values": zin}
    if side.get("rout"):
        result["rout"] = {"values": zout(net, side, keep, name)}
    if side.get("noise"):
        result["noise"] = noise(net, side, keep, name)
        if "integrated" in result["noise"]:
            import noise_indep  # noqa: PLC0415 - noise_indep imports this module
            band = result["noise"]["integrated"]
            exact = noise_indep.integrated(cir, result, band["fLow"], band["fHigh"])
            band.update({"outputV2": exact["outputV2"], "inputV2": exact["inputV2"],
                         "outputRms": math.sqrt(exact["outputV2"]), "inputRms": math.sqrt(exact["inputV2"]),
                         "method": "adaptive quadrature of the 60-digit independent PSD"})
            tr = band["ngspice_trapezoid"]
            band["agreement"] = max(abs(tr["outputV2"] - exact["outputV2"]) / exact["outputV2"],
                                    abs(tr["inputV2"] - exact["inputV2"]) / exact["inputV2"])
            # The independent quadrature becomes the reference only if
            # ngspice's own spectrum confirms it.
            if not band["agreement"] <= AGREEMENT_RTOL:
                raise NgspiceError(f"{name}: band integral disagrees with ngspice's spectrum by "
                                   f"{band['agreement']:.1e} (limit {AGREEMENT_RTOL:g})")
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"{name}.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", type=Path, default=HERE / "corpus")
    ap.add_argument("--out", type=Path, default=HERE / "expected")
    ap.add_argument("--keep", type=Path, help="write generated ngspice decks and logs here")
    ap.add_argument("names", nargs="*")
    args = ap.parse_args()
    cirs = sorted(args.corpus.glob("*.cir"))
    if args.names:
        cirs = [c for c in cirs if c.stem in args.names]
    failed = 0
    for cir in cirs:
        try:
            r = process(cir, args.out, args.keep)
            regions = ", ".join(f"{k}:{d.get('region', d['type'])}" for k, d in r["op"]["devices"].items())
            g0 = r["gain"]["values"][0] if r["gain"]["values"] else None
            gs = f"gain@{g0['f']:g}={complex(g0['re'], g0['im']):.6g}" if g0 and g0.get("re") is not None else ""
            print(f"ok    {cir.stem:28s} {gs}  {regions}")
        except (NgspiceError, KeyError, ValueError) as exc:
            failed += 1
            print(f"FAIL  {cir.stem:28s} {exc}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
