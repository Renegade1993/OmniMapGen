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
 * (named positions on the scale, for a notched control), `unit` ('x' for a
 * multiplier, shown as 1.0x) and `cli`. A label fits the page at about 21
 * characters; a longer one runs under its control.
 */
'use strict';

const { BIOME_DEFAULTS } = require('./biomes');
const { WATER_SHAPES, MAX_COVERAGE } = require('./water');

const PAGES = [
	// "Biomes" is K's word for what the generator calls zones (2026-09-27: every
	// "zone" a player reads); the ids and setting keys stay, so saved settings hold
	{ id: 'zones', label: 'Biomes' },
	{ id: 'borders', label: 'Borders' },
	{ id: 'treasure', label: 'Treasure' },
	{ id: 'monsters', label: 'Monsters' },
	{ id: 'underground', label: 'Underground' },
	{ id: 'scenery', label: 'Scenery' },
	{ id: 'water', label: 'Water' },
];

const KNOBS = [
	// ---- zones
	{ key: 'zoneCells', page: 'zones', label: 'Biome size',
		help: 'Map cells per biome (a 20 by 20 patch is 400). Bigger biomes mean fewer of them. Player starts are sized apart: together they take about half the land. Free layout only.',
		min: 150, max: 1500, step: 50 },
	// K, 2026-09-25, on the old flat 12-zone default binding on every map
	// bigger than about 72x72 at the default zone size: "bigger means
	// density parameters stay the same, you just get more of them." The
	// range now covers what Zone size actually implies at the largest map
	// (252x252 at Zone size's own minimum, 150, wants 423 zones), and the
	// default (300) sits above what any map wants at the default zone size
	// (400) so it stays out of the way unless someone deliberately pulls it
	// down to make a few large, simple zones on purpose.
	{ key: 'zoneCap', page: 'zones', label: 'Most biomes per level',
		help: 'The most biomes a level may have, starts included. It only matters when set below what Biome size gives; the biomes then grow to fill the map. Free layout only.',
		min: 4, max: 450, step: 1 },
	{ key: 'highLootRatio', page: 'zones', label: 'Treasure biomes',
		help: 'Share of the biomes, starts aside, that are treasure biomes: the richest loot behind the strongest guards. Free layout only.',
		min: 0, max: 1, step: 0.05 },
	{ key: 'townRatio', page: 'zones', label: 'Neutral town biomes',
		help: 'Share of the biomes, starts aside, built around a neutral town. Free layout only.',
		min: 0, max: 1, step: 0.05 },
	{ key: 'lowLootRatio', page: 'zones', label: 'Open low-loot biomes',
		help: 'Share of the biomes, starts aside, that are open ground with light loot and resource buildings such as windmills and water wheels. Free layout only.',
		min: 0, max: 1, step: 0.05 },

	// ---- borders and links
	{ key: 'borderSolidity', page: 'borders', label: 'Border solidity',
		help: 'How biomes are walled off from each other. Solid: thick, uneven mountain rims, as the game\'s own generator makes them. Mixed and Band: an even strip, with smaller rims or none. Porous: thin walls one tile wide. None: no walls, only a change of terrain.',
		min: 0, max: 1, step: 0.05,
		// stops sit on the generator's own thresholds (biomes.js rimModeOf,
		// rimLobeScale, bordersOff) so the label names the mode you get
		stops: [[0, 'None'], [0.25, 'Porous'], [0.5, 'Band'], [0.75, 'Mixed'], [1, 'Solid']] },
	// on the Borders page, with its tooltip in K's words (2026-09-27)
	{ key: 'biomeWobble', page: 'borders', label: 'Border wobble',
		help: 'How much biome borders bend. 0 gives straight lines.',
		min: 0, max: 1.5, step: 0.05 },
	{ key: 'interconnectivity', page: 'borders', label: 'Biome connections',
		help: 'Share of neighbouring biomes joined by a passage. Lower gives fewer ways through; every biome can still be reached. Free layout only.',
		min: 0, max: 1, step: 0.05 },
	{ key: 'interconnectPortal', page: 'borders', label: 'Portal share',
		help: 'Share of the passages that are a pair of portals instead of a gap in the wall. The game has eight portal colours, so past eight pairs the rest open as gaps. Free layout only.',
		min: 0, max: 1, step: 0.02 },
	{ key: 'openPathNoRoad', page: 'borders', label: 'Passages without road',
		help: 'How often a passage has no road through it, set against Passages with road: equal settings give half of each. Free layout only.',
		min: 0, max: 1, step: 0.05 },
	{ key: 'openPathRoad', page: 'borders', label: 'Passages with road',
		help: 'How often a passage has a road through it, set against Passages without road: equal settings give half of each. Free layout only.',
		min: 0, max: 1, step: 0.05 },
	{ key: 'roadNetwork', page: 'borders', label: 'Build Road Network',
		help: 'Roads linking every town. Off leaves only the roads through the passages. Free layout only.',
		min: 0, max: 1, step: 1, stops: [[0, 'Off'], [1, 'On']] },
	{ key: 'roadType', page: 'borders', label: 'Road type',
		help: 'What the roads are paved with. Moving along cobblestone costs half what open grass does, gravel 65% and dirt 75%. Real random maps pave nearly every road with cobblestone.',
		min: 0, max: 2, step: 1, stops: [[0, 'Dirt'], [1, 'Gravel'], [2, 'Cobblestone']], default: 2 },

	// ---- treasure
	{ key: 'artifactDensity', page: 'treasure', label: 'Artifacts',
		help: 'How many artifacts lie on the map. 0 places none.',
		min: 0, max: 0.02, step: 0.001 },
	{ key: 'artifactRichness', page: 'treasure', label: 'Artifact quality',
		help: 'How good the artifacts are: low gives mostly treasure and minor artifacts, high more major artifacts and relics.',
		min: 0, max: 1, step: 0.05 },
	{ key: 'pickupDensity', page: 'treasure', label: 'Chests and campfires',
		help: 'How many treasure chests, spell scrolls and campfires: 1x is the usual amount, 2x twice as many, 0 none.',
		min: 0, max: 3, step: 0.1, unit: 'x' },
	{ key: 'resourceDensity', page: 'treasure', label: 'Resource piles',
		help: 'How many resource piles lie loose on the map: 1x is the usual amount, 0 none.',
		min: 0, max: 3, step: 0.1, unit: 'x' },
	{ key: 'mineDensity', page: 'treasure', label: 'Mines',
		help: 'How many mines, not counting each start\'s own sawmill and ore pit: 1x is the usual amount, 0 none.',
		min: 0, max: 3, step: 0.1, unit: 'x' },
	{ key: 'starterMines', page: 'treasure', label: 'Starting mines',
		help: 'A sawmill and an ore pit beside every start.',
		min: 0, max: 1, step: 1, stops: [[0, 'Off'], [1, 'On']] },
	{ key: 'dwellingDensity', page: 'treasure', label: 'Creature dwellings',
		help: 'How many creature dwellings stand outside the towns: 1x is the usual amount, 0 none.',
		min: 0, max: 3, step: 0.1, unit: 'x' },
	{ key: 'bonusDensity', page: 'treasure', label: 'Shrines and bonuses',
		help: 'How many shrines, schools and buildings that raise a skill, luck or morale: 1x is the usual amount, 0 none.',
		min: 0, max: 3, step: 0.1, unit: 'x' },

	// ---- monsters (K, 2026-09-24: a tier control, one stack-size scale that
	// moves the whole curve, and a guard switch per placement context)
	{ key: 'monsterStrength', page: 'monsters', label: 'Monster tier',
		help: 'Shifts every monster by whole creature levels: Weak puts a level 2 creature where a level 3 one would stand, Strong a level 4 one.',
		min: -2, max: 2, step: 1, stops: [[-2, 'Very weak'], [-1, 'Weak'], [0, 'Normal'], [1, 'Strong'], [2, 'Very strong']] },
	{ key: 'stackScale', page: 'monsters', label: 'Stack size',
		help: 'How many creatures stand in each stack. At 1.0x the game rolls each creature\'s usual number; 2.0x about doubles every stack, 0.5x halves it.',
		min: 0.25, max: 3, step: 0.05, unit: 'x' },
	{ key: 'guardDensity', page: 'monsters', label: 'Monster count',
		help: 'How many monsters guard treasure or stand in the open: 1x is the usual number, 0 none. Guards between biomes follow Guards at bottlenecks.',
		min: 0, max: 3, step: 0.1, unit: 'x' },
	{ key: 'objectGuardShare', page: 'monsters', label: 'Guarding vs roaming',
		help: 'Share of the monsters that guard something worth taking; the rest stand in the open.',
		min: 0, max: 1, step: 0.05 },
	{ key: 'guardTreasure', page: 'monsters', label: 'Guards on treasure',
		help: 'Monsters guard artifacts, chests, Pandora\'s boxes, prisons, banks and other treasure. Off leaves treasure unguarded, and those monsters stand in the open instead.',
		min: 0, max: 1, step: 1, stops: [[0, 'Off'], [1, 'On']] },
	{ key: 'guardMines', page: 'monsters', label: 'Guards on mines',
		help: 'Monsters guard mines and other resource buildings. Off leaves them unguarded.',
		min: 0, max: 1, step: 1, stops: [[0, 'Off'], [1, 'On']] },
	{ key: 'guardDwellings', page: 'monsters', label: 'Guards on dwellings',
		help: 'Monsters guard creature dwellings. Off leaves them unguarded.',
		min: 0, max: 1, step: 1, stops: [[0, 'Off'], [1, 'On']] },
	{ key: 'guardBottlenecks', page: 'monsters', label: 'Guards at bottlenecks',
		help: 'Monsters guard the ways between biomes: passages, portals and gates, a template\'s links included. Off leaves them all open.',
		min: 0, max: 1, step: 1, stops: [[0, 'Off'], [1, 'On']] },
	{ key: 'chokeGuardRatio', page: 'monsters', label: 'Bottleneck guard share',
		help: 'Share of the passages between biomes with a guard in them. A passage out of a start always has one. Free layout only.',
		min: 0, max: 1, step: 0.05 },
	{ key: 'guardPortals', page: 'monsters', label: 'Guards at portals',
		help: 'A monster in front of both ends of every portal pair that has no guard of its own.',
		min: 0, max: 1, step: 1, stops: [[0, 'Off'], [1, 'On']] },
	{ key: 'lootGuardWeight', page: 'monsters', label: 'Treasure guard pull',
		help: 'How strongly guards gather on treasure and dwellings compared with the rates measured on your random maps.',
		min: 0, max: 4, step: 0.1, unit: 'x' },
	{ key: 'mineGuardWeight', page: 'monsters', label: 'Mine guard pull',
		help: 'How strongly guards gather on mines compared with the rates measured on your random maps.',
		min: 0, max: 4, step: 0.1, unit: 'x' },

	// ---- underground
	{ key: 'subterraneanGateRatio', page: 'underground', label: 'Gates between levels',
		help: 'How many subterranean gates link the surface and the underground: 1x is the usual number. A template puts its gates on its own links. Free layout only.',
		min: 0, max: 2, step: 0.1, unit: 'x' },
	{ key: 'subterraneanNarrow', page: 'underground', label: 'Narrow tunnels',
		help: 'How the underground is carved: 0 gives wide caverns, 1 narrow tunnels between small chambers.',
		min: 0, max: 1, step: 0.05 },
	// K (2026-09-27): starts underground by default, as in the game, inferred
	// from the template, and the player's to override
	{ key: 'undergroundStarts', page: 'underground', label: 'Starts underground',
		help: 'Whether player starts may lie underground on a two-level map. As the game does: a start whose picked town belongs on the surface stays up, Dungeon goes down, and a random town may land on either level. Never keeps every start on the surface; Always puts them all below.',
		min: 0, max: 2, step: 1, stops: [[0, 'Never'], [1, 'As the game does'], [2, 'Always']] },
	{ key: 'subterraneanOpen', page: 'underground', label: 'Open cave floor',
		help: 'How much of the underground is open floor rather than solid rock. Real two-level maps leave about 57% open.',
		min: 0.2, max: 0.9, step: 0.05 },

	// ---- scenery
	{ key: 'decorDensity', page: 'scenery', label: 'Scenery',
		help: 'How much scenery (mountains, trees, rocks) fills the inside of biomes: 1x is the usual amount, 0 none. The walls between biomes follow Border solidity.',
		min: 0, max: 2, step: 0.1, unit: 'x' },
	{ key: 'rivers', page: 'scenery', label: 'Rivers', cli: 'rivers',
		help: 'Rivers across the map.',
		min: 0, max: 1, step: 1, stops: [[0, 'Off'], [1, 'On']], default: 1 },
	{ key: 'riverAmount', page: 'scenery', label: 'River amount',
		help: 'How much of the map the rivers run through: 1x is what real random maps have.',
		min: 0.25, max: 3, step: 0.25, unit: 'x', default: 1 },

	// ---- map (drawn on the Map page, beside the player counts)
	{ key: 'teams', page: 'map', label: 'Teams',
		help: 'How many allied teams the players form, dealt out in colour order: with two, red, tan, orange and teal against blue, green, purple and pink. None: every player for themselves.',
		// to seven, as the game's own Random Map Setup offers
		min: 1, max: 7, step: 1, stops: [[1, 'None'], [2, 'Two'], [3, 'Three'], [4, 'Four'], [5, 'Five'],
			[6, 'Six'], [7, 'Seven']], default: 1 },

	// ---- the game's own Random Map Setup choices (stock: true), which the
	// classic tab lays out as that screen does; the released tab has its own
	// players, road type and water levers instead, and leaves these out
	{ key: 'compOnly', page: 'map', stock: true, label: 'Computer only players',
		help: 'Players only the computer plays, beside the human or computer seats. Random picks a number the template allows.',
		min: -1, max: 7, step: 1, default: 3 },
	{ key: 'roadDirt', page: 'map', stock: true, label: 'Dirt road',
		help: 'Allows dirt roads. Roads take the best type allowed, cobblestone first, as in the game\'s own generator; with none allowed there are no roads.',
		min: 0, max: 1, step: 1, stops: [[0, 'Off'], [1, 'On']], default: 1 },
	{ key: 'roadGravel', page: 'map', stock: true, label: 'Gravel road',
		help: 'Allows gravel roads. Roads take the best type allowed, cobblestone first, as in the game\'s own generator; with none allowed there are no roads.',
		min: 0, max: 1, step: 1, stops: [[0, 'Off'], [1, 'On']], default: 1 },
	{ key: 'roadCobblestone', page: 'map', stock: true, label: 'Cobblestone road',
		help: 'Allows cobblestone roads. Roads take the best type allowed, cobblestone first, as in the game\'s own generator; with none allowed there are no roads.',
		min: 0, max: 1, step: 1, stops: [[0, 'Off'], [1, 'On']], default: 1 },
	{ key: 'waterContent', page: 'map', stock: true, label: 'Water content',
		help: 'None makes a dry map. Normal uses the Water page as set. Islands lays the water out as islands, at the Water page\'s amount. Random rolls one of the three.',
		min: -1, max: 2, step: 1, stops: [[0, 'None'], [1, 'Normal'], [2, 'Islands'], [-1, 'Random']], default: 1 },

	// ---- water
	{ key: 'waterCoverage', page: 'water', label: 'Amount of water',
		help: 'How much of the surface is water. 0 is a dry map.',
		min: 0, max: MAX_COVERAGE, step: 0.05 },
	{ key: 'waterShape', page: 'water', label: 'Water layout',
		help: 'Where the water goes. ' + WATER_SHAPES.map(s => `${s.label}: ${s.help}`).join(' '),
		min: 0, max: WATER_SHAPES.length - 1, step: 1,
		stops: WATER_SHAPES.map((s, i) => [i, s.label]) },
	{ key: 'waterAccess', page: 'water', label: 'Harbours',
		help: 'Where heroes can get a boat. Starts: a shipyard at each start on the shore. Towns: a shipyard in every biome with a town on the shore, as the game\'s own generator does. Every biome: a boat in every other biome on the shore too. Lakes under 25 tiles get none; on Islands and Archipelago every player still starts with a shipyard and a boat.',
		min: 0, max: 3, step: 1, stops: [[0, 'None'], [1, 'Starts'], [2, 'Towns'], [3, 'Every biome']] },
	{ key: 'waterTreasure', page: 'water', label: 'Treasure on the water',
		help: 'How much treasure lies on the water: flotsam, sea chests, survivors, shipwrecks and derelict ships. 1x is the usual amount, 0 none.',
		min: 0, max: 3, step: 0.1, unit: 'x' },
	// K (2026-09-27): a density lever for the buildings on the water, as the
	// land's biomes have theirs
	{ key: 'waterBuildings', page: 'water', label: 'Buildings on the water',
		help: 'How many sites a boat can visit: mermaids and buoys for luck and morale, sirens, and whirlpools, which come in pairs and throw a ship from one to the other. 1x is the usual number.',
		min: 0, max: 3, step: 0.1, unit: 'x' },
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
