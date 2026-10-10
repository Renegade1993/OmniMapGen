"""render.py - one level of a map as a picture with a labelled coordinate grid (called by mapsight.js render).

Every object is drawn on its visiting tile, the tile a hero steps to, which is where mapsight's lists put it (drawing on
the anchor put 3-wide monsters a tile off, 2026-10-01). Measured the same evening: positions read off a 48x48 crop at
20 px a tile with a bold line every 4 tiles were exact 12 times out of 12, and off a whole 144x144 level at 8 px a tile
with a bold line every 12, exact 11 of 11 (labels that overlap get swapped). Use a crop around a coordinate the card
gave you; do not hunt for defects across a whole level by eye.

py render.py dump.json out.png [--crop x,y,w,h] [--px 20] [--pitch 4] [--mark x,y]...
"""
import argparse
import json
from PIL import Image, ImageDraw, ImageFont

ap = argparse.ArgumentParser()
ap.add_argument("dump"); ap.add_argument("out")
ap.add_argument("--crop", default=""); ap.add_argument("--px", type=int, default=0); ap.add_argument("--pitch", type=int, default=0)
ap.add_argument("--mark", action="append", default=[])
a = ap.parse_args()

d = json.load(open(a.dump, encoding="utf8"))
x0, y0, W, H = (int(v) for v in a.crop.split(",")) if a.crop else (0, 0, d["W"], d["H"])
W = min(W, d["W"] - x0); H = min(H, d["H"] - y0)
P = a.px or (20 if max(W, H) <= 60 else 8)
pitch = a.pitch or (4 if max(W, H) <= 60 else 12)
M = 34
img = Image.new("RGB", (W * P + 2 * M, H * P + 2 * M + 22), (255, 255, 255))
g = ImageDraw.Draw(img)
try:
    font = ImageFont.truetype("arial.ttf", 13); bold = ImageFont.truetype("arialbd.ttf", 12)
except OSError:
    font = bold = ImageFont.load_default()
TERR = {".": (226, 220, 196), "=": (150, 105, 60), "g": (247, 196, 196), "b": (150, 150, 140), "w": (90, 140, 210), "r": (60, 60, 60)}
for y in range(H):
    row = d["rows"][y0 + y]
    for x in range(W):
        g.rectangle([M + x * P, M + y * P, M + x * P + P - 1, M + y * P + P - 1], fill=TERR.get(row[x0 + x], (255, 0, 255)))
OBJ = {"town": (128, 0, 160), "monster": (220, 0, 0), "high": (255, 200, 0), "low": (250, 240, 150), "dwelling": (0, 160, 60),
       "mine": (0, 90, 200), "bank": (255, 120, 0), "gate": (0, 0, 0), "monolith": (0, 200, 200)}
for o in d["objects"]:
    x, y = o["at"][0] - x0, o["at"][1] - y0
    if not (0 <= x < W and 0 <= y < H) or o["cls"] not in OBJ:
        continue
    cx, cy = M + x * P + P / 2, M + y * P + P / 2
    r = P * (0.7 if o["cls"] == "town" else 0.42)
    if o["cls"] == "monster":
        g.line([cx - r, cy - r, cx + r, cy + r], fill=OBJ["monster"], width=2); g.line([cx - r, cy + r, cx + r, cy - r], fill=OBJ["monster"], width=2)
    else:
        g.rectangle([cx - r, cy - r, cx + r, cy + r], fill=OBJ[o["cls"]], outline=(0, 0, 0))
half = max(1, pitch // 2)
for k in range(0, W + 1):
    v = x0 + k
    if v % half == 0:
        X = M + k * P; b = v % pitch == 0
        g.line([X, M, X, M + H * P], fill=(0, 0, 0) if b else (120, 120, 120), width=2 if b else 1)
        if b:
            g.text((X - 8, 4), str(v), fill=(0, 0, 0), font=font); g.text((X - 8, M + H * P + 6), str(v), fill=(0, 0, 0), font=font)
for k in range(0, H + 1):
    v = y0 + k
    if v % half == 0:
        Y = M + k * P; b = v % pitch == 0
        g.line([M, Y, M + W * P, Y], fill=(0, 0, 0) if b else (120, 120, 120), width=2 if b else 1)
        if b:
            g.text((2, Y - 7), str(v), fill=(0, 0, 0), font=font); g.text((M + W * P + 4, Y - 7), str(v), fill=(0, 0, 0), font=font)
for n, m in enumerate(a.mark, 1):
    mx, my = (int(v) for v in m.split(","))
    cx, cy = M + (mx - x0) * P + P / 2, M + (my - y0) * P + P / 2
    g.ellipse([cx - P, cy - P, cx + P, cy + P], outline=(0, 0, 255), width=3)
    g.text((cx + P + 1, cy - P - 12), str(n), fill=(0, 0, 255), font=bold)
legend = "brown road, pink guard ring, grey blocked, dark rock/water; X monster, purple town, gold high loot, pale low loot, green dwelling, blue mine, orange bank, black gate, cyan monolith; blue rings = --mark"
g.text((M, M + H * P + 24), legend, fill=(0, 0, 0), font=font)
img.save(a.out)
print("saved", a.out, img.size)
