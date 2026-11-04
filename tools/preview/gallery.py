"""Preview pictures and a gif per template, every frame a real generator run (MapGen Dev, 2026-11-04).

K, 2026-11-03: "preview images for all templates need to be: 1. Consistent look/aesthetic across previews for different templates 2. Be easy to read 3. Have clear
major symbology, like start positions (little castles, colored for player starts, grey for non) 4. Have a gif of various settings, with as much variability as possible
for each template". K, 2026-11-02: the gif shows every size; the pictures use the template's preferred setup; captions name player count and levels.
Spec table: roster\\SPEC-MapGenDev-previews-1104.md.

    py gallery.py --out DIR [--gen DIR] [--only SLUG] [--seconds 3] [--workers 3]

Frame 1 of every plan is the template's preferred setup (the still picture, <slug>.png); the other frames vary size, players, levels and water as far as the template
allows, with a new seed each. Output in DIR: <slug>_NN.png, <slug>.png, <slug>.frames.json (caption, settings, seconds, contentSha256 per frame), <slug>.gif, and
maps\\ with the generated maps (a re-run keeps maps that exist). The generator is --gen (default: this repository); maps are drawn by layout_dump.js and layout_render.py.
--userdir: the VCMI user folder whose mods the maps use (as generate-cli --vcmiuserdir). NODE_PATH: the generator's node_modules.
"""
import argparse
import concurrent.futures as cf
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
from layout_render import render  # noqa: E402

NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
NAMES = {36: "Small", 72: "Medium", 108: "Large", 144: "Extra Large", 180: "Huge", 252: "Giant"}
# water layouts: id -> (waterShape stop, label, waterContent, waterCoverage), the lobby's own setup for each (src/biome/water.js WATER_SHAPES)
WATER = {"lakes": (0, "Lakes", 1, 0.20), "coastal": (1, "Coastal", 1, 0.25), "continental": (2, "Continental", 1, 0.30), "mediterranean": (3, "Mediterranean", 1, 0.30),
         "highland": (4, "Highland", 1, 0.0), "islands": (5, "Islands", 2, 0.45), "archipelago": (6, "Archipelago", 1, 0.30)}


def F(size, players, levels, seed, water=None):
    return {"size": size, "players": players, "levels": levels, "seed": seed, "water": water}


SIZES = (36, 72, 108, 144, 180, 252)


def plan(first, preferred, varied):
    """the panel cycles the frames: the preferred setup at every size from the original's first size up and round (item 6, K: "the images should show the different
    sizes, but generally under template preferred criteria"), then the varied frames (item 30: "a gif of various settings, with as much variability as possible")"""
    order = [s for s in SIZES if s >= first] + [s for s in SIZES if s < first]
    return [dict(preferred(s), preferred=True) for s in order] + [dict(v, preferred=False) for v in varied]


# slug: (template name or None for the open layout, [frames]); frame 1 is the preferred setup at the original's smallest size (the still picture)
PLANS = {
    "jebus_cross": ("Jebus Cross", plan(108, lambda s: F(s, 4, 1, 1),   # the original: Large to Extra Large, 2 to 4 players, one level
        [F(36, 2, 2, 2), F(72, 3, 2, 4), F(72, 4, 2, 5), F(108, 2, 1, 7, "coastal"), F(144, 3, 2, 9), F(180, 2, 1, 10, "mediterranean"), F(252, 4, 2, 12),
         F(108, 3, 1, 13, "lakes")])),
}


def caption(name, f):
    lv = "1 level" if f["levels"] == 1 else "2 levels"
    w = ", " + WATER[f["water"]][1] + " water" if f["water"] else ""
    return f"{name}, {NAMES[f['size']]} {f['size']}x{f['size']}: {f['players']} players, {lv}{w}"


def work(slug, template, n, f, out, gen, env):
    maps = os.path.join(out, "maps")
    base = f"{slug}_{f['size']}_p{f['players']}_L{f['levels']}_s{f['seed']}" + ("_" + f["water"] if f["water"] else "")
    vm = os.path.join(maps, base + ".vmap")
    if not os.path.exists(vm):
        cmd = ["node", os.path.join("src", "main", "generate-cli.js"), "--w", str(f["size"]), "--h", str(f["size"]), "--players", str(f["players"]), "--humans", "1",
               "--underground", "1" if f["levels"] == 2 else "0", "--seed", str(f["seed"]), "--out", vm, "--declaremods", "1"] + (["--vcmiuserdir", env["VCMI_USER_DIR"]] if env.get("VCMI_USER_DIR") else [])
        if template:
            cmd += ["--template", template]
        if f["water"]:
            shape, _label, content, coverage = WATER[f["water"]]
            cmd += ["--bio.waterShape", str(shape), "--bio.waterContent", str(content), "--bio.waterCoverage", str(coverage)]
        else:
            cmd += ["--bio.waterContent", "0", "--bio.waterCoverage", "0"]
        r = subprocess.run(cmd, cwd=gen, env=env, capture_output=True, text=True, timeout=2700, creationflags=NO_WINDOW)
        if r.returncode != 0 or not os.path.exists(vm):
            return n, None, "generator failed %s %s" % (r.returncode, (r.stderr or r.stdout)[-300:])
    dump = vm + ".dump.json"
    if not os.path.exists(dump) or os.path.getmtime(dump) < os.path.getmtime(vm) or os.path.getmtime(dump) < os.path.getmtime(os.path.join(HERE, "layout_dump.js")):
        r = subprocess.run(["node", os.path.join(HERE, "layout_dump.js"), "--tip", gen, "--out", dump, vm], cwd=gen, env=env, capture_output=True, text=True, timeout=300,
                           creationflags=NO_WINDOW)
        if r.returncode != 0:
            return n, None, "dump failed " + (r.stderr or r.stdout)[-300:]
    png = os.path.join(out, f"{slug}_{n:02d}.png")
    info = render(dump, png)
    return n, {"order": n, "file": os.path.basename(png), **f, "map": os.path.basename(vm), "caption": caption(template or "Classic", f), **info}, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--gen", default=REPO)
    ap.add_argument("--userdir", default="", help="the VCMI user folder whose mods the maps use (VCMI_USER_DIR)")
    ap.add_argument("--only", default="")
    ap.add_argument("--seconds", type=float, default=3.0)
    ap.add_argument("--workers", type=int, default=3)
    a = ap.parse_args()
    out = os.path.abspath(a.out)
    os.makedirs(os.path.join(out, "maps"), exist_ok=True)
    env = dict(os.environ)
    if a.userdir:
        env["VCMI_USER_DIR"] = os.path.abspath(a.userdir)
    from PIL import Image
    bad = 0
    for slug, (template, frames_in) in PLANS.items():
        if a.only and a.only != slug:
            continue
        t0 = time.time()
        res = {}
        with cf.ThreadPoolExecutor(max_workers=a.workers) as ex:
            futs = [ex.submit(work, slug, template, n, f, out, os.path.abspath(a.gen), env) for n, f in enumerate(frames_in, 1)]
            for fu in cf.as_completed(futs):
                n, meta, err = fu.result()
                print(slug, n, err or meta["caption"], f"{time.time() - t0:.0f}s", flush=True)
                if err:
                    bad += 1
                else:
                    res[n] = meta
        frames = [res[n] for n in sorted(res)]
        if not frames:
            continue
        for f in frames:
            p = os.path.join(out, f["file"])
            f["path"] = "mapgen/preview/" + slug + "/" + os.path.splitext(f["file"])[0]
            f["seconds"] = a.seconds
            f["contentSha256"] = hashlib.sha256(open(p, "rb").read()).hexdigest()
        shutil.copy2(os.path.join(out, frames[0]["file"]), os.path.join(out, slug + ".png"))
        json.dump({"schemaVersion": 1, "loop": True, "frames": frames, "note": "frame 1 is the template's preferred setup; every frame is one real generator run; tools/preview/gallery.py"},
                  open(os.path.join(out, slug + ".frames.json"), "w", encoding="utf-8"), indent=1)
        imgs = [Image.open(os.path.join(out, f["file"])).convert("RGB").quantize(colors=96, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE) for f in frames]
        imgs[0].save(os.path.join(out, slug + ".gif"), save_all=True, append_images=imgs[1:], duration=int(a.seconds * 1000), loop=0, optimize=True)
        print("gif", slug, len(imgs), "frames", flush=True)
    print("finished", "bad", bad, flush=True)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
