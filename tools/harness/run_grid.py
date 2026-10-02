"""run_grid.py - runs a grid of jobs through the engine's own random map generator and through ours.

K, 2026-10-01: "run mapgens from VCMI with all possible settings, and run our mapgen with those templates
mirroring the VCMI-required settings, and then diffing out what varies".

For every job x seed: the engine (VCMI_rmg.exe in VCMI\\rmgrun, started through DMB Dev's launch plan under the
isolation guard, one process per map with its own timeout) writes <out>\\engine\\<run>.vmap and .zones.json;
ours (generate-cli.js under the guard, core content only) writes <out>\\ours\\<run>.vmap and a zone dump.
A map already on disk is skipped, so a stopped grid resumes.

Every run is bounded: --engine-timeout and --ours-timeout per map, --stop-at (HH:MM, local) for the whole grid,
a stop file (<out>\\STOP) checked before each map, and the lanes end with the parent: if this process dies the
children it started end with their own timeouts.

usage: py run_grid.py --grid grid.json --out DIR [--lanes 4] [--stop-at 23:00] [--engine-timeout 150]
                      [--ours-timeout 400] [--only-side engine|ours] [--limit N]
"""
import argparse
import datetime
import json
import os
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

PROJECT = r"C:\AI Projects\Heroes 3"
MAPGEN = os.path.join(PROJECT, "VCMIMapGen")
RMGRUN = os.path.join(PROJECT, "VCMI", "rmgrun")
DMBTEST = os.path.join(PROJECT, "VCMI", "dmbtest")
SMOKE_LAUNCH = os.path.join(PROJECT, ".tmp", "opus", "smoke_launch.py")
PRELOAD = os.path.join(PROJECT, "! LLM Files", "Tools", "isolation", "dmbIsolationPreload.js")
PYISO = os.path.join(PROJECT, "! LLM Files", "Tools", "isolation", "python")
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

log_lock = threading.Lock()
GEN_ROOT = None  # --gen-root DIR: a frozen copy of the generator (src, package.json, node_modules) our side runs from
OURS_ENV = {}  # --ours-env KEY=VALUE: extra environment for our generator only (an A/B of one switch)


def log(out, line):
    stamp = datetime.datetime.now().strftime("%H:%M:%S")
    with log_lock:
        with open(os.path.join(out, "run.log"), "a", encoding="utf8") as fh:
            fh.write(f"{stamp} {line}\n")


def guard_env(extra=None):
    env = dict(os.environ)
    env["NODE_OPTIONS"] = f'--require "{PRELOAD.replace(os.sep, "/")}"'
    env["PYTHONPATH"] = PYISO
    env["VCMI_ROOT"] = DMBTEST
    env.pop("VCMI_USER_DIR", None)
    if extra:
        env.update(extra)
    return env


def run_engine(job, seed, run, out, timeout):
    base = os.path.join(out, "engine", run)
    if os.path.exists(base + ".vmap") and os.path.exists(base + ".zones.json"):
        return "skip"
    spec = {"out": base, "template": job["template"], "w": job["w"], "h": job["h"], "levels": job["levels"],
            "players": job["players"], "water": job["water"], "monsters": job["monsters"], "seed": seed}
    jobfile = base + ".job.json"
    with open(jobfile, "w", encoding="utf8") as fh:
        json.dump([spec], fh)
    env = guard_env({"SMOKE_EXE": "VCMI_rmg.exe"})
    t0 = time.time()
    try:
        r = subprocess.run([sys.executable, SMOKE_LAUNCH, RMGRUN, str(timeout), jobfile, "--deadline", str(timeout - 5)],
                           env=env, capture_output=True, text=True, timeout=timeout + 30, creationflags=NO_WINDOW)
        ok = os.path.exists(base + ".vmap") and os.path.exists(base + ".zones.json")
        tail = [l for l in r.stdout.splitlines() if l.startswith(("OK", "FAIL", "DEADLINE", "INIT"))][-1:]
        return ("ok" if ok else "FAIL") + f" {time.time() - t0:.0f}s " + (tail[0][:140] if tail else f"rc={r.returncode}")
    except subprocess.TimeoutExpired:
        return f"TIMEOUT {timeout}s"


def run_ours(job, seed, run, out, timeout):
    base = os.path.join(out, "ours", run)
    if os.path.exists(base + ".vmap") and os.path.exists(base + ".zonedump.json"):
        return "skip"
    args = ["node", os.path.join(GEN_ROOT or MAPGEN, "src", "main", "generate-cli.js"), "--out", base + ".vmap",
            "--template", job["template"], "--w", str(job["w"]), "--h", str(job["h"]), "--players", str(job["players"]),
            "--seed", str(seed), "--accommodate", "size,players,humans,underground", "--declaremods", "0",
            "--factions", ",".join(["random"] * job["players"]),
            "--bio.waterContent", str(job["water"]), "--bio.monsterStrength", str(job["monsters"] + 1)]
    if job["levels"] >= 2:
        args += ["--underground", "1"]
    # the user folder holds the game data (CRTRAITS, terrain and monster tables) the generator reads, as it does under the game;
    # without it ours falls back to the zone model and loses its pools (found 2026-10-01: tier 1 first run lacked it)
    env = guard_env({"VMAPGEN_ZONE_DUMP": base + ".zonedump.json", "VCMI_USER_DIR": os.path.join(RMGRUN, "userdata"), **OURS_ENV})
    t0 = time.time()
    try:
        r = subprocess.run(args, env=env, capture_output=True, text=True, timeout=timeout, cwd=GEN_ROOT or MAPGEN,
                           creationflags=NO_WINDOW)
        with open(base + ".log", "w", encoding="utf8") as fh:
            fh.write(r.stdout + r.stderr)
        ok = os.path.exists(base + ".vmap")
        return ("ok" if ok else "FAIL") + f" {time.time() - t0:.0f}s"
    except subprocess.TimeoutExpired:
        return f"TIMEOUT {timeout}s"


def main():
    global GEN_ROOT
    ap = argparse.ArgumentParser()
    ap.add_argument("--grid", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--lanes", type=int, default=2)
    ap.add_argument("--stop-at", default=None)
    ap.add_argument("--engine-timeout", type=int, default=150)
    ap.add_argument("--ours-timeout", type=int, default=400)
    ap.add_argument("--only-side", choices=["engine", "ours"], default=None)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--ours-env", action="append", default=[])
    ap.add_argument("--gen-root", default=None)
    a = ap.parse_args()
    OURS_ENV.update(dict(kv.split("=", 1) for kv in a.ours_env))
    GEN_ROOT = os.path.abspath(a.gen_root) if a.gen_root else None
    a.out = os.path.abspath(a.out)
    a.grid = os.path.abspath(a.grid)
    os.makedirs(a.out, exist_ok=True)
    # under pythonw there is no console, so no Ctrl-C can reach it (a console-attached start was ended by one)
    if sys.stdout is None or sys.stderr is None:
        sys.stdout = sys.stderr = open(os.path.join(a.out, "run.stdout"), "a", buffering=1)
    grid = json.load(open(a.grid, encoding="utf8"))
    os.makedirs(os.path.join(a.out, "engine"), exist_ok=True)
    os.makedirs(os.path.join(a.out, "ours"), exist_ok=True)
    deadline = None
    if a.stop_at:
        hh, mm = a.stop_at.split(":")
        now = datetime.datetime.now()
        deadline = now.replace(hour=int(hh), minute=int(mm), second=0, microsecond=0)
        if deadline <= now:
            deadline += datetime.timedelta(days=1)
    stopfile = os.path.join(a.out, "STOP")
    runs = [(j, s) for j in grid["jobs"] for s in grid["seeds"]]
    if a.limit:
        runs = runs[:a.limit]
    log(a.out, f"grid {grid['name']}: {len(runs)} runs, lanes {a.lanes}, stop-at {a.stop_at}")
    done = [0]

    def stopping():
        return os.path.exists(stopfile) or (deadline and datetime.datetime.now() >= deadline)

    def one(item):
        job, seed = item
        if stopping():
            return
        run = f"{job['id']}_s{seed}"
        res = []
        if a.only_side != "ours":
            res.append("engine " + run_engine(job, seed, run, a.out, a.engine_timeout))
        if a.only_side != "engine" and not stopping():
            res.append("ours " + run_ours(job, seed, run, a.out, a.ours_timeout))
        done[0] += 1
        log(a.out, f"[{done[0]}/{len(runs)}] {run}: " + " | ".join(res))

    with ThreadPoolExecutor(max_workers=a.lanes) as ex:
        list(ex.map(one, runs))
    log(a.out, "finished" + (" (stopped early)" if stopping() else ""))


if __name__ == "__main__":
    main()
