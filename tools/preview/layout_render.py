"""Draw a template preview picture from layout_dump.js's JSON.

    from layout_render import render;  render("map.dump.json", "frame.png")

DMB Dev, 2026-11-03 (K, 2026-11-02: player starts labelled, portal lanes colour coded so they do not blend, a legend in plain words). MapGen Dev, 2026-11-04 (K,
2026-11-03: "preview images for all templates need to be: 1. Consistent look/aesthetic across previews for different templates 2. Be easy to read 3. Have clear major
symbology, like start positions (little castles, colored for player starts, grey for non)"; spec table roster\\SPEC-MapGenDev-previews-1104.md).

564x282, always, so the lobby panel (282 wide, 141 high box) halves it exactly. One look for every template: zone fills by role (treasure zones that touch
in different greens), a dark line where two zones meet, a short neutral bar across the border where a passage joins two zones (left out on a map of more than 30), a disc in the pair's colour with
the pair's number at each end of a portal pair
and a square at each gate between the levels (each link its own colour, both ends of one link the same, links that share a zone different), a castle on every
start (the player's own colour with the player's number; grey for a start with no player), a small dot on every neutral town, castles pushed apart where
they would overlap, a legend that names exactly what the picture shows, and the caption under it. No game art. Opus Reviewer's rollout review, 2026-11-04:
bars and diamonds in place of lines to the zone centres, which knotted.
"""
import json
import numpy as np
from PIL import Image, ImageDraw, ImageFont

CW, CH = 564, 282
BG = (22, 24, 30)
INK = (10, 10, 12)
SS = 3
# zone fills: blue is kept for water alone (the lead, 2026-11-04: treasure zones in blue read as sea on the water layouts)
FILL = {"start": (224, 164, 48), "cpuStart": (224, 164, 48), "treasure": (92, 176, 112), "lowLoot": (92, 176, 112), "junction": (150, 124, 200), "town": (206, 120, 92), "standard": (168, 158, 136)}
DARKEN = 0.82
WATER = (16, 44, 88)   # the sea: darker than the Treasure fill's blue so the two are never mistaken
# player colours as the game draws them; player 1 is red
PLAYERS = ["red", "blue", "tan", "green", "orange", "purple", "teal", "pink"]
PCOL = {"red": (255, 0, 0), "blue": (49, 82, 255), "tan": (156, 115, 82), "green": (66, 148, 41), "orange": (255, 132, 0), "purple": (140, 41, 165), "teal": (8, 156, 165), "pink": (198, 123, 140)}
GREY = (150, 150, 150)
NEUTRAL = (236, 236, 228)
# link colours: bright, far from each other, none of them a zone fill or a player colour
LANES = [(255, 235, 60), (255, 60, 220), (0, 230, 255), (170, 255, 0), (255, 255, 255), (255, 140, 150), (120, 255, 200), (255, 190, 90), (200, 160, 255)]
FONTS = ["C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/verdanab.ttf"]
LEGEND_FONT = 17
ROW_H = 24
CAPTION_FONT = 14
CAPTION_H = 19


def font(size):
    for f in FONTS:
        try:
            return ImageFont.truetype(f, size)
        except OSError:
            continue
    return ImageFont.load_default()


def colour_lanes(lanes):
    """one palette index per lane; lanes that share a zone get different ones (greedy, busiest lane first)"""
    keys = [((a[0], a[1]), (b[0], b[1])) for a, b in ((l["a"], l["b"]) for l in lanes)]
    nb = [set() for _ in lanes]
    for i in range(len(lanes)):
        for j in range(i + 1, len(lanes)):
            if set(keys[i]) & set(keys[j]):
                nb[i].add(j); nb[j].add(i)
    order = sorted(range(len(lanes)), key=lambda i: -len(nb[i]))
    use = [0] * len(LANES)
    col = [None] * len(lanes)
    for i in order:
        taken = {col[j] for j in nb[i] if col[j] is not None}
        free = [c for c in range(len(LANES)) if c not in taken]
        pick = min(free or range(len(LANES)), key=lambda c: use[c])
        col[i] = pick; use[pick] += 1
    return col


def castle(dr, cx, cy, h, fill, outline=INK, o=None):
    """a small castle centred on (cx, cy), h high: three towers with battlements, a gate; drawn twice, the outline grown by o first"""
    w = h * 1.15
    o = h * 0.09 if o is None else o
    L, R, T, B = cx - w / 2, cx + w / 2, cy - h / 2, cy + h / 2
    tw, mw = w * 0.30, w * 0.34
    parts = [(L, T + h * 0.22, L + tw, B), (R - tw, T + h * 0.22, R, B), (cx - mw / 2, T, cx + mw / 2, B), (L, cy, R, B)]
    for g, c in ((o, outline), (0, fill)):
        for x0, y0, x1, y1 in parts:
            dr.rectangle([x0 - g, y0 - g, x1 + g, y1 + g], fill=c)
    # battlements: a notch in the middle of each tower's top
    for x0, y0, x1, _ in parts[:3]:
        nw = (x1 - x0) * 0.34
        dr.rectangle([(x0 + x1) / 2 - nw / 2, y0, (x0 + x1) / 2 + nw / 2, y0 + h * 0.13], fill=outline)
    # the gate
    gw = w * 0.17
    dr.rectangle([cx - gw / 2, B - h * 0.30, cx + gw / 2, B], fill=outline)
    dr.ellipse([cx - gw / 2, B - h * 0.30 - gw / 2, cx + gw / 2, B - h * 0.30 + gw / 2], fill=outline)


def dashed(dr, p, q, fill, width, dash, gap):
    dx, dy = q[0] - p[0], q[1] - p[1]
    n = (dx * dx + dy * dy) ** 0.5
    if n == 0:
        return
    ux, uy = dx / n, dy / n
    t = 0.0
    while t < n:
        e = min(n, t + dash)
        dr.line([(p[0] + ux * t, p[1] + uy * t), (p[0] + ux * e, p[1] + uy * e)], fill=fill, width=width)
        t = e + gap


# treasure zones that touch each other take different greens (Opus Reviewer, 2026-11-04: Headquarters' two prizes were one colour)
TREASURE_SHADES = [(92, 176, 112), (54, 128, 78), (146, 206, 150)]


def treasure_shades(d, level):
    """zone id -> shade index for the treasure zones of one level, touching zones different (greedy, biggest first)"""
    W, H = d["W"], d["H"]
    ids = np.array(d["grid"][level], dtype=np.int32).reshape(H, W)
    tz = {z["z"]: z for z in d["zones"] if z["l"] == level and z["role"] in ("treasure", "lowLoot")}
    nb = {k: set() for k in tz}
    for a, b in ((ids[:, :-1], ids[:, 1:]), (ids[:-1, :], ids[1:, :])):
        m = (a != b)
        for x, y in set(zip(a[m].tolist(), b[m].tolist())):
            if x in tz and y in tz:
                nb[x].add(y); nb[y].add(x)
    out = {}
    for k in sorted(tz, key=lambda k: -tz[k]["n"]):
        used = {out[j] for j in nb[k] if j in out}
        out[k] = next((i for i in range(len(TREASURE_SHADES)) if i not in used), 0)
    return out


def panel_image(d, level, P):
    """the zone fills of one level as a P x P RGB image at SS times the size, with the dark borders between zones"""
    W, H = d["W"], d["H"]
    ids = np.array(d["grid"][level], dtype=np.int32).reshape(H, W)
    shade = treasure_shades(d, level)
    lut = {}
    for z in d["zones"]:
        if z["l"] == level:
            base = TREASURE_SHADES[shade[z["z"]]] if z["z"] in shade else FILL.get(z["role"], FILL["standard"])
            lut[z["z"]] = tuple(int(c * DARKEN) for c in base)
    n = P * SS
    big = np.array(Image.fromarray(ids.astype(np.int32), mode="I").resize((n, n), Image.NEAREST))
    img = np.empty((n, n, 3), dtype=np.uint8)
    img[:] = BG
    for zid, c in lut.items():
        img[big == zid] = c
    wat = d.get("water")
    if wat:
        w = np.array(wat[level], dtype=np.uint8).reshape(H, W)
        if w.any():
            mask = np.array(Image.fromarray(w * 255, mode="L").resize((n, n), Image.NEAREST)) > 127
            img[mask] = WATER
    edge = np.zeros((n, n), dtype=bool)
    for k in range(SS):
        edge[:, :-1 - k] |= big[:, :-1 - k] != big[:, 1 + k:]
        edge[:-1 - k, :] |= big[:-1 - k, :] != big[1 + k:, :]
    edge &= big >= 0
    img[edge] = (14, 16, 20)
    return Image.fromarray(img, "RGB")


def town_marks(d):
    """(empty starts, neutral towns): a start zone with no player gets a grey castle on its town nearest the zone centre (or the centre when it has none); every
    other town no player owns is a neutral town (K via the lead, 2026-11-04: grey castle = a start without a player; neutral towns a smaller, clearly different symbol)"""
    key = lambda t: (t["l"], round(t["x"], 1), round(t["y"], 1))
    taken = {key(s) for s in d["starts"]}
    played = {(s["l"], s.get("zone")) for s in d["starts"]}
    towns = [t for t in d.get("towns", []) if key(t) not in taken]
    empty, used = [], set()
    for z in d["zones"]:
        if z["role"] not in ("start", "cpuStart") or (z["l"], z["z"]) in played:
            continue
        mine = [t for t in towns if t["l"] == z["l"] and t.get("zone") == z["z"]]
        if mine:
            t = min(mine, key=lambda t: (t["x"] - z["cx"]) ** 2 + (t["y"] - z["cy"]) ** 2)
            used.add(key(t)); empty.append(t)
        else:
            empty.append({"l": z["l"], "x": z["cx"], "y": z["cy"]})
    return empty, [t for t in towns if key(t) not in used]


def spread_castles(items, at, gap, square):
    """id(item) -> drawing position: castles closer than gap pushed apart in small steps, kept inside the map square (lo, hi) (the Reviewer,
    2026-11-04: corner castles stood outside the map on the big Nostalgia frames; inside, even if they overlap a little)"""
    lo, hi = square[0] + 11 * SS, square[1] - 11 * SS
    pos = {id(t): [min(hi, max(lo, c)) for c in at(t["l"], t["x"], t["y"])] for t in items}
    for _ in range(30):
        moved = False
        for i, a in enumerate(items):
            for b in items[i + 1:]:
                if a["l"] != b["l"]:
                    continue
                pa, pb = pos[id(a)], pos[id(b)]
                dx, dy = pb[0] - pa[0], pb[1] - pa[1]
                dist = (dx * dx + dy * dy) ** 0.5
                if dist >= gap:
                    continue
                if dist < 1e-6:
                    dx, dy, dist = 1.0, 0.0, 1.0
                push = (gap - dist) / 2 + 1
                for q, sgn in ((pa, -1), (pb, 1)):
                    q[0] = min(hi, max(lo, q[0] + sgn * dx / dist * push))
                    q[1] = min(hi, max(lo, q[1] + sgn * dy / dist * push))
                moved = True
        if not moved:
            break
    return {k: tuple(v) for k, v in pos.items()}


def legend_items(d, zone, lanes):
    empty, neutral = town_marks(d)
    items = [("castle", "Player start")]
    if empty:
        items.append(("grey", "Empty start"))
    if neutral:
        items.append(("dot", "Neutral town"))
    if any(l.get("border") for l in lanes) and sum(1 for q in lanes if q.get("border")) <= 30:
        items.append(("lane", "Passage"))
    if any(l.get("portal") for l in lanes):
        items.append(("pin", "Portal pair (same number)"))
    if any(zone[tuple(l["a"])]["l"] != zone[tuple(l["b"])]["l"] and not l.get("portal") for l in lanes):
        items.append(("square", "Way between levels"))
    roles = {z["role"] for z in d["zones"]}
    if roles & {"start", "cpuStart"}:
        items.append((FILL["start"], "Start zone"))
    if roles & {"treasure", "lowLoot"}:
        items.append((FILL["treasure"], "Treasure zone"))
    if "junction" in roles:
        items.append((FILL["junction"], "Junction"))
    if "town" in roles:
        items.append((FILL["town"], "Town zone"))
    if "standard" in roles:
        items.append((FILL["standard"], "Open land"))
    if any(any(w) for w in d.get("water", [])):
        items.append((tuple(min(255, int(c / DARKEN)) for c in WATER), "Water"))   # the legend square is darkened like the zone fills, so it is given brighter
    return items


def legend_rows(items, dc, fl):
    rows, cur, width = [], [], 0
    for it in items:
        w = 26 + int(dc.textlength(it[1], font=fl)) + 16
        if cur and width + w - 16 > CW - 16:
            rows.append(cur); cur, width = [], 0
        cur.append((it, w)); width += w
    if cur:
        rows.append(cur)
    return rows


def render(dump_path, out_path, caption=None):
    """caption: one line drawn under the legend (the frame's settings); None draws none"""
    d = json.load(open(dump_path, encoding="utf-8")) if isinstance(dump_path, str) else dump_path
    W, H, NL = d["W"], d["H"], d["NL"]
    zone = {(z["l"], z["z"]): z for z in d["zones"]}
    lanes = [l for l in d["lanes"] if tuple(l["a"]) in zone and tuple(l["b"]) in zone]
    probe = ImageDraw.Draw(Image.new("RGB", (CW, CH)))
    fl = font(LEGEND_FONT)
    items = legend_items(d, zone, lanes)
    rows = legend_rows(items, probe, fl)
    legend_h = ROW_H * len(rows) + 6 + (CAPTION_H if caption else 0)
    title_h = 16 if NL == 2 else 0
    P = CH - legend_h - title_h
    PAD = 14   # room round the map so a castle on the edge is not cut
    MP = P - 2 * PAD
    gap = 10
    total = P * NL + gap * (NL - 1)
    x0 = (CW - total) // 2
    ox = [x0 + l * (P + gap) for l in range(NL)]
    canvas = Image.new("RGB", (CW, CH), BG)
    panels = []
    for l in range(NL):
        mp = panel_image(d, l, MP)
        pi = Image.new("RGB", (P * SS, P * SS), BG)
        pi.paste(mp, (PAD * SS, PAD * SS))
        panels.append((pi, ImageDraw.Draw(pi)))
    cols = colour_lanes(lanes)
    s = MP * SS / W  # high-resolution pixels per tile

    def at(l, x, y):
        return (x * s + PAD * SS, y * s + PAD * SS)
    # links (Opus Reviewer, 2026-11-04: lines to the zone centres knotted): a passage is a short bar across the border where its zones meet, a
    # portal a diamond at each of its two monolith ends, a way between levels a square at each gate; each link its own colour, the two ends of
    # one link the same, links that share a zone different
    marks = {}   # (level, zone) -> count of symbols placed at a zone centre for want of a real position

    def centre_spot(z):
        k = marks.get((z["l"], z["z"]), 0); marks[(z["l"], z["z"])] = k + 1
        p = at(z["l"], z["cx"], z["cy"])
        return (p[0] + (k % 3 - 1) * 2.6 * 6 * SS, p[1] + (k // 3) * 2.6 * 6 * SS)
    marksym = []
    pnum = 0
    for lane, ci in zip(lanes, cols):
        a, b = zone[tuple(lane["a"])], zone[tuple(lane["b"])]
        if lane.get("portal"):
            ends = lane.get("portalEnds") or [None, None]
            pnum += 1
            for e, z in enumerate((a, b)):
                pos = (ends[e][0], at(ends[e][0], ends[e][1], ends[e][2])) if ends[e] else (z["l"], centre_spot(z))
                marksym.append(("pin", pos[0], pos[1], ci, pnum))
        elif a["l"] != b["l"]:
            for e, z in enumerate((a, b)):
                pos = (lane["ends"][e][0], at(lane["ends"][e][0], lane["ends"][e][1], lane["ends"][e][2])) if lane.get("ends") else (z["l"], centre_spot(z))
                marksym.append(("square", pos[0], pos[1], ci))
        elif lane.get("border") and sum(1 for q in lanes if q.get("border")) <= 30:   # on a map of more than 30 passages the zone borders already show them
            l0, bx, by, dx, dy = lane["border"]
            marksym.append(("bar", l0, at(l0, bx, by), ci, (dx, dy), lane["wide"]))
    for m in marksym:
        kind, lv, (px, py), ci = m[0], m[1], m[2], m[3]
        dr = panels[lv][1]
        h = 6 * SS
        if kind == "bar":   # a thin neutral bar: bars never cross, so no colour is needed to tell them apart (K item 31 readability, the Reviewer's pass)
            (dx, dy), wide = m[4], m[5]
            half = 7 * SS
            wb = (4 if wide else 3) * SS
            p0, p1 = (px - dx * half, py - dy * half), (px + dx * half, py + dy * half)
            dr.line([p0, p1], fill=INK, width=wb + 2 * SS)
            dr.line([p0, p1], fill=(250, 240, 210), width=wb)
        elif kind == "pin":   # a portal end: a disc in the pair's colour with the pair's number, the same at both ends (item 2 colour, item 31 readability)
            r = 6.5 * SS
            dr.ellipse([px - r - 1.5 * SS, py - r - 1.5 * SS, px + r + 1.5 * SS, py + r + 1.5 * SS], fill=INK)
            dr.ellipse([px - r, py - r, px + r, py + r], fill=LANES[ci])
            dr.text((px, py), str(m[4]), font=font(int(9 * SS)), fill=INK, anchor="mm")
        elif kind == "diamond":
            dr.polygon([(px, py - h - 2 * SS), (px + h + 2 * SS, py), (px, py + h + 2 * SS), (px - h - 2 * SS, py)], fill=INK)
            dr.polygon([(px, py - h), (px + h, py), (px, py + h), (px - h, py)], fill=LANES[ci])
        else:
            dr.rectangle([px - h - SS, py - h - SS, px + h + SS, py + h + SS], fill=INK)
            dr.rectangle([px - h, py - h, px + h, py + h], fill=LANES[ci])
    # towns: grey castles for towns no player owns, then the player castles on top, each with the player's number under it
    empty, neutral = town_marks(d)
    spot = spread_castles(d["starts"] + empty, at, 26 * SS, (PAD * SS, (PAD + MP) * SS))
    for t in neutral:   # a neutral town: a small light dot with a dark ring
        p = at(t["l"], t["x"], t["y"])
        r0 = 3.2 * SS
        panels[t["l"]][1].ellipse([p[0] - r0 - 1.5 * SS, p[1] - r0 - 1.5 * SS, p[0] + r0 + 1.5 * SS, p[1] + r0 + 1.5 * SS], fill=INK)
        panels[t["l"]][1].ellipse([p[0] - r0, p[1] - r0, p[0] + r0, p[1] + r0], fill=NEUTRAL)
    for t in empty:   # a start position with no player: the start castle in grey, no number
        p = spot[id(t)]
        castle(panels[t["l"]][1], p[0], p[1], 20 * SS, GREY)
    fn = font(12 * SS)
    for st in sorted(d["starts"], key=lambda t: t["colour"]):
        dr = panels[st["l"]][1]
        p = spot[id(st)]
        hc = 22 * SS
        c = PCOL.get(st["colour"], GREY)
        castle(dr, p[0], p[1] - 4 * SS, hc, c, outline=(255, 255, 255), o=1.4 * SS)
        castle(dr, p[0], p[1] - 4 * SS, hc, c, outline=INK, o=0)   # inner battlements and gate in dark, the white edge stays round the outside
        label = str(PLAYERS.index(st["colour"]) + 1) if st["colour"] in PLAYERS else "?"
        dr.text((p[0], p[1] + hc / 2 + 1 * SS), label, font=fn, fill=(255, 255, 255), anchor="mm", stroke_width=SS + 1, stroke_fill=INK)
    for l in range(NL):
        pi = panels[l][0].resize((P, P), Image.LANCZOS)
        canvas.paste(pi, (ox[l], title_h))
    dc = ImageDraw.Draw(canvas)
    if NL == 2:
        ft = font(14)
        for l, name in enumerate(("Surface", "Underground")):
            dc.text((ox[l] + P // 2, 1), name, font=ft, fill=(255, 255, 255), anchor="mt", stroke_width=1, stroke_fill=INK)
    # legend: what this picture shows, in plain words
    y0 = CH - legend_h + 4
    for r, row in enumerate(rows):
        x = (CW - (sum(w for _, w in row) - 16)) // 2
        y = y0 + r * ROW_H + ROW_H // 2
        for (kind, text), w in row:
            if kind == "castle":
                castle(dc, x + 10, y, 16, PCOL["red"], outline=(255, 255, 255), o=1)
                castle(dc, x + 10, y, 16, PCOL["red"], outline=INK, o=0)
            elif kind == "grey":
                castle(dc, x + 10, y, 15, GREY)
            elif kind == "dot":
                dc.ellipse([x + 4, y - 7, x + 18, y + 7], fill=INK); dc.ellipse([x + 6, y - 5, x + 16, y + 5], fill=NEUTRAL)
            elif kind == "lane":
                dc.line([(x + 5, y), (x + 17, y)], fill=INK, width=6)
                dc.line([(x + 5, y), (x + 17, y)], fill=(250, 240, 210), width=4)
            elif kind == "pin":
                dc.ellipse([x + 3, y - 9, x + 21, y + 9], fill=INK); dc.ellipse([x + 5, y - 7, x + 19, y + 7], fill=LANES[0]); dc.text((x + 12, y), "1", font=font(11), fill=INK, anchor="mm")
            elif kind == "portal":
                dashed(dc, (x, y), (x + 20, y), INK, 7, 6, 3)
                dashed(dc, (x, y), (x + 20, y), LANES[0], 4, 6, 3)
            elif kind == "diamond":
                dc.polygon([(x + 11, y - 9), (x + 20, y), (x + 11, y + 9), (x + 2, y)], fill=INK); dc.polygon([(x + 11, y - 6), (x + 17, y), (x + 11, y + 6), (x + 5, y)], fill=LANES[0])
            elif kind == "square":
                dc.rectangle([x + 3, y - 8, x + 19, y + 8], fill=INK); dc.rectangle([x + 5, y - 6, x + 17, y + 6], fill=LANES[0])
            else:
                dc.rectangle([x + 2, y - 8, x + 20, y + 8], fill=tuple(int(c * DARKEN) for c in kind), outline=(14, 16, 20))
            dc.text((x + 26, y), text, font=fl, fill=(235, 235, 235), anchor="lm")
            x += w
    if caption:
        fc = font(CAPTION_FONT)
        dc.text((CW // 2, CH - CAPTION_H // 2 - 1), caption, font=fc, fill=(255, 226, 150), anchor="mm")
    canvas.save(out_path, optimize=True)
    return {"zones": len(zone), "lanes": len(lanes), "portals": sum(1 for l in lanes if l.get("portal")), "starts": len(d["starts"]), "towns": len(d.get("towns", [])),
            "legend": [t for _, t in items]}


if __name__ == "__main__":
    import sys
    print(render(sys.argv[1], sys.argv[2]))
