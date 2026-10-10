"""convert.py - original .h3m maps to .vmap through the engine's own map reader, so mapsight reads one format.

py convert.py <map.h3m or a folder of them> [--out DIR] [--timeout 120]

Runs VCMI_rmgconv.exe (tools/rmgdump built with the "convert" job, 2026-10-01; the harness's VCMI_rmg.exe is the same
program before that change) from VCMI\\rmgrun, through the harness's launcher (tools/harness/run_grid.py: the isolation
guard, no window, a deadline inside the program and a timeout outside it). One process converts the whole list.
Writes <out>/<name>.vmap with spaces and odd characters turned into _. Default out: .tmp/mapsight/h3m.
"""
import argparse
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "harness"))
import run_grid as rg  # noqa: E402  (guard_env, SMOKE_LAUNCH, RMGRUN, NO_WINDOW)

ap = argparse.ArgumentParser()
ap.add_argument("src"); ap.add_argument("--out", default=os.path.join(rg.PROJECT, ".tmp", "mapsight", "h3m"))
ap.add_argument("--timeout", type=int, default=120)
a = ap.parse_args()

if not os.path.exists(os.path.join(rg.RMGRUN, "VCMI_rmgconv.exe")):
    sys.exit("VCMI_rmgconv.exe is missing from VCMI\\rmgrun: build tools/rmgdump (build.bat) and copy out\\VCMI_rmg.exe there under that name")
src = [os.path.join(a.src, f) for f in sorted(os.listdir(a.src)) if f.lower().endswith(".h3m")] if os.path.isdir(a.src) else [a.src]
os.makedirs(a.out, exist_ok=True)
jobs = [{"convert": os.path.abspath(f), "out": os.path.join(a.out, re.sub(r"[^\w.-]+", "_", os.path.splitext(os.path.basename(f))[0])), "seed": 0}
        for f in src]
jf = os.path.join(a.out, "convert.job.json")
json.dump(jobs, open(jf, "w", encoding="utf8"))
budget = a.timeout + 3 * len(jobs)
r = subprocess.run([sys.executable, rg.SMOKE_LAUNCH, rg.RMGRUN, str(budget), jf, "--deadline", str(budget - 5)],
                   env=rg.guard_env({"SMOKE_EXE": "VCMI_rmgconv.exe"}), capture_output=True, text=True,
                   timeout=budget + 30, creationflags=rg.NO_WINDOW)
ok = [j for j in jobs if os.path.exists(j["out"] + ".vmap")]
for line in r.stdout.splitlines():
    if line.startswith(("FAIL", "DEADLINE", "INIT")):
        print(line[:200])
print(f"converted {len(ok)} of {len(jobs)} into {a.out}")
sys.exit(0 if len(ok) == len(jobs) else 1)
