# mapsight: see a map as structure

Built 2026-10-01 by the Opus Map Vision teammate after K played Coldshadow and found no neutral dragon dwellings
where he expected them, roads that stop short or T into nothing, high-value loot lying unguarded, players starting
underground, and snow wells on wasteland, while the lane's ratios all looked right. Research behind it, with the
measurements: the project's research note "Opus Seeing The Map" of 2026-10-01 (not in this repository).

The rule this folder exists for: a generator change is judged by structure in place (where things are, what a road
reaches, what guards what, what a hero can walk to, which level and zone), measured the same way on the engine's own
maps, never by a count or ratio alone.

## START HERE: dialling the generator into a template (for the agent tuning OmniMapGen)

K, 2026-10-01: the suite must let the MapGen agent "dial our generator into any template, reproduce it exactly even with
the right settings, and have complete clarity about all content, relationships, statistics", and "definitely tell when
a road ends improperly". The loop, every time:

1. Engine reference, once per template and settings. Use exactly the requested players: the harness's engine job left
   computer-only players at random and VCMI then filled every start zone (27 templates got 6 to 8 players where ours
   makes 4). `tools\rmgdump` now takes `"compOnly": 0`; the matched reference set built 2026-10-01 is
   `.tmp\opus-seeing\engine_matched` (tier-1 engine maps, the 27 replaced by 4 exact-player seeds each, made with
   `VCMI\rmgrun\VCMI_rmgconv.exe`). For new settings, run the engine with compOnly 0 (see `.tmp\opus-seeing\eng0.py`).
2. Ours: generate 2 to 8 seeds from a frozen copy of the generator with the same template, size, levels, players, water
   and monsters (`tools\harness\run_grid.py --only-side ours --gen-root <frozen copy>`).
3. `node tools/mapsight/mapsight.js report --engine <engine dir> --ours <ours dir> --match '^<template id>$' --out <dir>`
   (drop --match for every template; an index.md ranks them and lists what is wrong on most templates).
4. Read the template's report top to bottom:
   - TARGET line: what a real engine map of this template scores against the other engine seeds (definite flags and
     fixed-check failures). Ours is dialled in when it scores inside that. Across the 93 tier-1 templates the target is
     about 1 to 8; ours scored a median of 23 (2026-10-01).
   - Settings: size, levels and start slots must match the engine's. Fix the settings before anything else.
   - Fixed checks: road ends (at nothing, at an object, gaps), sealing, dragons, starts. Any FAIL is real.
   - Spatial relationships: DEFINITE flags are differences fewer than 1 in 100 real engine maps show; each has the
     coordinates in ours (and, where ours has too little, an engine example) to open with `near` and `render --crop`.
   - Content per 1000 tiles: MISSING (on 3 of 4 engine seeds, none in ours), EXTRA (in ours, on no engine seed), and
     counts that are off.
   - Improper road ends of ours, each with coordinates.
5. Before changing the generator, open the top flags as crops of ours and of the engine at the same scale and write what
   each shows. Then change the generator, regenerate, rerun the report. Repeat until inside the target.
6. Last, a map from K's own route (his game writes it to `Documents\My Games\Dead Man's Boots\Maps\RandomMaps`):
   `report ... --maps <that map> --as <template id>`. His game uses his mods; the harness runs core content.

Speed: profiles are cached (`.tmp\mapsight\cache`, keyed by the map and by the source of sight.js, relations.js and
profile.js); 930 maps profile in about 40 s, a full 93-template report in a minute or two.
Limits: on 36x36 maps many measures have fewer than 5 objects and are skipped, so a small template passes more easily
than it should; zones are compared as guard-bounded areas (ours numbers its zones unlike the template); guard strength
is compared by creature level, not AI value; the reference is the engine's own generator, and the original hand-made
maps are a reference column only.

## Fix loop: one number, then the biggest failing family, then the code (works today)

K, 2026-10-01: "make it systemic so the other agent can employ your methods". This is the loop that took Coldshadow's
Fantasy from 64.8% to 84%+ the same day. Each turn of it is one generator change, measured on 8 seeds.

1. Score. `mapsight score --ours <8 of ours> --engine <the template's engine maps> --show 60`. The headline MATCH is the
   share of features inside the engine's own spread, each family weighted the same; the line under it gives the engine
   scored against itself (about 94 to 98%). That is the target. Every feature outside its line is listed with ours'
   median, the engine's median and range.
2. Under the list, "Where to look" groups the failing features by cause (`lib/guide.js`), biggest summed score first.
   Each group names what to run to see the cases and the generator code that decides them, with the switch that turns
   the current fix off. Take the top group.
3. See it before touching code. Run the `see:` commands on one of ours and one engine map: `near` at the coordinates
   (`profile(...).examples` holds up to 8 per relation), `zones` for zone links and counts, `guards`, `patches`.
   Write down what the cases show in words. If you cannot say what is physically different, you are not ready to edit.
4. Find the pass that did it. Generate that one seed with traces on (`VMAPGEN_DROP_TRACE=all`, `VMAPGEN_WALL_TRACE=cells`,
   `VMAPGEN_GATE_TRACE=1`, `VMAPGEN_SEAL_TRACE=1`, `VMAPGEN_TOWN_TRACE=1`) and find the tile in the log: every pass that
   opens a wall, drops an object or places a gate says where. `.tmp\opus-seeing\one_ours.py OUT SEED KEY=VALUE...` makes
   one Coldshadow map from the worktree generator and saves the full log beside it.
5. Change the code, behind a `VMAPGEN_...=0` switch for the old behaviour, with a comment naming the measurement.
6. Check the one seed (the same trace, the counts that matter: `.tmp\opus-seeing\leaks.js` for zone links, towns, gates,
   monoliths), then all 8 seeds and the score (`.tmp\opus-seeing\cycle.sh NAME` does generate, leaks, warnings and
   score in about 25 minutes). Read the warnings file as well as the score: a fix that raises one family can empty a
   zone (it happened: 52.5% after the first leak fix, every zone's towns "found no room").
7. Commit when the score rises and nothing new broke. Next family.

What the Coldshadow turns found, as examples of the kind of cause each family has (2026-10-01):

| family | cause found | fix |
|---|---|---|
| zone graph (12.5 non-template links a map, engine 1) | the level was forced into one piece; gate sites on zone borders held the wall open; the pocket and dig passes cut walls to reach pieces joined only through the other level | plan.js splitLevels, zonePieces, cross-level sweepStranded, clearOfBorder |
| zone (towns, mines at 0) | the fill only used the piece holding the first start | fillLevel reach = zonePieces on a split level |
| relation: gate/monolith sealed behind a guard | the guard stood on an end approach tile | guardEnd and postGuard take the tile whose ring covers the approach |
| relation: monolith side by side | every portal took the open cell nearest its zone's centre | zoneCell keeps 4 tiles from other gates and monoliths |
| relation: loot sealed behind a guard | loot is laid out one by one and the pocket wall stops at a neighbour's approach | sealTarget absorbs loose neighbours (SEAL_ABSORB); the rest needs pile placement like the engine's |

## Random discovery: patches beside the engine (works today)

    node tools/mapsight/mapsight.js patches --ours <our map>... --engine <engine dir> --match '^<template id>_s' --n 10 --out <dir> [--seed N]

K, 2026-10-01: random 20x20 patches, "especially if its also looking at a reference map beside it to try and match a zone
from ours to it". For each map of ours, n patches at random on walkable ground, spread over levels and kinds of area;
each paired with the engine patch of the same level and kind of area whose walls, walkable ground, water and distance to a
town are closest, so the content and layout are free to differ. `patches.md` has, per pair, the ranked count differences,
both text maps side by side (T town, M monster, H high loot, l low loot, D dwelling, N mine, K bank, G gate, O monolith,
s small building, = road, # wall, % scattered obstacle, ! guard ring, ~ water or rock), and every object with its
relationships (against a wall or on open floor, sealed or reachable, what each guard stands next to). `p*.png` are the
pictures, ours left. Read the text first; open a picture when the text shows something no measure names, then turn it
into a measure (relations.js) and confirm it on the engine's maps. 10 maps x 10 patches is a few seconds.
Found this way so far: guards clustered, gates bunched near towns, small buildings in clumps (each now a measure).

## Minimap: the whole map at a glance, ours beside the engine's (works today)

    node tools/mapsight/mapsight.js minimap --ours <our map> --engine <engine map of the same template> --out <dir> [--cell 4]

K, 2026-10-01: "what about a minimap snapshot comparison". Per level: `minimap_levelN.png` (both maps in game-minimap
colours, darker where blocked, roads, towns, guards, prizes) and `minimap.md` with a text minimap (one character per 4x4
tiles: T town, ~ water, ^ rock, # mostly wall, $ 3+ loot, M 2+ guards, = road, . open ground, : walkable between walls)
and layout numbers that compare across seeds: share of each cell kind, open and walled stretches (count, mean, largest),
and clumping (Clark-Evans ratio: under 1 clumped, 1 random, over 1 evenly spread) of loot, guards, dwellings and banks.
Found on 4 templates x 2 seeds (2026-10-01): the engine spaces guards evenly (1.8 to 2.35, ours 1.25 to 1.41) and
dwellings and banks too (1.4 to 2.0, ours 0.9 to 1.5); its walls join into one network (largest walled stretch 2 to 4
times ours) and its open stretches are smaller (largest 4 to 16 cells, ours 16 to 48). Loot clumping does not differ.
Zone outlines (ours smooth and convex, the engine's ragged) are measured by tools/map_metrics.js (biome compactness and
convexity).

## Zone sheet: every template zone, ours beside the engine's (works today)

    node tools/mapsight/mapsight.js zonesheet --ours <our map> --engine <engine map> --out <dir> [--zones 1,9,17] [--px 3]

K, 2026-10-02, a design directive: keep inventing ways to see the difference, easy for the next agent to use, and
never only numbers: "be sure also not to forsake visual cohesiveness comparisons". `zonesheet.png`: each template zone
on the level that holds most of it, ours left and the engine's right, both at the same pixels a tile, the zone's edge in
white and other zones dimmed, towns, guards, high loot, dwellings, banks, mines, gates and monoliths marked, a line of
counts under each pair. `zonesheet.md`: the same counts as a table (ours/engine). Needs a zone tile map on both sides.
The first sheet (Coldshadow seed 1, 2026-10-02) showed what no score had: underground the engine's tunnels form a Y or
an X with a road along them from link end to link end (zone 18: 102 road tiles), ours loop round rock islands and the
road barely enters (16); one junction zone five times the engine's open area. Which level a zone lands on is random per
seed in the engine as well, so compare shapes, not levels.

## More discovery avenues that start from no named measure (works today)

K, 2026-10-01: "i feel like you still don't have enough different discovery avenues". In `lib/discover.js`, each takes
`--ours <maps> --engine <engine maps of the same template>` and prints a ranked list with coordinates in ours:

- `neighbours [--r 3]`: for every kind of object, the share that has each other kind (and a wall, a road) within r tiles,
  ours against the engine, ranked by how sure the difference is. Unsupervised: it finds relationships no one named.
  Nostalgia: guards within 3 tiles of a town on 50% of ours, 0% of the engine's; low loot at towns 74% / 18%; banks
  beside banks 30% / 2%; dwellings beside dwellings 17% / 1%; mercury labs with a road near 0% / 83%.
- `motifs`: every 3x3 shape of wall, scattered obstacle, floor, road and water, counted on both. Nostalgia: lone obstacles
  in open floor 2 to 3 times as common in ours (the engine's obstacles join into walls).
- `outliers [--n 30]`: objects of ours whose surroundings (wall distance, nearest guard, sealed or not, nearest town,
  nearest road, crowding) are furthest from every engine object of the same kind, with the two features that differ most.
  Nostalgia: gold mines on roads in open ground, towns with no road near, gates crowded by objects, black markets on roads.
- `walk [--days 7]`: a hero walks from each start (1500 movement a day, roads 60, terrain 100 to 175; a guard ring is a
  fight and the walk goes on) and everything met is tallied day by day, with the spread between starts (fairness).
  Nostalgia: by day 7 ours hands out 283 pickups against 161, 20 banks against 12, 7 mines against 4.
- `starts --out DIR`: each player's first screen, 30x30 round his town, ours beside the engine's, as pictures.

## Zone by zone, guard strength, and the real game (works today)

K, 2026-10-01: "engineer these gaps away".
- `zones --ours <maps> --engine <maps>`: the template's zones one by one (level, size, start, towns, dragons, dwellings,
  loot, banks, mines, guards, gates, monoliths) and every link between two zones (passages through open ground with the
  guard in each, gates, monoliths), across seeds, ours beside the engine's. Needs zone tile maps: the engine's from
  rmgdump built 2026-10-01 (`VCMI_rmgconv.exe`, zoneTiles), ours from generate.js with templateIds (branch
  opus-coldshadow; set VMAPGEN_ZONE_DUMP=1, which run_grid does). Coldshadow, 8 seeds of ours against 4: every template
  link exists on both, but ours also joins zones the template never joins (69 such links over 8 seeds, a guard standing
  in most of the gaps; the engine: none): the zone borders leak. Which zones go underground varies by seed on both sides.
- `guards --ours <maps> --engine <maps>`: guard strength (amount x AI value, core creatures) by the dearest thing each
  guard seals and by zone type. Coldshadow: ours has 319 guards a map that seal nothing (engine 67); 24 seal a relic
  (engine 102); level 7+ dwellings get 5 guards a map at a median 13k (engine 27.5 at 89k); cheap things (minor
  artifacts, scrolls, low loot, mines) get guards 1.6 to 2.4 times the engine's. Totals by zone type match.
- `load <maps> [--wait 45]`: the real game, through the team's loader (.tmp\opus\modmap_load.py: dmbtest client,
  --testmap, invisible desktop, hard deadline): started, AI moves, problems other than AI chatter. FAIL when the map does
  not start, the AI does not move, or the engine refuses objects.

## Setup (every shell)

Run from `VCMIMapGen`. Point the asset index at the test install and at the mirror of K's mods (read only; the
generator's crawler never guesses an install, and K's own folders are off limits):

    export VCMI_ROOT="<project>/VCMI/dmbtest"
    export VCMI_USER_DIR="<project>/.tmp/dmb/k-env/run"

Without them the card still runs; dwelling tiers, the neutral-dragon lookup by creature and the mod-terrain part of
the terrain check are off. The mirror is refreshed by `DMB\release\k_env_run.py`. The core terrain table is read from
`<VCMI_USER_DIR>\Data` (or `MAPSIGHT_H3DATA`).

## Stage 1: one map (works today)

    node tools/mapsight/mapsight.js card   <map.vmap|map.h3m> [--all] [--json out.json]
    node tools/mapsight/mapsight.js near   <map> <x> <y> [--r 5] [--level 0]
    node tools/mapsight/mapsight.js render <map> <out.png> [--level 0] [--crop x,y,w,h] [--mark x,y]...
    node tools/mapsight/mapsight.js convert <map.h3m>          (prints the cached .vmap path)

`card` prints, per map: starts and their level (and zone); dwellings per level by tier, neutral dragon dwellings by
type; per zone (from the sidecar) or, with no sidecar, per guard-bounded region, which neutral dragon dwellings sit
where and whether that zone has a town; per level the road graph: pieces, pieces that reach no building, entrances
joined, near misses (a road END within 3 tiles of a building none of whose visiting tiles carry road), stubs (road
ends at nothing, away from entrances, guards and the edge) with the junction each hangs from (arm of 15 or less: a T
to nowhere); per loot class the share with a guard within 2 tiles and the share a hero can walk to from a start
without a fight (free regions linked through subterranean gates and two-way monoliths); every high-value object with
no guard within 2; visitable objects whose art does not belong on their ground when another art of the same type
does (the snow well on wasteland). Every finding carries coordinates; positions are the visiting tile.

`near` lists every visitable thing within r tiles with its nearest guard (monsters: amount, creature, level) and
draws a character map of the square around it. Use it on a coordinate the card gave you.

`render` draws one level with a labelled grid, objects on their visiting tile, guard rings in pink, and `--mark`
rings. Measured: positions read off a 48x48 crop at 20 px a tile are exact (12 of 12), off a whole 144x144 level at 8
px a tile also exact (11 of 11) but labels that sit within 2 tiles of each other get swapped. Use pictures to look at
a place the card named, and for K's before/after; do not hunt for defects across a whole level by eye.

`.h3m` (original maps) is converted by the engine's own reader: `convert.py` runs `VCMI\rmgrun\VCMI_rmgconv.exe`
(`tools\rmgdump` with its `convert` job, built 2026-10-01) through the harness launcher (isolation guard, no window,
deadline). Cache: `.tmp\mapsight\h3m`. `py tools/mapsight/convert.py <folder of .h3m>` converts a whole folder in one
process.

Card time: about 0.1 s a map after a 1 s index load.

## Stage 2: engine, ours and originals side by side (works today)

    node tools/mapsight/mapsight.js compare --run .tmp/harness/<grid> [--match REGEX] [--orig .tmp/mapsight/h3m] [--maps K-route maps...]

Reads the layout `tools/harness/run_grid.py` writes (`<grid>\engine\<id>_s<seed>.vmap` with `.zones.json`,
`<grid>\ours\<id>_s<seed>.vmap` with `.vmap.zones.json`), so the existing harness makes the inputs: `make_grid.py`,
`run_grid.py`, `chain.py` and the STOP file work as before, and `diff.js` / `measure.js` still give the count-level
view. Per group (template, size, levels, players, water, monsters) it prints each check's engine range over the
seeds, the originals' range, and every map of ours with FAIL marks; then the per-zone dragon check (engine zones that
hold neutral dragon dwellings in at least half the seeds must hold one in ours; needs ours' zone tile map).

The originals are hand-made scenarios, so they are a reference column, never pass/fail. All 159 maps in `Documents\My Games\vcmi\Maps` (the shipped scenarios) convert (2026-10-01: 159 of 159, about a
minute); the column shows their middle half (25th to 75th percentile), since hand-made maps spread from 0 to 100% on
most checks. 6 of them share
a name with a harness template.

## Road ends: telling definitively when a road ends wrong (works today)

Every road end is judged by the rule the engine's own 744 tier-1 maps follow (2026-10-01; rivers excluded, see below):
98% of the engine's road ends touch a town, mine, monolith or gate, 1% a guard ring, and the rest are one-tile
overshoots at a corner. The card lists every improper end with coordinates and the gate fails on any:

- at nothing: touches no destination, guard or object, and runs 2+ tiles back to the junction or turn it hangs from (a T
  to nowhere). Engine: 24 ends in 744 maps, all on maps 72 wide or smaller, at most 2 on a map.
- at an object: ends at loot, a bank, a dwelling or a small building instead of a destination. Engine: 5 in 744 maps.
- gap: an end within 3 tiles of a different road piece, two roads that nearly meet and do not ("hit towns, only to be
  disconnected nearby"). Engine: 11 in 744 maps. Example on K's `mapgen_144x144_p4_s31329844`, underground: roads reach
  the town at (69,36) from both sides and stop at (68,37) and (70,37); the tile in front of the entrance has no road.

Rivers: `parseTileCode` (src/preview/palette.js) puts a river in its road slot when a tile has no road. mapsight reads
the layer codes itself; a layer is a river when its code is a river's (rw ri rm rl ra lr ww ut pw sr), else a road.
Every road number in this folder before commit 'road ends' counted the engine's rivers as roads.

## The difference finder: what is different, without anyone naming it first (works today)

    node tools/mapsight/mapsight.js diff --run .tmp/harness/<grid> --match '<template id regex>' [--maps <K-route maps>...] [--top 25] [--all] [--json out]

K, 2026-10-01: "i want a measurement on everything since an agent cant 'see' spatial relationships all at once like a
human, it needs a way to do so". `lib/relations.js` describes every object by its relationship to what is around it
and turns each relationship into a share (of guards, of high loot, of dwellings, of road tiles, of walkable ground...):

- guards: blocks the only way to a prize / to other loot, stands beside loot a hero can walk around it to, sits in a
  passage, stands in open ground closing nothing; in a corridor or on open floor; on a road; closes a pile of 3+;
  creature level against what it holds;
- high loot, low loot, dwellings, mines, banks, gates, monoliths: sealed behind a guard, at the end of a spur, against a
  wall, on open floor, in a town's area, next to another of its kind, road at its entrance;
- dwellings: faction against the nearest town; level 6+ sealed; towns: road at the entrance, a mine within 10;
- roads: in corridors or on open floor, inside guard rings, in pieces reaching no building;
- ground: open floor (4+ tiles from a wall) against corridors, scattered obstacles against walls, open ground in areas
  with no town; starts on the surface.

Terms: a wall is rock or water or a blocked mass of 25+ tiles; open ground is a guard-free area over 30 tiles; sealed
means no visiting tile on open ground. `diff` computes every share on the engine's maps and on ours and ranks the
measures by how far ours falls outside the engine's spread, each with coordinates in ours (the objects without the
relationship when ours has too little of it) and in the engine's map, ready for `near` and `render --crop`.
Self-check: an engine map against the other engine seeds has 0 of 67 measures outside the range.

On Coldshadow (K's two two-level maps against the engine's 8 seeds, 2026-10-01) the top of the list, unprompted:
subterranean gates sealed behind a guard (engine 100%, ours 7 to 14%), level 6+ dwellings sealed (97 to 100% against
10 to 12%), gates in a town's area (0% against 64%), monoliths sealed (100% against 25 to 50%), high loot sealed (89
to 91% against 13 to 17%), guards beside loot a hero walks around (0 to 1% against 52 to 53%), high loot in a town's
area (8 to 11% against 56 to 59%), guards on open floor (7 to 8% against 29 to 32%), high loot at the end of a spur
(42 to 48% against 7 to 11%), open floor (7 to 10% of walkable ground against 27 to 30%).

How to use it every time: run `diff` before and after a change; take the top five, open each with `render --crop`
on ours and on the engine's map at the same scale, write two lines on what each picture shows, then fix the generator
or record why the difference is right. A difference that keeps mattering becomes a gate check.

## Stage 3: the gate (works today)

    node tools/mapsight/mapsight.js gate --run .tmp/harness/<grid> --match '<template id regex>' [--maps <K-route map>...]

Exit 0 PASS, 1 FAIL, 2 nothing to judge (no group with 3+ engine seeds, or `--maps` without a `--match` that picks
exactly one group). The checks and their rules against the engine's [min, max]:

| check | fails when | stands for |
|---|---|---|
| starts underground | above max | K: "players are spawning underground" |
| neutral dragon dwellings | below min | K: "no neutral crystal/faerie/azure/rust dragon creature generation buildings" |
| dragon zones without a town | below min | Coldshadow's central dragon caches |
| per-zone dragons | an engine dragon zone empty in ours | the same, zone by zone |
| high loot reachable past no guard | above max plus 5 points | K: "the guards have to block access": open means a visiting tile lies in a free area over 30 tiles, so no guard stands in the way |
| relics, majors, Pandoras open | above max plus 2 | the same, for the prizes |
| dwellings reachable past no guard | above max plus 5 points | |
| high loot walkable from a start | above max plus 5 points | |
| road tiles reaching no building | above max plus 10 | K: roads "disconnected nearby" |
| road stubs to nothing | above max | K: roads "T off to nowhere" |
| road ends short of an entrance | above max | K's broken-road-connection example |
| road tiles | below 80% of min | |
| towns with road at the entrance | below min minus 2 points | |
| buildings on the wrong ground | above max plus 5 | K's wells-on-wasteland example |

Proof it separates (2026-10-01, Coldshadow 144x144 two levels, `.tmp\harness\ab_engine`): the 8 engine maps judged
against their own range PASS 8 of 8; the 8 maps of ours FAIL 8 of 8 (dragon zones 17 to 20 empty, high loot reachable
past no guard 83 to 93% against the engine's 9 to 11%, 21 to 70 orphan road tiles against 0 to 19); K's one-level map from his
game FAILS on dragons, guarding and roads.

## The procedure for the MapGen lane, every generator change

1. Freeze the generator (`--gen-root .tmp\gen_snap`) and run the A/B grid for the templates the change touches, plus
   Coldshadow one and two levels, with `run_grid.py` (8 seeds; engine maps already on disk are reused).
2. `mapsight gate --run <grid> --match <id>` for each group. Every FAIL gets a fix or a written reason in the log.
3. Generate one map through K's own route (launcher, his Mods, his preset; his game writes it to
   `Documents\My Games\Dead Man's Boots\Maps\RandomMaps\`, read it, never write there) and gate it with `--maps`.
4. For each fix, `card` before and after, and `render --crop` around two of the coordinates it named, filed with
   the log entry, so K sees the same thing the gate saw.
5. Nothing is placed for K, and nothing is called fixed, until steps 2 and 3 pass.

## What it cannot do yet

- Maps from K's game carry no zone sidecar, so their per-zone check uses guard-bounded regions; the zone ids of the
  per-zone dragon check need ours' `.vmap.zones.json` (harness runs) or a K-route map regenerated with the CLI.
- The engine sidecars written before 2026-10-01 have no `zoneTiles`; per-zone counts for the engine come from its
  per-zone object lists. Rebuilt rmgdump writes `zoneTiles`; the harness's `VCMI_rmg.exe` is still the older build
  until someone copies `tools\rmgdump\out\VCMI_rmg.exe` over it.
- Guard strength: the asset index's `aiValue` is 0 for every creature; `near` shows amount, creature and level. Only
  the 150 core creatures have AI values (`src\biome\creature_values.json`), not used in a check yet.
- High-value loot is read by object type (major and relic artifacts, Pandora's boxes, spell scrolls, placed
  artifacts); placed artifacts are not split by class.
- The terrain check has a noise floor of about a dozen buildings on engine maps (corpus rules for mines on swamp),
  which is why it is judged against the engine's range.
- Stubs and near misses overlap between engine and ours (engine 2 to 9 and 5 to 13 per map); they pass or fail
  only at the edge. Orphan road tiles, guarding and dragons separate cleanly.
- Engine ranges were measured with the harness's default settings (weak monsters, default loot). K's high-loot preset
  needs its own engine run before the guarding thresholds bind on high loot.
- The engine always makes Coldshadow two-level (asked for one level it adds the underground anyway), so a one-level
  Coldshadow of ours is judged against the two-level engine range.
