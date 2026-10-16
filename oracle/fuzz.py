"""Large parallel fuzz: generate random circuits with ngspice references, then
compare the solver on every one.

usage: uv run fuzz.py [--jobs 8] [--per-batch 50] [--seeds 100-139] [--kinds wildmos,wildbjt,wildmixed,mos,bjt,mixed,linear]
                      [--dir fuzz]

Each (kind, seed) batch goes to <dir>/<kind>_<seed>/ (git-ignored). Failures are
listed with compare.py's -v detail. The CLI is $SMALLSIGNAL_BIN (required).
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent


def seeds(spec: str) -> list[int]:
    lo, _, hi = spec.partition("-")
    return list(range(int(lo), int(hi or lo) + 1))


def generate(kind: str, seed: int, count: int, root: Path) -> tuple[str, str]:
    wild = kind.startswith("wild")
    base = kind.removeprefix("wild")
    out = root / f"{kind}_{seed}"
    args = ["uv", "run", "-q", "random_circuits.py", "--kind", base, "--seed", str(seed), "--count", str(count),
            "--out", str(out / "c"), "--expected", str(out / "e")]
    if wild:
        args.append("--wild")
    p = subprocess.run(args, cwd=HERE, capture_output=True, text=True)
    return f"{kind}_{seed}", (p.stdout + p.stderr).strip().splitlines()[-1] if (p.stdout + p.stderr).strip() else ""


def compare(batch: Path) -> tuple[int, int, list[str]]:
    p = subprocess.run(["uv", "run", "-q", "compare.py", "-v", "--corpus", str(batch / "c"), "--expected", str(batch / "e")],
                       cwd=HERE, capture_output=True, text=True)
    lines = p.stdout.splitlines()
    fails = [l for l in lines if l and not l.startswith(("circuit ", " ")) and " pass " not in l and "passed" not in l]
    detail = [l for l in lines if l.startswith(" ")]
    total = next((l for l in lines if "passed" in l), "0/0 passed")
    ok, n = total.split()[0].split("/")
    return int(ok), int(n), fails + detail


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--jobs", type=int, default=8)
    ap.add_argument("--per-batch", type=int, default=50)
    ap.add_argument("--seeds", default="100-103")
    ap.add_argument("--kinds", default="wildmos,wildbjt,wildmixed")
    ap.add_argument("--dir", type=Path, default=HERE / "fuzz")
    ap.add_argument("--skip-generate", action="store_true")
    args = ap.parse_args()
    if not os.environ.get("SMALLSIGNAL_BIN"):
        print("set SMALLSIGNAL_BIN", file=sys.stderr)
        return 2
    jobs = [(k, s) for k in args.kinds.split(",") for s in seeds(args.seeds)]
    with ThreadPoolExecutor(args.jobs) as pool:
        if not args.skip_generate:
            for name, msg in pool.map(lambda j: generate(j[0], j[1], args.per_batch, args.dir), jobs):
                print(f"gen {name}: {msg}", flush=True)
        results = list(pool.map(lambda j: compare(args.dir / f"{j[0]}_{j[1]}"), jobs))
    ok = sum(r[0] for r in results)
    n = sum(r[1] for r in results)
    for (k, s), (_, _, fails) in zip(jobs, results):
        for f in fails:
            print(f"[{k}_{s}] {f}")
    print(f"\n{ok}/{n} fuzz circuits passed")
    return 0 if ok == n else 1


if __name__ == "__main__":
    sys.exit(main())
