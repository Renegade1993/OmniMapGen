"""water_menu_v2.py: the water menu mockup, version 2 (K item 32): land and water only, castles, one line each, one shared legend of three entries.
MapGen Dev, 2026-11-04. Reads the gallery dumps (.tmp\\m1104\\gal\\maps) and template-info.json's waterLayouts one lines."""
import json
import os
import sys
import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, r"C:\AI Projects\Heroes 3\.tmp\m1104\previews\tools\preview")
import layout_render as lr  # noqa: E402

MAPS = sys.argv[1] if len(sys.argv) > 1 else "maps"
INFO = r"C:\AI Projects\Heroes 3\.tmp\m1104\previews\mod\template-info.json"
OUT = sys.argv[2] if len(sys.argv) > 2 else "water_menu"
TH = os.path.join(OUT, "v2")
os.makedirs(TH, exist_ok=True)
info = json.load(open(INFO, encoding="utf-8"))["waterLayouts"]
NAMES = {"lakes": "Lakes", "coastal": "Coastal", "continental": "Continental", "mediterranean": "Mediterranean", "islands": "Islands", "archipelago": "Archipelago"}
rows = [(k, 72, 4) for k in NAMES] + [("islands", 180, 8), ("archipelago", 180, 8)]
S = 240
tiles = []
for k, size, p in rows:
    dump = os.path.join(MAPS, f"water_{k}_{size}_p{p}_L1_s11_{k}.vmap.dump.json")
    png = os.path.join(TH, f"water_{k}_{size}_p{p}.png")
    r = lr.render_water(dump, png, S)
    assert r["starts"] == p, (k, size, r)
    # check (spec row 1): only two colours in the map square apart from the castles
    a = np.array(Image.open(png).convert("RGB"))[14:S - 14, 14:S - 14].reshape(-1, 3)
    cols, cnt = np.unique(a, axis=0, return_counts=True)
    top2 = cnt[np.argsort(-cnt)][:2].sum() / cnt.sum()
    print(k, size, p, "starts", r["starts"], "two main colours cover", f"{top2:.3f}", "of the map square")
    tiles.append((k, size, p, png))

fb, f, fs = lr.font(17), lr.font(14), lr.font(13)
CWD = 2 * (S + 300) + 60
ROWH = S + 20
H = 60 + ROWH * 4 + 50
img = Image.new("RGB", (CWD, H), lr.BG)
d = ImageDraw.Draw(img)
d.text((CWD // 2, 22), "Water layout (mockup, version 2: land and water only)", font=lr.font(20), fill=(255, 226, 150), anchor="mm")
import textwrap  # noqa: E402
for i, (k, size, p, png) in enumerate(tiles):
    col, row = i % 2, i // 2
    x, y = 20 + col * (S + 320), 50 + row * ROWH
    img.paste(Image.open(png), (x, y))
    label = NAMES[k] + ("" if p == 4 else f" ({p} players, {size}x{size})")
    d.text((x + S + 14, y + 20), label, font=fb, fill=(255, 255, 255))
    yy = y + 50
    for part in textwrap.wrap(info[k]["oneLine"], 34):
        d.text((x + S + 14, yy), part, font=f, fill=(225, 225, 225)); yy += 20
# the shared legend, three entries
y = H - 30
x = CWD // 2 - 230
d.rectangle([x, y - 9, x + 18, y + 9], fill=lr.W_LAND, outline=(14, 16, 20)); d.text((x + 26, y), "Land", font=f, fill=(235, 235, 235), anchor="lm"); x += 120
d.rectangle([x, y - 9, x + 18, y + 9], fill=lr.W_SEA, outline=(14, 16, 20)); d.text((x + 26, y), "Water", font=f, fill=(235, 235, 235), anchor="lm"); x += 130
lr.castle(d, x + 10, y, 16, lr.PCOL["red"], outline=(255, 255, 255), o=1); lr.castle(d, x + 10, y, 16, lr.PCOL["red"], outline=lr.INK, o=0)
d.text((x + 26, y), "Player start (number = player)", font=f, fill=(235, 235, 235), anchor="lm")
out = os.path.join(OUT, "water_menu_v2.png")
img.save(out, optimize=True)
print("saved", out, img.size)
