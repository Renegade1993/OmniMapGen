"""minimap.py - two whole levels side by side in game-minimap colours (called by mapsight minimap). Ours left.

py minimap.py dump.json out.png
"""
import json
import sys
from PIL import Image, ImageDraw, ImageFont

d = json.load(open(sys.argv[1], encoding="utf8"))
sides = [s for s in (d["left"], d["right"]) if s]
P = max(2, min(4, 640 // max(len(s["rows"][0]) for s in sides)))
GAP, TOP = 24, 22
Wt = sum(len(s["rows"][0]) * P for s in sides) + GAP * (len(sides) - 1)
Ht = max(len(s["rows"]) * P for s in sides) + TOP + 18
img = Image.new("RGB", (Wt, Ht), (255, 255, 255))
g = ImageDraw.Draw(img)
try:
    font = ImageFont.truetype("arialbd.ttf", 12)
except OSError:
    font = ImageFont.load_default()
PLAYER = {"red": (255, 40, 40), "blue": (40, 90, 255), "tan": (210, 170, 110), "green": (40, 170, 40), "orange": (255, 140, 30),
          "purple": (170, 60, 220), "teal": (30, 200, 200), "pink": (255, 120, 180)}
DOT = {"monster": (230, 0, 0), "high": (255, 215, 0), "dwelling": (0, 220, 90), "bank": (255, 120, 0), "mine": (60, 140, 255)}
ox = 0
for s, title in zip((d["left"], d["right"]), (d["leftTitle"], d["rightTitle"])):
    if not s:
        continue
    g.text((ox, 4), title, fill=(0, 0, 0), font=font)
    for y, row in enumerate(s["rows"]):
        for x, c in enumerate(row):
            g.rectangle([ox + x * P, TOP + y * P, ox + x * P + P - 1, TOP + y * P + P - 1], fill=tuple(c))
    for m in s["marks"]:
        x, y = m["at"]
        cx, cy = ox + x * P + P // 2, TOP + y * P + P // 2
        if m["cls"] == "town":
            col = PLAYER.get(m.get("owner") or "", (255, 255, 255))
            g.rectangle([cx - 3 * P // 2 - 2, cy - 3 * P // 2 - 2, cx + 3 * P // 2 + 2, cy + 3 * P // 2 + 2], fill=col, outline=(0, 0, 0))
        else:
            r = max(1, P // 2)
            g.rectangle([cx - r, cy - r, cx + r, cy + r], fill=DOT[m["cls"]])
    ox += len(s["rows"][0]) * P + GAP
g.text((0, Ht - 16), "terrain colour, darker = blocked, black = rock; brown road; squares towns (white neutral); dots: red guard, gold high loot, green dwelling, orange bank, blue mine", fill=(0, 0, 0))
img.save(sys.argv[2])
