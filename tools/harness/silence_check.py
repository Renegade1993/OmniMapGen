"""silence_check.py - proves the harness opens no window, by counting real top-level windows while it runs.

K, 2026-10-01: "SOME JERKOFF ON THIS TEAM IS SPAMMING ME WITH CMD WINDOWS". Get-Process MainWindowHandle does not
see a console hosted by a terminal, so this enumerates every top-level window on the desktop with EnumWindows
(ctypes), before and during a 30-second run of engine maps through the grid's own launch path with 4 lanes, and
reports every visible window that was not there before. The count has to be 0.

Start it the way the grid is started (pythonw through WMI), so the parent chain is the same:
    pythonw silence_check.py <result file>
"""
import ctypes
import ctypes.wintypes as wt
import datetime
import os
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import run_grid  # noqa: E402

out_file = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "silence_result.txt")
user32 = ctypes.windll.user32
EnumWindows = user32.EnumWindows
EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)


def windows():
    found = {}

    def cb(hwnd, _):
        if user32.IsWindowVisible(hwnd):
            n = user32.GetWindowTextLengthW(hwnd)
            buf = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, buf, n + 1)
            cls = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, cls, 256)
            pid = wt.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            found[int(hwnd)] = (cls.value, buf.value, pid.value)
        return True

    EnumWindows(EnumWindowsProc(cb), 0)
    return found


def main():
    lines = []
    start = datetime.datetime.now()
    lines.append(f"start {start:%H:%M:%S} running as {os.path.basename(sys.executable)}")
    before = windows()
    lines.append(f"visible windows before: {len(before)}")
    out = os.path.join(HERE, "..", "..", ".tmp", "harness", "silence")
    out = os.path.abspath(out)
    os.makedirs(os.path.join(out, "engine"), exist_ok=True)
    job = {"template": "Jebus Cross", "w": 108, "h": 108, "levels": 1, "players": 4, "water": 0, "monsters": -1}
    new = {}
    maps = []
    stop = threading.Event()

    def watch():
        while not stop.is_set():
            for h, v in windows().items():
                if h not in before and h not in new:
                    new[h] = v + (time.time(),)
            time.sleep(0.05)

    t = threading.Thread(target=watch, daemon=True)
    t.start()
    deadline = time.time() + 32

    def lane(k):
        n = 0
        while time.time() < deadline:
            seed = 100 * k + n
            run = f"silence_L{k}_s{seed}"
            res = run_grid.run_engine(dict(job, id=run), seed, run, out, 100)
            maps.append((run, res))
            n += 1

    lanes = [threading.Thread(target=lane, args=(k,)) for k in range(4)]
    for th in lanes:
        th.start()
    for th in lanes:
        th.join()
    time.sleep(1.0)
    stop.set()
    t.join(timeout=2)
    ok = sum(1 for _, r in maps if r.startswith("ok"))
    lines.append(f"maps run through the launch path: {len(maps)} ({ok} ok) in {(datetime.datetime.now() - start).total_seconds():.0f} s")
    lines.append(f"NEW VISIBLE WINDOWS DURING THE RUN: {len(new)}")
    for h, (cls, title, pid, _) in new.items():
        lines.append(f"  hwnd {h} class {cls!r} title {title!r} pid {pid}")
    lines.append("RESULT: " + ("SILENT" if not new else "WINDOWS APPEARED"))
    open(out_file, "w", encoding="utf8").write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
