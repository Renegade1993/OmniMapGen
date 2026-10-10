"""pair.py - two map patches side by side at the same scale (called by mapsight patches). Ours left, engine right.

py pair.py dump.json out.png
"""
import json
import sys
from PIL import Image, ImageDraw, ImageFont

d = json.load(open(sys.argv[1], encoding="utf8"))
S = d["s"]; P = 22; M = 30; GAP = 40; TOP = 22
img = Image.new("RGB", (2 * (S * P + 2 * M) + GAP, S * P + 2 * M + TOP + 20), (255, 255, 255))
g = ImageDraw.Draw(img)
try:
    font = ImageFont.truetype("arial.ttf", 12); bold = ImageFont.truetype("arialbd.ttf", 12)
except OSError:
    font = bold = ImageFont.load_default()
TERR = {".": (226, 220, 196), "=": (150, 105, 60), "g": (247, 196, 196), "b": (150, 150, 140), "r": (60, 60, 60)}
OBJ = {"town": (128, 0, 160), "monster": (220, 0, 0), "high": (255, 200, 0), "low": (250, 240, 150), "dwelling": (0, 160, 60),
       "mine": (0, 90, 200), "bank": (255, 120, 0), "gate": (0, 0, 0), "monolith": (0, 200, 200), "other": (180, 110, 220)}
for side, ox in (("left", 0), ("right", S * P + 2 * M + GAP)):
    p = d[side]
    g.text((ox + M, 4), ("OURS  " if side == "left" else "ENGINE  ") + p["title"], fill=(0, 0, 0), font=bold)
    for y, row in enumerate(p["rows"]):
        for x, c in enumerate(row):
            X, Y = ox + M + x * P, TOP + M + y * P
            g.rectangle([X, Y, X + P - 1, Y + P - 1], fill=TERR.get(c, (255, 0, 255)))
    for o in p["objects"]:
        x, y = o["at"][0] - p["x0"], o["at"][1] - p["y0"]
        cx, cy = ox + M + x * P + P / 2, TOP + M + y * P + P / 2
        r = P * (0.7 if o["cls"] == "town" else 0.42)
        if o["cls"] == "monster":
            g.line([cx - r, cy - r, cx + r, cy + r], fill=OBJ["monster"], width=2); g.line([cx - r, cy + r, cx + r, cy - r], fill=OBJ["monster"], width=2)
        elif o["cls"] in OBJ:
            g.rectangle([cx - r, cy - r, cx + r, cy + r], fill=OBJ[o["cls"]], outline=(0, 0, 0))
    for k in range(0, S + 1, 2):
        b = (p["x0"] + k) % 4 == 0
        X = ox + M + k * P
        g.line([X, TOP + M, X, TOP + M + S * P], fill=(0, 0, 0) if b else (140, 140, 140), width=1)
        if b: g.text((X - 6, TOP + M - 14), str(p["x0"] + k), fill=(0, 0, 0), font=font)
        b = (p["y0"] + k) % 4 == 0
        Y = TOP + M + k * P
        g.line([ox + M, Y, ox + M + S * P, Y], fill=(0, 0, 0) if b else (140, 140, 140), width=1)
        if b: g.text((ox + 2, Y - 7), str(p["y0"] + k), fill=(0, 0, 0), font=font)
g.text((M, TOP + 2 * M + S * P + 2), "brown road, pink guard ring, grey blocked, dark rock/water; X monster, purple town, gold high loot, pale low loot, green dwelling, blue mine, orange bank, violet small building", fill=(0, 0, 0), font=font)
img.save(sys.argv[2])
