"""stale_check.py: are the module's template previews still the maps the generator makes? (MapGen Dev, 2026-11-04)

K, 2026-11-04 (item 31): "Lets make sure that any update that changes maps also gets a check to update the map previews (i imagine a lot of this
geometry will be shifting)".

    py stale_check.py [--gen DIR] [--mod DIR] [--userdir DIR] [--out DIR] [--frames first|all] [--workers 3]

For every set the module ships (config/mapgen/preview/<slug>.frames.json, written by ship.py), the frame's map is made again with the generator in
--gen (the plan's template, levers, size, players, levels, water and seed: gallery.py PLANS) and drawn into its dump; the hash of what the picture is
drawn from (gallery.draw_hash) must equal the drawHash stored with the frame. Frame 1 (the still, the template's preferred setup) by default;
--frames all checks every frame. Prints one line per set (OK, STALE with the frames that moved, or MISSING when a frame carries no hash) and exits 0
only when every set is OK. The cure for STALE: py gallery.py --out DIR, then py ship.py --gallery DIR, and look at the pictures.
Environment as gallery.py: NODE_PATH (the generator's node_modules), VCMI_ROOT; --userdir the VCMI user folder whose mods the maps use.
Bounded: each map has gallery.work's own timeout; the whole run stops at --deadline-min (default 60).
"""
import argparse
import concurrent.futures as cf
import json
import os
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
import gallery  # noqa: E402
import ship  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gen", default=REPO)
    ap.add_argument("--mod", default=os.path.join(REPO, "mod"))
    ap.add_argument("--userdir", default="")
    ap.add_argument("--out", default="")
    ap.add_argument("--frames", choices=("first", "all"), default="first")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--deadline-min", type=float, default=60)
    a = ap.parse_args()
    conf = os.path.join(a.mod, "Content", "config", "mapgen", "preview")
    out = os.path.abspath(a.out) if a.out else tempfile.mkdtemp(prefix="stale_")
    os.makedirs(os.path.join(out, "maps"), exist_ok=True)
    env = dict(os.environ)
    if a.userdir:
        env["VCMI_USER_DIR"] = os.path.abspath(a.userdir)
    stop = time.time() + a.deadline_min * 60
    jobs, verdict = [], {}
    for gslug, cslug in ship.SLUGS.items():
        fj = os.path.join(conf, cslug + ".frames.json")
        if not os.path.exists(fj):
            continue
        if gslug not in gallery.PLANS:
            verdict[cslug] = "MISSING plan"
            continue
        name, template, _frames, levers = gallery.PLANS[gslug]
        frames = json.load(open(fj, encoding="utf-8"))["frames"]
        for f in (frames[:1] if a.frames == "first" else frames):
            if not f.get("drawHash"):
                verdict[cslug] = "MISSING hash (previews made before stale_check.py; make them again)"
                continue
            want = {k: f[k] for k in ("size", "players", "levels", "seed", "water")}
            jobs.append((cslug, gslug, name, template, levers, f["order"], want, f["drawHash"]))
    moved = {}

    def one(job):
        cslug, gslug, name, template, levers, order, want, h = job
        if time.time() > stop:
            return cslug, order, "deadline"
        n, meta, err = gallery.work("stale_" + gslug, name, template, levers, order, dict(want), out, os.path.abspath(a.gen), env)
        if err:
            return cslug, order, "error: " + err
        return cslug, order, None if meta["drawHash"] == h else "moved"

    with cf.ThreadPoolExecutor(max_workers=a.workers) as ex:
        for cslug, order, res in ex.map(one, jobs):
            if res:
                moved.setdefault(cslug, []).append(f"{order} {res}")
    bad = 0
    for cslug in sorted({j[0] for j in jobs} | set(verdict)):
        if cslug in verdict:
            print(f"{cslug}: {verdict[cslug]}"); bad += 1
        elif cslug in moved:
            print(f"{cslug}: STALE (frames {', '.join(moved[cslug])})"); bad += 1
        else:
            print(f"{cslug}: OK")
    print(f"stale_check: {'PASS' if not bad else 'FAIL'}, {len(jobs)} frame(s) checked, {bad} set(s) not OK; maps in {out}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
