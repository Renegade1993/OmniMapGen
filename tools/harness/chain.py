r"""chain.py - runs the harness grids one after the other, silent, bounded.

pythonw chain.py --stop-at HH:MM [--lanes auto|N] [--max-lanes 6] [--wait-for <run dir>] grid1 grid2 ...
Waits (until the stop time) for the --wait-for run to log "finished" so two grids never overlap, then runs each named
grid (.tmp/harness/grids/<name>.json into .tmp/harness/<name>) with run_grid.py under the same stop-at. Before each grid
it sizes the lanes to the free commit (about 3 GB a lane, 6 GB spare; TESTING.md rule 10), widens by itself when other jobs end, and the 4 GB brake stops it. Ends by itself at the stop time or when the
grids are done; a STOP file at .tmp/harness/CHAIN_STOP ends it too. Registered in the PC's script registry.
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


RESERVE = os.path.join(H, "lane_reserve.json")


def reserve(lanes):
    """Record this chain's lanes and when they were launched: memory a lane takes only shows in free commit a minute
    on, so another chain deciding in that minute would count it as still free."""
    import json
    try:
        d = json.load(open(RESERVE, encoding="utf8"))
    except Exception:
        d = {}
    d[str(os.getpid())] = [lanes, time.time()]
    d = {k: v for k, v in d.items() if time.time() - v[1] < 3600}
    json.dump(d, open(RESERVE, "w", encoding="utf8"))


def pending_elsewhere():
    """GB the other chains launched in the last two minutes have yet to take."""
    import json
    try:
        d = json.load(open(RESERVE, encoding="utf8"))
    except Exception:
        return 0.0
    return sum(3.0 * v[0] for k, v in d.items() if k != str(os.getpid()) and time.time() - v[1] < 120)


def fit(cur):
    """Lanes the free commit has room for: about 3 GB a lane with 6 GB kept spare (TESTING.md rule 10); the lanes
    already running hold memory that stays theirs, so they count as room."""
    return max(0, int((commit_free_gb() - pending_elsewhere() + 3 * cur - 6) // 3))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stop-at", required=True)
    ap.add_argument("--lanes", default="auto", help="a number, or auto: as many as the free commit has room for")
    ap.add_argument("--max-lanes", type=int, default=6)
    ap.add_argument("--wait-for", default=None)
    ap.add_argument("--only-side", default=None)
    ap.add_argument("--gen-root", default=None)
    ap.add_argument("--brake-gb", type=float, default=4)
    ap.add_argument("grids", nargs="+")
    a = ap.parse_args()
    auto = str(a.lanes) == "auto"
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
    py = sys.executable.replace("python.exe", "pythonw.exe") if sys.executable.endswith("python.exe") else sys.executable
    for g in a.grids:
        out = os.path.join(H, g)
        lg = os.path.join(out, "run.log")
        done = False
        force_n = 0
        while not done and not over():
            # zero lanes is the only reason to wait: then at most ten minutes, and the number is read again
            n = min(a.max_lanes, fit(0)) if auto else int(a.lanes)
            if auto and force_n:
                n, force_n = force_n, 0      # the width a widening just chose (the lanes it stopped still hold memory for a minute)
            if n < 1:
                log(f"free commit {commit_free_gb():.1f} GB leaves room for no lane, waiting")
                for _ in range(10):
                    if over() or fit(0) >= 1:
                        break
                    time.sleep(60)
                continue
            reserve(n)
            log(f"start {g} lanes {n} commit free {commit_free_gb():.1f} GB")
            cmd = [py, os.path.join(HERE, "run_grid.py"), "--grid", os.path.join(H, "grids", g + ".json"), "--out", out,
                   "--lanes", str(n), "--stop-at", a.stop_at]
            if a.only_side:
                cmd += ["--only-side", a.only_side]
            if a.gen_root:
                cmd += ["--gen-root", a.gen_root]
            t0 = time.time()
            p = subprocess.Popen(cmd, creationflags=NOWIN, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            restart = False
            while p.poll() is None:
                if commit_free_gb() < a.brake_gb:
                    # the brake: stopped (its lanes end with it); the grid is relaunched, smaller, once memory is back
                    log(f"free commit {commit_free_gb():.1f} GB under the brake {a.brake_gb:g}, stopping {g}")
                    p.kill()
                    restart = True
                    time.sleep(60)
                    break
                if auto and time.time() - t0 > 300 and min(a.max_lanes, fit(n)) > n:
                    # the headroom grew (another job's lanes ended): widen. Done maps are skipped on the relaunch.
                    log(f"widening {g}: {n} to {min(a.max_lanes, fit(n))} lanes, commit free {commit_free_gb():.1f} GB")
                    reserve(min(a.max_lanes, fit(n)))
                    force_n = min(a.max_lanes, fit(n))
                    p.kill()
                    restart = True
                    break
                if datetime.datetime.now() >= end + datetime.timedelta(minutes=10):
                    p.kill()
                    log("killed run_grid past stop time")
                    break
                time.sleep(10)
            if not restart:
                tail = open(lg, encoding="utf8").read()[-300:] if os.path.exists(lg) else ""
                done = "finished" in tail or over()
                log(f"{g} done rc={p.poll()}")
    log("chain ended")


if __name__ == "__main__":
    main()
