"""zonesheet.py - every template zone, ours beside the engine's, one picture (called by mapsight zonesheet).

py zonesheet.py dump.json out.png
"""
import json
import sys
from PIL import Image, ImageDraw, ImageFont

d = json.load(open(sys.argv[1], encoding="utf8"))
P = int(d.get("px", 3))
pairs = d["pairs"]
try:
    font = ImageFont.truetype("arialbd.ttf", 12)
    small = ImageFont.truetype("arial.ttf", 11)
except OSError:
    font = small = ImageFont.load_default()
PLAYER = {"red": (255, 40, 40), "blue": (40, 90, 255), "tan": (210, 170, 110), "green": (40, 170, 40), "orange": (255, 140, 30),
          "purple": (170, 60, 220), "teal": (30, 200, 200), "pink": (255, 120, 180)}
DOT = {"monster": (230, 0, 0), "high": (255, 215, 0), "dwelling": (0, 220, 90), "bank": (255, 120, 0), "mine": (60, 140, 255),
       "gate": (0, 0, 0), "monolith": (0, 255, 255)}
GAP, HEAD, FOOT, PAD = 16, 18, 30, 24
COLS = 2

def size(s):
    return len(s["rows"][0]) * P, len(s["rows"]) * P

blocks = []
for pr in pairs:
    (wl, hl), (wr, hr) = size(pr["left"]), size(pr["right"])
    blocks.append((wl + GAP + wr, HEAD + max(hl, hr) + FOOT))
colw = [0] * COLS
rows = [blocks[i:i + COLS] for i in range(0, len(blocks), COLS)]
for r in rows:
    for c, (w, _) in enumerate(r):
        colw[c] = max(colw[c], w)
Wt = sum(colw) + PAD * (COLS + 1)
Ht = sum(max(h for _, h in r) for r in rows) + PAD * (len(rows) + 1) + 20
img = Image.new("RGB", (Wt, Ht), (255, 255, 255))
g = ImageDraw.Draw(img)

def draw(side, ox, oy):
    for y, row in enumerate(side["rows"]):
        for x, c in enumerate(row):
            g.rectangle([ox + x * P, oy + y * P, ox + x * P + P - 1, oy + y * P + P - 1], fill=tuple(c))
    for m in side["marks"]:
        x, y = m["at"]
        cx, cy = ox + x * P + P // 2, oy + y * P + P // 2
        if m["cls"] == "town":
            col = PLAYER.get(m.get("owner") or "", (255, 255, 255))
            g.rectangle([cx - 2 * P, cy - 2 * P, cx + 2 * P, cy + 2 * P], fill=col, outline=(0, 0, 0))
        else:
            r = max(1, P // 2)
            g.rectangle([cx - r, cy - r, cx + r, cy + r], fill=DOT[m["cls"]], outline=(0, 0, 0) if m["cls"] in ("gate", "monolith") else None)

oy = PAD
for ri, r in enumerate(rows):
    ox = PAD
    for c, (w, h) in enumerate(r):
        pr = pairs[ri * COLS + c]
        g.text((ox, oy), f"zone {pr['zone']}: OURS left, ENGINE right", fill=(0, 0, 0), font=font)
        wl, hl = size(pr["left"])
        draw(pr["left"], ox, oy + HEAD)
        draw(pr["right"], ox + wl + GAP, oy + HEAD)
        hh = max(hl, size(pr["right"])[1])
        cap = pr["caption"]
        half = cap.find("  high loot")
        g.text((ox, oy + HEAD + hh + 2), cap[:half] if half > 0 else cap, fill=(0, 0, 0), font=small)
        if half > 0:
            g.text((ox, oy + HEAD + hh + 15), cap[half + 2:], fill=(0, 0, 0), font=small)
        ox += colw[c] + PAD
    oy += max(h for _, h in r) + PAD
g.text((PAD, Ht - 18), "white line zone edge, dimmed other zones; brown road; squares towns (white neutral); dots: red guard, gold high loot, green dwelling, orange bank, blue mine, black gate, cyan monolith; counts ours/engine", fill=(0, 0, 0), font=small)
img.save(sys.argv[2])
