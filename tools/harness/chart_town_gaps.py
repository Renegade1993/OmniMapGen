"""chart_town_gaps.py JSON OUT.png: the nearest-town walking distance histograms of town_gaps.js, one panel for start towns and one for neutral towns,
the share of towns per 5-tile bin, one bar series per label (ours against the engine). A line marks K's 15 tiles. The last bin (60 and more, or no
other town within 60) is drawn at the right, clipped, and its value written on the bar."""
import json
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

data = json.load(open(sys.argv[1], encoding="utf-8"))
labels = list(data)
colors = ["#1b6ca8", "#e08a1e", "#6b6b6b", "#2a9d5b"]
fig, axes = plt.subplots(2, 1, figsize=(11, 8.2), dpi=110)
for ax, kind, title in zip(axes, ["start", "neutral"], ["Start town: walking tiles to the nearest other town", "Neutral town: walking tiles to the nearest other neutral town"]):
    nb = len(data[labels[0]][kind])
    w = 0.8 / len(labels)
    for k, lab in enumerate(labels):
        h = data[lab][kind]
        tot = max(1, sum(h))
        pc = [100.0 * v / tot for v in h]
        xs = [i + (k - (len(labels) - 1) / 2) * w for i in range(nb)]
        ax.bar(xs, [min(p, 32) for p in pc], width=w, color=colors[k % len(colors)], label=f"{lab} ({tot} towns, {data[lab]['maps']} maps)")
        if pc[-1] > 32:
            ax.text(xs[-1], 32.4, f"{pc[-1]:.0f}%", ha="center", va="bottom", fontsize=8, color=colors[k % len(colors)])
    ax.axvline(3 - 0.5, color="#c0392b", linestyle="--", linewidth=1.2)
    ax.text(3 - 0.45, 33.5, "15 tiles", color="#c0392b", fontsize=9, va="top")
    ax.set_xticks(range(nb))
    ax.set_xticklabels([f"{i * 5}-{i * 5 + 4}" for i in range(nb - 1)] + ["60+"], fontsize=8)
    ax.set_ylim(0, 36)
    ax.set_ylabel("% of towns")
    ax.set_title(title, fontsize=11, loc="left")
    ax.spines[["top", "right"]].set_visible(False)
    ax.legend(fontsize=8, frameon=False, loc="upper center", bbox_to_anchor=(0.62, 1.0))
axes[1].set_xlabel("walking tiles (8-connected, over open ground; the last bin: 60 or more, or none)")
fig.tight_layout()
fig.savefig(sys.argv[2])
print("saved", sys.argv[2])
