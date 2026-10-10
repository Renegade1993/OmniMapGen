# Coldshadow: plan for making ours match the engine (Opus Map Vision, 2026-10-01, branch opus-coldshadow)

Worktree `.tmp\opus-wt`, branch `opus-coldshadow` (from `mapsight`). Not for `main` until K and the lane accept it.
Judge every step with `tools\mapsight` against the engine's Coldshadow (`.tmp\opus-seeing\engine_matched`): report
(target 1 to 3 definite flags for this template), road ends (none improper), patches, minimap, neighbours, walk.

## Root cause of most flags (read in src/biome/content.js, 2026-10-01)

The engine's TreasurePlacer builds each pile as one rmg::Object: the pile's items packed together, its border made
blocked, one entrance left with the guard on it; ObstaclePlacer then fills the blocked border, so every pile is a pocket
cut into the scenery with a guard in its mouth. Ours simulates the same piles (`pileSim.landed`, content.js ~1927, each
with its objects and its guard) but then unpacks them into per-type counts (`pileMan`, ~1973) that separate passes place
one object at a time (`put`, ~1466, random cell, three quarters of the time against a mass edge), and posts each pile's
guard beside the dearest object of the pile's kind (`postPileGuard`, ~2851; the comment at ~2811: "Our objects are not
piles"). So objects stand alone on open floor, guards stand beside them rather than in front, and guards crowd.

## Change 1: pockets (expected to move the top flags together)

After `pileSim` (content.js ~1966), for each landed pile, richest first:
1. Site: an open cell against a mass (edgeCells) with room for the pile: a cluster of k cells (k = the pile's objects,
   each its footprint) all adjacent to blocking or to each other, plus one entrance cell E outside the cluster, open, on
   reachable ground, and not on a road, doorway or another entrance (reachOnReserved).
2. Place the pile's objects in the cluster (dearest deepest, as the engine's piles read from the mouth inward), mark
   them placed so the per-type passes take only what is left (pileMan counts less these).
3. Guarded pile: the guard stands so that its ring covers E (on E itself, which a monster may occupy); every other cell
   around the cluster that is still open becomes must-block.
4. Must-block cells go to the rim pass (rimfill.js fillRimRows), which lays whole obstacle pieces there before its own
   lobes, keeping E and the guard's approach free. Without that pass they stay open and the pocket leaks.
5. Connectivity: the pocket's walls must not cut the zone (connectivity.accepts) or weld two masses beyond what the
   engine does; a site that fails moves on.
Acceptance (mapsight report, Coldshadow): high loot sealed near the engine's 74 to 91%, dwellings sealed 85 to 100%,
guards beside walk-around loot under 5%, guards with another within 2 tiles near 0%, high loot at spur ends near 40%.

## Change 2: dragon caches as tunnels (junction zones 17 to 20)

The engine's junction zones are winding corridors 2 to 6 wide in rock; ours are round caves (mapsight shape, 4+ tiles
from a wall: engine 3 to 18%, ours 20 to 49%). Look at how ours carves a zone's free paths (plan.js, cavefit.js) and
make junction zones carve corridors (the engine's fractalize keeps tiles within about six of its free paths and blocks
the rest).

## Change 3: roads

Every road end at a town, mine, monolith or gate or a guard; no gaps between pieces; no road to a bank or loot.
mapsight card lists each improper end with coordinates.

## Change 4: monoliths and gates

Not side by side, not in town areas, sealed behind a guard (engine 100%).

## Settings

Compare ours made with the same template, size, levels and players as the engine (engine run with compOnly 0); K's
own game uses his preset and mods, checked last with `report --maps <his map> --as <id>`.
