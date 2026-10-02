r"""chain.py - runs the harness grids one after the other, silent, bounded.

pythonw chain.py --stop-at HH:MM [--lanes 2] [--wait-for <run dir>] grid1 grid2 ...
Waits (until the stop time) for the --wait-for run to log "finished" so two grids never overlap, then runs each named
grid (.tmp/harness/grids/<name>.json into .tmp/harness/<name>) with run_grid.py under the same stop-at. Before each grid
it checks free commit memory (needs 20 GB) and the STOP file of that run. Ends by itself at the stop time or when the
grids are done; a STOP file at .tmp/harness/CHAIN_STOP ends it too. Registered in C:\Users\Kmoney\.agents\SCRIPT-REGISTRY.md.
"""
import argparse
import ctypes
import datetime
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
H = os.path.join(ROOT, ".tmp", "harness")
NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)


class MS(ctypes.Structure):
    _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong), ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong), ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong), ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]


def commit_free_gb():
    m = MS(); m.dwLength = ctypes.sizeof(MS)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
    return m.ullAvailPageFile / 2 ** 30


def log(msg):
    with open(os.path.join(H, "chain.log"), "a", encoding="utf8") as f:
        f.write(f"{datetime.datetime.now():%H:%M:%S} {msg}\n")


def stop_dt(hhmm):
    h, m = map(int, hhmm.split(":"))
    t = datetime.datetime.now().replace(hour=h, minute=m, second=0, microsecond=0)
    return t if t > datetime.datetime.now() else t + datetime.timedelta(days=1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stop-at", required=True)
    ap.add_argument("--lanes", type=int, default=2)
    ap.add_argument("--wait-for", default=None)
    ap.add_argument("--only-side", default=None)
    ap.add_argument("--gen-root", default=None)
    ap.add_argument("--gate-gb", type=float, default=20)
    ap.add_argument("--brake-gb", type=float, default=4)
    ap.add_argument("grids", nargs="+")
    a = ap.parse_args()
    end = stop_dt(a.stop_at)
    stop_file = os.path.join(H, "CHAIN_STOP")

    def over():
        return datetime.datetime.now() >= end or os.path.exists(stop_file)

    if a.wait_for:
        lg = os.path.join(a.wait_for, "run.log")
        base = open(lg, encoding="utf8").read().count("finished") if os.path.exists(lg) else 0
        log(f"waiting for {a.wait_for} to finish (finished lines so far: {base})")
        while not over():
            if os.path.exists(lg) and open(lg, encoding="utf8").read().count("finished") > base:
                break
            time.sleep(10)
    for g in a.grids:
        if over():
            break
        while commit_free_gb() < a.gate_gb and not over():
            log(f"free commit {commit_free_gb():.1f} GB under {a.gate_gb:g}, waiting")
            time.sleep(60)
        if over():
            break
        out = os.path.join(H, g)
        log(f"start {g} lanes {a.lanes} commit free {commit_free_gb():.1f} GB")
        cmd = [sys.executable.replace("python.exe", "pythonw.exe") if sys.executable.endswith("python.exe") else sys.executable,
               os.path.join(HERE, "run_grid.py"), "--grid", os.path.join(H, "grids", g + ".json"), "--out", out,
               "--lanes", str(a.lanes), "--stop-at", a.stop_at]
        if a.only_side:
            cmd += ["--only-side", a.only_side]
        if a.gen_root:
            cmd += ["--gen-root", a.gen_root]
        p = subprocess.Popen(cmd, creationflags=NOWIN, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        while p.poll() is None:
            if commit_free_gb() < a.brake_gb:
                # the brake: under it the grid is stopped (its lanes end with it) and the gate waits for memory again
                log(f"free commit {commit_free_gb():.1f} GB under the brake {a.brake_gb:g}, stopping {g}")
                p.kill()
                break
            if datetime.datetime.now() >= end + datetime.timedelta(minutes=10):
                p.kill(); log("killed run_grid past stop time")
                break
            time.sleep(10)
        log(f"{g} done rc={p.poll()}")
    log("chain ended")


if __name__ == "__main__":
    main()
