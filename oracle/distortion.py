"""Weakly nonlinear (distortion) reference from ngspice.

Sidecar: "distortion": {"amplitudes": [1e-3, 2e-3, 5e-3, 1e-2], "freq": 1000,
"amplitude": 1e-3 (the one the solver is asked about), "periods": 10,
"points_per_period": 4000}. The input must be a V source with a DC value.

For v_in = V0 + A·cos(ωt) the output's cosine series is
    c1 = a1·A + (3/4)·a3·A³ + …,  c2 = (1/2)·a2·A² + …,  c3 = (1/4)·a3·A³ + …
where v_out = a1·v + a2·v² + a3·v³ + … around the bias. Three ngspice methods:

  harmonic   quasi-static harmonic balance: N=64 DC solutions at
             V0 + A·cos(2πk/N), then a DFT. No time integration, no
             interpolation: exact harmonics of the static transfer curve to
             ngspice's reltol (1e-9). Primary reference.
  transient  .tran with SIN(V0 A f), DFT over the last whole periods of a
             fixed-step waveform. Confirms the quasi-static assumption at f
             (capacitors) and is the textbook HD measurement.
  taylor     least-squares polynomial (degree 7) of a dense DC sweep
             V0 ± 20 mV: a1, a2, a3 directly.
  disto      ngspice's .disto (Volterra series) with a unit DISTOF1: the
             small-signal a2 = 2·H2, a3 = 4·H3 at f (complex), and a1 = AC gain.
             Exact for level-1 MOS without body effect, BJTs and diodes; wrong
             by several % in a2, a3 when a MOSFET has GAMMA > 0 ("valid": false).

The reference coefficients are .disto's where it is valid (uncertainty: the
gap to the DC-Taylor fit), else the DC-Taylor ones (span 20 mV / max(1, |a1|),
uncertainty: the change when the span halves). Harmonic balance and the
transient confirm them.

a1, a2, a3 come from fitting c1/A, c2/A², c3/A³ as polynomials in A² (with
an A⁴ term when there are four or more amplitudes) across the amplitudes
(intercept = small-signal limit); the fit residual is reported. Choose
amplitudes small enough that a5 and higher stay below the A⁴ term: for a
high-gain stage that means tens of µV.
HD2 = |c2/c1|, HD3 = |c3/c1| at each amplitude; the small-signal forms are
HD2 ≈ |a2|·A/(2|a1|), HD3 ≈ |a3|·A²/(4|a1|).
"""

from __future__ import annotations

import math
import re
from pathlib import Path

import run_ngspice
import spice

N_HB = 64


def _input(net: spice.Netlist, side: dict) -> tuple[spice.Element, float]:
    e = net.element(side["input"])
    if e.kind != "v":
        raise ValueError("distortion needs a V-source input")
    return e, float(spice.source_dc(e) or 0)


def _vout(side: dict) -> str:
    return spice.vexpr(side["output"], side.get("ref"))


def _cos_series(samples: list[float], periods: int, harmonics: int = 3) -> list[float]:
    """Cosine coefficients c_n (signed, phase-aligned to cos) of n·periods bins."""
    n = len(samples)
    out = []
    for h in range(1, harmonics + 1):
        k = h * periods
        re_ = sum(v * math.cos(2 * math.pi * k * i / n) for i, v in enumerate(samples)) * 2 / n
        im_ = sum(v * math.sin(2 * math.pi * k * i / n) for i, v in enumerate(samples)) * 2 / n
        # Report the in-phase (cos) part with its sign; keep |.| for HD.
        out.append((re_, math.hypot(re_, im_)))
    return out


def harmonic_balance(net, side, amp: float, keep, name: str) -> list[float]:
    e, v0 = _input(net, side)
    lines = []
    for k in range(N_HB):
        val = v0 + amp * math.cos(2 * math.pi * k / N_HB)
        lines += [f"alter {e.name} dc = {val!r}", "op", f"let hb{k} = {_vout(side)}", f"print hb{k}"]
    deck = spice.render(net, None) + "\n".join(run_ngspice.control(lines)) + "\n"
    v = run_ngspice.run_deck(deck, keep, f"{name}.hb")
    samples = [float(v[f"hb{k}"]) for k in range(N_HB)]
    return [c for c, _ in _cos_series(samples, 1)]


def transient(net, side, amp: float, freq: float, periods: int, ppp: int, keep, name: str) -> list[float]:
    """Harmonic magnitudes |c1|, |c2|, |c3| of a SIN(V0 A f) transient,
    from the last 4 whole periods of the waveform resampled (`linearize`) on
    a uniform grid of `ppp` points per period, with the step capped at that
    grid so the interpolation is between solved points only."""
    import subprocess
    import tempfile
    e, v0 = _input(net, side)
    period = 1 / freq
    step = period / ppp
    tok = e.tokens
    body = [f"{tok[0]} {tok[1]} {tok[2]} DC {v0!r} SIN({v0!r} {amp!r} {freq!r})" if l.split()[:1] == [tok[0]] else l
            for l in spice.render(net, None).splitlines()]
    t_from = (periods - 4) * period
    nodes = [n for n in (side["output"], side.get("ref")) if n and n not in spice.GROUND]
    expr = _vout(side)
    control = [run_ngspice.current_options() + " method=gear maxord=2",
               ".control", "set numdgt=15",
               f"tran {step!r} {periods * period!r} {t_from!r} {step!r}",
               "linearize " + " ".join(f"v({n})" for n in nodes),
               f"let tw = {expr}", "wrdata tranout tw", ".endc", ".end"]
    deck = "\n".join([*body, *control]) + "\n"
    with tempfile.TemporaryDirectory() as tmp:
        (Path(tmp) / "d.cir").write_text(deck)
        if keep:
            keep.mkdir(parents=True, exist_ok=True)
            (keep / f"{name}.tran.cir").write_text(deck)
        proc = subprocess.run(["ngspice", "-b", "d.cir"], capture_output=True, text=True, cwd=tmp,
                              timeout=run_ngspice.NGSPICE_TIMEOUT_S * 10)
        out = next((Path(tmp) / n for n in ("tranout", "tranout.data") if (Path(tmp) / n).exists()), None)
        if out is None:
            raise run_ngspice.NgspiceError(f"{name}: transient wrote no data: {(proc.stdout + proc.stderr)[-200:]}")
        rows = [tuple(map(float, l.split()[:2])) for l in out.read_text().splitlines() if l.strip()]
    want = 4 * ppp
    pts = [y for t, y in rows if t >= t_from - step / 2][:want]
    if len(pts) < want:
        raise run_ngspice.NgspiceError(f"{name}: transient grid has {len(pts)} of {want} points")
    return [mag for _, mag in _cos_series(pts, 4)]


def disto(net, side, freq: float, keep, name: str) -> dict:
    """ngspice .disto (Volterra series, small-signal limit) with a unit
    DISTOF1 on the input: the 2nd-harmonic phasor is a2/2, the 3rd a3/4, and
    the AC gain at f is a1 (all complex, so frequency dependence is kept)."""
    e, v0 = _input(net, side)
    tok = e.tokens
    body = [f"{tok[0]} {tok[1]} {tok[2]} DC {v0!r} AC 1 DISTOF1 1" if l.split()[:1] == [tok[0]] else l
            for l in spice.render(net, None).splitlines()]
    expr = _vout(side)
    lines = [f"ac lin 1 {freq!r} {freq!r}", f"let d1 = {expr}", "print d1",
             f"disto lin 1 {freq!r} {freq!r}", "setplot disto1", f"let d2 = {expr}", "print d2",
             "setplot disto2", f"let d3 = {expr}", "print d3"]
    deck = "\n".join(body) + "\n" + "\n".join(run_ngspice.control(lines)) + "\n"
    v = run_ngspice.run_deck(deck, keep, f"{name}.disto")
    a1, h2, h3 = complex(v["d1"]), complex(v["d2"]), complex(v["d3"])
    return {"a1": a1, "a2": 2 * h2, "a3": 4 * h3}


def taylor(net, side, keep, name: str, span: float = 0.02, points: int = 81) -> list[float]:
    e, v0 = _input(net, side)
    lines = [f"dc {e.name} {v0 - span!r} {v0 + span!r} {2 * span / (points - 1)!r}", f"let ty = {_vout(side)}",
             "print ty"]
    deck = spice.render(net, None) + "\n".join(run_ngspice.control(lines)) + "\n"
    text = run_ngspice.run_deck_text(deck, keep, f"{name}.taylor")
    ys = [float(m.group(1)) for m in re.finditer(r"^\d+\s+\S+\s+(\S+)\s*$", text, re.M)]
    xs = [-span + 2 * span * i / (points - 1) for i in range(points)]
    if len(ys) != points:
        raise run_ngspice.NgspiceError(f"{name}: dc sweep printed {len(ys)} of {points} values")
    coef = _polyfit([x / span for x in xs], ys, 7)
    return [coef[1] / span, coef[2] / span**2, coef[3] / span**3]


def _polyfit(xs, ys, deg):
    """Least squares via normal equations on scaled x (|x| <= 1), deg <= 7."""
    n = deg + 1
    A = [[sum(x ** (i + j) for x in xs) for j in range(n)] for i in range(n)]
    b = [sum(y * x**i for x, y in zip(xs, ys)) for i in range(n)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(A[r][c]))
        A[c], A[p], b[c], b[p] = A[p], A[c], b[p], b[c]
        for r in range(c + 1, n):
            f = A[r][c] / A[c][c]
            A[r] = [a - f * ac for a, ac in zip(A[r], A[c])]
            b[r] -= f * b[c]
    x = [0.0] * n
    for r in range(n - 1, -1, -1):
        x[r] = (b[r] - sum(A[r][j] * x[j] for j in range(r + 1, n))) / A[r][r]
    return x


def _fit_limit(amps, values):
    """Fit values(A) = p + q·A² (+ r·A⁴ with four or more amplitudes) by least
    squares; return (p, residual rms / |p|). p is the small-amplitude limit."""
    deg = 2 if len(amps) >= 4 else 1
    xs = [a * a for a in amps]
    scale = max(xs)
    coef = _polyfit([x / scale for x in xs], values, deg)
    fit = lambda x: sum(c * (x / scale) ** i for i, c in enumerate(coef))
    res = math.sqrt(sum((fit(x) - y) ** 2 for x, y in zip(xs, values)) / len(xs))
    p = coef[0]
    return p, res / abs(p) if p else math.inf


def _disto_valid(text: str) -> bool:
    """ngspice-47's .disto is exact for level-1 MOS without body effect, BJTs
    and diodes, but wrong by several % in a2, a3 when any MOSFET has
    GAMMA > 0 (proven against an exact implicit series of the DC equations
    with ngspice's threshold law: oracle/README)."""
    for m in re.finditer(r"^\.model\s+\S+\s+[np]mos\b(.*)$", text, re.I | re.M):
        g = re.search(r"gamma\s*=\s*([-+\d.eE]+)", m.group(1), re.I)
        if g and float(g.group(1)) != 0:
            return False
    return True


def analyze(cir: Path, net: spice.Netlist, side: dict, keep) -> dict:
    spec = side["distortion"]
    amps = spec.get("amplitudes", [1e-3, 2e-3, 5e-3, 1e-2])
    freq = spec.get("freq", 1000.0)
    name = cir.stem
    hb = {a: harmonic_balance(net, side, a, keep, name) for a in amps}
    h1, e1 = _fit_limit(amps, [hb[a][0] / a for a in amps])
    h2, e2 = _fit_limit(amps, [hb[a][1] / a**2 for a in amps])
    h3, e3 = _fit_limit(amps, [hb[a][2] / a**3 for a in amps])
    hb_coef = [h1, 2 * h2, 4 * h3]
    # Reference: DC-sweep Taylor fit with a span that keeps the output swing
    # small for any gain; its uncertainty is the change when the span halves.
    span = 0.02 / max(1.0, abs(h1))
    tay = taylor(net, side, keep, name, span=span)
    tay_half = taylor(net, side, keep, name + ".half", span=span / 2)
    unc = [abs(a - b) for a, b in zip(tay, tay_half)]
    try:
        dis = disto(net, side, freq, keep, name)
        dis_out = {k: {"re": v.real, "im": v.imag} for k, v in dis.items()}
    except (run_ngspice.NgspiceError, KeyError, ValueError) as exc:
        dis_out = {"error": str(exc)[:200]}
    dis_out["valid"] = _disto_valid(cir.read_text())
    tr = {}
    try:
        for a in amps:
            tr[a] = transient(net, side, a, freq, spec.get("periods", 10), spec.get("points_per_period", 4000), keep, name)
    except run_ngspice.NgspiceError as exc:
        tr = {"error": str(exc)}
    points = []
    for a in amps:
        c1, c2, c3 = hb[a]
        row = {"A": a, "c1": c1, "c2": c2, "c3": c3, "hd2": abs(c2 / c1), "hd3": abs(c3 / c1)}
        if a in tr:
            t1, t2, t3 = tr[a]
            row.update({"tran_hd2": t2 / t1, "tran_hd3": t3 / t1})
        points.append(row)
    amp = spec.get("amplitude", amps[0])
    # Frequency-dependent HD from .disto's complex Volterra phasors at each f:
    # the 2f output for a unit DISTOF1 is H2(jω,jω)/2, the 3f output
    # H3(jω,jω,jω)/4, so HD2 = A·|a2|/(2|a1|) and HD3 = A²·|a3|/(4|a1|).
    vs_freq = []
    if dis_out["valid"]:
        for f in spec.get("vsFreq", []):
            d = disto(net, side, f, keep, f"{name}.f{f:g}")
            vs_freq.append({"f": f, "hd2": abs(d["a2"]) * amp / (2 * abs(d["a1"])),
                            "hd3": abs(d["a3"]) * amp**2 / (4 * abs(d["a1"]))})
    if dis_out["valid"] and "a1" in dis_out:
        # Exact Volterra coefficients; their uncertainty is the (tiny) gap to
        # the independent DC-Taylor fit at the full span.
        ref = [dis_out[k]["re"] for k in ("a1", "a2", "a3")]
        unc = [abs(r - t) for r, t in zip(ref, tay)]
        which = "disto"
    else:
        ref, which = tay, "taylor"
    a1, a2, a3 = ref
    return {
        "freq": freq,
        "amplitude": amp,
        "reference": which,
        "coefficients": [{"order": i + 1, "value": v, "uncertainty": u} for i, (v, u) in enumerate(zip(ref, unc))],
        "taylor": [{"order": i + 1, "value": v} for i, v in enumerate(tay)],
        "hd2": {"value": abs(a2) * amp / (2 * abs(a1)), "form": "|a2|·A/(2|a1|)"},
        "hd3": {"value": abs(a3) * amp**2 / (4 * abs(a1)), "form": "|a3|·A²/(4|a1|)"},
        "taylor_span": span,
        "harmonic_balance": {"coefficients": hb_coef, "fit_error": {"a1": e1, "a2": e2, "a3": e3}},
        "disto": dis_out,
        "vsFreq": vs_freq,
        "points": points,
        "transient_error": tr.get("error") if isinstance(tr, dict) and "error" in tr else None,
    }
