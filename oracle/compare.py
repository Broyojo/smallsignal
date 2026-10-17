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

from run_ngspice import OPTIONS, rel_diff

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
    noise_spec = side["noise"] if isinstance(side.get("noise"), dict) else {}
    freqs = sorted({float(f) for f in [*side.get("freqs", []), *noise_spec.get("freqs", [])]})
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
    if side.get("noise"):
        band = side["noise"].get("band") if isinstance(side["noise"], dict) else None
        args += ["--noise-band", ",".join(repr(float(f)) for f in band)] if band else ["--noise"]
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


def by_freq(values: list[dict] | None, f: float) -> dict | None:
    """The entry at frequency f (relative 1e-9, so f = 0 matches only 0).
    Frequencies are matched, never logged: the solver may return f = 0."""
    for v in values or []:
        if math.isclose(float(v.get("f", math.nan)), f, rel_tol=1e-9):
            return v
    return None


# Noise: ngspice's PSDs equal an independent exact recomputation from its own
# linearization to <= 2e-14 (noise_indep.py over the noise corpus), so the
# error budget is the operating-point agreement (~1e-9): same rtol as AC.
NOISE_RTOL = 1e-6
NOISE_INT_RTOL = 1e-4
# Absolute floor of a noise density (V²/Hz); a band integral's is this times
# the band width. A reference of exactly zero noise passes only a solver
# value within it.
NOISE_FLOOR = 1e-40


def compare_noise(got: dict, want: dict, rep: Report):
    gn = got.get("noise") or {}
    for q in ("output", "input"):
        for w in want["noise"][q]:
            g = next((x for x in gn.get(q) or [] if math.isclose(x["f"], w["f"], rel_tol=1e-9)), None)
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
    # Per reference frequency (as by_freq matches them): {(element, source): v2}.
    expect: list[tuple[float, dict[tuple[str, str], float]]] = []
    for c in want["noise"]["contributors"]:
        if c["source"] != "total":
            for w in c["values"]:
                at = next((d for f, d in expect if math.isclose(f, w["f"], rel_tol=1e-9)), None)
                if at is None:
                    expect.append((w["f"], at := {}))
                at[(c["element"], c["source"])] = w["v2"]
    if gn.get("contributors") is None:
        rep.failures.append("noise.contributors: missing")
        expect = []
    for f, ng in expect:
        row = by_freq(gn.get("contributors"), f) or {}
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


def compare(got: dict, want: dict, rep: Report):
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
        for w in want[q]["values"]:
            rep.complex(f"{q}@{w['f']:g}", by_freq(gq.get("values"), w["f"]), w, kind)
    if "noise" in want:
        compare_noise(got, want, rep)


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
            compare(run_cli(cmd, cir, side), want, rep)
        except (RuntimeError, json.JSONDecodeError, subprocess.TimeoutExpired, OSError) as exc:
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
