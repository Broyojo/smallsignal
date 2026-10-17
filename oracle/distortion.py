"""Weakly nonlinear (distortion) reference from ngspice.

Sidecar: "distortion": {"amplitudes": [1e-3, 2e-3, 5e-3, 1e-2], "freq": 1000,
"amplitude": 1e-3 (the one the solver is asked about), "periods": 10,
"points_per_period": 4000}. The input (and `inputNeg`) must be V sources
with a DC value. With `inputNeg`, v_in is driven as the solver's `mode`:
differential moves the two sources by ±v/2, common by +v each.

For v_in = V0 + A·cos(ωt) the output's cosine series is
    c1 = a1·A + (3/4)·a3·A³ + …,  c2 = (1/2)·a2·A² + …,  c3 = (1/4)·a3·A³ + …
where v_out = a1·v + a2·v² + a3·v³ + … around the bias. Three ngspice methods:

  harmonic   quasi-static harmonic balance: N=64 DC solutions at
             V0 + A·cos(2πk/N), then a DFT. No time integration, no
             interpolation: exact harmonics of the static transfer curve to
             ngspice's reltol (1e-9). Primary reference.
  transient  .tran with SIN(V0 A f), DFT over the last whole periods of a
             fixed-step waveform. Confirms the quasi-static assumption at f
             (capacitors) and is the textbook HD measurement: its HD2, HD3
             must match harmonic balance's within the transient's
             resolution (transient_tolerance), else generation fails. A
             transient that times out or fails to run is recorded in
             transient_error; the amplitudes before it are kept and checked.
  taylor     least-squares polynomial (degree 7) of a dense DC sweep
             V0 ± 20 mV: a1, a2, a3 directly.
  disto      ngspice's .disto (Volterra series) with a unit DISTOF1: the
             small-signal a2 = 2·H2, a3 = 4·H3 at f (complex), and a1 = AC gain.
             Exact for level-1 MOS without body effect, BJTs and diodes; wrong
             by several % in a2, a3 when a MOSFET has GAMMA > 0 ("valid": false).

The reference coefficients are the memoryless (s → 0) ones: .disto's real parts
at f/10 where .disto is valid and they are its DC limit (they move by at most
1e-9 from f to f/10, so the rest of the way, quadratic in f, is ~1e-11, and
they agree with the DC-Taylor fit within 3x its uncertainty; uncertainty: the
gap to that fit), else the DC-Taylor ones (span 20 mV / max(1, |a1|),
uncertainty: the change when the span halves). Harmonic balance and the
transient confirm them: generation fails when either misses (see
harmonic_balance_disagreements, transient_disagreements).

Harmonic balance's a1, a2, a3 come from fitting c1/A, c2/A², c3/A³ as
polynomials in A² (with an A⁴ term when there are four or more amplitudes)
across the amplitudes (intercept = small-signal limit); the fit residual is
reported, and the uncertainty (_fit_limit) covers the samples' measured
resolution and the fit's truncation. The amplitudes must be at least three,
distinct and positive, so the fit has a residual. Choose them small enough
that a5 and higher stay below the A⁴ term: for a high-gain stage that means
tens of µV.

.disto must run (generation fails if it prints nothing or errors), except
inside disto_optional(), where an unavailable .disto is recorded
("unavailable": true), the DC-Taylor fit is the reference and vsFreq is
empty. ngspice-47 built on x86-64 Linux prints no .disto results.
HD2 = |c2/c1|, HD3 = |c3/c1| at each amplitude; the small-signal forms are
HD2 ≈ |a2|·A/(2|a1|), HD3 ≈ |a3|·A²/(4|a1|).
"""

from __future__ import annotations

import contextlib
import contextvars
import math
import re
import subprocess
import tempfile
from pathlib import Path

import run_ngspice
import spice

N_HB = 64
DEFAULT_AMPLITUDES = [1e-3, 2e-3, 5e-3, 1e-2]


_DISTO_OPTIONAL: contextvars.ContextVar[bool] = contextvars.ContextVar("disto_optional", default=False)


@contextlib.contextmanager
def disto_optional():
    """In this thread, analyze() goes on without .disto when it is unavailable."""
    token = _DISTO_OPTIONAL.set(True)
    try:
        yield
    finally:
        _DISTO_OPTIONAL.reset(token)


def amplitudes(spec: dict) -> list[float]:
    return spec.get("amplitudes") or DEFAULT_AMPLITUDES


# The transient's DFT window is its last WINDOW_PERIODS periods, after at
# least one period of settling.
WINDOW_PERIODS = 4
# At 200 points per period the 3rd harmonic still has 3ωh ≤ 0.1 rad per
# step, so transient_tolerance's first-order resampling bound holds.
MIN_POINTS_PER_PERIOD = 200


def _positive(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) and x > 0


def _checked_spec(side: dict, name: str) -> tuple[dict, list[float]]:
    """The distortion sidecar and its amplitudes, or a ValueError naming the
    circuit and the control. amplitudes: at least three, distinct, finite and
    positive (the A² fit has degree 1 or 2 and needs one more point than
    parameters for a residual); amplitude, freq: finite and positive;
    periods: an integer above WINDOW_PERIODS; points_per_period: an integer
    of at least MIN_POINTS_PER_PERIOD; vsFreq: a list of finite positive
    frequencies."""
    spec = side.get("distortion")
    if not isinstance(spec, dict):
        raise ValueError(f"{name}: distortion must be an object, got {spec!r}")

    def bad(key, want):
        return ValueError(f"{name}: distortion.{key} must be {want}, got {spec.get(key)!r}")

    amps = amplitudes(spec)
    if not (isinstance(amps, list) and all(_positive(a) for a in amps) and len(set(amps)) == len(amps)
            and len(amps) >= 3):
        raise bad("amplitudes", "at least 3 distinct positive numbers")
    if not _positive(amplitude(spec)):
        raise bad("amplitude", "a positive number")
    if not _positive(spec.get("freq", 1000.0)):
        raise bad("freq", "a positive frequency")
    periods = spec.get("periods", 10)
    if not (isinstance(periods, int) and not isinstance(periods, bool) and periods > WINDOW_PERIODS):
        raise bad("periods", f"an integer above {WINDOW_PERIODS} (the DFT window plus settling)")
    ppp = spec.get("points_per_period", 4000)
    if not (isinstance(ppp, int) and not isinstance(ppp, bool) and ppp >= MIN_POINTS_PER_PERIOD):
        raise bad("points_per_period", f"an integer of at least {MIN_POINTS_PER_PERIOD}")
    vs = spec.get("vsFreq", [])
    if not (isinstance(vs, list) and all(_positive(f) for f in vs)):
        raise bad("vsFreq", "a list of positive frequencies")
    return spec, amps


def amplitude(spec: dict) -> float:
    """The input amplitude HD2/HD3 are reported at (the solver's --amplitude)."""
    return spec["amplitude"] if spec.get("amplitude") is not None else amplitudes(spec)[0]


def _drive(net: spice.Netlist, side: dict) -> list[tuple[spice.Element, float, float]]:
    """(source, DC value, weight) for each driven source: v_in = v moves each
    source by weight·v. With inputNeg, the differential mode is ±1/2 and the
    common mode 1, 1, as the solver's."""
    weights = [(side["input"], 1.0)]
    if side.get("inputNeg"):
        if (side.get("mode") or "differential") == "differential":
            weights = [(side["input"], 0.5), (side["inputNeg"], -0.5)]
        else:
            weights = [(side["input"], 1.0), (side["inputNeg"], 1.0)]
    out = []
    for name, w in weights:
        e = net.element(name)
        if e.kind != "v":
            raise ValueError("distortion needs V-source inputs")
        out.append((e, spice.value(spice.source_dc(e) or "0"), w))
    return out


def _with_sources(net: spice.Netlist, side: dict, spec) -> str:
    """The netlist with each driven source's line from spec(source, DC, weight)."""
    lines = {e.tokens[0]: spec(e, v0, w) for e, v0, w in _drive(net, side)}
    return "\n".join(lines.get(l.split()[0], l) if l.split() else l for l in spice.render(net, None).splitlines())


def _dc_points(net, side, offsets: list[float], keep, tag: str) -> list[float]:
    """v_out at v_in = offsets[k] (each an .op with the sources altered)."""
    drive = _drive(net, side)
    lines = []
    for k, x in enumerate(offsets):
        lines += [f"alter {e.name} dc = {v0 + w * x!r}" for e, v0, w in drive]
        lines += ["op", f"let p{k} = {_vout(side)}", f"print p{k}"]
    deck = spice.render(net, None) + "\n".join(run_ngspice.control(lines)) + "\n"
    v = run_ngspice.run_deck(deck, keep, tag)
    return [float(v[f"p{k}"]) for k in range(len(offsets))]


def _vout(side: dict) -> str:
    return spice.vexpr(side["output"], side.get("ref"))


def _out_nodes(side: dict) -> list[str]:
    return [n for n in (side["output"], side.get("ref")) if n and n not in spice.GROUND]


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


def harmonic_balance(net, side, amp: float, keep, name: str) -> tuple[list[float], float]:
    """Cosine coefficients c1, c2, c3 at amplitude `amp`, and the samples'
    measured resolution: samples k and N−k sit at the same offset but are
    solved after neighbours on opposite sides, so their spread is the solve
    error that shows; it is floored at the printed step (15 digits) of the
    largest |v_out|. Each c_n (a DFT with weights 2/N) is within twice it."""
    offsets = [amp * math.cos(2 * math.pi * k / N_HB) for k in range(N_HB)]
    samples = _dc_points(net, side, offsets, keep, f"{name}.hb")
    spread = max(abs(samples[k] - samples[N_HB - k]) for k in range(1, N_HB // 2))
    big = max(abs(v) for v in samples)
    printed = 10.0 ** (math.floor(math.log10(big)) - 14) if big else 0.0
    return [c for c, _ in _cos_series(samples, 1)], max(spread, printed)


def _tolerances() -> tuple[float, float]:
    """(reltol, vntol) of the run options."""
    opts = run_ngspice.current_options()
    return tuple(float(re.search(rf"\b{k}\s*=\s*([-+\d.eE]+)", opts).group(1)) for k in ("reltol", "vntol"))


def transient(net, side, amp: float, freq: float, periods: int, ppp: int, keep,
              name: str) -> tuple[list[float], float]:
    """Harmonic magnitudes |c1|, |c2|, |c3| of a SIN(V0 A f) transient,
    from the last 4 whole periods of the waveform resampled (`linearize`) on
    a uniform grid of `ppp` points per period, with the step capped at that
    grid so the interpolation is between solved points only; and the solve
    tolerance of v_out over that window, max over t of reltol·Σ|v(node)| +
    vntol per node (each node converges to reltol·|v| + vntol)."""
    period = 1 / freq
    step = period / ppp
    body = _with_sources(net, side, lambda e, v0, w: f"{e.tokens[0]} {e.tokens[1]} {e.tokens[2]} DC {v0!r} "
                         f"SIN({v0!r} {w * amp!r} {freq!r})").splitlines()
    t_from = (periods - WINDOW_PERIODS) * period
    nodes = _out_nodes(side)
    expr = _vout(side)
    control = [run_ngspice.current_options() + " method=gear maxord=2",
               ".control", "set numdgt=15",
               f"tran {step!r} {periods * period!r} {t_from!r} {step!r}",
               "linearize " + " ".join(f"v({n})" for n in nodes),
               f"let tw = {expr}", *(f"let n{i} = v({n})" for i, n in enumerate(nodes)),
               "set wr_singlescale", "wrdata tranout tw " + " ".join(f"n{i}" for i in range(len(nodes))),
               ".endc", ".end"]
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
        rows = [list(map(float, l.split())) for l in out.read_text().splitlines() if l.strip()]
    want = WINDOW_PERIODS * ppp
    window = [r for r in rows if r[0] >= t_from - step / 2][:want]
    if len(window) < want:
        raise run_ngspice.NgspiceError(f"{name}: transient grid has {len(window)} of {want} points")
    reltol, vntol = _tolerances()
    solve = max(reltol * sum(abs(v) for v in r[2:]) + vntol * len(nodes) for r in window)
    return [mag for _, mag in _cos_series([r[1] for r in window], WINDOW_PERIODS)], solve


def transient_tolerance(n: int, hd: float, c1: float, solve: float, ppp: int) -> float:
    """How far the transient's HD_n may sit from harmonic balance's (hd, c1)
    with a quasi-static circuit. Two parts:
      - linearize: the grid sample between two timepoints at most h = T/ppp
        apart is off by up to (h²/8)·|v''|, which scales harmonic k by up to
        1 + (kωh)²/8, so HD_n moves by up to (n²−1)(2π/ppp)²/8 relative;
        doubled for timepoints that drift against the grid.
      - the solves: every sample of either waveform is within `solve` of the
        exact v_out, so each c_k (a DFT with weights 2/N) is within 2·solve,
        and the two waveforms' HD_n differ by up to 4·solve·(1 + HD_n)/|c1|.
    A circuit with memory at f (f not far below its poles) misses it by
    orders of magnitude."""
    return (n * n - 1) * (2 * math.pi / ppp) ** 2 / 4 * hd + 4 * solve * (1 + hd) / abs(c1)


def transient_magnitude_tolerance(n: int, cn: float, solve: float, ppp: int) -> float:
    """How far the transient's |c_n| may sit from harmonic balance's, for a
    point whose fundamental is 0 (no HD to compare): linearize scales
    harmonic n by up to 1 + (nωh)²/8 (doubled, as transient_tolerance), and
    the two waveforms' c_n differ by up to 4·solve."""
    return n * n * (2 * math.pi / ppp) ** 2 / 4 * abs(cn) + 4 * solve


def transient_disagreements(d: dict) -> list[str]:
    """Each transient result that misses harmonic balance's by more than its
    tolerance: HD2, HD3, or |c1..c3| where the fundamental is 0 (d as
    analyze writes it). A point without one is a disagreement too, unless
    its amplitude is in the recorded `transient_failed` list."""
    points = d["points"]
    failed = set(d.get("transient_failed") or []) if d.get("transient_error") is not None else set()
    out = []
    for p in points:
        if p["A"] in failed:
            continue
        keys = ("hd2", "hd3") if p["hd2"] is not None else ("c1", "c2", "c3")
        for h in keys:
            t, tol = p.get(f"tran_{h}"), p.get(f"tran_tol_{h}")
            w = p[h] if h.startswith("hd") else abs(p[h])
            if t is None:
                out.append(f"transient {h} at A={p['A']:g}: missing (no recorded transient failure covers it)")
            elif not (tol is not None and abs(t - w) <= tol):
                out.append(f"transient {h} at A={p['A']:g}: {t:.8e} vs harmonic balance {w:.8e} "
                           f"(diff {abs(t - w):.1e}, tolerance {tol if tol is None else f'{tol:.1e}'})")
    return out


def zero_orders(d: dict) -> list[bool]:
    """Which reference a_n are 0: within 3x the reference's plus harmonic
    balance's uncertainty (the latter is the measured DC resolution, so an
    exact zero has a floor). d as analyze writes it."""
    hb_unc = d["harmonic_balance"].get("uncertainty") or [0.0] * 3
    return [abs(c["value"]) <= 3 * (c["uncertainty"] + u) for c, u in zip(d["coefficients"], hb_unc)]


def _hd(n: int, an: float, a1: float, amp: float, zero: list[bool]) -> dict:
    """HD_n = |a_n|·A^(n-1)/(2^(n-1)|a1|), as the solver reports it: infinite
    when a1 is 0 and a_n is not, unavailable (0/0) when both are."""
    form = "|a2|·A/(2|a1|)" if n == 2 else "|a3|·A²/(4|a1|)"
    if not zero[0]:
        return {"value": abs(an) * amp ** (n - 1) / (2 ** (n - 1) * abs(a1)), "form": form}
    if not zero[n - 1]:
        return {"value": None, "form": form, "infinite": True}
    return {"value": None, "form": form, "unavailable": f"0/0: a1 and a{n} are 0"}


def disto(net, side, freq: float, keep, name: str) -> dict:
    """ngspice .disto (Volterra series, small-signal limit) with a unit
    DISTOF1 on the input: the 2nd-harmonic phasor is a2/2, the 3rd a3/4, and
    the AC gain at f is a1 (all complex, so frequency dependence is kept)."""
    def line(e, v0, w):
        mag, phase = abs(w), "180" if w < 0 else "0"
        return f"{e.tokens[0]} {e.tokens[1]} {e.tokens[2]} DC {v0!r} AC {mag!r} {phase} DISTOF1 {mag!r} {phase}"

    body = _with_sources(net, side, line).splitlines()
    expr = _vout(side)
    lines = [f"ac lin 1 {freq!r} {freq!r}", f"let d1 = {expr}", "print d1",
             f"disto lin 1 {freq!r} {freq!r}", "setplot disto1", f"let d2 = {expr}", "print d2",
             "setplot disto2", f"let d3 = {expr}", "print d3"]
    deck = "\n".join(body) + "\n" + "\n".join(run_ngspice.control(lines)) + "\n"
    v = run_ngspice.run_deck(deck, keep, f"{name}.disto")
    a1, h2, h3 = complex(v["d1"]), complex(v["d2"]), complex(v["d3"])
    return {"a1": a1, "a2": 2 * h2, "a3": 4 * h3}


def taylor(net, side, keep, name: str, span: float = 0.02, points: int = 81) -> list[float]:
    xs = [-span + 2 * span * i / (points - 1) for i in range(points)]
    drive = _drive(net, side)
    if len(drive) > 1:
        # Two sources move together: one .op per point.
        ys = _dc_points(net, side, xs, keep, f"{name}.taylor")
    else:
        e, v0, _ = drive[0]
        lines = [f"dc {e.name} {v0 - span!r} {v0 + span!r} {2 * span / (points - 1)!r}", f"let ty = {_vout(side)}",
                 "print ty"]
        deck = spice.render(net, None) + "\n".join(run_ngspice.control(lines)) + "\n"
        text = run_ngspice.run_deck_text(deck, keep, f"{name}.taylor")
        ys = [float(m.group(1)) for m in re.finditer(r"^\d+\s+\S+\s+(\S+)\s*$", text, re.M)]
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


def _fit_limit(amps, values, errs):
    """Fit values(A) = p + q·A² (+ r·A⁴ with four or more amplitudes) by least
    squares; return (p, residual rms / |p|, uncertainty of p). p is the
    small-amplitude limit and a linear map Σ w_i·values_i, so:
      - values within errs_i move it by up to Σ|w_i|·errs_i;
      - the first term the fit leaves out, κ·A^(2·deg+2), shifts p by κ·b and
        leaves residuals κ·r_i (b, r_i: the fit of that term's shape); the
        largest residual measures κ, so its shift is max|res|·|b|/max|r_i|.
    The uncertainty is the sum."""
    deg = 2 if len(amps) >= 4 else 1
    xs = [a * a for a in amps]
    scale = max(xs)
    us = [x / scale for x in xs]
    coef = _polyfit(us, values, deg)
    poly = lambda c, u: sum(ci * u**i for i, ci in enumerate(c))
    res = [abs(poly(coef, u) - y) for u, y in zip(us, values)]
    rms = math.sqrt(sum(r * r for r in res) / len(res))
    weights = [_polyfit(us, [float(i == j) for j in range(len(us))], deg)[0] for i in range(len(us))]
    nxt = [u ** (deg + 1) for u in us]
    b = _polyfit(us, nxt, deg)
    shape = max(abs(poly(b, u) - y) for u, y in zip(us, nxt))
    unc = sum(abs(w) * e for w, e in zip(weights, errs)) + max(res) * abs(b[0]) / shape
    p = coef[0]
    return p, rms / abs(p) if p else math.inf, unc


def harmonic_balance_disagreements(d: dict) -> list[str]:
    """Each harmonic-balance coefficient that misses the reference's by more
    than 3x their uncertainties (and 1e-12·|a1| for exact zeros); d as
    analyze writes it."""
    hb = d["harmonic_balance"]
    unc = hb.get("uncertainty") or [None] * 3
    floor = 1e-12 * abs(d["coefficients"][0]["value"])
    out = []
    for c, x, u in zip(d["coefficients"], hb["coefficients"], unc):
        lim = None if u is None else 3 * (u + c["uncertainty"]) + floor
        if not (lim is not None and abs(x - c["value"]) <= lim):
            out.append(f"harmonic balance a{c['order']} {x:.10e} vs {d['reference']} {c['value']:.10e} "
                       f"(diff {abs(x - c['value']):.1e}, limit {lim if lim is None else f'{lim:.1e}'})")
    return out


def _disto_valid(net: spice.Netlist) -> bool:
    """ngspice-47's .disto is exact for level-1 MOS without body effect, BJTs
    and diodes, but wrong by several % in a2, a3 when any MOSFET has
    GAMMA > 0 (proven against an exact implicit series of the DC equations
    with ngspice's threshold law: oracle/README). Reads the parser's joined
    model lines, so `+` continuations count."""
    for line in net.model_lines:
        m = re.match(r"\.model\s+\S+\s+[np]mos\b(.*)$", line, re.I)
        g = m and re.search(r"\bgamma\s*=\s*([-+\d.eE]+)", m.group(1), re.I)
        if g and float(g.group(1)) != 0:
            return False
    return True


def _disto_dc(net, side, freq: float, at_f: dict, tay: list[float], tay_unc: list[float], keep,
              name: str) -> tuple[list[float] | None, dict]:
    """.disto's a1..a3 in the DC limit (real parts at f/10), or None with the
    reason: they must move by at most 1e-9 between f and f/10 (the rest of
    the way to f = 0 is quadratic in f: ~1e-11), and agree with the DC-Taylor
    fit within 3x its uncertainty (a pole below f/10 would pass the first)."""
    low = disto(net, side, freq / 10, keep, f"{name}.dc")
    keys = ("a1", "a2", "a3")
    # A coefficient that is 0 (a1 too, at a symmetric node) has no relative
    # change: below 3x its Taylor uncertainty the change is measured
    # against that.
    floor = 1e-12 * abs(low["a1"])
    change = max(_ratio(abs(at_f[k].real - low[k].real), max(abs(low[k].real), floor, 3 * u))
                 for k, u in zip(keys, tay_unc))
    ref = [low[k].real for k in keys]
    gap = max(_ratio(abs(r - t), 3 * u + 1e-12 * abs(r) + floor) for r, t, u in zip(ref, tay, tay_unc))
    info = {"f": freq / 10, "change": change, "taylor_gap": gap}
    if change > 1e-9:
        return None, {**info, "error": "not quasi-static at f"}
    if gap > 1:
        return None, {**info, "error": "disagrees with the DC-Taylor fit"}
    return ref, info


def _ratio(x: float, scale: float) -> float:
    """x / scale, with 0/0 = 0."""
    return x / scale if scale else (0.0 if x == 0 else math.inf)


def analyze(cir: Path, net: spice.Netlist, side: dict, keep) -> dict:
    name = cir.stem
    spec, amps = _checked_spec(side, name)
    freq = spec.get("freq", 1000.0)
    hb = {a: harmonic_balance(net, side, a, keep, name) for a in amps}
    # a_n = 2^(n-1)·lim c_n/A^n; each c_n is within twice the samples'
    # resolution.
    fits = [_fit_limit(amps, [hb[a][0][n - 1] / a**n for a in amps], [2 * hb[a][1] / a**n for a in amps])
            for n in (1, 2, 3)]
    hb_coef = [2 ** n * p for n, (p, _, _) in enumerate(fits)]
    hb_unc = [2 ** n * u for n, (_, _, u) in enumerate(fits)]
    e1, e2, e3 = (e for _, e, _ in fits)
    h1 = hb_coef[0]
    # Reference: DC-sweep Taylor fit with a span that keeps the output swing
    # small for any gain; its uncertainty is the change when the span halves.
    span = 0.02 / max(1.0, abs(h1))
    tay = taylor(net, side, keep, name, span=span)
    tay_half = taylor(net, side, keep, name + ".half", span=span / 2)
    unc = tay_unc = [abs(a - b) for a, b in zip(tay, tay_half)]
    dis_dc = None
    try:
        dis = disto(net, side, freq, keep, name)
        dis_out = {k: {"re": v.real, "im": v.imag} for k, v in dis.items()}
        dis_out["valid"] = _disto_valid(net)
        if dis_out["valid"]:
            dis_dc, dis_out["dc_limit"] = _disto_dc(net, side, freq, dis, tay, unc, keep, name)
    except (run_ngspice.NgspiceError, KeyError, ValueError) as exc:
        dis_out = _disto_unavailable(name, exc, net)
    tr = {}
    tr_errors, tr_failed = [], []
    ppp = spec.get("points_per_period", 4000)
    for a in amps:
        # Each amplitude on its own: a failure is recorded for that amplitude
        # only, and the others still run.
        try:
            tr[a] = transient(net, side, a, freq, spec.get("periods", 10), ppp, keep, name)
        except (run_ngspice.NgspiceError, subprocess.TimeoutExpired) as exc:
            tr_errors.append(f"A={a:g}: {exc}"[:200])
            tr_failed.append(a)
    tr_error = "; ".join(tr_errors) or None
    points = []
    for a in amps:
        (c1, c2, c3), res = hb[a]
        # A fundamental within 3x its resolution (each c_n is within 2·res)
        # is 0: no HD at this amplitude, the transient is compared by |c_n|.
        c1_zero = abs(c1) <= 3 * 2 * res
        row = {"A": a, "c1": c1, "c2": c2, "c3": c3,
               "hd2": None if c1_zero else abs(c2 / c1), "hd3": None if c1_zero else abs(c3 / c1)}
        if a in tr:
            mags, solve = tr[a]
            if c1_zero:
                for n, (t, c) in enumerate(zip(mags, (c1, c2, c3)), 1):
                    row.update({f"tran_c{n}": t, f"tran_tol_c{n}": transient_magnitude_tolerance(n, c, solve, ppp)})
            else:
                t1, t2, t3 = mags
                row.update({"tran_hd2": t2 / t1, "tran_hd3": t3 / t1,
                            "tran_tol_hd2": transient_tolerance(2, row["hd2"], c1, solve, ppp),
                            "tran_tol_hd3": transient_tolerance(3, row["hd3"], c1, solve, ppp)})
        points.append(row)
    # A transient that ran must confirm harmonic balance (the quasi-static
    # assumption at f); only one that timed out or failed is optional.
    # ValueError: run_ngspice's main() catches it whether or not it runs as
    # __main__ (its NgspiceError is then a different class).
    tr_record = {"points": points, "transient_error": tr_error, "transient_failed": tr_failed}
    if bad := transient_disagreements(tr_record):
        raise ValueError(f"{name}: not quasi-static at {freq:g} Hz: " + "; ".join(bad[:2])
                         + (f" (+{len(bad) - 2} more)" if len(bad) > 2 else ""))
    amp = amplitude(spec)
    if dis_dc is not None:
        # Exact Volterra coefficients at their DC limit; their uncertainty is
        # the (tiny) gap to the independent DC-Taylor fit at the full span.
        ref = dis_dc
        unc = [abs(r - t) for r, t in zip(ref, tay)]
        which = "disto"
    else:
        ref, which = tay, "taylor"
    a1, a2, a3 = ref
    floors = [3 * (u + h) for u, h in zip(unc, hb_unc)]
    zero = zero_orders({"coefficients": [{"value": v, "uncertainty": u} for v, u in zip(ref, unc)],
                        "harmonic_balance": {"uncertainty": hb_unc}})
    # Frequency-dependent HD from .disto's complex Volterra phasors at each f:
    # the 2f output for a unit DISTOF1 is H2(jω,jω)/2, the 3f output
    # H3(jω,jω,jω)/4, so HD2 = A·|a2|/(2|a1|) and HD3 = A²·|a3|/(4|a1|). An
    # H_n within the static a_n's zero floor is 0: H1 = 0 makes HD_n null,
    # marked infinite (hd2Infinite, hd3Infinite) unless H_n is 0 too.
    vs_freq = []
    if dis_out["valid"] and not dis_out.get("unavailable"):
        try:
            for f in spec.get("vsFreq", []):
                d = disto(net, side, f, keep, f"{name}.f{f:g}")
                h = [abs(d[k]) for k in ("a1", "a2", "a3")]
                if h[0] > floors[0]:
                    vs_freq.append({"f": f, "hd2": h[1] * amp / (2 * h[0]), "hd3": h[2] * amp**2 / (4 * h[0])})
                else:
                    row = {"f": f, "hd2": None, "hd3": None}
                    row.update({f"hd{n}Infinite": True for n in (2, 3) if h[n - 1] > floors[n - 1]})
                    vs_freq.append(row)
        except (run_ngspice.NgspiceError, KeyError, ValueError) as exc:
            dis_out.update(_disto_unavailable(name, exc, net))
            vs_freq = []
    result = {
        "freq": freq,
        "amplitude": amp,
        "reference": which,
        "coefficients": [{"order": i + 1, "value": v, "uncertainty": u} for i, (v, u) in enumerate(zip(ref, unc))],
        "taylor": [{"order": i + 1, "value": v, "uncertainty": u} for i, (v, u) in enumerate(zip(tay, tay_unc))],
        "hd2": _hd(2, a2, a1, amp, zero),
        "hd3": _hd(3, a3, a1, amp, zero),
        "taylor_span": span,
        "harmonic_balance": {"coefficients": hb_coef, "fit_error": {"a1": e1, "a2": e2, "a3": e3},
                             "uncertainty": hb_unc},
        "disto": dis_out,
        "vsFreq": vs_freq,
        "points": points,
        "transient_error": tr_error,
    }
    if tr_failed:
        result["transient_failed"] = tr_failed
    if bad := harmonic_balance_disagreements(result):
        raise ValueError(f"{name}: harmonic balance disagrees with the reference: " + "; ".join(bad))
    return result


def _disto_unavailable(name: str, exc: Exception, net) -> dict:
    """The disto record for a .disto that errored or printed nothing, or a
    ValueError outside disto_optional()."""
    why = (f"printed no {exc.args[0]}" if isinstance(exc, KeyError) else str(exc))[:200]
    if not _DISTO_OPTIONAL.get():
        raise ValueError(f"{name}: .disto unavailable ({why}); generation needs it "
                         "(install-ngspice.sh builds ngspice-47)") from exc
    return {"error": why, "valid": _disto_valid(net), "unavailable": True}
