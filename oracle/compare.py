"""Compare the smallsignal CLI against ngspice reference results.

usage: uv run compare.py [--corpus DIR] [--expected DIR] [--rtol R] [-v] [names...]

The CLI is $SMALLSIGNAL_BIN if set, else target/release/smallsignal after a
`cargo build --release -p smallsignal-cli`, else `cargo run -q --release -p
smallsignal-cli --`. Each circuit's sidecar JSON supplies --input/--output/--freq.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path

import distortion
import spice
from run_ngspice import OPTIONS, requested, settings, rel_diff

HERE = Path(__file__).resolve().parent
REPO = HERE.parent

# Absolute floors per quantity, so exact zeros and ngspice's gmin (1e-15 S) noise don't fail.
ATOL = {"v": 1e-9, "i": 1e-13, "g": 1e-13, "gain": 1e-12, "z": 1e-9}
MOS_KEYS = {"id": "i", "vgs": "v", "vds": "v", "vbs": "v", "gm": "g", "gds": "g", "gmb": "g"}
BJT_KEYS = {"ic": "i", "ib": "i", "vbe": "v", "vce": "v", "gm": "g", "gpi": "g", "go": "g"}
DIODE_KEYS = {"id": "i", "gd": "g"}
INF_THRESHOLD = 1e15


def cli_command() -> list[str]:
    env = os.environ.get("SMALLSIGNAL_BIN")
    if env:
        return shlex.split(env)
    build = subprocess.run(["cargo", "build", "-q", "--release", "-p", "smallsignal-cli"], cwd=REPO,
                           capture_output=True, text=True)
    binary = REPO / "target" / "release" / "smallsignal"
    if build.returncode == 0 and binary.exists():
        return [str(binary)]
    return ["cargo", "run", "-q", "--release", "-p", "smallsignal-cli", "--"]


def with_options(cir: Path) -> Path:
    """Copy of the netlist with the same .options (gmin etc.) ngspice ran with."""
    title, _, body = cir.read_text().partition("\n")
    tmp = tempfile.NamedTemporaryFile("w", suffix=".cir", delete=False)
    tmp.write(f"{title}\n{OPTIONS}\n{body}")
    tmp.close()
    return Path(tmp.name)


def run_cli(cmd: list[str], cir: Path, side: dict) -> dict:
    out = side["output"] + (f":{side['ref']}" if side.get("ref") else "")
    net = with_options(cir)
    args = [*cmd, "analyze", str(net), "--input", side["input"], "--output", out, "--verify"]
    # The CLI takes one frequency list: the sidecar's freqs plus any noise.freqs.
    noise_spec = settings(side, "noise") or {}
    freqs = sorted({float(f) for f in [*side.get("freqs", []), *noise_spec.get("freqs", [])]})
    # ... and distortion.vsFreq (the frequencies distortion.py ran .disto at).
    dist_spec = settings(side, "distortion") or {}
    freqs = sorted({*freqs, *(float(f) for f in dist_spec.get("vsFreq", []))})
    if freqs:
        args += ["--freq", ",".join(repr(f) for f in freqs)]
    if side.get("rin"):
        args.append("--rin")
    if side.get("rout"):
        args.append("--rout")
    if side.get("inputNeg"):
        args += ["--input-neg", side["inputNeg"]]
    if side.get("mode"):
        args += ["--mode", side["mode"]]
    if side.get("match"):
        args += ["--match", ";".join(",".join(g) for g in side["match"])]
    if requested(side, "noise"):
        band = noise_spec.get("band")
        args += ["--noise-band", ",".join(repr(float(f)) for f in band)] if band else ["--noise"]
    if requested(side, "distortion"):
        # ngspice is fully nonlinear, so every transistor and diode is selected.
        devices = [e.tokens[0] for e in spice.parse(cir.read_text()).elements if e.kind in "mqd"]
        args += ["--nonlinear", ",".join(devices), "--order", "3",
                 "--amplitude", repr(float(distortion.amplitude(dist_spec)))]
    try:
        proc = subprocess.run(args, cwd=REPO, capture_output=True, text=True, timeout=120)
    finally:
        net.unlink()
    if proc.returncode != 0:
        msg = (proc.stderr or proc.stdout).strip().splitlines()
        raise RuntimeError(f"CLI exit {proc.returncode}: {msg[-1] if msg else ''}")
    data = json.loads(proc.stdout)
    if "error" in data:
        raise RuntimeError(f"CLI error: {data['error']}")
    # The solver's own exact checks must hold too: KCL identity and the
    # symbolic-vs-numeric cross-check of every quantity.
    if not data.get("verify", {}).get("kcl", False):
        raise RuntimeError("CLI KCL identity check failed")
    for q in ("gain", "rin", "rout"):
        check = data.get(q, {}).get("check", {})
        if not check.get("ok", True):
            raise RuntimeError(f"CLI {q}: symbolic vs numeric mismatch {check.get('maxRelDiff', 0):.2e}")
    # The noise closed form at s -> 0 against the numeric DC solve.
    low = (data.get("noise") or {}).get("inputLowFreq") or {}
    if (low.get("check") or {}).get("ok") is False:
        raise RuntimeError(f"CLI noise.inputLowFreq: closed form vs numeric mismatch {low['check'].get('maxRelDiff')}")
    # The distortion closed forms' a_n against the numeric ones (null: no
    # exact a_n materialized, nothing to check).
    dcheck = (data.get("distortion") or {}).get("check")
    if dcheck is not None and dcheck.get("ok") is False:
        raise RuntimeError(f"CLI distortion: closed form vs numeric mismatch {dcheck.get('maxRelDiff')} "
                           f"(orders {dcheck.get('orders')})")
    return data


class Report:
    def __init__(self, rtol: float, reference_limits: dict | None = None):
        self.rtol = rtol
        self.failures: list[str] = []
        self.worst = 0.0
        # Quantities where ngspice itself is known to be inaccurate, each
        # justified in the sidecar (prefix -> {"rtol", "why"}).
        self.limits = reference_limits or {}

    def tol_for(self, what: str) -> float:
        for prefix, limit in self.limits.items():
            if what.startswith(prefix):
                return limit["rtol"]
        return self.rtol

    def real(self, what: str, got, want: float, kind: str):
        if got is None:
            self.failures.append(f"{what}: missing")
            return
        err = abs(float(got) - want)
        tol = self.tol_for(what) * abs(want) + ATOL[kind]
        self.worst = max(self.worst, err / (abs(want) + ATOL[kind]))
        if not err <= tol:
            self.failures.append(f"{what}: got {got:.12g}, want {want:.12g}")

    def complex(self, what: str, got: dict | None, want: dict, kind: str):
        if got is None:
            self.failures.append(f"{what}: missing")
            return
        if want.get("inf"):
            if not is_inf(got):
                self.failures.append(f"{what}: want infinite, got {got}")
            return
        if is_inf(got):
            # A limited quantity may be truly infinite where ngspice shows noise.
            if self.tol_for(what) < 1e300:
                self.failures.append(f"{what}: got infinite, want {want['re']:.6g}{want['im']:+.6g}j")
            return
        g = complex(got["re"], got["im"])
        w = complex(want["re"], want["im"])
        err = abs(g - w)
        tol = self.tol_for(what) * abs(w) + ATOL[kind]
        self.worst = max(self.worst, err / (abs(w) + ATOL[kind]))
        if not err <= tol:
            self.failures.append(f"{what}: got {g:.10g}, want {w:.10g}")


def is_inf(v: dict) -> bool:
    if v.get("inf"):
        return True
    re_, im_ = v.get("re"), v.get("im")
    if re_ is None or isinstance(re_, str) or isinstance(im_, str):
        return True
    return not math.isfinite(re_) or not math.isfinite(im_) or abs(complex(re_, im_)) > INF_THRESHOLD


def lower_keys(d: dict) -> dict:
    return {str(k).lower(): v for k, v in (d or {}).items()}


def by_freq(values: list[dict] | None, f: float, used: set[int] | None = None) -> dict | None:
    """The entry at frequency f: the closest within relative 1e-9 (so f = 0
    matches only 0), or None if there is none or two are equally close.
    Frequencies are matched, never logged: the solver may return f = 0.
    With `used` (the ids of entries already paired, one set per list), the
    pairing is one-to-one: an entry is returned at most once (and added)."""
    best, best_d, tie = None, math.inf, False
    for v in values or []:
        g = float(v.get("f", math.nan))
        if (used is not None and id(v) in used) or not math.isclose(g, f, rel_tol=1e-9):
            continue
        d = abs(g - f)
        if d < best_d:
            best, best_d, tie = v, d, False
        elif d == best_d:
            tie = True
    if best is None or tie:
        return None
    if used is not None:
        used.add(id(best))
    return best


# Noise: ngspice's PSDs equal an independent exact recomputation from its own
# linearization to <= 2e-14 (noise_indep.py over the noise corpus), so the
# error budget is the operating-point agreement (~1e-9): same rtol as AC.
NOISE_RTOL = 1e-6
NOISE_INT_RTOL = 1e-4
# Absolute floor of a noise density (V²/Hz); a band integral's is this times
# the band width. A reference of exactly zero noise passes only a solver
# value within it.
NOISE_FLOOR = 1e-40

# Distortion: coefficients within rtol plus 3x the reference's measured
# uncertainty (distortion.py: .disto vs DC-Taylor, or a half-span refit).
DIST_RTOL = 1e-6


def compare_noise(got: dict, want: dict, rep: Report):
    gn = got.get("noise") or {}
    for q in ("output", "input"):
        used: set[int] = set()
        for w in want["noise"][q]:
            g = by_freq(gn.get(q), w["f"], used)
            what = f"noise.{q}@{w['f']:g}"
            if g is None or g.get("v2") is None:
                rep.failures.append(f"{what}: missing")
                continue
            err = abs(g["v2"] - w["v2"])
            rep.worst = max(rep.worst, rel_diff(g["v2"], w["v2"], NOISE_FLOOR))
            if err > NOISE_RTOL * w["v2"] + NOISE_FLOOR:
                rep.failures.append(f"{what}: got {g['v2']:.10e}, want {w['v2']:.10e}")
    # Per-source contributions: the solver lists the largest MAX_CONTRIBUTORS
    # per frequency as [{f, sources: [{element, kind, v2}], omitted?}] and sums
    # the rest in omitted {count, v2}; its kinds map to ngspice's. A source
    # the solver lists is compared on its own; every other ngspice source
    # must be no larger than the smallest listed one and is checked through
    # omitted: their sum against omitted.v2, their count (every solver
    # source not listed, as ngspice prints one value for each) against
    # omitted.count.
    kind_map = {("r", "thermal"): "thermal", ("m", "thermal"): "id", ("m", "flicker"): "1overf",
                ("q", "shot_c"): "ic", ("q", "shot_b"): "ib", ("q", "flicker"): "1overf",
                ("d", "shot"): "id", ("d", "flicker"): "1overf"}

    def ng_key(src: dict) -> tuple[str, str | None]:
        el = src.get("element", "").lower()
        return el, kind_map.get((el[:1], src.get("kind")))

    solver_sources = {ng_key(s_) for s_ in gn.get("sources") or []}
    # Per reference frequency, exactly as written (two distinct frequencies
    # stay two rows): {(element, source): v2}.
    expect: dict[float, dict[tuple[str, str], float]] = {}
    for c in want["noise"]["contributors"]:
        if c["source"] != "total":
            for w in c["values"]:
                expect.setdefault(w["f"], {})[(c["element"], c["source"])] = w["v2"]
    if gn.get("contributors") is None:
        rep.failures.append("noise.contributors: missing")
        expect = {}
    used_rows: set[int] = set()
    for f, ng in expect.items():
        row = by_freq(gn.get("contributors"), f, used_rows)
        if row is None:
            # Even a reference of all-zero shares needs the solver's row.
            rep.failures.append(f"noise.contributors@{f:g}: no solver row")
            continue
        listed = {k: s_.get("v2") for s_ in row.get("sources", []) if (k := ng_key(s_))[1]}
        smallest = min((v for v in listed.values() if v is not None), default=0.0)
        omitted = row.get("omitted")
        rest_v2, rest_n = 0.0, 0
        for (el, src), w in sorted(ng.items()):
            what = f"noise.{el}.{src}@{f:g}"
            g = listed.get((el, src))
            if (el, src) in listed:
                if g is None or abs(g - w) > NOISE_RTOL * w + NOISE_FLOOR:
                    rep.failures.append(f"{what}: got {g}, want {w:.10e}")
            elif omitted is not None and (el, src) in solver_sources:
                rest_v2 += w
                rest_n += 1
                if w > smallest * (1 + NOISE_RTOL) + NOISE_FLOOR:
                    rep.failures.append(f"{what}: {w:.3e} is among the largest but not listed")
            elif w != 0:
                rep.failures.append(f"{what}: missing (ngspice {w:.3e})")
        if omitted is not None:
            what = f"noise.omitted@{f:g}"
            if omitted.get("count") != rest_n:
                rep.failures.append(f"{what}.count: got {omitted.get('count')}, want {rest_n}")
            g = omitted.get("v2")
            if g is None or abs(g - rest_v2) > NOISE_RTOL * rest_v2 + NOISE_FLOOR * max(rest_n, 1):
                rep.failures.append(f"{what}.v2: got {g}, want {rest_v2:.10e}")
    # Integrated noise over a band: the reference is an adaptive 60-digit
    # quadrature of the independently rebuilt PSD, confirmed by a Richardson
    # trapezoid of ngspice's own spectrum to ~1e-10 (not ngspice's
    # onoise_total, which is percent-level off). rtol 1e-4 matches the
    # solver's integrator target; its own relError claim must also hold.
    if "integrated" in want["noise"]:
        gi = gn.get("integrated") or {}
        for key in ("outputV2", "inputV2"):
            w, g = want["noise"]["integrated"][key], gi.get(key)
            what = f"noise.integrated.{key}"
            if g is None:
                rep.failures.append(f"{what}: missing")
                continue
            band = want["noise"]["integrated"]
            err = rel_diff(g, w, NOISE_FLOOR * (band["fHigh"] - band["fLow"]))
            rep.worst = max(rep.worst, err)
            if err > NOISE_INT_RTOL:
                rep.failures.append(f"{what}: got {g:.8e}, want {w:.8e} (rel {err:.1e})")
            claimed = gi.get("relError")
            if claimed is not None and err > max(2 * claimed, 1e-9):
                rep.failures.append(f"{what}: error {err:.1e} exceeds the solver's own relError {claimed:.1e}")
        # The solver must claim convergence and a finite error estimate,
        # unless the reference says it cannot converge (solverConverged).
        expect_conv = want["noise"]["integrated"].get("solverConverged", True)
        if gi.get("converged") is not expect_conv:
            rep.failures.append(f"noise.integrated.converged: got {gi.get('converged')}, want {expect_conv}")
        claimed = gi.get("relError")
        if not (isinstance(claimed, (int, float)) and math.isfinite(claimed)):
            rep.failures.append(f"noise.integrated.relError: got {claimed}, want a finite estimate")


def compare_distortion(got: dict, want: dict, rep: Report):
    gd = got.get("distortion") or {}
    gc = {c.get("order"): c.get("value") for c in gd.get("coefficients") or []}
    ref = want["distortion"]
    coef_tol = {c["order"]: DIST_RTOL * abs(c["value"]) + 3 * c["uncertainty"]
                + 1e-12 * abs(ref["coefficients"][0]["value"]) for c in ref["coefficients"]}
    for c in ref["coefficients"]:
        g = gc.get(c["order"])
        what = f"distortion.a{c['order']}"
        if g is None:
            rep.failures.append(f"{what}: missing")
            continue
        tol = coef_tol[c["order"]]
        rep.worst = max(rep.worst, abs(g - c["value"]) / max(abs(c["value"]), 1e-300))
        if abs(g - c["value"]) > tol:
            rep.failures.append(f"{what}: got {g:.10e}, want {c['value']:.10e} (tol {tol:.1e}, ref {ref['reference']})")
    def infinite(q) -> bool:
        return bool(q) and q.get("value") is None and q.get("latex") == "\\infty"

    # HD with a1 = 0 is infinite, or 0/0 (unavailable: null) when a_n is 0 too.
    for h in ("hd2", "hd3"):
        gq = gd.get(h)
        g = (gq or {}).get("value")
        w = ref[h]["value"]
        if ref[h].get("infinite"):
            if not infinite(gq):
                rep.failures.append(f"distortion.{h}: got {g if gq else 'null'}, want infinite (a1 = 0)")
        elif w is None:
            if gq is not None:
                rep.failures.append(f"distortion.{h}: got {'infinite' if infinite(gq) else g}, want null "
                                    f"({ref[h].get('unavailable')})")
        elif g is None:
            rep.failures.append(f"distortion.{h}: {'infinite' if infinite(gq) else 'missing'}, want {w:.8e}")
        elif abs(g - w) > 1e-5 * w + 1e-15:
            rep.failures.append(f"distortion.{h}: got {g:.8e}, want {w:.8e}")
    # IIP3 = sqrt(4|a1|/(3|a3|)) over the reference's a1, a3 intervals (each
    # within the coefficient tolerance above); an a3 that may be 0 allows an
    # infinite IIP3, which an exact 0 requires (latex \infty, value null).
    # As the solver: a1 = a3 = 0 (distortion.zero_orders) requires null (0/0),
    # and a1 = 0 with a3 != 0 requires exactly 0.
    (w1, t1), (w3, t3) = ((abs(c["value"]), coef_tol[c["order"]]) for c in ref["coefficients"] if c["order"] in (1, 3))
    zero = distortion.zero_orders(ref)
    gi = gd.get("iip3") or {}
    g = gi.get("value")
    lo = math.sqrt(4 * max(w1 - t1, 0.0) / (3 * (w3 + t3))) if w3 + t3 > 0 else math.inf
    hi = math.sqrt(4 * (w1 + t1) / (3 * (w3 - t3))) if w3 > t3 else math.inf
    if zero[0] and zero[2]:
        if gd.get("iip3") is not None:
            rep.failures.append(f"distortion.iip3: got {'infinite' if infinite(gi) else g}, want null (0/0: a1 = a3 = 0)")
    elif zero[0]:
        if g != 0 or infinite(gi):
            rep.failures.append(f"distortion.iip3: got {'infinite' if infinite(gi) else g if gi else 'missing'}, "
                                "want 0 (a1 = 0, a3 != 0)")
    elif w3 == 0:
        if not infinite(gi):
            rep.failures.append(f"distortion.iip3: got {g if g is not None else gi or 'missing'}, want infinite (a3 = 0)")
    elif not gi or (g is None and not infinite(gi)):
        rep.failures.append("distortion.iip3: missing")
    elif infinite(gi):
        if hi < math.inf:
            rep.failures.append(f"distortion.iip3: got infinite, want {math.sqrt(4 * w1 / (3 * w3)):.8e}")
    else:
        want = math.sqrt(4 * w1 / (3 * w3))
        rep.worst = max(rep.worst, abs(g - want) / want)
        if not lo <= g <= hi:
            rep.failures.append(f"distortion.iip3: got {g:.10e}, want {want:.10e} (range {lo:.10e}..{hi:.10e})")
    # The reference's own harmonic-balance and transient confirmations
    # (distortion.py refuses to write disagreeing ones; this catches stale or
    # edited expectations).
    rep.failures += [f"expected distortion: {m}" for m in distortion.harmonic_balance_disagreements(ref)
                     + distortion.transient_disagreements(ref)]
    # Frequency-dependent HD against .disto's complex Volterra phasors, which
    # match an exact 50-digit harmonic perturbation to ~4e-12 (textbook_nd).
    # Only the reference's (positive) frequencies are compared; a solver point
    # at another frequency, such as f = 0 from the sidecar's freqs, is ignored.
    used: set[int] = set()  # one-to-one, as the noise rows
    for w in ref.get("vsFreq", []):
        g = by_freq(gd.get("vsFreq"), w["f"], used)
        for h in ("hd2", "hd3"):
            what = f"distortion.vsFreq.{h}@{w['f']:g}"
            # H1 = 0: null, marked infinite unless H_n is 0 too (0/0).
            if w[h] is None:
                want_inf = bool(w.get(f"{h}Infinite"))
                if g is None or g.get(h) is not None or bool(g.get(f"{h}Infinite")) != want_inf:
                    got = "missing" if g is None else g.get(h) if g.get(h) is not None else \
                        "infinite" if g.get(f"{h}Infinite") else "null"
                    rep.failures.append(f"{what}: got {got}, want {'infinite' if want_inf else 'null (0/0)'}")
                continue
            if g is None or g.get(h) is None:
                rep.failures.append(f"{what}: {'infinite' if g and g.get(f'{h}Infinite') else 'missing'}")
                continue
            # An exact zero (symmetry, linearity) is checked with the same
            # absolute floor as hd2, hd3.
            err = abs(g[h] - w[h])
            rep.worst = max(rep.worst, err / max(w[h], 1e-15 / DIST_RTOL))
            if err > DIST_RTOL * w[h] + 1e-15:
                rep.failures.append(f"{what}: got {g[h]:.10e}, want {w[h]:.10e} (diff {err:.1e})")


def compare(got: dict, want: dict, rep: Report, side: dict | None = None):
    """got against want; with the sidecar, a requested noise or distortion
    analysis whose expected block is missing fails."""
    for q in ("noise", "distortion"):
        if side and requested(side, q) and q not in want:
            rep.failures.append(f"{q}: the sidecar requests it but the expected result has no {q} block")
    gnodes = lower_keys(got.get("op", {}).get("nodes"))
    for n, v in want["op"]["nodes"].items():
        rep.real(f"V({n})", gnodes.get(n), v, "v")
    gdevs = lower_keys(got.get("op", {}).get("devices"))
    for name, w in want["op"]["devices"].items():
        g = lower_keys(gdevs.get(name))
        if not g:
            rep.failures.append(f"{name}: missing from op.devices")
            continue
        keys = {"nmos": MOS_KEYS, "pmos": MOS_KEYS, "npn": BJT_KEYS, "pnp": BJT_KEYS}.get(w["type"], DIODE_KEYS)
        for k, kind in keys.items():
            rep.real(f"{name}.{k}", g.get(k), w[k], kind)
        if "region" in w and "region" in g and g["region"] != w["region"]:
            rep.failures.append(f"{name}.region: got {g['region']}, want {w['region']}")
    for q, kind in (("gain", "gain"), ("rin", "z"), ("rout", "z")):
        if q not in want:
            continue
        gq = got.get(q) or {}
        used: set[int] = set()
        for w in want[q]["values"]:
            rep.complex(f"{q}@{w['f']:g}", by_freq(gq.get("values"), w["f"], used), w, kind)
    if "noise" in want:
        compare_noise(got, want, rep)
    if "distortion" in want:
        compare_distortion(got, want, rep)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", type=Path, default=HERE / "corpus")
    ap.add_argument("--expected", type=Path, default=HERE / "expected")
    ap.add_argument("--rtol", type=float, default=1e-6)
    ap.add_argument("-v", "--verbose", action="store_true", help="list every failing quantity")
    ap.add_argument("names", nargs="*")
    args = ap.parse_args()

    cmd = cli_command()
    wants = sorted(args.expected.glob("*.json"))
    if args.names:
        wants = [w for w in wants if w.stem in args.names]
    passed = 0
    print(f"{'circuit':28s} {'status':6s} {'worst rel err':>13s}  detail")
    for wpath in wants:
        want = json.loads(wpath.read_text())
        cir = (args.corpus / want["netlist"]).resolve()  # the CLI runs from the repo root
        side = json.loads(cir.with_suffix(".json").read_text())
        rep = Report(args.rtol, side.get("reference_limits"))
        try:
            compare(run_cli(cmd, cir, side), want, rep, side)
        except (RuntimeError, ValueError, json.JSONDecodeError, subprocess.TimeoutExpired, OSError) as exc:
            print(f"{wpath.stem:28s} {'ERROR':6s} {'':>13s}  {str(exc)[:100]}")
            continue
        if rep.failures:
            detail = "; ".join(rep.failures if args.verbose else rep.failures[:2])
            more = "" if args.verbose or len(rep.failures) <= 2 else f" (+{len(rep.failures) - 2} more)"
            print(f"{wpath.stem:28s} {'FAIL':6s} {rep.worst:13.2e}  {detail}{more}")
        else:
            passed += 1
            print(f"{wpath.stem:28s} {'pass':6s} {rep.worst:13.2e}")
    print(f"\n{passed}/{len(wants)} passed (rtol={args.rtol:g})")
    return 0 if passed == len(wants) else 1


if __name__ == "__main__":
    sys.exit(main())
