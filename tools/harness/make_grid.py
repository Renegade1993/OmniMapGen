"""make_grid.py - the run grid for the engine-against-ours harness (K, 2026-10-01).

Reads the engine's own template table (templates.txt, from `VCMI_rmg.exe --list-templates`: name, players,
humans, min size, max size, water allowed, zone count) and writes a grid of jobs, each legal for its
template, so every run is a setting the engine itself offers.

  tier1   every template at its smallest legal size and level count, 4 players (or the template's own
          range), default water and monsters (weak, the engine's Normal of the calibration)
  sizes   every template at its smallest, middle and largest legal size
  levels  every template with two levels where it allows both
  water   every template that allows it, water Normal and Islands
  players every template at its smallest and largest player count
  monsters every template at weak, normal and strong monsters

usage: py make_grid.py <templates.txt> <tier> <out grid.json> [--only "A,B"] [--seeds 1,2,3,4,5,6,7,8]
"""
import json
import re
import sys


def parse_range(s):
    # "2-8" or "2" or "1-2,4": the numbers it allows
    out = []
    for part in s.split(","):
        part = part.strip()
        if not part:
            continue
        m = re.match(r"^(\d+)-(\d+)$", part)
        if m:
            out.extend(range(int(m.group(1)), int(m.group(2)) + 1))
        elif part.isdigit():
            out.append(int(part))
    return sorted(set(out))


def load(path):
    rows = []
    for line in open(path, encoding="utf8"):
        f = line.rstrip("\n").split("\t")
        if len(f) < 9 or f[0] != "TEMPLATE":
            continue
        mn = [int(x) for x in f[5].split(",")]
        mx = [int(x) for x in f[6].split(",")]
        rows.append({
            "template": f[1], "players": parse_range(f[3]), "humans": parse_range(f[4]),
            "min": mn, "max": mx, "water": [int(x) for x in f[7].split(",") if x != ""], "zones": int(f[8]),
        })
    return rows


def sizes_of(t):
    (w0, h0, l0), (w1, h1, l1) = t["min"], t["max"]
    out = [(w0, h0)]
    if (w1, h1) != (w0, h0):
        mid = ((w0 + w1) // 2 // 36 * 36 or w0, (h0 + h1) // 2 // 36 * 36 or h0)
        out += [mid, (w1, h1)]
    seen, res = set(), []
    for s in out:
        if s not in seen:
            seen.add(s)
            res.append(s)
    return res


def players_default(t):
    p = t["players"] or [2]
    want = 4
    cand = [x for x in p if x <= want]
    return max(cand) if cand else min(p)


def job(t, w, h, levels, players, water, monsters, tag):
    jid = re.sub(r"[^A-Za-z0-9]+", "_", t["template"]).strip("_")
    return {"id": f"{jid}_{w}x{h}_L{levels}_p{players}_w{water}_m{monsters}", "template": t["template"],
            "w": w, "h": h, "levels": levels, "players": players, "water": water, "monsters": monsters, "tier": tag}


def make(rows, tier):
    jobs = []
    for t in rows:
        (w0, h0), l0 = t["min"][:2], t["min"][2]
        lv_all = sorted({t["min"][2], t["max"][2]})
        p = players_default(t)
        if tier == "tier1":
            jobs.append(job(t, w0, h0, l0, p, 0, -1, tier))
        elif tier == "sizes":
            for (w, h) in sizes_of(t):
                jobs.append(job(t, w, h, l0, p, 0, -1, tier))
        elif tier == "levels":
            for lv in lv_all:
                jobs.append(job(t, w0, h0, lv, p, 0, -1, tier))
        elif tier == "water":
            for wc in (1, 2):
                if wc in t["water"]:
                    jobs.append(job(t, w0, h0, l0, p, wc, -1, tier))
        elif tier == "players":
            for pc in sorted({min(t["players"] or [2]), max(t["players"] or [2])}):
                jobs.append(job(t, w0, h0, l0, pc, 0, -1, tier))
        elif tier == "monsters":
            for m in (-1, 0, 1):
                jobs.append(job(t, w0, h0, l0, p, 0, m, tier))
        else:
            raise SystemExit("unknown tier " + tier)
    return jobs


def main():
    args = sys.argv[1:]
    only = None
    seeds = [1, 2, 3, 4, 5, 6, 7, 8]
    for i, a in enumerate(list(args)):
        if a == "--only":
            only = [x.strip() for x in args[i + 1].split(",")]
        if a == "--seeds":
            seeds = [int(x) for x in args[i + 1].split(",")]
    src, tier, out = args[0], args[1], args[2]
    rows = load(src)
    if only:
        rows = [r for r in rows if r["template"] in only]
    jobs = make(rows, tier)
    json.dump({"name": tier, "seeds": seeds, "jobs": jobs}, open(out, "w", encoding="utf8"), indent=1)
    print(f"{tier}: {len(rows)} templates, {len(jobs)} jobs x {len(seeds)} seeds = {len(jobs) * len(seeds)} runs per side -> {out}")


if __name__ == "__main__":
    main()
