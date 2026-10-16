"""zonemap.py - draws the zone picture of lib/zonemap.js (called by mapsight.js zonemap): each map's level 0, land coloured by the zone's role,
the sea blue, borders black, labels with the zone id and land share, a red outline on a zone of 60+ cells under 40% land, white squares for the
starts, a white line from the middle of each zone's cells to the middle of its land, a legend along the top.

py zonemap.py dump.json out.png
"""
import json
import sys
from PIL import Image, ImageDraw, ImageFont

ROLE = {
    "start": (214, 72, 64), "empty start slot": (176, 150, 130), "neutral town": (236, 150, 48), "high loot": (232, 205, 70),
    "low loot": (150, 196, 98), "standard": (196, 182, 140), "junction": (150, 90, 180),
}
SEA = (52, 98, 168)
maps = json.load(open(sys.argv[1], encoding="utf8"))
P = max(2, min(6, 900 // max(m["W"] for m in maps)))
HEAD, GAP, LEG = 22, 10, 26
Wt = sum(m["W"] * P for m in maps) + GAP * (len(maps) - 1)
Ht = LEG + HEAD + max(m["H"] for m in maps) * P
img = Image.new("RGB", (Wt, Ht), (24, 24, 24))
g = ImageDraw.Draw(img)
try:
    font = ImageFont.truetype("arial.ttf", 12); bold = ImageFont.truetype("arialbd.ttf", 12)
except OSError:
    font = bold = ImageFont.load_default()
# legend
lx = 6
for name, col in list(ROLE.items()) + [("sea", SEA)]:
    g.rectangle([lx, 7, lx + 12, 19], fill=col, outline=(0, 0, 0)); g.text((lx + 16, 6), name, fill=(235, 235, 235), font=font)
    lx += 22 + int(g.textlength(name, font=font)) + 10
g.text((lx, 6), "white line: zone middle to land middle; red outline: 60+ cells under 40% land; diamond: dragon dwelling", fill=(200, 200, 200), font=font)

x0 = 0
for m in maps:
    W, H, zone, wet = m["W"], m["H"], m["zone"], m["wet"]
    role = {z["z"]: z["role"] for z in m["zones"]}
    flag = {z["z"] for z in m["zones"] if z["flag"]}
    top = LEG + HEAD
    for y in range(H):
        for x in range(W):
            i = y * W + x
            z = zone[i]
            col = SEA if wet[i] else ROLE.get(role.get(z, "standard"), (128, 128, 128))
            if not wet[i] and z in flag:
                col = tuple(min(255, int(c * 0.75 + 255 * 0.25)) for c in col)
            g.rectangle([x0 + x * P, top + y * P, x0 + x * P + P - 1, top + y * P + P - 1], fill=col)
    # borders
    for y in range(H):
        for x in range(W):
            z = zone[y * W + x]
            if x + 1 < W and zone[y * W + x + 1] != z:
                g.line([x0 + (x + 1) * P, top + y * P, x0 + (x + 1) * P, top + (y + 1) * P - 1], fill=(0, 0, 0), width=1)
            if y + 1 < H and zone[(y + 1) * W + x] != z:
                g.line([x0 + x * P, top + (y + 1) * P, x0 + (x + 1) * P - 1, top + (y + 1) * P], fill=(0, 0, 0), width=1)
    # red outline for flagged zones: their border cells
    for y in range(H):
        for x in range(W):
            z = zone[y * W + x]
            if z in flag and any(0 <= x + dx < W and 0 <= y + dy < H and zone[(y + dy) * W + x + dx] != z for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                g.rectangle([x0 + x * P, top + y * P, x0 + x * P + P - 1, top + y * P + P - 1], fill=(230, 40, 40))
    for z in m["zones"]:
        cx, cy = z["c"]
        if z["lc"]:
            lxx, lyy = z["lc"]
            g.line([x0 + cx * P, top + cy * P, x0 + lxx * P, top + lyy * P], fill=(255, 255, 255), width=2)
        label = f"z{z['z']} {round(100 * z['share'])}%"
        tw = g.textlength(label, font=bold)
        tx, ty = x0 + cx * P - tw / 2, top + cy * P - 7
        g.rectangle([tx - 2, ty - 1, tx + tw + 2, ty + 13], fill=(0, 0, 0))
        g.text((tx, ty), label, fill=(255, 255, 255), font=bold)
    for dx, dy in m.get("dragons", []):
        X, Y = x0 + dx * P + P / 2, top + dy * P + P / 2
        g.polygon([(X, Y - 6), (X + 6, Y), (X, Y + 6), (X - 6, Y)], fill=(255, 255, 255), outline=(0, 0, 0))
    for sx, sy in m["starts"]:
        g.rectangle([x0 + sx * P - 4, top + sy * P - 4, x0 + sx * P + 4, top + sy * P + 4], outline=(255, 255, 255), width=2)
    nflag = len(flag)
    g.text((x0 + 4, LEG + 4), f"{m['name']}  zones under 40% land: {nflag}", fill=(255, 255, 255), font=bold)
    x0 += W * P + GAP
img.save(sys.argv[2])
print(sys.argv[2], img.size)
