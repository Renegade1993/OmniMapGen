"""A contact sheet of preview frames with their captions, for looking at a gif's frames side by side (MapGen Dev, 2026-11-04; spec table 30.1 check).

    py sheet.py OUT.png FRAMES.json [FRAMES.json ...] [--first] [--cols 2] [--half]

Each frames.json is gallery.py's <slug>.frames.json; the pictures are read from beside it. --first takes only frame 1 of each (the still pictures of every template
side by side); --half draws every frame at the lobby panel's own 282x141.
"""
import json
import os
import sys
from PIL import Image, ImageDraw, ImageFont


def main():
    a = sys.argv[1:]
    first, half = "--first" in a, "--half" in a
    cols = int(a[a.index("--cols") + 1]) if "--cols" in a else 2
    files = [x for x in a[1:] if x.endswith(".json")]
    tiles = []
    for fj in files:
        d = json.load(open(fj, encoding="utf-8"))
        frames = d["frames"][:1] if first else d["frames"]
        for f in frames:
            tiles.append((os.path.join(os.path.dirname(fj), f["file"]), "%d. %s%s" % (f["order"], f["caption"], "" if f.get("preferred", True) else "  (varied)")))
    w, h = (282, 141) if half else (564, 282)
    caph = 22
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * (w + 8) + 8, rows * (h + caph + 8) + 8), (40, 42, 48))
    dr = ImageDraw.Draw(sheet)
    try:
        ft = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 13)
    except OSError:
        ft = ImageFont.load_default()
    for i, (p, cap) in enumerate(tiles):
        x, y = 8 + (i % cols) * (w + 8), 8 + (i // cols) * (h + caph + 8)
        im = Image.open(p).convert("RGB")
        sheet.paste(im.resize((w, h), Image.LANCZOS) if half else im, (x, y))
        dr.text((x, y + h + 4), cap, font=ft, fill=(230, 230, 230))
    sheet.save(a[0])
    print(a[0], len(tiles), "frames")


if __name__ == "__main__":
    main()
