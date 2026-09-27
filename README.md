# OmniMapGen

A random map generator for [VCMI](https://vcmi.eu), the open-source Heroes of Might and Magic III
engine. It writes `.vmap` files the game loads directly. Dead Man's Boots (DMB), a VCMI fork, runs it
from its MapGen tab; it also runs on its own from the command line.

It reads the game's configuration and every active mod from the VCMI install it is given, the way
the engine loads them (submods at any depth, and each mod's patches to the objects it names), so mod
towns, creatures, dwellings, banks and spells reach the maps as the engine would place them. It
generates two ways:

- Free layout: terrain by wave function collapse over parallel chunks, zones sized and classed from
  the player's settings, content placed by the engine's own value and guard rules.
- Template: any RMG template the install offers (the engine's, HotA's, a mod's), with its zones,
  links, towns, mines, treasure bands and guards followed the engine's way.

Its output is measured against maps VCMI's own generator made with the same templates, sizes and
mods: towns, mines, guards by level, treasure, creature banks and dwellings per map.

## Installing it in the game

OmniMapGen is a VCMI mod. It needs a client with the map generator framework, which Dead Man's
Boots (DMB) has. Install and enable it from DMB's launcher like any other mod, or unzip
`omnimapgen.zip` from the latest release into the `Mods` folder of your game's user folder and
enable it in the launcher. A single-player lobby then shows a MapGen button beside Random Map,
and Generate map makes a map with the tab's settings and selects it. The mod carries its own
Node runtime; nothing else needs installing.

To build the mod from this repository: `node tools/make_mod.js --node-zip <node-vX-win-x64.zip>
--node-sums <SHASUMS256.txt>` with the official Node build and nodejs.org's checksum list; the
mod lands in `dist/`.

## Running it from the command line

Node 24 or newer; no packages are needed.

    node src/main/generate-cli.js --w 72 --h 72 --players 4 --seed 7 --out map.vmap \
      --vcmiroot "<VCMI install>" --vcmiuserdir "<VCMI user folder>"

Add `--template "Jebus Cross"` for a template map, `--declaremods 1` to use the mods active in the
user folder, `--underground 1` for a second level. `--listtemplates 1` lists what the install
offers and `--listknobs 1` the settings. The generator never guesses where VCMI lives: name the
install and user folder, or set `VCMI_ROOT` and `VCMI_USER_DIR`.

The installed mod's `generator` folder holds the same program: `generate.cmd` runs it on the
bundled Node.

## Tests

    node --test "test/*.test.js"

The suite generates against a VCMI source tree with the MapGen tab, `..\VCMI\source` by default
(set `VMAPGEN_TEST_ROOT` to point elsewhere).

## Layout

| Folder | What is in it |
|---|---|
| `src/main` | the command line and the map pipeline |
| `src/parser` | the install and mod reader, the asset index |
| `src/rmg` | templates: loading, zone plans, start placement |
| `src/biome` | zones, terrain classes, content, guards, towns, water |
| `src/wfc`, `src/stitch` | the terrain solver and chunk stitching |
| `src/exporter` | the `.vmap` writer |
| `src/preview` | a PNG preview of a map, and a `.vmap` reader |
| `ui` | the MapGen tab's widget and settings configs |
| `mod` | the mod's manifest, `mod.json` |
| `tools` | packages the mod (`make_mod.js`); builds the tab's configs from the generator's settings; a settings fuzzer; an extractor for the game's own object templates |

## License

MIT, see [LICENSE](LICENSE). Heroes of Might and Magic III and its art belong to their owners; the
generator ships none of it and reads what your own install has.
