"""Copy gallery.py's pictures into the generator module, in the layout DMB's template panel reads (MapGen Dev, 2026-11-04).

    py ship.py --gallery DIR [--mod mod]

The client (client/lobby/MapGenTab.cpp) finds a template's pictures by the slug of its name (lower case, apostrophes dropped, anything else one
underscore): config/mapgen/preview/<slug>.frames.json is cycled frame by frame, each frame's "path" a sprite under Sprites/mapgen/preview/<slug>/;
without it, the one picture <slug>.png with <slug>.json's caption. A water layout is water_<id>. The open layout with no template ("None") shows
config/mapgen/preview/frames.json, which is pointed at Classic's frames. Writes, per set: Sprites/mapgen/preview/<slug>/NN.png, <slug>.png (frame 1,
the template's preferred setup), config/mapgen/preview/<slug>.frames.json, <slug>.json, <slug>.gif. The 11-03 pictures these replace are removed.
"""
import argparse
import hashlib
import json
import os
import shutil

# gallery slug -> the client's slug (pictureSlug of the template's name in template-info.json)
SLUGS = {"jebus_cross": "jebus_cross", "coldshadows_fantasy": "coldshadows_fantasy", "headquarters": "headquarters", "golems_aplenty": "golems_aplenty",
         "classic": "classic", "mini_nostalgia": "mini_nostalgia_approximate", "nostalgia": "nostalgia_approximate",
         "water_lakes": "water_lakes", "water_coastal": "water_coastal", "water_continental": "water_continental",
         "water_mediterranean": "water_mediterranean", "water_islands": "water_islands", "water_archipelago": "water_archipelago"}
OLD = ["open_examples", "open_examples.gif", "captions.json"]   # the 11-03 open-layout gallery, replaced by Classic's frames


def sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gallery", required=True)
    ap.add_argument("--mod", default=os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "mod"))
    a = ap.parse_args()
    spr = os.path.join(a.mod, "Content", "Sprites", "mapgen", "preview")
    conf = os.path.join(a.mod, "Content", "config", "mapgen", "preview")
    os.makedirs(spr, exist_ok=True)
    os.makedirs(conf, exist_ok=True)
    for name in OLD:
        for base in (spr, conf):
            p = os.path.join(base, name)
            if os.path.isdir(p):
                shutil.rmtree(p)
            elif os.path.exists(p):
                os.remove(p)
    shipped = []
    for gslug, cslug in SLUGS.items():
        fj = os.path.join(a.gallery, gslug + ".frames.json")
        if not os.path.exists(fj):
            print("missing", gslug)
            continue
        fr = json.load(open(fj, encoding="utf-8"))
        d = os.path.join(spr, cslug)
        if os.path.isdir(d):
            shutil.rmtree(d)
        os.makedirs(d)
        for f in fr["frames"]:
            name = "%02d" % f["order"]
            dst = os.path.join(d, name + ".png")
            shutil.copy2(os.path.join(a.gallery, f["file"]), dst)
            f["file"], f["path"], f["contentSha256"] = name + ".png", "mapgen/preview/" + cslug + "/" + name, sha(dst)
            f.pop("map", None)
        json.dump(fr, open(os.path.join(conf, cslug + ".frames.json"), "w", encoding="utf-8"), indent=1)
        first = os.path.join(d, "01.png")
        shutil.copy2(first, os.path.join(spr, cslug + ".png"))
        f0 = fr["frames"][0]
        json.dump({"schemaVersion": 1, "id": cslug, "caption": f0["caption"], "width": f0["size"], "height": f0["size"], "levels": f0["levels"],
                   "players": f0["players"], "water": f0.get("water"), "contentSha256": sha(first), "note": "frame 1 of " + cslug + ".frames.json (the preferred setup)"},
                  open(os.path.join(conf, cslug + ".json"), "w", encoding="utf-8"), indent=1)
        shutil.copy2(os.path.join(a.gallery, gslug + ".gif"), os.path.join(conf, cslug + ".gif"))
        shipped.append((cslug, len(fr["frames"])))
        if gslug == "classic":   # the open layout with no template shows frames.json: Classic's frames
            json.dump(fr, open(os.path.join(conf, "frames.json"), "w", encoding="utf-8"), indent=1)
    for s, n in shipped:
        print(s, n, "frames")


if __name__ == "__main__":
    main()
