"""Independent 60-digit MNA solve of the solver's own small-signal certificate.

usage: uv run mpverify.py <solver binary> <netlist.cir> [--junctions] [--gmin G] [--json]

The solver's `--certificate` lists its MNA stamps and symbolic parameters. This
script restamps them itself (own stamping, own mpmath LU at 60 digits), using
the parameter values the solver reports, and evaluates gain, rin and rout at
the sidecar's frequencies. It prints, per value: the 60-digit result, the
solver's result and ngspice's (expected/), so it shows
  - whether the solver's floating-point value is the exact value of its own
    linearized circuit (artifact proofs: the solver is exact, ngspice is not);
  - with --junctions, whether adding every MOS bulk-junction conductance the
    solver left out (ngspice's formula IS·M/Vt·exp(V/Vt) + gmin at the
    solver's operating point) reproduces ngspice (root-cause proof).
"""

from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import mpmath as mp

import spice
from run_ngspice import OPTIONS

mp.mp.dps = 60
RUN_GMIN = re.search(r"gmin=([^ ]+)", OPTIONS).group(1)  # the solver runs with ngspice's options
VT = mp.mpf("1.38064852e-23") * mp.mpf("300.15") / mp.mpf("1.6021766208e-19")


def run(binary: str, text: str, side: dict, extra: list[str]) -> dict:
    title, _, body = text.partition("\n")
    with tempfile.NamedTemporaryFile("w", suffix=".cir", delete=False) as f:
        f.write(f"{title}\n{OPTIONS}\n{body}")
        path = f.name
    out = side["output"] + (f":{side['ref']}" if side.get("ref") else "")
    try:
        p = subprocess.run([binary, "analyze", path, "--input", side["input"], "--output", out, *extra],
                           capture_output=True, text=True, timeout=300)
    finally:
        Path(path).unlink()
    return json.loads(p.stdout)


def model_params(text: str) -> dict[str, dict[str, float]]:
    out = {}
    for m in re.finditer(r"^\.model\s+(\S+)\s+\S+\s*\(?([^)\n]*)\)?", text, re.I | re.M):
        out[m.group(1).lower()] = {k.lower(): float(v) for k, v in re.findall(r"(\w+)=([-+\d.eE]+)", m.group(2))}
    return out


def omitted_junctions(text: str, res: dict, gmin: float) -> list[tuple[str, str, mp.mpf, str]]:
    """MOS bulk junctions the solver did not include, as (node, node, g, label)."""
    net = spice.parse(text)
    params = model_params(text)
    have = {p["name"].lower() for p in res["params"]}
    volt = {k.lower(): v for k, v in res["op"]["nodes"].items()}
    v = lambda n: mp.mpf(0) if n in spice.GROUND else mp.mpf(repr(volt[n.lower()]))
    out = []
    for e in net.elements:
        if e.kind != "m":
            continue
        mname = e.tokens[5].lower()
        t = -1 if net.models.get(mname) == "pmos" else 1
        mult = next((float(x.split("=")[1]) for x in e.tokens[6:] if x.lower().startswith("m=")), 1.0)
        isat = mp.mpf(params.get(mname, {}).get("is", 1e-14)) * mult
        d, _, s, b = e.nodes
        for other, which in ((s, "bs"), (d, "bd")):
            if b == other or f"r{which}_{e.name}".lower() in have:
                continue
            vj = t * (v(b) - v(other))
            g = (isat / VT * mp.exp(vj / VT) if vj > -3 * VT else 0) + gmin
            out.append((b, other, g, f"{e.name}.{which}"))
    return out


def omitted_gmu(text: str, res: dict, gmin: float = 0.0) -> list[tuple[str, str, mp.mpf, str]]:
    """BJT base-collector conductances g_mu the solver dropped (as (b, c, g, label)).
    The solver's g_mu includes ngspice's gmin; gmin=0 keeps only the physical
    part gbc/BR (g_mu − the run's gmin)."""
    net = spice.parse(text)
    have = {p["name"].lower() for p in res["params"]}
    out = []
    for e in net.elements:
        if e.kind == "q" and f"rmu_{e.name}".lower() not in have:
            d = {k.lower(): v for k, v in res["op"]["devices"].items()}[e.name.lower()]
            g = mp.mpf(repr(d["gmu"])) - mp.mpf(RUN_GMIN) + mp.mpf(gmin)
            out.append((e.nodes[1], e.nodes[0], max(g, mp.mpf(0)), f"{e.name}.gmu"))
    return out


def solve(cert: dict, res: dict, s: mp.mpc, extra_adm, excite: str, out_idx, ref_idx, override=None):
    val = {p["name"]: mp.mpf(repr(p["value"])) for p in res["params"]}
    val.update(override or {})
    var = {p["var"]: p for p in cert["params"]}

    def expr(e: str):
        total = mp.mpc(1)
        for factor in e.split("*"):
            f = factor.strip()
            if f == "s":
                total *= s
            elif re.fullmatch(r"[-+\d.eE]+", f):
                total *= mp.mpf(f)
            else:
                p = var[f]
                x = val[p["name"]]
                total *= 1 / x if p["conductance"] else x
        return total

    n, nb = len(cert["nodes"]), len(cert["branch"])
    A = mp.matrix(n + nb, n + nb)
    b = mp.matrix(n + nb, 1)

    def add(r, c, x):
        if r is not None and c is not None:
            A[r, c] += x

    for e in cert["elems"]:
        k = e["kind"]
        if k == "adm":
            y = expr(e["y"])
            add(e["a"], e["a"], y); add(e["b"], e["b"], y); add(e["a"], e["b"], -y); add(e["b"], e["a"], -y)
        elif k == "vccs":
            g = expr(e["g"])
            for r, rs in ((e["op"], 1), (e["on"], -1)):
                for c, cs in ((e["cp"], 1), (e["cn"], -1)):
                    add(r, c, rs * cs * g)
        elif k == "cccs":
            f = expr(e["f"])
            add(e["a"], n + e["ctrl"], f); add(e["b"], n + e["ctrl"], -f)
        else:
            raise SystemExit(f"unhandled element {k}")
    for (a, c, g) in extra_adm:
        add(a, a, g); add(c, c, g); add(a, c, -g); add(c, a, -g)
    for k, br in enumerate(cert["branch"]):
        row = n + k
        add(br["a"], row, 1); add(br["b"], row, -1); add(row, br["a"], 1); add(row, br["b"], -1)
        kind = br["kind"]
        if kind == "vsrc":
            b[row] = mp.mpf(br["val"]) if excite == "gain" else 0
        elif kind == "vcvs":
            e_ = expr(br["e"])
            add(row, br["cp"], -e_); add(row, br["cn"], e_)
        elif kind == "ccvs":
            add(row, n + br["ctrl"], -expr(br["h"]))
        elif kind == "ind":
            add(row, row, -expr(br["z"]))
        else:
            raise SystemExit(f"unhandled branch {kind}")
    if excite == "gain":
        for inj in cert["inj"]:
            if inj["into"] is not None:
                b[inj["into"]] += mp.mpf(inj["i"])
            if inj["outof"] is not None:
                b[inj["outof"]] -= mp.mpf(inj["i"])
    else:  # rout: every source zeroed, 1 A into out from ref
        if out_idx is not None:
            b[out_idx] += 1
        if ref_idx is not None:
            b[ref_idx] -= 1
    return mp.lu_solve(A, b)


def ngspice_params(res: dict, want: dict) -> dict[str, mp.mpf]:
    """The solver's device parameters replaced by ngspice's own linearization."""
    out = {}
    devs = {k.lower(): v for k, v in want["op"]["devices"].items()}
    for p in res["params"]:
        name = p["name"]
        if "_" not in name:
            continue
        kind, dev = name.split("_", 1)
        d = devs.get(dev.lower())
        if not d:
            continue
        src = {"gm": ("gm", False), "gmb": ("gmb", False), "rpi": ("gpi", True), "rmu": ("gmu", True),
               "ro": ("gds" if "gds" in d else "go", True), "rd": ("gd", True)}.get(kind)
        if src and src[0] in d and d[src[0]] != 0:
            v = mp.mpf(repr(d[src[0]]))
            out[name] = 1 / v if src[1] else v
    return out


def evaluate(binary: str, cir: Path, add: str = "none", params: str = "ours", dps: int = 60) -> dict:
    """60-digit gain/rin/rout per frequency: {"gain@f": mpc|inf, ...} plus the
    solver's and ngspice's values under keys ("ours", key) / ("ngspice", key)."""
    mp.mp.dps = dps
    text = cir.read_text()
    side = json.loads(cir.with_suffix(".json").read_text())
    want_path = cir.parent.parent / "e" / f"{cir.stem}.json"
    want = json.loads(want_path.read_text()) if want_path.exists() else None
    cert = run(binary, text, side, ["--certificate"])
    res = run(binary, text, side, ["--freq", ",".join(map(repr, side["freqs"])), "--rin", "--rout"])
    names = {name.lower(): i for i, group in enumerate(cert["nodes"]) for name in group}
    idx = lambda n_: None if n_ is None or n_.lower() in spice.GROUND else names.get(n_.lower())
    out_idx, ref_idx = idx(side["output"]), idx(side.get("ref"))
    extra = []
    if add != "none":
        g = float(RUN_GMIN) if add == "all" else 0.0
        js = omitted_junctions(text, res, g) + omitted_gmu(text, res, g)
        extra = [(idx(a), idx(b), gj) for a, b, gj, _ in js if idx(a) != idx(b)]
    override = ngspice_params(res, want) if params == "ngspice" and want else None
    n = len(cert["nodes"])
    input_branch = cert["branches"].index(side["input"]) if side["input"] in cert["branches"] else None
    at = lambda vec, i: vec[i] if i is not None else 0
    out: dict = {}
    for f in side["freqs"]:
        s = mp.mpc(0, 2 * mp.pi * f)
        x = solve(cert, res, s, extra, "gain", out_idx, ref_idx, override)
        out[f"gain@{f:g}"] = at(x, out_idx) - at(x, ref_idx)
        if input_branch is not None:
            ib = x[n + input_branch]
            out[f"rin@{f:g}"] = -1 / ib if ib != 0 else mp.inf
        elif cert["inj"]:
            inj = cert["inj"][0]
            out[f"rin@{f:g}"] = at(x, inj["into"]) - at(x, inj["outof"])
        xo = solve(cert, res, s, extra, "rout", out_idx, ref_idx, override)
        out[f"rout@{f:g}"] = at(xo, out_idx) - at(xo, ref_idx)
        for q in ("gain", "rin", "rout"):
            key = f"{q}@{f:g}"
            r = res.get(q) or {}
            v = next((v for v in r.get("values", []) if v["f"] == f), None)
            out[("ours", key)] = math.inf if r.get("infinite") or v is None or v.get("re") is None else complex(v["re"], v["im"])
            if want and q in want:
                w = next(w for w in want[q]["values"] if math.isclose(w["f"], f))
                out[("ngspice", key)] = math.inf if w.get("inf") or w.get("re") is None else complex(w["re"], w["im"])
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("binary")
    ap.add_argument("netlist", type=Path)
    ap.add_argument("--junctions", action="store_true")
    ap.add_argument("--gmu", action="store_true", help="also add every BJT g_mu the solver left out")
    ap.add_argument("--add", choices=["none", "phys", "all"],
                    help="add omitted MOS junctions and BJT g_mu: physical part only, or with ngspice's gmin")
    ap.add_argument("--dps", type=int, default=60)
    ap.add_argument("--gmin", type=float, default=1e-15)
    ap.add_argument("--expected", type=Path, help="ngspice result (default: ../e/<name>.json beside c/)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    mp.mp.dps = args.dps
    text = args.netlist.read_text()
    side = json.loads(args.netlist.with_suffix(".json").read_text())
    exp_path = args.expected or args.netlist.parent.parent / "e" / f"{args.netlist.stem}.json"
    want = json.loads(exp_path.read_text()) if exp_path.exists() else None
    cert = run(args.binary, text, side, ["--certificate"])
    res = run(args.binary, text, side, ["--freq", ",".join(map(repr, side["freqs"])), "--rin", "--rout"])
    names = {name.lower(): i for i, group in enumerate(cert["nodes"]) for name in group}
    idx = lambda nname: None if nname is None or nname.lower() in spice.GROUND else names.get(nname.lower())
    out_idx, ref_idx = idx(side["output"]), idx(side.get("ref"))
    if args.add:
        args.junctions = args.gmu = args.add != "none"
        args.gmin = float(RUN_GMIN) if args.add == "all" else 0.0
    junctions = omitted_junctions(text, res, args.gmin) if args.junctions else []
    if args.gmu:
        junctions += omitted_gmu(text, res, args.gmin)
    extra = [(idx(a), idx(b), g) for a, b, g, _ in junctions if idx(a) != idx(b)]
    n = len(cert["nodes"])
    input_branch = cert["branches"].index(side["input"]) if side["input"] in cert["branches"] else None
    report = []
    for f in side["freqs"]:
        s = mp.mpc(0, 2 * mp.pi * f)
        x = solve(cert, res, s, extra, "gain", out_idx, ref_idx)
        at = lambda vec, i: vec[i] if i is not None else 0
        vals = {"gain": at(x, out_idx) - at(x, ref_idx)}
        if input_branch is not None:
            vals["rin"] = -1 / x[n + input_branch] if x[n + input_branch] != 0 else mp.inf
        else:
            inj = cert["inj"][0]
            vals["rin"] = at(x, inj["into"]) - at(x, inj["outof"])
        xo = solve(cert, res, s, extra, "rout", out_idx, ref_idx)
        vals["rout"] = at(xo, out_idx) - at(xo, ref_idx)
        for q, exact in vals.items():
            if q not in res or res[q].get("infinite"):
                ours = math.inf
            else:
                v = next(v for v in res[q]["values"] if v["f"] == f)
                ours = complex(v["re"], v["im"]) if v.get("re") is not None else math.nan
            ng = None
            if want and q in want:
                w = next(w for w in want[q]["values"] if math.isclose(w["f"], f))
                ng = math.inf if w.get("inf") or w.get("re") is None else complex(w["re"], w["im"])
            e = complex(exact) if exact != mp.inf else math.inf
            rel = lambda a: (abs(a - e) / abs(e)) if e not in (0, math.inf) and a not in (None, math.inf) else (0.0 if a == e else math.inf)
            report.append({"q": q, "f": f, "mp60": str(mp.nstr(exact, 17)), "ours_rel": rel(ours), "ngspice_rel": rel(ng) if ng is not None else None})
    if args.json:
        print(json.dumps({"junctions_added": [j[3] for j in junctions], "values": report}))
    else:
        if junctions:
            print("added junctions:", ", ".join(f"{j[3]}={mp.nstr(j[2], 4)} S" for j in junctions))
        for r in report:
            ng = "n/a" if r["ngspice_rel"] is None else f"{r['ngspice_rel']:.2e}"
            print(f"{r['q']:5} f={r['f']:<12g} mp60={r['mp60']:>40}  |ours-mp|/|mp|={r['ours_rel']:.2e}  |ngspice-mp|/|mp|={ng}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
