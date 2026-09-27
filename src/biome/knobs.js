/**
 * knobs.js - every generator lever a player can move, in one list (queue
 * item 25, the in-game MapGen UI).
 *
 * The in-game settings pages, the settings schema entries and the English
 * strings are all produced from this list, so a default can never drift
 * between them again (the standalone Electron app, retired 2026-09-26, had
 * carried four stale defaults that would have undone the corpus
 * calibration). Defaults are read from BIOME_DEFAULTS, not restated.
 *
 * A knob reaches the generator as `--bio.<key> <number>` (generate-cli.js),
 * except the ones marked `cli`, which are the generator's own flags.
 *
 * Fields: key, page, label, help, min, max, step, and optionally `stops`
 * (named positions on the scale, for a notched control) and `cli`.
 */
'use strict';

const { BIOME_DEFAULTS } = require('./biomes');
const { WATER_SHAPES, MAX_COVERAGE } = require('./water');

const PAGES = [
	{ id: 'zones', label: 'Zones' },
	{ id: 'borders', label: 'Borders' },
	{ id: 'treasure', label: 'Treasure' },
	{ id: 'monsters', label: 'Monsters' },
	{ id: 'underground', label: 'Underground' },
	{ id: 'scenery', label: 'Scenery' },
	{ id: 'water', label: 'Water' },
];

const KNOBS = [
	// ---- zones
	{ key: 'zoneCells', page: 'zones', label: 'Zone size',
		help: 'Map cells per zone. Larger zones mean fewer, bigger areas to fight over.',
		min: 150, max: 1500, step: 50 },
	// K, 2026-09-25, on the old flat 12-zone default binding on every map
	// bigger than about 72x72 at the default zone size: "bigger means
	// density parameters stay the same, you just get more of them." The
	// range now covers what Zone size actually implies at the largest map
	// (252x252 at Zone size's own minimum, 150, wants 423 zones), and the
	// default (300) sits above what any map wants at the default zone size
	// (400) so it stays out of the way unless someone deliberately pulls it
	// down to make a few large, simple zones on purpose.
	{ key: 'zoneCap', page: 'zones', label: 'Most zones per level',
		help: 'Upper limit on zones per level, player starts included. Zone size decides how many zones a map naturally wants; this only matters if you pull it below that to force fewer, bigger zones.',
		min: 4, max: 450, step: 1 },
	{ key: 'highLootRatio', page: 'zones', label: 'Treasure zones',
		help: 'Share of the non-start zones that are rich, heavily guarded treasure zones.',
		min: 0, max: 1, step: 0.05 },
	{ key: 'townRatio', page: 'zones', label: 'Neutral town zones',
		help: 'Share of the non-start zones built around a neutral town. Large maps add more towns by area.',
		min: 0, max: 1, step: 0.05 },
	{ key: 'lowLootRatio', page: 'zones', label: 'Open low-loot zones',
		help: 'Share of the non-start zones that are open ground with resource generators and weaker loot.',
		min: 0, max: 1, step: 0.05 },
	{ key: 'biomeWobble', page: 'zones', label: 'Border wobble',
		help: 'How much zone borders bend. 0 gives straight lines.',
		min: 0, max: 1.5, step: 0.05 },

	// ---- borders and links
	{ key: 'borderSolidity', page: 'borders', label: 'Border solidity',
		help: 'How zones are walled off: solid rims with thick lobes, a plain band, porous thin walls, or no border scenery at all.',
		min: 0, max: 1, step: 0.05,
		// stops sit on the generator's own thresholds (biomes.js rimModeOf,
		// rimLobeScale, bordersOff) so the label names the mode you get
		stops: [[0, 'None'], [0.25, 'Porous'], [0.5, 'Band'], [0.75, 'Mixed'], [1, 'Solid']] },
	{ key: 'interconnectivity', page: 'borders', label: 'Zone connections',
		help: 'How many neighbouring zones get a passage between them.',
		min: 0, max: 1, step: 0.05 },
	{ key: 'interconnectPortal', page: 'borders', label: 'Portal share',
		help: 'Share of the passages that are two-way portals instead of open ground.',
		min: 0, max: 1, step: 0.02 },
	{ key: 'openPathNoRoad', page: 'borders', label: 'Open passages without road',
		help: 'Weight of plain open passages among the non-portal ones.',
		min: 0, max: 1, step: 0.05 },
	{ key: 'openPathRoad', page: 'borders', label: 'Open passages with road',
		help: 'Weight of roaded passages among the non-portal ones.',
		min: 0, max: 1, step: 0.05 },
	{ key: 'roadNetwork', page: 'borders', label: 'Road network',
		help: 'Roads linking every town. Off leaves only the roads through passages.',
		min: 0, max: 1, step: 1, stops: [[0, 'Off'], [1, 'On']] },
	{ key: 'roadType', page: 'borders', label: 'Road type',
		help: 'What the roads are paved with. A hero moves along cobblestone for half the cost of open ground, along gravel for 65 and along dirt for 75 of every 100. Real random maps pave almost every road with cobblestone.',
		min: 0, max: 2, step: 1, stops: [[0, 'Dirt'], [1, 'Gravel'], [2, 'Cobblestone']], default: 2 },

	// ---- treasure
	{ key: 'artifactDensity', page: 'treasure', label: 'Artifacts',
		help: 'How many artifacts lie on the map.',
		min: 0, max: 0.02, step: 0.001 },
	{ key: 'artifactRichness', page: 'treasure', label: 'Artifact quality',
		help: 'Shifts artifacts from treasure and minor toward major and relic.',
		min: 0, max: 1, step: 0.05 },
	{ key: 'pickupDensity', page: 'treasure', label: 'Chests, scrolls and campfires',
		help: 'Multiplier on treasure chests, spell scrolls and campfires.',
		min: 0, max: 3, step: 0.1 },
	{ key: 'resourceDensity', page: 'treasure', label: 'Resource piles',
		help: 'Multiplier on loose resource piles.',
		min: 0, max: 3, step: 0.1 },
	{ key: 'mineDensity', page: 'treasure', label: 'Mines',
		help: 'Multiplier on mines beyond each player\'s starting pair.',
		min: 0, max: 3, step: 0.1 },
	{ key: 'starterMines', page: 'treasure', label: 'Starting mines',
		help: 'A sawmill and an ore pit beside every start.',
		min: 0, max: 1, step: 1, stops: [[0, 'Off'], [1, 'On']] },
	{ key: 'dwellingDensity', page: 'treasure', label: 'Creature dwellings',
		help: 'Multiplier on external creature dwellings.',
		min: 0, max: 3, step: 0.1 },
	{ key: 'bonusDensity', page: 'treasure', label: 'Shrines and one-visit buildings',
		help: 'Multiplier on shrines, schools, stat and luck buildings.',
		min: 0, max: 3, step: 0.1 },

	// ---- monsters (K, 2026-09-24: a tier control, one stack-size scale that
	// moves the whole curve, and a guard switch per placement context)
	{ key: 'monsterStrength', page: 'monsters', label: 'Monster tier',
		help: 'Creature levels added to every monster: weaker, lower-level creatures or stronger, higher-level ones.',
		min: -2, max: 2, step: 1, stops: [[-2, 'Very weak'], [-1, 'Weak'], [0, 'Normal'], [1, 'Strong'], [2, 'Very strong']] },
	{ key: 'stackScale', page: 'monsters', label: 'Stack size',
		help: 'Creatures per stack. Low-level creatures come in big stacks and high-level ones in small stacks; this moves the whole scale up or down together. At 1.0x the game rolls each creature\'s own usual number.',
		min: 0.25, max: 3, step: 0.05 },
	{ key: 'guardDensity', page: 'monsters', label: 'Monster count',
		help: 'Multiplier on every zone\'s monster budget, guards and roamers together.',
		min: 0, max: 3, step: 0.1 },
	{ key: 'objectGuardShare', page: 'monsters', label: 'Guarding vs roaming',
		help: 'Share of each zone\'s monsters posted on something worth taking; the rest roam.',
		min: 0, max: 1, step: 0.05 },
	{ key: 'guardTreasure', page: 'monsters', label: 'Guards on treasure',
		help: 'Monsters standing on artifacts, chests, Pandora\'s boxes, prisons, banks and other treasure. Off leaves treasure unguarded; those monsters roam instead.',
		min: 0, max: 1, step: 1, stops: [[0, 'Off'], [1, 'On']] },
	{ key: 'guardMines', page: 'monsters', label: 'Guards on mines',
		help: 'Monsters standing on mines and other resource generators.',
		min: 0, max: 1, step: 1, stops: [[0, 'Off'], [1, 'On']] },
	{ key: 'guardDwellings', page: 'monsters', label: 'Guards on dwellings',
		help: 'Monsters standing on creature dwellings.',
		min: 0, max: 1, step: 1, stops: [[0, 'Off'], [1, 'On']] },
	{ key: 'guardBottlenecks', page: 'monsters', label: 'Guards at bottlenecks',
		help: 'Monsters standing in the passages between zones.',
		min: 0, max: 1, step: 1, stops: [[0, 'Off'], [1, 'On']] },
	{ key: 'chokeGuardRatio', page: 'monsters', label: 'Bottleneck guard share',
		help: 'Share of zone passages with a monster standing in them, when bottleneck guards are on.',
		min: 0, max: 1, step: 0.05 },
	{ key: 'guardPortals', page: 'monsters', label: 'Guards at portals',
		help: 'A monster in front of each two-way monolith that links two zones.',
		min: 0, max: 1, step: 1, stops: [[0, 'Off'], [1, 'On']] },
	{ key: 'lootGuardWeight', page: 'monsters', label: 'Treasure guard pull',
		help: 'How strongly guards gather on treasure and dwellings compared with the rates measured on your random maps.',
		min: 0, max: 4, step: 0.1 },
	{ key: 'mineGuardWeight', page: 'monsters', label: 'Mine guard pull',
		help: 'How strongly guards gather on mines compared with the rates measured on your random maps.',
		min: 0, max: 4, step: 0.1 },

	// ---- underground
	{ key: 'subterraneanGateRatio', page: 'underground', label: 'Gates between levels',
		help: 'How many subterranean gates link the surface and the underground.',
		min: 0, max: 2, step: 0.1 },
	{ key: 'subterraneanNarrow', page: 'underground', label: 'Narrow tunnels',
		help: 'Share of underground zones carved as narrow tunnels rather than open caverns.',
		min: 0, max: 1, step: 0.05 },
	{ key: 'subterraneanOpen', page: 'underground', label: 'Open cave floor',
		help: 'Share of the underground left walkable.',
		min: 0.2, max: 0.9, step: 0.05 },

	// ---- scenery
	{ key: 'decorDensity', page: 'scenery', label: 'Scenery',
		help: 'Multiplier on scenery inside zones (mountains, trees, rocks). Border scenery follows Border solidity.',
		min: 0, max: 2, step: 0.1 },
	{ key: 'rivers', page: 'scenery', label: 'Rivers', cli: 'rivers',
		help: 'Rivers across the map.',
		min: 0, max: 1, step: 1, stops: [[0, 'Off'], [1, 'On']], default: 1 },
	{ key: 'riverAmount', page: 'scenery', label: 'River amount',
		help: 'Multiplier on how much of the map the rivers run through. 1 is the share measured on real random maps.',
		min: 0.25, max: 3, step: 0.25, default: 1 },

	// ---- map (drawn on the Map page, beside the player counts)
	{ key: 'teams', page: 'map', label: 'Teams',
		help: 'Allied teams among the players, dealt out in colour order: red, blue, tan and so on in turn. None is every player for themselves; a count at or above the number of players is the same.',
		min: 1, max: 4, step: 1, stops: [[1, 'None'], [2, 'Two'], [3, 'Three'], [4, 'Four']], default: 1 },

	// ---- water
	{ key: 'waterCoverage', page: 'water', label: 'Amount of water',
		help: 'Share of the surface under water. 0 is a dry map. The land left over is shared out among the zones.',
		min: 0, max: MAX_COVERAGE, step: 0.05 },
	{ key: 'waterShape', page: 'water', label: 'Water layout',
		help: 'Where the water goes. ' + WATER_SHAPES.map(s => `${s.label}: ${s.help}`).join(' '),
		min: 0, max: WATER_SHAPES.length - 1, step: 1,
		stops: WATER_SHAPES.map((s, i) => [i, s.label]) },
	{ key: 'waterAccess', page: 'water', label: 'Harbours',
		help: 'Where heroes can take to the water. Starts: a shipyard at each player start on the shore. Towns: a shipyard in every zone with a town on the shore, as the game\'s own generator does. Every zone: a boat in every other zone on the shore as well. Lakes under 25 cells get none. On Islands and Archipelago every player still gets a shipyard and a boat at the start, whatever this says.',
		min: 0, max: 3, step: 1, stops: [[0, 'None'], [1, 'Starts'], [2, 'Towns'], [3, 'Every zone']] },
	{ key: 'waterTreasure', page: 'water', label: 'Treasure on the water',
		help: 'Multiplier on what lies on the water a boat can reach: flotsam, sea chests, survivors, buoys, mermaids and the two water banks.',
		min: 0, max: 3, step: 0.1 },
];

// defaults come from the generator itself; booleans read as 0/1
for (const k of KNOBS) {
	if (k.default === undefined) {
		const v = BIOME_DEFAULTS[k.key];
		k.default = typeof v === 'boolean' ? (v ? 1 : 0) : v;
	}
	if (k.default === undefined) throw new Error(`knob ${k.key} has no default`);
}

module.exports = { PAGES, KNOBS };
