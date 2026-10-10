r"""crash_silence_check.py - proves a crashing harness exe opens no window, by counting real top-level windows.

K, 2026-10-01: a visible "VCMI_rmg.exe - Application Error" dialog appeared mid-grid. rmgdump now sets SetErrorMode and
an unhandled-exception filter (tools/rmgdump/crashguard.cpp); this starts a copy of it with --crash-test (a deliberate
write to address 0x10 at the first job) through the grid's own launch path, with EnumWindows sampling every 50 ms
before, during and for three seconds after, and reports every visible window that was not there before. Also checks
that the run left <out>.crash.txt naming the template and seed, and that the exit code is not zero.
Start it like the grid is started (pythonw through WMI):  pythonw crash_silence_check.py <result file>
"""
import ctypes
import ctypes.wintypes as wt
import datetime
import json
import os
import shutil
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import run_grid  # noqa: E402

out_file = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "crash_silence_result.txt")
user32 = ctypes.windll.user32
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

    user32.EnumWindows(EnumWindowsProc(cb), 0)
    return found


def main():
    lines = [f"start {datetime.datetime.now():%H:%M:%S}"]
    exe_src = os.path.join(HERE, "..", "rmgdump", "out", "VCMI_rmg.exe")
    exe = os.path.join(run_grid.RMGRUN, "VCMI_rmgcrash.exe")
    shutil.copy2(exe_src, exe)
    out = os.path.abspath(os.path.join(HERE, "..", "..", ".tmp", "harness", "crashsilence"))
    os.makedirs(out, exist_ok=True)
    base = os.path.join(out, "crash_probe")
    for ext in (".crash.txt",):
        if os.path.exists(base + ext):
            os.remove(base + ext)
    spec = [{"out": base, "template": "Jebus Cross", "w": 108, "h": 108, "levels": 1, "players": 4, "water": 0,
             "monsters": 0, "seed": 4242}]
    jobfile = base + ".job.json"
    json.dump(spec, open(jobfile, "w"))
    before = windows()
    lines.append(f"visible windows before: {len(before)}")
    new = {}
    stop = threading.Event()

    def watch():
        while not stop.is_set():
            for h, v in windows().items():
                if h not in before and h not in new:
                    new[h] = v + (time.time(),)
            time.sleep(0.05)

    t = threading.Thread(target=watch, daemon=True)
    t.start()
    env = run_grid.guard_env({"SMOKE_EXE": "VCMI_rmgcrash.exe"})
    r = subprocess.run([sys.executable, run_grid.SMOKE_LAUNCH, run_grid.RMGRUN, "60", jobfile, "--deadline", "50", "--crash-test"],
                       env=env, capture_output=True, text=True, timeout=90, creationflags=run_grid.NO_WINDOW)
    time.sleep(3.0)
    stop.set()
    t.join(timeout=2)
    lines.append(f"exit code of the crashing run: {r.returncode}")
    lines.append("stdout: " + " | ".join(l for l in r.stdout.splitlines() if l.startswith("CRASH"))[:400])
    cf = base + ".crash.txt"
    lines.append("crash file: " + (open(cf).read().strip()[:400] if os.path.exists(cf) else "MISSING"))
    lines.append(f"NEW VISIBLE WINDOWS DURING THE CRASH: {len(new)}")
    for h, (cls, title, pid, _) in new.items():
        lines.append(f"  hwnd {h} class {cls!r} title {title!r} pid {pid}")
    wer = subprocess.run(["tasklist", "/FI", "IMAGENAME eq WerFault.exe"], capture_output=True, text=True, creationflags=run_grid.NO_WINDOW).stdout
    lines.append("WerFault running afterwards: " + ("yes" if "WerFault" in wer else "no"))
    lines.append("RESULT: " + ("SILENT" if not new and r.returncode != 0 and os.path.exists(cf) else "CHECK"))
    open(out_file, "w", encoding="utf8").write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
