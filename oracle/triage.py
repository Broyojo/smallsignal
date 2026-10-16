"""Triage fuzz failures into root-cause buckets.

usage: uv run triage.py <solver binary> [--dir fuzz]

Buckets: real solver bugs (overflow -> NaN, unmodeled forward-biased bulk
junctions, DC non-convergence where ngspice converges), and comparison
artifacts (BJT reverse-active label, gmin-level impedances, absurd >1 A
junction currents, gmin-level node voltages). Unclassified cases are listed.
"""
import json, re, sys, collections
from pathlib import Path
sys.path.insert(0, ".")
from compare import run_cli, compare, Report
B = sys.argv[1]
ROOT = Path(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[2] == "--dir" else Path("fuzz")
cats = collections.defaultdict(list)
def absurd(want):
    """ngspice currents above 1 A: a junction forward-biased straight from a source."""
    return any(abs(d.get(k, 0)) > 1.0 for d in want["op"]["devices"].values() for k in ("id", "ic", "ib"))
for batch in sorted(ROOT.iterdir()):
    for wpath in sorted((batch / "e").glob("*.json")):
        want = json.loads(wpath.read_text())
        cir = (batch / "c" / want["netlist"]).resolve()
        name = f"{batch.name}/{cir.stem}"
        side = json.loads(cir.with_suffix(".json").read_text())
        rep = Report(1e-6)
        try:
            got = run_cli([B], cir, side)
        except Exception as e:
            m = str(e)
            k = "ERR dc-nonconv" if "converge" in m else "ERR singular" if "singular" in m else "ERR " + m[:45]
            cats[k + (" [absurd ngspice currents]" if absurd(want) else "")].append(name); continue
        compare(got, want, rep)
        f = rep.failures
        if not f: cats["pass"].append(name); continue
        warn = " ".join(got.get("warnings", []))
        nan = any(v.get("re") is None and not v.get("inf") for q in ("gain","rin","rout") for v in (got.get(q) or {}).get("values", []) if not (got.get(q) or {}).get("infinite"))
        non_label = [x for x in f if ".region" not in x]
        op = [x for x in non_label if "@" not in x]
        if not non_label: k = "label-only (BJT reverse-active named cutoff)"
        elif absurd(want): k = "absurd currents (>1 A: junction across a source)"
        elif nan: k = "BUG overflow -> NaN values"
        elif "forward biased" in warn: k = "bulk junction forward biased (not modeled)"
        elif op:
            vals = [abs(float(m)) for x in op for m in re.findall(r"want ([-\d.e+]+)", x)]
            k = "op: tiny-magnitude values (gmin-level)" if vals and max(vals) < 1e-6 else "op: OTHER"
        else:
            def mag(x):
                m = re.search(r"want ([^;]+)", x); s = m.group(1).strip().replace("j", "j")
                try: return abs(complex(s.replace(" ", "")))
                except: return 0
            k = "impedance >=1e12 / gmin-level" if all(x.startswith(("rin","rout")) and ("infinite" in x or mag(x) > 1e12) for x in non_label) else "ac: OTHER"
        cats[k].append(f"{name} :: {non_label[0][:120] if non_label else f[0]}")
tot = sum(len(v) for v in cats.values())
for k in sorted(cats, key=lambda k: -len(cats[k])):
    print(f"{len(cats[k]):5d}  {k}")
print(f"{tot:5d}  total")
for k in cats:
    if "OTHER" in k or k.startswith("ERR") and "absurd" not in k or "symbolic" in k:
        print(f"\n== {k}"); [print("  ", x) for x in cats[k][:30]]
