/**
 * content.js - per-biome object fill driven by the Nostalgia parameter set.
 *
 * Each biome's class and the global richness ratio decide what placeholder
 * objects land inside it. All objects are faction-agnostic VCMI placeholders
 * so the map stays valid for any town selection at pre-game.
 *
 * Artifact tiers follow artifactRichness: higher richness shifts the treasure
 * distribution toward relic/major; guards on high-value objects scale with
 * biome class.
 */
'use strict';

// set VMAPGEN_DECOR_TRACE=1 to see the scenery budget against what lands
const DECOR_TRACE = !!process.env.VMAPGEN_DECOR_TRACE;
// set VMAPGEN_FILL_TRACE=1 to count put() rejections by reason per biome
const FILL_TRACE = !!process.env.VMAPGEN_FILL_TRACE;

const { BIOME_CLASS, BIOME_DEFAULTS } = require('./biomes');
const { OBJECT_TEMPLATES } = require('../stitch/zones');
const {
	mineTemplate, pileTemplate, chestTemplate, campfireTemplate,
	CLASS_MINES, CORE_BANKS, bankBandWeight, bandEligibility, bankEligAt, BONUS_POOL, pickBonus, STRUCTURES, STRUCTURE_SUBTYPE,
	SPELL_SCROLL, pandoraTemplate, prisonTemplate, obeliskTemplate,
	pandoraOptions, prisonOptions, makePrisonHeroPool, SPECIALS,
	UTIL_POOL, pickUtil, DWELLING_POOL, pickDwelling, PILE_KINDS, seerHutOptions,
	SEER_ARTIFACTS, emptyRewardable,
} = require('./economy');
const { zoneTownTypes, townTemplate, townMods } = require('./zoneTowns');
const { artFor } = require('./terrainArt');
const TERRAIN_ART = process.env.VMAPGEN_TERRAIN_ART !== '0';
// the weights of the core bank and dwelling pools, which fill.banks and
// fill.dwellings are calibrated against (the banks proper and the utopia; the
// Crypt joined the draw later and adds its own share on top)
const CORE_BANK_WEIGHT = CORE_BANKS.filter(b => b.type !== 'crypt')
	.reduce((a, b) => a + (b.weight || 1), 0);
const CORE_DWELLING_WEIGHT = DWELLING_POOL.reduce((a, d) => a + (d.weight || 1), 0);
// Treasure chests grow with the chest pool: the corpus ran 4.68 chests per
// 1000 cells with core's chest alone (before April), 11.15 with two more
// types (April-August) and 13.68 with four (since August 26th), rarity 1000
// each but the lost wagon's 100 (.tmp\opus\chest_eras.js, 2026-09-26). Count
// = fill.chests x CHEST_K x (pool rarity / 1000)^CHEST_GAMMA fits all three
// on average, but not template by template: the late corpus's chests per
// chest-eligible pile run from 0.92 (Jebus Cross, where our count already
// matches) to 3.98 (Headquarters), because a rich pile's tail fills with
// cheap objects too (.tmp\opus\chest_calib.js). Off unless
// VMAPGEN_CHEST_GROWTH=1 until a pile simulation sizes chests per template;
// the pool still sets the mix.
const CHEST_GROWTH = process.env.VMAPGEN_CHEST_GROWTH === '1';
const CHEST_K = Number(process.env.VMAPGEN_CHEST_K) || 0.63;
const CHEST_GAMMA = Number(process.env.VMAPGEN_CHEST_GAMMA) || 0.77;
// a chest's draw per 1000 rarity against its value, from the late corpus:
// spell stones (1000) 4.57 per 1000 cells, the treasure piles (1500) 2.98,
// the lost wagon (1881) 1.6 per 1000 rarity; 1 at 1500
function chestValueRate(v) {
	if (!(v > 1000)) return 1.53;
	if (v <= 1500) return 1.53 - 0.53 * (v - 1000) / 500;
	if (v <= 1900) return 1 - 0.46 * (v - 1500) / 400;
	return 0.54 * Math.pow(1900 / v, 2.7);
}
// the richest object a free-layout zone of each class may draw from the bank
// pool, standing in for a template zone's richest pile (fillBiome, banks)
const FREE_ZONE_MAX = {
	[BIOME_CLASS.PLAYER]: 15000, [BIOME_CLASS.LOW_LOOT]: 15000, [BIOME_CLASS.TOWN]: 20000,
	[BIOME_CLASS.STANDARD]: 30000, [BIOME_CLASS.HIGH_LOOT]: Infinity,
};
// ...and the treasure bands a template zone of that kind most often has, for
// the bank mix (fillBiome): the corpus's commonest start-zone set, its two
// commonest treasure-zone sets, and its richest common one
// (.tmp\opus\zone_bands.js, 2026-09-26). Densities weigh the bands as pile
// counts would.
const FREE_ZONE_BANDS = (() => {
	const start = [{ min: 300, max: 3000, density: 9 }, { min: 3000, max: 6000, density: 6 },
		{ min: 10000, max: 15000, density: 1 }];
	return {
		[BIOME_CLASS.PLAYER]: start, [BIOME_CLASS.LOW_LOOT]: start,
		[BIOME_CLASS.TOWN]: [{ min: 6000, max: 8999, density: 9 }, { min: 10000, max: 17000, density: 9 },
			{ min: 17000, max: 20000, density: 3 }],
		[BIOME_CLASS.STANDARD]: [{ min: 10000, max: 15000, density: 9 }, { min: 15000, max: 20000, density: 6 },
			{ min: 20000, max: 30000, density: 1 }],
		[BIOME_CLASS.HIGH_LOOT]: [{ min: 3080, max: 12500, density: 4 }, { min: 15000, max: 50000, density: 3 },
			{ min: 45000, max: 75000, density: 3 }],
	};
})();
const { singleTemplate, dominoTemplate, trominoTemplate, mergedTemplate,
	packFor, clusterTemplate, DECOR_TYPES,
	DECOR_BLOCKED_SHARE,
	DECOR_BLOCKED_SHARE_UNDERGROUND } = require('./decor');
const DECOR_TYPE_SET = new Set(DECOR_TYPES);
// Pockets (Opus Map Vision, 2026-10-01, branch opus-coldshadow). The engine's guard stands on the only way into the
// pile it guards (TreasurePlacer; ObjectManager::addGuard puts it on the entrance and the pile's border is blocked).
// Ours used to refuse to take a target's last open approach and posted the guard beside it, so a hero walked round
// it (tools/mapsight: 49% of our guards beside loot a hero walks around, the engine 2%; high loot sealed 8% against
// 76%). With pockets on, a pile's guard may take the last approach, and the target's other approach tiles get a
// one-tile obstacle each, so the guard is the way in. VMAPGEN_SEAL_POCKETS=0 is the old placement.
const SEAL_POCKETS = process.env.VMAPGEN_SEAL_POCKETS !== '0';
const POCKET_LOOT = /^(randomArtifact|artifact$|pandoraBox$|spellScroll$)/;
const NOOK_T = {}; const RING_T = {}; if (process.env.VMAPGEN_RING_TRACE) process.on('exit', () => console.error('[ring] ' + JSON.stringify(RING_T))); if (process.env.VMAPGEN_NOOK_TRACE) process.on('exit', () => console.error('[nook] ' + JSON.stringify(NOOK_T)));
const SEAL_TRACE = process.env.VMAPGEN_SEAL_TRACE ? {} : null;
const SEAL_ABSORB = process.env.VMAPGEN_SEAL_ABSORB !== '0';
const SEAL_TIGHT = process.env.VMAPGEN_SEAL_TIGHT !== '0';
const SEAL_MODEL = process.env.VMAPGEN_SEAL_MODEL || 'ring';
const SEAL_SPOT = process.env.VMAPGEN_SEAL_SPOT !== '0';
const SEAL_MOVE = process.env.VMAPGEN_SEAL_MOVE !== '0';
const SEAL_RESITE = process.env.VMAPGEN_SEAL_RESITE !== '0';
const SEAL_GATHER = process.env.VMAPGEN_SEAL_GATHER !== '0';
const SEAL_LOOK = Math.max(1, Number(process.env.VMAPGEN_SEAL_LOOK || 8));
// With pockets, pile guards go to the dearest unguarded things first (the engine's strongest guards stand in front of
// its richest piles; ours posted them by the pile's kind and most landed on resources: 175 of 421 on a Coldshadow map,
// 9 of 92 dwellings guarded). Lower is dearer.
// Dwellings first (VMAPGEN_DWELLING_FIRST=0 puts relics first as before): the engine's dwelling shares its guard with a
// pile of treasure (0.82 of them on Coldshadow's Fantasy), so one guard on a dwelling with the zone's dear pickups
// gathered beside it seals both; relics first left 0.21 of our dwellings with no guard at all (2026-10-02).
const DWELLING_FIRST = process.env.VMAPGEN_DWELLING_FIRST !== '0';
const POCKET_RANK = { randomArtifactRelic: DWELLING_FIRST ? 1.5 : 1, creatureGeneratorCommon: DWELLING_FIRST ? 1 : 2, creatureGeneratorSpecial: DWELLING_FIRST ? 1 : 2, randomDwelling: DWELLING_FIRST ? 1 : 2,
	pandoraBox: 3, dragonUtopia: 3, randomArtifactMajor: 4, creatureBank: 5, spellScroll: 6, artifact: 6, randomArtifactMinor: 7,
	prison: 8, randomArtifactTreasure: 9, treasureChest: 10, campfire: 11, randomResource: 12, resource: 12 };
if (SEAL_TRACE) process.on('exit', () => console.error('[seal] ' + JSON.stringify(SEAL_TRACE)));

/*
 * Cave content density. Measured 2026-09-24 per floor cell of carved levels
 * (vmap_leveldensity.js, LEVEL 1, 71-map corpus vs 29-map sweep): functional
 * objects block 24.5% of our cave floor against the corpus's 18.6%, while
 * scenery blocks 1.4% against 14.5%. The fill's per-1000-cell rates were
 * tuned on the surface; a cave spends them on a third of the ground.
 */
const CAVE_CONTENT_SCALE = 18.6 / 24.5;
const { MINE_SUBTYPE } = require('../rmg/template');
const { zonePool: pileZonePool, preparePile } = require('../rmg/piles');

/**
 * Options every wandering monster needs.
 *
 * CGCreature::initialCharacter defaults to COMPLIANT, which sets agression to
 * -4. In takenAction the fight branch is `charisma < agression`, and charisma
 * bottoms out at -3 even for a hero three times weaker than the guard, so a
 * compliant stack can never fight; it falls through to the compliant join
 * branch and hands itself over for free. Every monster we generated before this
 * was a free recruit rather than an obstacle. All 24791 monsters across the 71
 * installed VCMI random maps are hostile, and the engine's own RMG sets the
 * same value at ObjectManager.cpp:784.
 *
 * amount is deliberately left out: the creature is not chosen until the engine
 * resolves the placeholder, and CGCreature::initObj then rolls a count from
 * that creature's own adventure-map range, which is the behaviour we want.
 */
const MONSTER_OPTIONS = { character: 'hostile' };

/**
 * Stack size by creature level when the player moves the Stack size lever
 * (stackScale, 1 = leave it to the engine). The engine rolls a creature's own
 * adventure-map range; with the creature unknown at generation time, a scaled
 * map writes an explicit count from a reference curve instead: the Castle line
 * of the game's own CRTRAITS.TXT (pikemen 20-50 and halberdiers 20-30 down to
 * angels 4-10 and archangels 3-8), averaged per level. Big stacks at low
 * levels, small at high, and the lever moves the whole curve.
 */
const STACK_RANGE = [[20, 40], [16, 28], [12, 22], [10, 18], [8, 14], [5, 11], [3, 9]];
/*
 * Template guards, the engine's way (queue 39b, 2026-09-25). A template zone
 * guarded with our own class bands put a level 4-7 stack on everything in a
 * "treasure" zone: Nostalgia came out with 180 level-7 stacks a map where the
 * engine's own Nostalgia maps have 1.8. The engine sizes each guard from the
 * value it guards and picks the creature to fit; these are its rules and
 * numbers, read from VCMI's lib\rmg (TreasurePlacer.cpp,
 * ObjectManager::chooseGuard) and config\randomMap.json, with each creature's
 * AI value and adventure-map stack range from the player's own CRTRAITS.TXT
 * (creature_values.json, ! LLM Files\Tools\extract_crtraits.js).
 * Index into the arrays: zone strength (weak -1, normal 0, strong 1) plus map
 * strength (weak 2, normal 3, strong 4) minus 1; normal and normal is 2.
 */
const GUARD_MIN_VALUE = [6500, 4167, 3000, 1833, 1333];    // TreasurePlacer minGuardedValues
const GUARD_V1 = [2500, 1500, 1000, 500, 0];
const GUARD_V2 = [7500, 7500, 7500, 5000, 5000];
const GUARD_M1 = [0.5, 0.75, 1.0, 1.5, 1.5];
const GUARD_M2 = [0.5, 0.75, 1.0, 1.0, 1.5];
const MIN_GUARD_STRENGTH = 2000;                           // randomMap.json
// mines are guarded on their own RMG value (config/objects/moddables.json)
const MINE_RMG_VALUE = { sawmill: 1500, orePit: 1500, alchemistLab: 3500, sulfurDune: 3500,
	crystalCavern: 3500, gemPond: 3500, goldMine: 7000 };
const GUARD_POOL = Object.entries(require('./creature_values.json'))
	.filter(([, c]) => !c.special && c.aiValue > 0 && c.level >= 1)
	.map(([id, c]) => ({ id, ...c }));
const AZURE = GUARD_POOL.find(c => c.id === 'azureDragon') || GUARD_POOL[GUARD_POOL.length - 1];
// The share of the piles that fit which the engine actually lands, and the
// share for a rich band (min value TPL_RICH_MIN and up), whose piles it lands
// fewer of: its high-value objects run out, so a rich pile comes out smaller
// or not at all (TreasurePlacer::prepareTreasurePile). Calibrated with the
// template lens (71 corpus-matched maps, 2026-09-26) once the pile spacing
// was read as the engine reads it (squared, below): one share of 0.75 put
// guards at 1.44x with levels 5-7 at 1.8x; 0.50 got the total but leaned
// strong (level 1 0.81, levels 5-7 1.22-1.30); 0.40 rich / 0.65 other puts
// every row within 6% (guards 0.98, level 1 1.02, 5 1.05, 6 1.03, 7 1.06,
// where the old linear reading at 0.75 had level 7 at 0.63).
// VMAPGEN_TPL_PILE_SHARE, _SHARE_RICH and _RICH_MIN override them.
const TPL_PILE_SHARE = Number(process.env.VMAPGEN_TPL_PILE_SHARE) || 0.65;
const TPL_PILE_SHARE_RICH = Number(process.env.VMAPGEN_TPL_PILE_SHARE_RICH) || 0.40;
const TPL_RICH_MIN = Number(process.env.VMAPGEN_TPL_RICH_MIN) || 10000;
// VMAPGEN_TPL_PILE_MODEL=engine: a template zone's piles built as the engine
// builds them (src/rmg/piles.js) give its chests and its guards (fillBiome);
// each pile the zone has room for lands at the share of its class. Fitted
// jointly on the late corpus's guard levels and its maps' chests
// (.tmp\opus\tmp\pile_fit.js, 2026-09-27): an unguarded pile, small and easy
// to place, always lands; a guarded one at 0.70, at 0.50 in a band from
// TPL_RICH_MIN. The fit read guard levels 1-7 at 0.80-1.08 of the corpus and
// its chests at 0.95, where the rate model's maps hold 0.50.
// The engine's piles draw the Dragon Utopia as often as any bank of its rarity, but its 7x7 footprint leaves many
// of them nowhere to stand: the engine's maps hold 0.35 of what its piles drew (harness, Coldshadow's 144x144 x2,
// 15.5 on the map against 44 drawn; VMAPGEN_UTOPIA_LAND overrides).
const UTOPIA_LAND = Number(process.env.VMAPGEN_UTOPIA_LAND) || 0.35;
const TPL_PILE_MODEL = process.env.VMAPGEN_TPL_PILE_MODEL || 'engine';
// VMAPGEN_TPL_PILE_VALUES=engine: the uniform model's pile guards sized on the
// values the engine's piles reach (fillBiome)
const TPL_PILE_VALUES = process.env.VMAPGEN_TPL_PILE_VALUES || 'uniform';
const TPL_PILE_LAND_OPEN = Number(process.env.VMAPGEN_TPL_PILE_LAND_OPEN) || 1.0;
// 0.70 to 0.85 on 2026-10-02, against 12 engine maps made with K's own mods (.tmp\opus-seeing\eng_k.py, rmgrun-k):
// start zones' guards per 100 tiles 0.67-1.39 against 1.06-1.54, now 0.93-1.52
const TPL_PILE_LAND_GUARDED = Number(process.env.VMAPGEN_TPL_PILE_LAND_GUARDED) || 0.85;
const TPL_PILE_LAND_RICH = Number(process.env.VMAPGEN_TPL_PILE_LAND_RICH) || 0.50;
// by zone role (K, 2026-10-02: treasure biomes nearly bare; tools/geometry/zonefill.js against the engine's same zones):
// a treasure zone lands every rich pile (high loot per 100 open tiles 1.2-2.2 -> 2.9-4.8, the engine's 2.3-7.4), a
// junction keeps the share above (all landed it overshot: 6.5-9 against the engine's 0.8-5.8). A rule of the registry.
// 1.0 to 0.70 the same evening, measured per zone tile against the engine with K's mods (an open-tile count moves with
// our scenery and had misled): treasure zones 10-16 guards 1.3x the engine's, now 1.0-1.1x
const TPL_PILE_LAND_RICH_TREASURE = Number(process.env.VMAPGEN_TPL_PILE_LAND_RICH_TREASURE) || 0.70;
// on the surface 0.85 (K, 2026-10-12: "larger coldshadow templates are looking loot sparse in a lot of the middle biomes"): loot value
// per 100 open tiles of the treasure zones, his one-level 144x144 maps seeds 1240997561 and 1841119826, 55700 and 61100 against the
// engine's one-level 74000-77000 (2 of 3 seeds pandoras 31-39 against 56-71), now 65600 and 83500 with guards crowded 1.1% and 1.0%;
// two levels, the surface's 62800 against 82000-90000 now 69700, the underground's (80400, the engine's 65000-68000) left as it was.
// A dry surface only: on his XL Mediterranean (water 0.45, seed 1583610596) the sea takes the treasure zones' land, they already
// carried 140500 a 100 open tiles, and 0.85 crowded the guards 4.4% to 6.7%
const TPL_PILE_LAND_RICH_TREASURE_SURFACE = Number(process.env.VMAPGEN_TPL_PILE_LAND_RICH_TREASURE_SURFACE) || 0.85;
// Measured per zone tile, not per open tile (an open-tile count moves with our scenery): the engine lands about half of
// the piles of a band from 50000 in every zone role (Coldshadow's Fantasy 144 L2, 28 engine maps against 5 of ours:
// zone 21 guards 1.23 a 100 tiles against our 2.31, zones 17-20 1.0 against 1.4, at the shares above). Bands below keep
// the role's share. A rule of the registry.
const TPL_VERY_RICH_MIN = Number(process.env.VMAPGEN_TPL_VERY_RICH_MIN) || 50000;
const TPL_PILE_LAND_VERY_RICH = Number(process.env.VMAPGEN_TPL_PILE_LAND_VERY_RICH) || 0.45;
// a treasure zone's piles from 50000 (Coldshadow's central zone 21): 1.4x the engine's high loot and 1.2x its guards at 0.45
// once the kept shares went (2026-10-03)
const TPL_PILE_LAND_VERY_RICH_TREASURE = Number(process.env.VMAPGEN_TPL_PILE_LAND_VERY_RICH_TREASURE) || 0.33;
// The engine places a zone's richest band first (createTreasures, at a distance from every object that falls as the
// bands add up), and a band placed after one from 50000 finds the room taken: Coldshadow's junctions 17-20 held 3.7x
// the engine's chests and 1.4x its guards with their 10000-15000 band landing like any other. That band, and any
// after a band from 50000, lands at this share of its own in a zone that is not a treasure zone (Coldshadow's central
// treasure zone 21, whose 20000-60000 band follows two from 100000, fell to half the engine's guards with it) (2026-10-03).
// A rule of the registry.
const TPL_PILE_LAND_AFTER_RICH = Number(process.env.VMAPGEN_TPL_PILE_LAND_AFTER_RICH) || 0.3;
const TPL_PILE_LAND_CHEAP_AFTER_RICH = Number(process.env.VMAPGEN_TPL_PILE_LAND_CHEAP_AFTER_RICH) || 0.6;
/**
 * The treasure piles a template zone lands, band by band, richest first, as
 * TreasurePlacer::createTreasures asks for them: floor(tiles * density / 400)
 * a band, as many as fit at the band's spacing (see the guard pass for the
 * squared reading), times the share the engine actually lands.
 * Returns [{ band, want, count }] in that order.
 */
// richScale: the rich bands (min 50000 and up) counted on that many times the cells. A one-level map puts the zones
// the template forces underground on the surface beside all the others, each with about half the room the engine's
// map gives it (the engine still writes them on a level of their own), so their dragon dwellings came out 8 to 21
// against the engine's 18 to 28 (Coldshadow's Fantasy, 2026-10-02).
function templatePiles(bands, cellCount, richScale = 1) {
	const linearRoom = process.env.VMAPGEN_PILE_ROOM === 'linear';
	const out = [];
	let totalDensity = 0;
	for (const t of [...(bands || [])].sort((a, b) => b.max - a.max)) {
		totalDensity += t.density || 0;
		if (!totalDensity) continue;
		const minDistance = Math.max(1, Math.sqrt(Math.min(t.min, 30000) / 10 / totalDensity));
		const d = linearRoom ? minDistance : Math.sqrt(minDistance);
		const cc = t.min >= 50000 ? cellCount * richScale : cellCount;
		const byDensity = Math.floor(cc * (t.density || 0) / 400);
		const byRoom = Math.floor(cc / (d * d));
		const want = Math.min(byDensity, byRoom);
		const share = t.min >= TPL_RICH_MIN ? TPL_PILE_SHARE_RICH : TPL_PILE_SHARE;
		out.push({ band: t, want, count: Math.round(want * share), d, byDensity, byRoom });
	}
	return out;
}
// A template zone's banks come out of its treasure piles, as the engine's do:
// TreasurePlacer builds each pile from objects that fit its value, at most one
// large object (a bank is one) a pile, so a pile holds a bank at a rate set by
// how much of its value range banks can fill. Core banks are worth 1000-9000
// (creatureBanks.json rmg.value): a pile of a band starting below TPL_BANK_RICH_MIN
// holds one at TPL_BANK_P_LOW, a richer pile, where every bank competes with
// relics, Pandora's boxes and dwellings, at TPL_BANK_P_HIGH. Per core bank
// weight; a mod pool scales it the way the free-layout count does. First
// fitted on Jebus Cross 108 p4, whose corpus maps hold 73 of 85 banks near the
// starts (bands 300-16000) where ours held 9 of 58 (2026-09-26).
const TPL_BANK_RICH_MIN = Number(process.env.VMAPGEN_TPL_BANK_RICH_MIN) || 9000;
const TPL_BANK_P_LOW = Number(process.env.VMAPGEN_TPL_BANK_P_LOW) || 0.107;
const TPL_BANK_P_HIGH = Number(process.env.VMAPGEN_TPL_BANK_P_HIGH) || 0.047;
// In the band mode (VMAPGEN_TPL_BANK_MODE=band, fillBiome) a pile holds a bank
// as the engine's draw gives one: in proportion to the bank weight the band
// admits (Z, the sum of
// economy.js bankBandWeight over the zone's pool) against everything else a
// pile of that value could take, Z / (Z + TPL_BANK_K). A flat per-pile rate
// with each band's own banks had put the late corpus's banks under 2000 at
// 2.1x and those over 6000 at 0.5x (lens run t23L): a start zone's cheap bands
// hold the most piles, and there only the cheap banks compete. K = 287 spends
// the bank draws the zone-level count did over the late corpus's template
// zones (.tmp\opus\bank_bandz_calib.js, 2026-09-26): about 0.12-0.26 a pile in
// bands under 3000, 0.57 at 3000-6000, 0.66-0.73 in the rich bands.
const TPL_BANK_K = Number(process.env.VMAPGEN_TPL_BANK_K) || 287;
// The same for a template zone's dwellings (fillBiome): everything else a pile
// could take, against the odds of the zone's own dwellings its band admits.
// 16 lands the late corpus's count (36.8 a map on its 11 maps against 36.9; K 4
// and 8 gave 116 and 68; lens t41L).
const TPL_DWELL_K = Number(process.env.VMAPGEN_TPL_DWELL_K) || 16;
// Free layout only: the bank and dwelling rates were calibrated while the
// stranded sweep still dropped everything behind a pickup or a guard (19-31
// objects a 108x108 map). With that fixed (2026-09-26) the free-layout lens
// read banks 1.19 and dwellings 1.18 of the corpus, so both come down by that
// much; template maps take their counts from the zone and stay as they were.
// Again on 2026-09-27, when a start zone grew to a share of the map and its
// far ground filled as standard ground (plan.js fillLevel): banks read 1.16-
// 1.26 and dwellings 1.51-1.59 over two seeds (lens t55F), so 0.84 and 0.85
// became 0.71 and 0.55.
const FREE_BANK_SCALE = Number(process.env.VMAPGEN_FREE_BANK_SCALE) || 0.71;
const FREE_DWELL_SCALE = Number(process.env.VMAPGEN_FREE_DWELL_SCALE) || 0.55;
/** A guard for a pile of `value`, or null where the engine leaves it unguarded.
 * A zone-link guard (zoneGuard) skips the pile threshold, as the engine's does.
 * pool: the creatures the zone allows (zoneGuardPool); core by default. */
function engineGuard(value, idx, rng, zoneGuard = false, pool = GUARD_POOL) {
	const i = Math.max(0, Math.min(4, idx));
	if (!zoneGuard && !(value > GUARD_MIN_VALUE[i])) return null;
	const s = Math.floor(Math.max(0, (value - GUARD_V1[i]) * GUARD_M1[i]))
		+ Math.floor(Math.max(0, (value - GUARD_V2[i]) * GUARD_M2[i]));
	if (s < MIN_GUARD_STRENGTH) return null;
	const ok = pool.filter(c => Math.floor(c.aiValue * (c.advMin + c.advMax) / 2) < s
		&& s < c.aiValue * 100);
	const c = ok.length ? ok[(rng() * ok.length) | 0] : AZURE;
	let amount = Math.floor(s / c.aiValue);
	if (amount >= 4) amount = Math.floor(amount * (0.75 + rng() * 0.5));
	return { level: Math.min(7, c.level), amount: Math.max(1, amount), creature: c.id, strength: s };
}
/**
 * The strength (amount x AI value) the engine's own maps put on a guard by what it stands over: the medians over its Coldshadow's Fantasy
 * maps (mapsight guards, 2026-10-06; Pandora's boxes 21k where ours stood at 13k: K, "a lot of pandora boxes aren't guarded as well as they
 * are in vcmi templates"). A guard posted after the pile passes (guardDearLoot, the approach closing) takes its strength from here, not from
 * the nearest guard of its zone, which in a junction zone is a 100k dragon stack.
 */
/** A prison's experience by the value its pile drew it at (randomMap.json prisons; piles.js PRISON_VALUES). */
/** The nearest another guard may stand to a guard, in tiles (Chebyshev): the engine's stacks on 20 Coldshadow maps, nearest other stack p10 4,
 * median 5, crowded (within 2) 0.1%. Used by the guard register here and by guardDearLoot and the approach closing (plan.js, approachclose.js). */
const GUARD_GAP = 4;
const PRISON_TIER_EXP = { 2500: 0, 5000: 5000, 10000: 15000, 20000: 90000, 30000: 500000 };
// prisons by experience: the medians of the guards beside the engine's prisons of that tier on 20 Coldshadow maps (prison_tiers.js, 2026-10-08)
const LOOT_GUARD_STRENGTH = { randomArtifactRelic: 65000, pandoraBox: 21000, randomArtifactMajor: 11000, artifact: 17000, spellScroll: 5000,
	dwelling: 8000, dragonDwelling: 50000, prison90000: 61000, prison500000: 80000,
	// the engine's gold mine guards: medians 2.2k (computer starts) to 5.9k (junctions) on 20 Coldshadow maps (mine_guards.js, 2026-10-08)
	goldMine: 4000 };
function lootGuard(kind, p, rng, pool = GUARD_POOL) {
	const base = LOOT_GUARD_STRENGTH[kind];
	if (!base) return null;
	// the Monster tier lever moves the strength as it moves the engine's table (index 1 at Normal)
	const sAt = (v, i) => Math.floor(Math.max(0, (v - GUARD_V1[i]) * GUARD_M1[i])) + Math.floor(Math.max(0, (v - GUARD_V2[i]) * GUARD_M2[i]));
	const i = Math.max(0, Math.min(4, 1 + Math.max(-2, Math.min(2, Math.round(Number(p && p.monsterStrength) || 0)))));
	const s = Math.floor(base * (0.6 + 0.8 * rng()) * (sAt(20000, i) / sAt(20000, 1)));
	if (s < MIN_GUARD_STRENGTH) return null;
	const ok = pool.filter(c => Math.floor(c.aiValue * (c.advMin + c.advMax) / 2) < s && s < c.aiValue * 100);
	const c = ok.length ? ok[(rng() * ok.length) | 0] : AZURE;
	let amount = Math.floor(s / c.aiValue);
	if (amount >= 4) amount = Math.floor(amount * (0.75 + rng() * 0.5));
	return { level: Math.min(7, c.level), amount: Math.max(1, amount), creature: c.id, strength: s };
}
/** A template link's guard strength times p.linkGuardScale (plan.js linkGuardScale: a map smaller than the
 * template's own smallest), never below LINK_GUARD_MIN, under which engineGuard places no guard at all. */
const LINK_GUARD_MIN = 5000;
function scaledLinkGuard(strength, p) {
	const f = (p && p.linkGuardScale) || 1;
	if (!(strength > 0) || f >= 1) return strength;
	return Math.max(Math.min(strength, LINK_GUARD_MIN), Math.round(strength * f));
}
/**
 * The guards a template zone allows, as ZoneOptions::getMonsterTypes decides
 * them: creatures of an allowedMonsters faction (every faction when the list
 * is empty, CRmgTemplate.cpp:1028-1032) and not of a bannedMonsters one.
 * ObjectManager::chooseGuard picks only among these. Factions compare by bare
 * name; a creature that names none is neutral, as in the engine.
 */
function zoneGuardPool(pool, spec) {
	const bare = f => String(f || 'neutral').toLowerCase().replace(/^.*:/, '');
	const allowed = new Set(((spec && spec.allowedMonsters) || []).map(bare));
	const banned = new Set(((spec && spec.bannedMonsters) || []).map(bare));
	if (!allowed.size && !banned.size) return pool;
	const unbanned = pool.filter(c => !banned.has(bare(c.faction)));
	const kept = allowed.size ? unbanned.filter(c => allowed.has(bare(c.faction))) : unbanned;
	// every allowed faction banned: the engine falls back to all of them
	return kept.length ? kept : unbanned;
}
/** A dwelling of `pool` at the level nearest `level`, weighted within it. */
function nearestLevelDwelling(pool, level, rng) {
	let best = Infinity;
	for (const d of pool) best = Math.min(best, Math.abs(d.level - level));
	const near = pool.filter(d => Math.abs(d.level - level) === best);
	let roll = rng() * near.reduce((a, d) => a + (d.weight || 1), 0);
	for (const d of near) { roll -= d.weight || 1; if (roll <= 0) return d; }
	return near[near.length - 1];
}
/** A template guard's count (the engine's own rule for its value) follows the Stack size lever too; 1x leaves it as it is. */
function scaledAmount(n, p) {
	const s = p && Number.isFinite(p.stackScale) ? p.stackScale : 1;
	return s === 1 ? n : Math.max(1, Math.round(n * s));
}
function monsterOptions(tier, p, rng) {
	const s = p && Number.isFinite(p.stackScale) ? p.stackScale : 1;
	if (s === 1) return MONSTER_OPTIONS;
	const [lo, hi] = STACK_RANGE[Math.max(1, Math.min(7, tier | 0)) - 1];
	return { character: 'hostile', amount: Math.max(1, Math.round((lo + rng() * (hi - lo)) * s)) };
}

/** Which of the per-context guard toggles covers a guardable type. */
const DWELLING_GUARD_TYPES = new Set(['randomDwelling', 'creatureGeneratorCommon',
	'creatureGeneratorSpecial']);
const onOff = v => (v === undefined || v === null || Number(v) !== 0) ? 1 : 0;
function guardContextWeight(type, p) {
	if (type === 'mine') return p.mineGuardWeight * onOff(p.guardMines);
	if (DWELLING_GUARD_TYPES.has(type)) return p.lootGuardWeight * onOff(p.guardDwellings);
	return p.lootGuardWeight * onOff(p.guardTreasure);
}

// The level-1 weight that opens STANDARD zones to level-1 creeps. Only the
// standard band uses it; the start and low-loot bands keep CREEP_LEVEL_W's own
// level-1 weight. Free-layout maps drew level 1 at 0.55 of the corpus without
// it and 1.02 with 4.25 (lens runs f19 and f20B, 2026-09-26; 8 overshoots).
// VMAPGEN_STANDARD_LVL1=0 turns it off.
const STANDARD_LVL1_W = process.env.VMAPGEN_STANDARD_LVL1 !== undefined
	? Number(process.env.VMAPGEN_STANDARD_LVL1) || 0 : 4.25;

/**
 * Creature tier band per biome class.
 *
 * Wandering monsters were all emitted as plain `randomMonster`, which the
 * engine resolves to any creature of any tier, so a guard told a player
 * nothing about where they were standing. Now the tier tracks the biome the
 * way the dwelling bands already do: a wanderer in a player's home zone is a
 * tier 1-3 stack, one in a high-loot zone is tier 4-7, and the guard in front
 * of an object is bumped further by what it is guarding.
 */
const CREEP_BANDS = {
	[BIOME_CLASS.PLAYER]:    [1, 3],
	[BIOME_CLASS.TOWN]:      [2, 4],
	[BIOME_CLASS.LOW_LOOT]:  [1, 3],
	[BIOME_CLASS.STANDARD]:  [STANDARD_LVL1_W ? 1 : 2, 5],
	[BIOME_CLASS.HIGH_LOOT]: [3, 7],
};

/** Tier adjustment for the thing a guard is standing in front of. */
const GUARD_VALUE_BUMP = {
	dragonUtopia: 3,
	pandoraBox: 2,
	randomArtifactRelic: 2,
	prison: 1,
	randomArtifactMajor: 1,
	creatureBank: 1,
	mine: 1,
	randomDwelling: 0,
	creatureGeneratorCommon: 0,
	creatureGeneratorSpecial: 0,
	randomArtifactMinor: 0,
	randomArtifactTreasure: 0,
	treasureChest: 0,
	randomResource: -1,
	resource: -1,
	campfire: -1,
};

/**
 * How often each kind of object has a monster on its approach.
 *
 * Measured over 26 of the installed VCMI random maps: major artifacts 66%,
 * relics 52%, minor 48%, treasure-tier 28%, campfires 29%, chests 24%,
 * resource piles 19-24%, mines 16%, creature banks 14%. The utility buildings
 * are left alone in real maps and are left alone here: witch huts 3%,
 * windmills 4%, learning stones 4%, shrines 5%.
 *
 * randomDwelling is the one number not measured, because real maps write
 * resolved dwelling types rather than the placeholder. 0.2 puts it between a
 * chest and an artifact, which is where a free creature stack per week belongs.
 *
 * These are relative weights for spending the guard budget, not independent
 * rolls. The budget itself stays as calibrated (13.2 per 1000 cells map-wide),
 * and 75% of it goes on object guards because that is the share of monsters in
 * those same maps that sit on something's approach: 6964 of 9252.
 */
const GUARD_CHANCE = {
	randomArtifactMajor: 0.66,
	randomArtifactRelic: 0.52,
	dragonUtopia: 0.50,
	randomArtifactMinor: 0.48,
	pandoraBox: 0.45,
	prison: 0.35,
	campfire: 0.29,
	randomArtifactTreasure: 0.28,
	treasureChest: 0.24,
	randomResource: 0.22,
	randomDwelling: 0.20,
	creatureGeneratorCommon: 0.20,
	creatureGeneratorSpecial: 0.20,
	mine: 0.16,
	creatureBank: 0.14,
	resource: 0.22,
	// pockets (SEAL_POCKETS): the engine guards its scroll and placed-artifact piles too
	spellScroll: 0.40,
	artifact: 0.50,
};

/**
 * The shares of the richest loot a monster stands over in the 71 real maps (tools/map_metrics.js guarded_*:
 * relics 0.69, majors 0.65, Pandora's boxes 0.58). Ours ran 0.37, 0.36 and 0.38 because the budget was spent by
 * chance across every guardable object; K, 2026-09-30: "High loot isn't being properly gated by monsters". These
 * are guarded first, each with that chance, and the rest of the budget goes on as before.
 */
const HIGH_LOOT_GUARDED = { randomArtifactRelic: 0.69, randomArtifactMajor: 0.65, pandoraBox: 0.58 };

/** Share of the monster budget spent guarding objects rather than roaming. */
const OBJECT_GUARD_SHARE = 0.75;

// Corpus per-level monster shares: low tiers dominate. A uniform in-band pick
// put lvl2-7 at 2.3-3.9x corpus; drawing inside the band by these weights
// keeps the band semantics while the mix matches. The first weights assumed
// the corpus's mod creatures (half its guards, levels unknown then) spread
// evenly over the levels; read from the mods' own configs they do not, and
// free-layout maps matched to all 71 corpus maps ran level 7 at 2.3x the
// corpus and level 1 at 0.70x (fidelity lens, 2026-09-25). Was
// [3.3, 2.3, 2.0, 1.9, 1.9, 1.7, 1.4], then [8, 2.2, 1.9, 1.45, 1.6, 1.7, 0.75].
// With the standard band opened to level 1 these put the free layout's levels
// 1-7 at 1.02, 1.00, 1.18, 0.92, 0.96, 0.83 and 1.20 of the corpus, mean level
// 0.99 (lens run f20B, 2026-09-26; the old ones with level 1 open: 0.93 to
// 1.28, level 6 at 0.75).
// VMAPGEN_CREEP_W="w1,...,w7" replaces them for a measurement run.
const CREEP_LEVEL_W = (() => {
	const env = String(process.env.VMAPGEN_CREEP_W || '').split(',').map(Number);
	return env.length === 7 && env.every(v => v >= 0) ? env : [8, 1.83, 1.35, 1.12, 1.28, 1.98, 0.64];
})();
function creepTier(cls, rng, bump = 0) {
	const [lo, hi] = CREEP_BANDS[cls] || CREEP_BANDS[BIOME_CLASS.STANDARD];
	const w = l => (l === 1 && cls === BIOME_CLASS.STANDARD && STANDARD_LVL1_W
		? STANDARD_LVL1_W : CREEP_LEVEL_W[l - 1]);
	let sum = 0;
	for (let l = lo; l <= hi; l++) sum += w(l);
	let roll = rng() * sum, t = hi;
	for (let l = lo; l <= hi; l++) {
		roll -= w(l);
		if (roll <= 0) { t = l; break; }
	}
	return Math.max(1, Math.min(7, t + bump));
}

/** Artifact tier objects by richness bucket. */
const ART_TIERS = [
	{ type: 'randomArtifactTreasure', tpl: OBJECT_TEMPLATES.randomArtifact },
	{ type: 'randomArtifactMinor',    tpl: OBJECT_TEMPLATES.randomArtifact },
	{ type: 'randomArtifactMajor',    tpl: OBJECT_TEMPLATES.randomArtifact },
	{ type: 'randomArtifactRelic',    tpl: OBJECT_TEMPLATES.randomArtifact },
];

/**
 * Creature-bank / skill / utility fill.
 *
 * The skill and generator entries are CONCRETE objects: the engine keeps our
 * template verbatim for anything it does not randomize, so these carry the
 * animation and mask harvested from real maps rather than a remembered name.
 * Their subtype is the canonical one the engine registers, not the "object"
 * compatibility alias.
 */
const structEntry = name => ({
	type: name, tpl: STRUCTURES[name], subtype: STRUCTURE_SUBTYPE[name],
});
const FILL_TYPES = {
	// Corpus share per 1k cells: the stone out-numbers the hut ~2.5:1, so
	// the draw is weighted rather than uniform.
	skillStructures: [
		{ ...structEntry('witchHut'),      w: 19 },
		{ ...structEntry('learningStone'), w: 49 },
		{ ...structEntry('scholar'),       w: 41 },
	],
	resourceGenerators: [
		structEntry('waterWheel'),
		structEntry('windmill'),
		structEntry('mysticalGarden'),
	],
	creeps: [
		{ type: 'randomMonster', tpl: OBJECT_TEMPLATES.randomMonster, opts: MONSTER_OPTIONS },
	],
	dwellings: [
		{ type: 'randomDwelling', tpl: OBJECT_TEMPLATES.randomDwelling },
	],
	towns: [
		{ type: 'randomTown', tpl: OBJECT_TEMPLATES.randomTown },
	],
};

function pickArtifactTier(richness, rng, zd = 0, lean = 1) {
	// Corpus tier split measured 2026-09-22 (census): treasure ~26%, minor
	// ~45%, major ~38%, relic ~2% overall. The FAR field is a different
	// animal: pooled 32+ bands carry 114 treasure / 2839 minor / 2936 major
	// / 1950 relic - relics are a quarter of far-field artifacts where they
	// are one-in-fifty near the start. Tier weights therefore lean on the
	// zone's graph distance from a player start, not on richness alone.
	// 2026-09-23 recheck against the full corpus: relics are ~18% of all
	// artifacts map-wide (the old comment's "2%" was a near-field slice), so
	// the baseline relic weight rose and major came down to hold minor/major
	// near the corpus's 35/33 split.
	const w = [
		(0.65 - richness * 0.4) / (1 + zd),       // treasure thins out
		1,                                        // minor
		0.65 * (1 + zd * 0.2) * lean,             // major
		(0.10 + richness * 0.05 + zd * 0.20) * lean, // relic, rare near home
	];
	const total = w[0] + w[1] + w[2] + w[3];
	let roll = rng() * total;
	for (let i = 0; i < 4; i++) { roll -= w[i]; if (roll <= 0) return ART_TIERS[i]; }
	return ART_TIERS[0];
}

/**
 * Per-class fill recipes, as objects per 1000 biome cells.
 *
 * Calibrated 2026-09-20 against the 71 real VCMI random maps installed under
 * Maps/RandomMaps. Measuring those gave stable map-wide rates per 1000 cells
 * that barely move between a 36x36 and a 216x216: guards 13.2, resource piles
 * 25.1, treasure chests 7, campfires 1.5, creature banks 6.2, dwellings 1.5,
 * skill structures 1.0, resource generators 0.5. The rows below spread those
 * totals across the biome classes, richer in loot zones and quieter in the
 * zone a player starts in, so the area-weighted average lands near the
 * measured figure.
 *
 * These used to scale with sqrt(area), which is the wrong shape entirely: it
 * produced 100 guards per 1000 cells on a 36x36 map, roughly 7.6 times the
 * real rate, and would have gone thin on large maps for the same reason. The
 * generated map was effectively a wall of monsters with nothing behind them.
 *
 * Artifacts stay on their own expression further down because that one was
 * already linear in area and already measured correct, at 12.4 per 1000
 * against a real 11.1.
 *
 * Mines are not here. Their count is driven per player rather than per area
 * (see mineRate in plan.js), because a small map still has to give every
 * player a full set of mines and so runs a far higher density than a big one.
 *
 * The bonuses row was re-measured 2026-09-21 over 30 maps and came back at 7.36
 * per 1000 cells map-wide, where this table was carrying 2.5. The whole row was
 * scaled by that ratio, keeping the split between classes. The pool it draws
 * from grew from 13 types to 26 at the same time.
 */
/*
 * Recalibrated 2026-09-21 against the corpus, measured rather than guessed.
 *
 * ! LLM Files\Tools\content_rates.js counts every object type in a generated
 * map and in the installed corpus, in the same units (objects per 1000 map
 * cells), and prints the ratio. It compares against corpus maps within a
 * factor of two of ours by area, because density falls off with map size and
 * pooling a 36x36 with a 216x216 makes every comparison lie a little.
 *
 * Each column below was multiplied by 1/ratio from a three-map run at
 * 108x108 with four players: chests 1.54, banks 1.67, scrolls 1.37, creeps
 * 1.23, campfires 1.16, dwellings 1.08, piles 1.03, artifacts 0.67. Mines
 * came out at 1.08 and were left alone. The skills, generators and bonuses
 * columns have their own calibration and are not part of this pass.
 */
/*
 * pandoras / prisons / obelisks added 2026-09-21, first pass seeded from the
 * corpus map-wide rates (1.93 / 0.84 / 0.45 per 1000 cells): pandoras sit in
 * the loot zones where the engine's RMG puts them (TreasurePlacer), prisons
 * spread across the middle of the map, and obelisks everywhere, since the
 * puzzle only works if a player keeps finding them.
 */
/*
 * utils added 2026-09-22: the one-visit/quest/market/portal long tail the
 * census showed absent (seerHut, crypt, denOfThieves, observatory, markets,
 * camps, monoliths, ~30 types at ~4/1k map-wide). Spread by class like the
 * skills column: rarer in the loot biomes where banks already crowd.
 */
/*
 * 2026-09-22 second pass: pickup columns raised ~50% (piles/chests) and
 * ~2.5x (campfires/scrolls) because placement attrition lands ~40% of the
 * budget on a crowded map - measured post-hoc against the census, the
 * landed rate is what the corpus number means. utils raised to cover the
 * ~7/1k long tail of one-visit and quest objects.
 */
/**
 * Per-class treasure budget, in gold-equivalent value per open cell.
 *
 * VCMI gives each zone an explicit treasure spend: {min,max,density} bands,
 * `count = size * density / 400` piles rolled to land in [min,max], so a
 * start zone (~55k in 4SM0d) and a treasure zone (~242k) differ by intent
 * rather than by accident. Our fill is per-category rates, so the budget
 * is enforced differently: every value-bearing category's rate is scaled
 * by one factor that makes the zone's expected total value land on this
 * per-cell target. The targets are fitted to the corpus value-vs-distance
 * curve measured by vmap_zonevalue.js - ~380/cell at the start ring, ~800
 * out in the far field.
 */
const CLASS_VALUE_CELL = {
	[BIOME_CLASS.PLAYER]:    300,
	[BIOME_CLASS.TOWN]:      380,
	[BIOME_CLASS.LOW_LOOT]:  330,
	[BIOME_CLASS.STANDARD]:  430,
	// 950 -> 1025 tried on audit pass 5: byte-identical output (31758
	// objects both runs). HIGH_LOOT zones are anchor-saturated too, so
	// the target cannot buy more objects. The far band's value is
	// structural: MINES_PER_PLAYER 6->5 pulled ~120k/1k of un-respendable
	// mine value and dropped 32+ from 0.96x to 0.85x, so mines stay 6.
	[BIOME_CLASS.HIGH_LOOT]: 950,
};
/**
 * Mean value of one object per fill category, matching the model
 * vmap_zonevalue.js scores finished maps with. Categories absent here are
 * budget-free (mines, creeps, skills, generators, bonuses, obelisks are
 * placed by other zone fields in the engine's model and stay unscaled).
 */
const MEAN_VALUE = {
	banks: 15000, piles: 700, chests: 1500, campfires: 600, scrolls: 3000,
	pandoras: 8000, prisons: 12000, utils: 1500, artifacts: 12000,
};
/**
 * Value of one placed object, matching the fixed table vmap_zonevalue.js
 * scores a finished map with. Used only for the BUDGET_TRACE report - how
 * much a zone actually placed against what its class asked for.
 */
const BUDGET_TRACE = !!process.env.VMAPGEN_BUDGET;
const SPENT_RES = { wood: 300, ore: 300, mercury: 1000, sulfur: 1000,
	crystal: 1000, gems: 1000, gold: 750 };
const SPENT_ART = { randomArtifactTreasure: 5000, randomArtifactMinor: 10000,
	randomArtifactMajor: 20000, randomArtifactRelic: 30000 };
const SPENT_UTIL = { treasureChest: 1500, campfire: 600, pandoraBox: 8000,
	spellScroll: 3000, prison: 12000, seerHut: 6000, crypt: 2500 };
function spentValue(o) {
	const t = o.type, s = String(o.subtype || '');
	if (t === 'resource') return SPENT_RES[s] || 500;
	if (t === 'randomResource') return 750;
	if (t === 'artifact' || t === 'randomArtifact') return 10000;
	if (SPENT_ART[t] !== undefined) return SPENT_ART[t];
	if (t === 'creatureBank') return 15000;
	if (t === 'dragonUtopia') return 25000;
	if (t === 'mine') return 2500;
	if (/^creatureGenerator/.test(t) || /^randomDwelling/.test(t)) return 4500;
	return SPENT_UTIL[t] || 0;
}
// dwellings price by tier: level * ~1500 at the class band midpoint
const DWELLING_VALUE = {
	[BIOME_CLASS.PLAYER]:    3750,
	[BIOME_CLASS.TOWN]:      3000,
	[BIOME_CLASS.HIGH_LOOT]: 8250,
	[BIOME_CLASS.STANDARD]:  5250,
	[BIOME_CLASS.LOW_LOOT]:  3750,
};
/*
 * creeps doubled 2026-09-23 (queue 4d): landed guard density was 6.94/1k
 * against the corpus's 13.45/1k - ~1.94x across every class row, keeping
 * the class spread. Guards also learned to stand in front of pandora
 * boxes, prisons and dragon utopias (GUARD_CHANCE), with the tier bump
 * scaled to the guarded object's value.
 */
const CLASS_FILL = {
	// utils cut ~3.4x 2026-09-23: the draw count asked for ~9/1k while the
	// pool's corpus types total ~2.2/1k, and landmark debt turns almost every
	// draw into a placement, so seerHut/crypt/monolith landed 2-4x corpus
	// even after pool weight trims. The count, not the weights, was wrong.
	// artifacts cut ~0.7x 2026-09-23: minor/major ran 1.6x corpus; the count
	// is budget-normalized so the cut frees piles/chests, not total value.
	// bonuses cut ~0.7x same pass: every pool type ran 1.4-1.9x corpus, the
	// same too-many-draws signature as utils had. skills is a count of
	// building placements (witchHut/learningStone/scholar); corpus puts the
	// stone at ~2.5x the hut, so the pool draw is weighted now.
	[BIOME_CLASS.PLAYER]:    { dwellings: 1.90, creeps: 14.10, artifacts: 0.07, skills: 1.05, generators: 0.51, banks:  2.67, piles: 45.0, chests: 15.0, campfires: 3.8, bonuses:  5.7, scrolls: 2.3, pandoras: 0.45, prisons: 0.35, obelisks: 0.4, utils: 1.8 },
	[BIOME_CLASS.TOWN]:      { dwellings: 2.20, creeps: 25.30, artifacts: 0.09, skills: 1.25, generators: 0.61, banks:  6.18, piles: 41.0, chests: 16.5, campfires: 4.0, bonuses:  6.6, scrolls: 3.1, pandoras: 1.2, prisons: 0.7, obelisks: 0.5, utils: 2.8 },
	// audit pass 6: the far band is anchor-saturated at ~0.83x corpus on
	// the pooled 53-map zonevalue measure, so value has to come from a
	// richer mix per slot, not more objects. artifacts 0.45->0.90 shot
	// the artifact class to 1.55x (minor 1.80); 0.60 is the landing.
	[BIOME_CLASS.HIGH_LOOT]: { dwellings: 1.45, creeps: 58.22, artifacts: 0.60, skills: 0.77, generators: 0.26, banks: 21.71, piles: 37.0, chests: 22.0, campfires: 5.5, bonuses:  7.2, scrolls: 14.0, pandoras: 6.0, prisons: 2.5, obelisks: 0.8, utils: 2.0 },
	[BIOME_CLASS.STANDARD]:  { dwellings: 1.70, creeps: 31.51, artifacts: 0.16, skills: 0.96, generators: 0.51, banks: 10.35, piles: 39.0, chests: 17.0, campfires: 4.3, bonuses:  5.2, scrolls: 5.5, pandoras: 1.9, prisons: 0.85, obelisks: 0.65, utils: 2.5 },
	[BIOME_CLASS.LOW_LOOT]:  { dwellings: 1.05, creeps: 21.96, artifacts: 0.07, skills: 0.67, generators: 0.92, banks:  2.67, piles: 48.0, chests: 15.5, campfires: 4.0, bonuses:  3.3, scrolls: 2.3, pandoras: 0.85, prisons: 0.55, obelisks: 0.5, utils: 2.0 },
};
// 2026-09-23 census rebalance: landed rates ran chests 1.71x, scrolls 1.53x
// and artifacts 1.44x corpus while banks sat at 0.87x. The zone budget
// normalises total value, so these are mix weights, not fill rates - cutting
// the overshooters frees value the budget reallocates into the under-target
// classes. Cuts run deeper than the raw ratio because the vf scale recovers
// part of the cut.
for (const cls in CLASS_FILL) {
	CLASS_FILL[cls].chests *= 0.75;
	CLASS_FILL[cls].scrolls *= 0.70;
	CLASS_FILL[cls].artifacts *= 0.70;
	CLASS_FILL[cls].campfires *= 0.55;
	// audit loop pass 1: dwellings ran 2.15x corpus pooled. Same mix-weight
	// logic - the budget rebalances into whatever the cut frees. Piles ran
	// 1.50x the same pass (the cheapest object per value point, so the
	// normaliser keeps buying them).
	CLASS_FILL[cls].dwellings *= 0.50;
	CLASS_FILL[cls].piles *= 0.80;
}
// 2026-09-23 rebalance against the repointed 75-map corpus (MapsArchive
// union): dwellings landed 0.43x (the 0.50 cut above overshot), the
// bonus/skill/generator families ~0.3x, obelisks 0.51x, banks 0.86x LOW;
// resources 1.30x, chests 1.25x, campfires 1.35x HIGH. The count-driven
// columns (dwellings, bonuses, skills, generators, obelisks) move the
// emitted rate directly; the value-bearing ones are mix weights the zone
// budget spends, so cutting chests/piles/campfires is what pays for the
// banks raise.
for (const cls in CLASS_FILL) {
	CLASS_FILL[cls].dwellings *= 2.2;
	CLASS_FILL[cls].banks *= 1.15;
	// audit-loop pass 3: the bank class total read 0.81-0.85x corpus and the
	// two 1.15 raises above chased it. The real number: over half the corpus
	// bank class is mod-art types we cannot emit; corpus core banks total
	// ~2.4/1k and we land 5.0/1k, so core banks run ~2x over. Cut toward the
	// core rate - the zone budget spends the difference on the classes that
	// are actually low. 0.5 -> landed 3.69/1k (1.53x core); second step to
	// 0.325 targets the last third of the gap.
	CLASS_FILL[cls].banks *= 0.325;
	// 2026-09-25: mod banks place now, and the count grows with the pool
	// (bankWeight / CORE_BANK_WEIGHT in fillBiome), so this column is the
	// core-pool count and the total follows the install. It landed core at
	// 1.26x and the total at 1.31x (fidelity lens runs B0 and T5); this
	// takes both to the corpus.
	CLASS_FILL[cls].banks *= 0.76;
	// Same for dwellings: the count follows the pool (dwellPoolWeight in
	// fillBiome), and with this install's mods it landed at 1.41x the corpus
	// (lens run T7; more than the pool ratio because per-zone counts are small
	// and rounding turns some zeros into ones).
	CLASS_FILL[cls].dwellings *= 0.71;
	CLASS_FILL[cls].bonuses *= 2.6;
	CLASS_FILL[cls].skills *= 2.5;
	CLASS_FILL[cls].generators *= 2.8;
	CLASS_FILL[cls].obelisks *= 1.8;
	CLASS_FILL[cls].piles *= 0.80;
	CLASS_FILL[cls].chests *= 0.85;
	// audit-loop pass 4: resource class residual 1.24x with every subtype
	// 1.3-1.5x warm; real cut this time (an earlier attempt added only a
	// comment over these lines and measured byte-identical output - the
	// tell was 33863 objects on both runs). Landed resource 1.24->0.99x,
	// every subtype 0.82-1.21. The pile draws ARE sensitive to this knob
	// despite zone overspend - the budget respends value into other
	// columns, the count drop is what stays.
	CLASS_FILL[cls].piles *= 0.80;
	// audit-loop pass 4b: treasureChest ran 1.31-1.34x after the earlier
	// trims; same count-drop mechanism as piles.
	CLASS_FILL[cls].chests *= 0.80;
	CLASS_FILL[cls].campfires *= 0.75;
	// second pass: the utility tail pooled 2-3x on the market/camp picks;
	// the pool weights now carry the mix, the rate just spends it.
	CLASS_FILL[cls].utils *= 0.85;
	// 2026-09-24 audit pass (item 21): the rim change left more ground open
	// at fill time and every usable-scaled count grew with it - measured
	// artifacts 1.47x and monsters 1.19x corpus per floor cell on the i20c
	// sweep (vmap_leveldensity LEVEL 0; LEVEL 1 caves 1.57x / 1.20x). The
	// zone vf clamps at 2.2 on every class, so these rates ARE the landed
	// counts; the cuts are the measured reciprocals.
	CLASS_FILL[cls].artifacts *= 0.67;
	CLASS_FILL[cls].creeps *= 0.84;
	// 2026-09-24 audit pass, size-matched at the sizes K plays (surface per
	// floor cell, 7 maps at 108x108 and 5 at 144x144, .tmp/opus/typerates.js):
	// scrolls 1.35 / 1.50x corpus, campfires 1.43 / 1.78x, chests 1.32 /
	// 1.22x, dwellings 1.46 / 1.59x, obelisks 1.29 / 1.30x, skill buildings
	// 1.23-1.48x. Every class sits at the 2.2 value clamp (.tmp/opus/
	// vfcheck.js: unclamped 3.0-4.7), so each cut lands as written. Pandoras
	// (1.29 / 1.40x) and prisons (1.17 / 1.66x) are left high on purpose:
	// they carry the far band's value in place of the mod treasure objects
	// a core-only map cannot emit (far band 1.03x of corpus value).
	CLASS_FILL[cls].scrolls *= 0.72;
	CLASS_FILL[cls].campfires *= 0.63;
	CLASS_FILL[cls].chests *= 0.80;
	CLASS_FILL[cls].dwellings *= 0.70;
	CLASS_FILL[cls].obelisks *= 0.77;
	CLASS_FILL[cls].skills *= 0.80;
}

/**
 * Footprint cells for a template anchored at (x,y).
 *
 * VCMI anchors objects at the bottom-right/active cell. The engine reads a mask
 * as `usedTiles[maskH-1-i][line.length-1-j] = mask[i][j]`
 * (ObjectTemplate.cpp:269) and converts cell (X,Y) of that grid into the map
 * offset (-X,-Y), so mask[i][j] lands at
 * (x - (rowLen-1-j), y - (maskH-1-i)).
 *
 * Note rowLen, not the widest row. This used to use the widest row, which is
 * the same answer for every rectangular mask and the wrong answer for a ragged
 * one. Everything the generator ships is rectangular, but creature bank
 * templates come straight out of the live asset index, so a modded bank with
 * uneven rows would have been placed and blocked in the wrong cells.
 *
 * Non-space/'0' chars are footprint cells.
 */
function footprintCells(tpl, x, y) {
	const mh = tpl.mask.length;
	const cells = [];
	for (let i = 0; i < mh; i++) {
		const line = tpl.mask[i];
		for (let j = 0; j < line.length; j++) {
			if (line[j] === ' ' || line[j] === '0') continue;
			cells.push([x - (line.length - 1 - j), y - (mh - 1 - i), line[j]]);
		}
	}
	return cells;
}

/**
 * The cells a template actually makes impassable.
 *
 * VCMI's mask alphabet, from ObjectTemplate::readJson:
 *   ' ' '0'  nothing        'V'  VISIBLE only
 *   'B'  VISIBLE|BLOCKED    'H'  BLOCKED
 *   'A'  VISIBLE|BLOCKED|VISITABLE   'T'  BLOCKED|VISITABLE
 * so 'V' is where the sprite is drawn and nothing more: a hero walks straight
 * across it, and `blockedOffsets` never contains it.
 *
 * The generator used to reserve every mask cell, V included. That is far
 * stricter than the game: across 13 of the installed VCMI random maps, 101497
 * cells are covered by more than one object's mask, which is 28% of every mask
 * cell on those maps. Treating art as wall made the walkable region smaller
 * than it really is, rejected placements the game would accept, and made it
 * impossible to post a guard beside anything, because a 2x2 monster and a 2x2
 * resource pile cannot be adjacent if their art may not touch.
 */
function blockingCells(tpl, x, y) {
	return footprintCells(tpl, x, y).filter(([, , ch]) => 'BHAT'.includes(ch));
}

/**
 * The cells a hero steps onto to use the object, per VCMI's mask alphabet:
 * 'A' and 'T' are the visitable ones, everything else is wall or decoration.
 * An object whose entrance has no open ground beside it is scenery, however
 * valuable it is meant to be.
 */
function visitableCells(tpl, x, y) {
	const mh = tpl.mask.length;
	const out = [];
	for (let i = 0; i < mh; i++) {
		const line = tpl.mask[i];
		for (let j = 0; j < line.length; j++)
			if (line[j] === 'A' || line[j] === 'T')
				out.push([x - (line.length - 1 - j), y - (mh - 1 - i)]);
	}
	return out;
}

/**
 * The (dx,dy) offsets a hero may approach this template's visitable cells
 * from, read off visitableFrom the way ObjectTemplate::readJson builds
 * visitDir: a '+' at vf[r][c] permits approach from offset (c-1, r-1), so
 * vf[0] is the row NORTH of the cell. The engine checks the same bits on
 * both ends of every step (CMap::checkForVisitableDir, CMap.cpp:346-358), so
 * entering and leaving a visitable cell obey the same permitted set.
 *
 * An absent visitableFrom is not "any direction": readJson's else branch
 * leaves visitDir = 0x00 (ObjectTemplate.cpp:221), so the object is
 * enterable from nothing. Placement used to check all eight neighbours
 * anyway, which is how a mine could end up packed against a dragon utopia
 * with only its forbidden north face open and still pass the check.
 */
function allowedDirs(tpl) {
	const vf = tpl.visitableFrom;
	if (!vf) return [];
	const out = [];
	for (let r = 0; r < vf.length; r++) {
		const line = String(vf[r]);
		for (let c = 0; c < line.length; c++)
			if (line[c] === '+' && !(r === 1 && c === 1))
				out.push([c - 1, r - 1]);
	}
	return out;
}

/**
 * Object types whose blocking goes away when the hero uses them: monsters
 * die (CGCreature::battleFinished removes unconditionally), pickups are
 * picked up, guards stand down, prisons and pandoras empty out. The mirror
 * of REMOVABLE in ! LLM Files\Tools\check_reach.py.
 *
 * A removable object's footprint may cover another object's approach cells:
 * the cell is blocked today and open once the holder is cleared, which is
 * exactly what a posted guard is. Permanent objects may not cover them,
 * because nothing makes them go away.
 */
const REMOVABLE_TYPES = new Set([
	'monster', 'randomMonster',
	'randomMonsterLevel1', 'randomMonsterLevel2', 'randomMonsterLevel3',
	'randomMonsterLevel4', 'randomMonsterLevel5', 'randomMonsterLevel6',
	'randomMonsterLevel7',
	'artifact', 'randomArtifact', 'randomArtifactTreasure',
	'randomArtifactMinor', 'randomArtifactMajor', 'randomArtifactRelic',
	'spellScroll', 'resource', 'randomResource', 'treasureChest',
	'campfire', 'flotsam', 'seaChest', 'shipwreckSurvivor',
	'prison', 'pandoraBox', 'grail', 'hero', 'randomHero', 'boat',
	'borderGuard', 'questGuard', 'event', 'oceanBottle',
]);

/**
 * True when the object could be reached if it were placed at (x,y).
 *
 * Only the object's own BLOCKING cells are discounted. Its art cells are open
 * ground in the game, so standing on one to use the object is legal.
 *
 * Only directions the template's visitableFrom permits count. The engine
 * refuses entry from anywhere else, so an object whose open ground is all on
 * a forbidden side is scenery that happens to occupy the map.
 */
// noRim: an entrance tile on the outermost row or column does not count (a mine entered only from there can be neither guarded nor closed: nothing
// stands on the rim; MapGen Dev's gold-front, 9 of 17 open gold mines at the map edge)
function entranceOpen(tpl, x, y, l, W, H, blocked, reachable, noRim = false) {
	const own = new Set(blockingCells(tpl, x, y).map(([a, b]) => b * W + a));
	const vis = visitableCells(tpl, x, y);
	// A mountain has no visitable cell and no entrance to keep open. Asking
	// whether its entrance is reachable is a question with no answer, and
	// falling off the end of the loop answered "no", which is why no scenery
	// larger than one cell could ever be placed. sweepStranded already treats
	// a template with no visitable cell as scenery; match it here.
	if (!vis.length) return true;
	for (const [vx, vy] of vis)
		for (const [dx, dy] of allowedDirs(tpl)) {
			const nx = vx + dx, ny = vy + dy;
			if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
			if (noRim && (nx === 0 || ny === 0 || nx === W - 1 || ny === H - 1)) continue;
			const c = ny * W + nx;
			if (own.has(c)) continue;                  // its own walls do not count
			if ((blocked[l * W * H + c] & OCCUPIED) || (FILL_SHADOW && shadowAt(blocked, l * W * H + c))) continue;
			if (reachable && !reachable[c]) continue;
			return true;
		}
	return false;
}

/**
 * The `blocked` grid carries two independent flags per cell:
 *   OCCUPIED  an object's wall stands here, nothing may walk through
 *   RESERVED  keep this clear, but it is walkable ground
 *
 * RESERVED exists for the doorways carved between biomes. Once art stopped
 * reserving ground, objects packed tightly enough to plug those gaps, and a
 * 36x36 map could end up with a 463 cell region sealed behind its own
 * scenery. The doorway cells are the map's corridors, so they are held open
 * without being treated as walls by the reachability walk.
 */
const OCCUPIED = 1;
const RESERVED = 2;
/**
 * APPROACH marks a cell that is a permitted approach to something already
 * placed: keep it open so the object stays usable. Permanent objects may not
 * cover it (footprintFits refuses); removable ones may, since a guard on the
 * approach is the normal way a treasure gets watched and the cell opens the
 * moment the guard dies. The engine's RMG keeps the same set clear, the
 * accessibleArea of RmgObject.cpp:70-84.
 */
const APPROACH = 4;
/**
 * A tile under a monolith's or a gate's picture (its passable V cells too), kept in a table of its own beside the `blocked` grid (a flag
 * bit in the grid read as "taken" to every pass that tests a tile for any flag, and gold mines went unguarded, bare areas grew): a player
 * sees no way in there
 * there, so entranceOpen does not count it (K, 2026-10-11, the two-way monolith over the gem pond). plan.js fillLevel sets it.
 */
const SHADOWS = new WeakMap();
// the fill's refusal and entranceOpen's read of the marks, on only with VMAPGEN_FILL_SHADOW=1: they cut K's 876637007 to 3 covered
// objects (9 with clearEntranceShadow alone), but moved the fill so that a 108x108 two-player Coldshadow seed 3 crowded 5.1% of its
// stacks within 2 tiles of another (approach-tiles.test.js, limit 5%; 4.x% before). Until that is worked out, clearEntranceShadow and
// openShutEntries (plan.js) do the work.
const FILL_SHADOW = process.env.VMAPGEN_FILL_SHADOW === '1';
/** Mark tile `i` (level offset included) of a `blocked` grid as under an entrance's picture. */
function markShadow(blocked, i) {
	let s = SHADOWS.get(blocked);
	if (!s) SHADOWS.set(blocked, s = new Uint8Array(blocked.length));
	s[i] = 1;
}
/** Whether tile `i` of a `blocked` grid lies under an entrance's picture. */
function shadowAt(blocked, i) {
	const s = SHADOWS.get(blocked);
	return !!(s && s[i]);
}
/** Whether any cell of a template's picture at (x, y), its V cells too, lies under an entrance's picture. */
function pictureOnShadow(tpl, x, y, l, W, H, blocked) {
	const m = (tpl && tpl.mask) || [];
	for (let i = 0; i < m.length; i++) for (let j = 0; j < m[i].length; j++) {
		if (!/[VBA]/.test(m[i][j])) continue;
		const fx = x - (m[i].length - 1 - j), fy = y - (m.length - 1 - i);
		if (fx >= 0 && fy >= 0 && fx < W && fy < H && shadowAt(blocked, l * W * H + fy * W + fx)) return true;
	}
	return false;
}
const MONSTER_TYPE = /^(monster|randomMonster)/;

function reserveCell(blocked, l, W, H, cell) {
	if (cell >= 0 && cell < W * H) blocked[l * W * H + cell] |= RESERVED;
}

/**
 * Every placed object's visitable cells, per blocked grid (global cell index,
 * level * W * H + cell): markApproach records them as each object lands, so
 * any placement can ask whether a cell is some object's entrance.
 */
const ENTRANCES = new WeakMap();
function entrancesOf(blocked) {
	let set = ENTRANCES.get(blocked);
	if (!set) ENTRANCES.set(blocked, (set = new Set()));
	return set;
}

/**
 * Whether a monster at (x, y) would stand over ground it must leave free: a
 * road, a corridor, a doorway or a held gate site (RESERVED), or another
 * object's entrance, within the 3x3 it guards, other than the cells in
 * `except` (the object it guards, and its approach). The engine refuses such a
 * guard (TreasurePlacer.cpp:1071: what the guard blocks beyond its own object
 * may not touch the zone's free paths, a road or any object's visitable
 * tile): a monster beside a road makes the road a fight. On [HotA] Nostalgia
 * seed 5002 treasure guards below stood over the only ways to two gates the
 * template leaves free, and pink was cut off from the three starts it shares
 * ground with.
 */
function reachOnReserved(tpl, x, y, l, W, H, blocked, except = null) {
	const own = new Set(blockingCells(tpl, x, y).map(([a, b]) => b * W + a));
	const entrances = ENTRANCES.get(blocked);
	for (const [vx, vy] of visitableCells(tpl, x, y))
		for (let dy = -1; dy <= 1; dy++)
			for (let dx = -1; dx <= 1; dx++) {
				const nx = vx + dx, ny = vy + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const c = ny * W + nx;
				if (own.has(c) || (except && except.has(c))) continue;
				if (blocked[l * W * H + c] & RESERVED) return true;
				if (entrances && entrances.has(l * W * H + c)) return true;
			}
	return false;
}

/**
 * Mark a placed object's open approach cells, so whatever lands next cannot
 * cover the only ground a hero may stand on to reach it. Only directions the
 * template's visitableFrom permits are marked: a monster packed against a
 * front-facing object's north face costs nothing, but a mountain covering
 * its south row corks it forever.
 */
function markApproach(tpl, x, y, l, W, H, blocked) {
	const own = new Set(blockingCells(tpl, x, y).map(([a, b]) => b * W + a));
	const entrances = entrancesOf(blocked);
	for (const [vx, vy] of visitableCells(tpl, x, y))
		if (vx >= 0 && vy >= 0 && vx < W && vy < H) entrances.add(l * W * H + vy * W + vx);
	for (const [vx, vy] of visitableCells(tpl, x, y))
		for (const [dx, dy] of allowedDirs(tpl)) {
			const nx = vx + dx, ny = vy + dy;
			if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
			const c = ny * W + nx;
			if (own.has(c) || (blocked[l * W * H + c] & OCCUPIED)) continue;
			blocked[l * W * H + c] |= APPROACH;
		}
}

/**
 * Walkable cells reachable from `seed`, as a count and a flag array.
 * Eight way, matching hero movement; RESERVED ground is walkable.
 */
function floodFrom(blocked, l, W, H, seed, out) {
	const base = l * W * H;
	out.fill(0);
	if (seed < 0 || (blocked[base + seed] & OCCUPIED)) return 0;
	const stack = [seed];
	out[seed] = 1;
	let n = 0;
	while (stack.length) {
		const c = stack.pop();
		n++;
		const x = c % W, y = (c / W) | 0;
		for (let dy = -1; dy <= 1; dy++)
			for (let dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue;
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const i = ny * W + nx;
				if (out[i] || (blocked[base + i] & OCCUPIED)) continue;
				out[i] = 1;
				stack.push(i);
			}
	}
	return n;
}

/**
 * A guard against the fill walling the map off with its own scenery.
 *
 * Each object contributes only a cell or two, so nothing looked wrong at any
 * single placement, and yet a 36x36 map could finish with a 463 cell region
 * sealed behind an unbroken line of five resource piles. The earlier version of
 * the code hid this by reserving every object's ART as well, which spread
 * objects two or three cells apart and made an accidental wall impossible; that
 * is also why it was never noticed. Now that packing matches the game, the
 * connectivity has to be checked instead of assumed.
 *
 * `tolerance` is the ground a placement may legitimately consume beyond its own
 * footprint: filling a one or two cell nook is fine, cutting a region is not.
 */
function makeConnectivityGuard(blocked, l, W, H, tolerance = 2, preferred = -1) {
	const base = l * W * H;
	let flags = new Uint8Array(W * H);
	let scratch = new Uint8Array(W * H);
	// The region this guard protects has to be the one the game is played in.
	// Taking the first free cell in row order picks whatever pocket happens to
	// sit at the top left, and the guard then defends a handful of tiles while
	// the fill quietly walls off the rest of the map: two 36x36 seeds finished
	// with a third of their ground reachable and nothing complained.
	let seedCell = (preferred >= 0 && preferred < W * H
		&& !(blocked[base + preferred] & OCCUPIED)) ? preferred : -1;
	if (seedCell < 0) {
		// largest free region, found once
		const seen = new Uint8Array(W * H);
		let bestSize = 0;
		for (let i = 0; i < W * H; i++) {
			if (seen[i] || (blocked[base + i] & OCCUPIED)) continue;
			const n = floodFrom(blocked, l, W, H, i, scratch);
			for (let k = 0; k < W * H; k++) if (scratch[k]) seen[k] = 1;
			if (n > bestSize) { bestSize = n; seedCell = i; }
		}
	}
	let count = floodFrom(blocked, l, W, H, seedCell, flags);
	let pending = -1;

	const pickSeed = () => {
		if (seedCell >= 0 && !(blocked[base + seedCell] & OCCUPIED)) return seedCell;
		for (let i = 0; i < W * H; i++)
			if (flags[i] && !(blocked[base + i] & OCCUPIED)) return i;
		return -1;
	};

	return {
		get size() { return count; },
		reachable: flags,
		/** True when marking `cells` would keep the map in one piece. */
		accepts(cells) {
			pending = -1;
			if (count <= 0) return true;          // nothing measured, allow
			let lost = 0;
			const newly = [];
			for (const c of cells) {
				if (flags[c]) lost++;
				if (blocked[base + c] & OCCUPIED) continue;
				blocked[base + c] |= OCCUPIED;
				newly.push(c);
			}
			let after = floodFrom(blocked, l, W, H, pickSeed(), scratch);
			// the seed may stand in a pocket a placement made without accepts() closed (a guard set in a walled pile's mouth): every flood
			// from it then came out small and every town and mine after it was refused (bank pockets, 144x144 seed 1: 7 of 17 towns,
			// 2026-10-09). Before refusing, judge from the largest region left and seed there.
			if (after < count - lost - tolerance) {
				const seen = new Uint8Array(W * H);
				let bestSize = 0, bestSeed = -1;
				for (let i = 0; i < W * H; i++) {
					if (seen[i] || (blocked[base + i] & OCCUPIED)) continue;
					const n = floodFrom(blocked, l, W, H, i, scratch);
					for (let k = 0; k < W * H; k++) if (scratch[k]) seen[k] = 1;
					if (n > bestSize) { bestSize = n; bestSeed = i; }
				}
				if (bestSize >= count - lost - tolerance && bestSeed >= 0) { seedCell = bestSeed; after = floodFrom(blocked, l, W, H, seedCell, scratch); }
			}
			for (const c of newly) blocked[base + c] &= ~OCCUPIED;
			if (after < count - lost - tolerance) return false;
			pending = after;                      // reuse this flood on refresh
			return true;
		},
		/**
		 * Take the accepted placement as done. The caller has already marked
		 * the cells, so the flood computed inside accepts() still applies and
		 * is simply swapped in rather than repeated.
		 */
		refresh() {
			if (pending >= 0) {
				const t = flags; flags = scratch; scratch = t;
				this.reachable = flags;
				count = pending;
				pending = -1;
				seedCell = pickSeed();
				return;
			}
			const was = count;
			seedCell = pickSeed();
			count = floodFrom(blocked, l, W, H, seedCell, flags);
			// a placement made without accepts() (a guard, a rock wall) can close the seed into a pocket, and the guard then
			// defends the pocket and refuses whatever touches the real ground: on a 108 two-level map its region fell to 556
			// tiles and every town and mine of three zones found no room (2026-10-04). Re-seed on the largest region.
			if (count < was / 2) {
				const seen = new Uint8Array(W * H);
				let bestSize = count, bestSeed = seedCell;
				for (let i = 0; i < W * H; i++) {
					if (seen[i] || (blocked[base + i] & OCCUPIED)) continue;
					const n = floodFrom(blocked, l, W, H, i, scratch);
					for (let k = 0; k < W * H; k++) if (scratch[k]) seen[k] = 1;
					if (n > bestSize) { bestSize = n; bestSeed = i; }
				}
				if (bestSeed !== seedCell) { seedCell = bestSeed; count = floodFrom(blocked, l, W, H, seedCell, flags); }
			}
		},
	};
}

/**
 * Would this template's impassable cells all land on free ground inside the
 * map? Art cells are ignored: they may overlap another object and may hang off
 * the edge, both of which real maps do constantly.
 *
 * `soft` is set for removable objects (REMOVABLE_TYPES): they may stand on a
 * cell somebody else needs as an approach, because they leave once used.
 * RESERVED stays off-limits to everything: a door cell behind a monster is
 * still a door that has to work before the monster is dead.
 */
// K, 2026-10-08: "can you spot the outcasts and school of magic? both are placed improperly close to the top map edge ... We should not place at the
// top grid row, anything taller than one tile, and anything taller than two grid tiles at the top two, and so on". An object is drawn up and to the
// left of its anchor over its whole mask (the visible-only V cells too), so one that is visited (a building, a dwelling, a pickup, a monster) stands
// where all of it is on the map: anchor row at least height - 1, anchor column at least width - 1 (the lead's extension to the left edge; K may veto
// it). Plain scenery keeps the old test: the border's mountains and trees cross the edge on the engine's maps too. Every path through here.
const EDGE_DIMS = new WeakMap();
function edgeDims(tpl) {
	let d = EDGE_DIMS.get(tpl);
	if (d === undefined) {
		const m = tpl.mask || [];
		d = m.some(r => r.includes('A')) ? { h: m.length, w: Math.max(...m.map(r => r.length)) } : null;
		EDGE_DIMS.set(tpl, d);
	}
	return d;
}
/** the anchor puts a visited object's picture over the top or left edge (footprintFits refuses it) */
function crossesEdge(tpl, x, y) {
	const ed = tpl && tpl.mask ? edgeDims(tpl) : null;
	return !!(ed && (y - (ed.h - 1) < 0 || x - (ed.w - 1) < 0));
}
function footprintFits(tpl, x, y, l, W, H, blocked, soft = false) {
	const ed = tpl && tpl.mask ? edgeDims(tpl) : null;
	if (ed && (y - (ed.h - 1) < 0 || x - (ed.w - 1) < 0)) return false;
	const veto = soft ? (OCCUPIED | RESERVED) : (OCCUPIED | RESERVED | APPROACH);
	for (const [fx, fy] of blockingCells(tpl, x, y)) {
		if (fx < 0 || fy < 0 || fx >= W || fy >= H) return false;
		if (blocked[l * W * H + fy * W + fx] & veto) return false;
	}
	return true;
}

/**
 * Mark a template's cells used. Returns false and marks nothing when any cell
 * falls off the map.
 *
 * The bounds test is the point. A negative fx does not throw in JavaScript, it
 * indexes `fy*W - 1`, which is a real cell on the previous row, so an object
 * anchored too close to the left edge used to silently reserve somebody else's
 * ground. Player towns reach here without a fits check in front of them, which
 * is exactly the path where that could happen.
 */
function footprintBlock(tpl, x, y, l, W, H, blocked) {
	const cells = blockingCells(tpl, x, y);
	for (const [fx, fy] of cells)
		if (fx < 0 || fy < 0 || fx >= W || fy >= H) return false;
	for (const [fx, fy] of cells) blocked[l * W * H + fy * W + fx] |= OCCUPIED;
	return true;
}

/**
 * Would placing blocking cells at `cells` weld or pincer separate masses?
 * Collect the already-blocked cells within `radius` of the new cells; if
 * they are all one 8-connected mass the object extends or neighbours a
 * single mass, but two or more disconnected groups means it sits between
 * different masses - welding them at radius 1, or at radius 2 leaving the
 * one-cell gap neither side can be roomy through. The corpus's masses
 * keep that second cell of air.
 *
 * Connectivity is a real flood over the blocked set, not a local ring
 * walk: a mass curving around a pocket has its ring cells on both sides
 * of the new cells, and they are still one mass.
 */
function weldsMasses(cells, blocked, l, W, H, radius = 1, labels = null) {
	const base = l * W * H;
	const own = new Set(cells);
	const ring = [];
	const ringSeen = new Set();
	for (const c of cells) {
		const x = c % W, y = (c / W) | 0;
		for (let dy = -radius; dy <= radius; dy++)
			for (let dx = -radius; dx <= radius; dx++) {
				if (!dx && !dy) continue;
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const n = ny * W + nx;
				if (own.has(n) || ringSeen.has(n)) continue;
				if (blocked[base + n] & OCCUPIED) {
					ringSeen.add(n); ring.push(n);
				}
			}
	}
	if (ring.length < 2) return false;
	// With the masses labelled up front (blockedComponents, same blocked set,
	// `cells` still open) the flood below is one comparison per ring cell.
	if (labels) {
		const k = labels[ring[0]];
		for (let i = 1; i < ring.length; i++) if (labels[ring[i]] !== k) return true;
		return false;
	}
	// flood over the existing blocked set only: the new cells are not
	// blocked yet, so a flood that could not reach one side from the other
	// proves the ring holds two masses this placement would weld shut
	const seen = new Uint8Array(W * H);
	const st = [ring[0]];
	seen[ring[0]] = 1;
	let left = ring.length - 1;
	while (st.length && left) {
		const c = st.pop();
		const x = c % W, y = (c / W) | 0;
		for (let dy = -1; dy <= 1; dy++)
			for (let dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue;
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const n = ny * W + nx;
				if (seen[n] || own.has(n) || !(blocked[base + n] & OCCUPIED))
					continue;
				seen[n] = 1;
				if (ringSeen.has(n)) left--;
				st.push(n);
			}
	}
	return left > 0;
}

/**
 * The 8-connected masses of level l's blocked cells, one label per cell (-1
 * where open). weldsMasses answers from these in place of a flood when one
 * snapshot of `blocked` is asked about many anchors in a row.
 */
function blockedComponents(blocked, l, W, H) {
	const base = l * W * H;
	const label = new Int32Array(W * H).fill(-1);
	const st = [];
	let k = 0;
	for (let c0 = 0; c0 < W * H; c0++) {
		if (label[c0] >= 0 || !(blocked[base + c0] & OCCUPIED)) continue;
		label[c0] = k; st.push(c0);
		while (st.length) {
			const c = st.pop(), x = c % W, y = (c / W) | 0;
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					if (!dx && !dy) continue;
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const n = ny * W + nx;
					if (label[n] >= 0 || !(blocked[base + n] & OCCUPIED)) continue;
					label[n] = k; st.push(n);
				}
		}
		k++;
	}
	return label;
}

/**
 * How many free cells would blocking `cells` leave as one-cell slivers: open
 * ground that sits inside a fully free 2x2 now and inside none afterwards.
 * Those are exactly the cells roomy% (vmap_leveldensity, vmap_thickness)
 * counts against a map, and item 21 found most of our roomy gap there: on
 * 108x108 our resources leave 0.9 of them each against the corpus's 0.5,
 * artifacts 0.9 against 0.4, and a fifth of ours sit between two objects
 * with no scenery near (corpus 4-10%). The engine avoids them twice:
 * ObjectManager::findPlaceForObject takes the tile farthest from every
 * object already placed, and ObstaclePlacer blocks leftover ground that
 * touches a single blocked group.
 */
const SLIVER_RULE = process.env.VMAPGEN_SLIVER !== 'off';
/*
 * Share of placements the sliver rule binds, per class. Binding every
 * placement overshot on every class (72x72 and 108x108 A/B, objring.js:
 * resources 0.90 -> 0.25 slivers per object against the corpus's 0.49,
 * artifacts 0.87 -> 0.29 vs 0.36, mines 1.53 -> 0.65 vs 1.34, roomy 76 ->
 * 88 vs 83), so each class binds on the share that lands it on its corpus
 * rate. Monsters stay exempt (see put()).
 */
const SLIVER_SHARE = { artifact: 0.9, resource: 0.63, util: 0.55, dwelling: 0.3,
	mine: 0.15, bank: 0.1, town: 0, monster: 0 };
const sliverClass = t => /^(resource|randomResource)$/.test(t) ? 'resource'
	: /^(artifact|randomArtifact)/.test(t) ? 'artifact'
	: t === 'mine' ? 'mine'
	: t === 'creatureBank' ? 'bank'
	: /^(creatureGenerator|randomDwelling)/.test(t) ? 'dwelling'
	: /^(town|randomTown)$/.test(t) ? 'town'
	: /^(monster|randomMonster)/.test(t) ? 'monster' : 'util';
function sliverCount(cells, blocked, l, W, H) {
	const base = l * W * H;
	const own = new Set(cells);
	const open = (x, y, after) => x >= 0 && y >= 0 && x < W && y < H
		&& !(blocked[base + y * W + x] & OCCUPIED) && !(after && own.has(y * W + x));
	const roomy = (x, y, after) => {
		for (const [ox, oy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]])
			if (open(x + ox, y + oy, after) && open(x + ox + 1, y + oy, after)
				&& open(x + ox, y + oy + 1, after) && open(x + ox + 1, y + oy + 1, after))
				return true;
		return false;
	};
	const seen = new Set();
	let n = 0;
	for (const c of cells) {
		const x = c % W, y = (c / W) | 0;
		for (let dy = -1; dy <= 1; dy++)
			for (let dx = -1; dx <= 1; dx++) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const k = ny * W + nx;
				if (seen.has(k)) continue;
				seen.add(k);
				if (!open(nx, ny, true)) continue;
				if (!roomy(nx, ny, true) && roomy(nx, ny, false)) n++;
			}
	}
	return n;
}

function objectEntry(type, x, y, l, tpl, opts, subtype = 'object') {
	const template = { animation: tpl.animation, editorAnimation: '', mask: tpl.mask };
	if (tpl.visitableFrom) template.visitableFrom = tpl.visitableFrom;
	const entry = {
		instanceName: `${type}_${x}_${y}_${l}`,
		l, x, y, type, subtype,
		template,
	};
	if (opts) entry.options = opts;
	if (process.env.VMAPGEN_SRC_TRACE && /^randomMonster/.test(type)) entry.__src = new Error().stack.split('\n').slice(2, 6).map(x => (/at (\S+)/.exec(x) || [])[1]).join('<');
	return entry;
}

/**
 * Fill one biome's cells. blocked marks already-used cells (starts, barriers,
 * choke guards). Returns vmap object entries.
 *
 * towns: shared [{instanceName,x,y,color?}] registry - dwellings emitted here
 * get options.sameAsTown pointing at the nearest town so their faction follows
 * whatever faction that town resolves to at game start (including the player's
 * pre-game castle pick through owner/alignmentToPlayer chains).
 * players: [{x,y,color}] for alignmentToPlayer on neutral towns.
 */
function fillBiome(cls, cells, blocked, W, H, l, rng, params, towns = [], players = [], objectPools = {}, terrain = 'gr', reachable = null, connectivity = null, zoneMeta = null, openMask = null, zoneDist = null, preplaced = [], zoneFaction = null) {
	const p = { ...BIOME_DEFAULTS, ...params };
	let userGuardDensity = 1;
	// A template zone overrides the free-running densities: its treasure bands
	// become a loot multiplier and its monsters field a guard one. Both are
	// already resolved by the caller against the template's own median.
	if (zoneMeta) {
		p.resourceDensity *= zoneMeta.loot;
		p.pickupDensity   *= zoneMeta.loot;
		p.artifactDensity *= zoneMeta.loot;
		userGuardDensity = p.guardDensity;     // the Monster count slider, before the zone's own monsters field scales it
		p.guardDensity    *= zoneMeta.guardScale;
		// The engine builds its dwellings into the treasure piles, so a rich
		// zone holds more of them: the dwelling density follows the zone's
		// loot too (VMAPGEN_TPL_DWELL_LOOT=0 turns it off). Template lens,
		// 71 corpus-matched maps, 2026-09-26: dwellings 27.2 a map without it,
		// 45.5 with it, corpus 45.1 (core 13.3, 23.2, 23.0); the per-template
		// spread fell from 0.46 to 0.33 (mean |log ratio|), Nostalgia and
		// Jebus Cross from about half the corpus's to about all of it; no
		// other row moved. The engine's own rule (a dwelling joins a pile only
		// for the zone's town faction) is the structural fix still to come.
		// the player's own "Creature dwellings" lever, before the loot: the
		// engine model below takes its richness from the piles themselves
		p.dwellingLever = p.dwellingDensity;
		if (process.env.VMAPGEN_TPL_DWELL_LOOT !== '0') p.dwellingDensity *= zoneMeta.loot;
	}
	let fill = CLASS_FILL[cls] || CLASS_FILL[BIOME_CLASS.STANDARD];
	// Zone treasure budget: scale every value-bearing rate by the single
	// factor that lands the zone's expected value on its per-class target
	// (CLASS_VALUE_CELL). The mix inside the zone is unchanged; only how
	// much of it there is moves. Template zones carry their own treasure
	// bands through zoneMeta.loot, so they are exempt - the template IS the
	// budget there.
	if (!zoneMeta) {
		// The budget does not bind on today's fill: every class asks for 3.3x
		// to 5.1x its fill and gets the 2.2 ceiling (VMAPGEN_TRACE_BUDGET=1
		// prints it), so the ceiling and CLASS_FILL set the value. 5a's 0.67
		// discount on the player class sat under that ceiling and did nothing
		// (0.67, 0.85 and 1.0 gave byte-identical sweeps); it is gone.
		// Queue 29: player zones get a 1.3x higher ceiling. The near bands had
		// been read at 0.80x and 1.04x of the corpus only because the fill's
		// monolith pairs made map-wide teleport networks; without them they
		// read 0.73x and 0.82x, and 2.86 brings them to 0.93x and 0.96x.
		const budgetCell = CLASS_VALUE_CELL[cls] || CLASS_VALUE_CELL[BIOME_CLASS.STANDARD];
		let ev = (DWELLING_VALUE[cls] || DWELLING_VALUE[BIOME_CLASS.STANDARD])
			* fill.dwellings;
		for (const k in MEAN_VALUE) ev += fill[k] * MEAN_VALUE[k];
		// fill rates are per 1000 cells; budgetCell is per cell
		const vf = ev > 0 ? (budgetCell * 1000) / ev : 1;
		const ceiling = cls === BIOME_CLASS.PLAYER ? 2.86 : 2.2;
		const clamped = Math.min(ceiling, Math.max(0.6, vf));
		if (process.env.VMAPGEN_TRACE_BUDGET)
			console.error(`[budget] class ${cls} budget/cell ${budgetCell.toFixed(0)} `
				+ `ev/1k ${ev.toFixed(0)} vf ${vf.toFixed(3)} -> ${clamped.toFixed(3)}`);
		if (clamped !== 1) {
			fill = { ...fill };
			for (const k in MEAN_VALUE) fill[k] *= clamped;
			fill.dwellings *= clamped;
		}
	}
	// Every rate in CLASS_FILL is "per 1000 cells", and the cells that count
	// are the ones an object could stand on. On the surface that is nearly all
	// of them so this changes little, but an underground biome is mostly solid
	// rock, and counting rock put a full biome's worth of content into the
	// third of it that was carved open: 170 objects in 480 open cells.
	const usable = cells.filter(i => !(blocked[l * W * H + i] & 1));
	const area = Math.max(1, usable.length);
	const scale = area / 1000 * (openMask ? CAVE_CONTENT_SCALE : 1);
	// Stochastic rounding for thin per-biome counts: a 0.5/1k rate in a
	// 430-cell biome is 0.2 objects and Math.round always floors it to zero,
	// which is why whole object classes never appeared. floor + the odds of
	// the fractional part keeps rare types rare but real.
	const rare = rate => {
		const n = scale * rate;
		return Math.floor(n) + (rng() < n - Math.floor(n) ? 1 : 0);
	};
	const out = [];

	// A creature's map sprite is 64x64, bottom-right on its tile (tools/harness/creature_extents.js: 130 of 141 core creatures cover
	// the tile to the left and the tile above, the rest one of them), so a monster hides what stands on those tiles and the tile
	// diagonally up and left (K, 2026-10-04: "multi-grid creatures improperly placed clipping onto loot"; a fire horse over a chest).
	// A monster is therefore never put where one of those tiles holds another object, and nothing else is put where an earlier
	// monster's sprite reaches; a guard takes the side of its target that leaves the target clear. The last quarter of a placement's
	// tries takes whatever fits, so counts do not fall. VMAPGEN_MONSTER_CLIP=0 turns it off.
	const CLIP_RULE = process.env.VMAPGEN_MONSTER_CLIP !== '0';
	const CLIP_D = [[0, 0], [-1, 0], [0, -1], [-1, -1]];     // its own tile too: a guard may stand on a pickup (footprintFits soft), which is the fire horse on the chest
	const solidAt = new Set(), shadowAt = new Set();
	let clipSynced = 0;
	const clipSync = () => {
		for (; clipSynced < out.length; clipSynced++) {
			const o = out[clipSynced];
			if (!o.template || !o.template.mask) continue;
			if (/^(monster|randomMonster)/.test(o.type))
				for (const [dx, dy] of CLIP_D) { const sx = o.x + dx, sy = o.y + dy; if (sx >= 0 && sy >= 0 && sx < W && sy < H) shadowAt.add(sy * W + sx); }
			for (const [cx, cy] of footprintCells(o.template, o.x, o.y)) if (cx >= 0 && cy >= 0 && cx < W && cy < H) solidAt.add(cy * W + cx);
		}
	};
	const monsterClips = (x, y) => {
		clipSync();
		return CLIP_D.some(([dx, dy]) => x + dx >= 0 && y + dy >= 0 && solidAt.has((y + dy) * W + x + dx));
	};
	const inMonsterShadow = (tpl, x, y) => {
		clipSync();
		return footprintCells(tpl, x, y).some(([cx, cy]) => shadowAt.has(cy * W + cx));
	};

	const nearest = (list, x, y) => {
		let best = null, bd = Infinity;
		for (const t of list) {
			const d = (t.x - x) * (t.x - x) + (t.y - y) * (t.y - y);
			if (d < bd) { bd = d; best = t; }
		}
		return best;
	};

	// Restricting to the walkable region keeps content out of pockets sealed
	// off by the barrier carving. Falls back to every open cell when no region
	// was supplied, so the function still works on its own.
	let free = cells.filter(i => !blocked[l * W * H + i] && (!reachable || reachable[i]));
	if (!free.length) free = cells.filter(i => !blocked[l * W * H + i]);
	// Anything a monster might be posted in front of, collected as it is placed
	// so the guard pass can choose among them once they all exist.
	const guardable = [];
	// Open cells sharing an edge with blocking, filled in once the scenery
	// packs land. Corpus functional objects nestle against mass edges, so
	// put() draws from here three quarters of the time: a pile on open
	// ground is its own blocked component while the same pile against a
	// mass is part of it, which is where the corpus's mass count comes
	// from. Raised 0.55 -> 0.75 after the audit pass: the extra mines and
	// towns the census rebalance bought scattered as singles and roominess
	// fell from ~80 to ~70 against the corpus's 83.3.
	let edgeCells = [];
	// opts may be a value or a function of the chosen anchor (x,y).
	// `pickFrom` narrows where an anchor may be drawn from. Only the scenery
	// fill uses it, to crowd clusters onto a few massifs instead of spreading
	// them evenly; everything else draws from the whole biome as before. The
	// list is advisory: entries that have since been built on are skipped, and
	// an exhausted list falls back to the open ground so a placement is never
	// lost to a crowded massif.
	const fillStat = FILL_TRACE
		? (objectPools.__fillStat || (objectPools.__fillStat = {})) : null;
	// onlyPick: draw from pickFrom alone, never from the rest of the zone (an
	// object that belongs beside another or nowhere)
	// K, 2026-09-30: "Lots of instances of prisons being placed directly in front of other adventure map
	// buildings". Real maps leave a prison within one tile of another building 6% of the time and within two
	// 9% (tools/map_metrics.js); ours was 22% and 40%. So a prison keeps two tiles from every building placed
	// before it on the level (and the buildings placed after keep their own approach clear as ever).
	const bld = (objectPools.__bld || (objectPools.__bld = {}))[l] || (objectPools.__bld[l] = new Set());
	const NOT_BUILDING = /^(monster|randomMonster|resource|randomResource|randomArtifact|artifact|spellScroll|treasureChest|campfire|pandoraBox|prison|seaChest|flotsam|obelisk)/;
	const registerBuilding = (type, tpl, x, y) => {
		if (NOT_BUILDING.test(type) || !visitableCells(tpl, x, y).length) return;
		for (const [a, b] of blockingCells(tpl, x, y)) bld.add(b * W + a);
		for (const [a, b] of visitableCells(tpl, x, y)) bld.add(b * W + a);
	};
	for (const t of towns) if ((t.l || 0) === l) for (const [gx, gy] of t.gates || []) bld.add(gy * W + gx);
	const PRISON_GAP = process.env.VMAPGEN_PRISON_GAP === '0' ? -1 : 2;
	// K, 2026-10-04: "the fuck is this prison stacking" (108x108 one level: 13 prisons, 1.11 a 1000 tiles against the engine's 0.6 to
	// 0.77, two pairs side by side). A prison keeps PRISON_SPACING tiles from every other prison on its level, and a level holds at most
	// PRISON_RATE of them to a 1000 tiles. VMAPGEN_PRISON_SPACING=0 and VMAPGEN_PRISON_RATE=0 are the old placement.
	const PRISON_SPACING = process.env.VMAPGEN_PRISON_SPACING !== undefined ? Number(process.env.VMAPGEN_PRISON_SPACING) : 8;
	const PRISON_RATE = process.env.VMAPGEN_PRISON_RATE !== undefined ? Number(process.env.VMAPGEN_PRISON_RATE) : 0.77;
	const prisonsHere = (objectPools.__prisons || (objectPools.__prisons = {}))[l] || (objectPools.__prisons[l] = []);
	const prisonBlocked = (x, y) => (PRISON_RATE > 0 && prisonsHere.length >= Math.ceil(PRISON_RATE * W * H / 1000))
		|| (PRISON_SPACING > 0 && prisonsHere.some(([a, b]) => Math.max(Math.abs(a - x), Math.abs(b - y)) < PRISON_SPACING));
	// Guard spacing (the lead, 2026-10-08: close the gap on monsters, blockers and loot). The engine's stacks stand 4 or more tiles apart
	// (nearest other stack p10 4, median 5, crowded 0.1% on 20 Coldshadow maps); ours stood 2 and 3 apart (27 to 43% crowded), because each
	// object took its own guard beside it wherever it lay. Every guard tile laid or held on a level is registered: guardNear counts the 5x5
	// round each, guardAt keeps the tiles. A guard, a held guard tile or a walled pile whose guard tile would stand in another's 5x5 takes
	// another place first, and an object that already has a guard beside its visiting tile passes its pile's guard to the next object.
	const GREG = objectPools.__guardReg || (objectPools.__guardReg = {});
	const guardReg = GREG[l] || (GREG[l] = { near: new Uint16Array(W * H), tight: new Uint16Array(W * H), at: new Set() });
	const guardNear = guardReg.near, guardTight = guardReg.tight, guardAt = guardReg.at;
	// a stack keeps GUARD_GAP - 1 tiles of ground between it and the next (nearest other stack 4 tiles off, the engine's p10)
	const holdGuard = (x, y) => {
		if (guardAt.has(y * W + x)) return;
		guardAt.add(y * W + x);
		const R = GUARD_GAP - 1;
		for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) { const u = x + dx, v = y + dy; if (u >= 0 && v >= 0 && u < W && v < H) { guardNear[v * W + u]++; if (Math.abs(dx) <= 2 && Math.abs(dy) <= 2) guardTight[v * W + u]++; } }
	};
	const guardCrowd = (x, y) => x >= 0 && y >= 0 && x < W && y < H && guardNear[y * W + x] > 0 && !(guardAt.has(y * W + x) && guardNear[y * W + x] === 1);
	// within 2 of another stack: the crowding the engine never shows (the first choice keeps GUARD_GAP, the second at least 3)
	const guardTightAt = (x, y) => x >= 0 && y >= 0 && x < W && y < H && guardTight[y * W + x] > 0 && !(guardAt.has(y * W + x) && guardTight[y * W + x] === 1);
	const guardBeside = (tpl, x, y) => visitableCells(tpl, x, y).some(([vx, vy]) => {
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (guardAt.has((vy + dy) * W + vx + dx)) return true;
		return false;
	});
	const lootNook = (x, y) => {
		let walls = 0;
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			if (!dx && !dy) continue;
			const u = x + dx, v = y + dy;
			if (u < 0 || v < 0 || u >= W || v >= H) { walls++; continue; }
			const f = blocked[l * W * H + v * W + u];
			if (f & RESERVED) return false;
			if ((f & OCCUPIED) || (openMask && !openMask[v * W + u])) walls++;   // a cave's rock is its open mask's zero
		}
		return walls >= (openMask ? 7 : 5);   // in a cave, a dead end: the guard's tile is its only way in
	};
	// The engine's test for a guarded pile (TreasurePlacer): every free tile round it but the guard's can be walled, none of them a
	// road, a door or another object's way in, and the guard's tile has a way out. Returns the walls it needs, or -1.
	const floorAt = c => !openMask || openMask[c];
	const lootZone = new Set(cells);
	let closableHow = null;
	const closable = (x, y) => {
		closableHow = null;
		if (x < 2 || y < 2 || x >= W - 2 || y >= H - 2) return -1;
		const ring = [];
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) ring.push((y + dy) * W + x + dx);
		const freeRing = ring.filter(c => floorAt(c) && !(blocked[l * W * H + c] & OCCUPIED));
		if (!freeRing.length) return -1;
		const inRing = new Set(ring); inRing.add(y * W + x);
		const exit = g => { const gx = g % W, gy = (g / W) | 0;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const c = (gy + dy) * W + gx + dx;
				if ((dx || dy) && !inRing.has(c) && floorAt(c) && !(blocked[l * W * H + c] & OCCUPIED)) return true; }
			return false; };
		const wallable = c => !(blocked[l * W * H + c] & (RESERVED | APPROACH)) && lootZone.has(c);
		let best = -1;
		for (const g of freeRing) {
			if ((blocked[l * W * H + g] & RESERVED) || !exit(g)) continue;
			const others = freeRing.filter(c => c !== g);
			if (others.every(wallable) && (best < 0 || others.length < best)) { best = others.length; closableHow = { g, others }; }
		}
		return best;
	};
	// The same test for an object wider than a tile or entered from fewer sides than a pickup (a prison is two tiles and is not entered from
	// above): the ring is every tile beside its footprint, and the guard's tile one it can be entered from. closable() treated a prison as a
	// one-tile pickup, so its walls could shut the sides it is entered from and the sweep dropped it as unreachable (9 of 11 prisons on a
	// 144x144 one level, 2026-10-08, when prisons first went through putLoot).
	const closableFor = (tpl, x, y) => {
		closableHow = null;
		if (x < 2 || y < 2 || x >= W - 2 || y >= H - 2) return -1;
		const foot = new Set(blockingCells(tpl, x, y).map(([a, b]) => b * W + a));
		for (const c of foot) { const cx = c % W, cy = (c / W) | 0; if (cx < 2 || cy < 2 || cx >= W - 2 || cy >= H - 2) return -1; }
		const ringSet = new Set();
		for (const c of foot) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const n = c + dy * W + dx; if (!foot.has(n)) ringSet.add(n); }
		const ring = [...ringSet];
		const freeRing = ring.filter(c => floorAt(c) && !(blocked[l * W * H + c] & OCCUPIED));
		if (!freeRing.length) return -1;
		const ways = new Set();
		for (const [vx, vy] of visitableCells(tpl, x, y)) for (const [dx, dy] of allowedDirs(tpl)) { const c = (vy + dy) * W + vx + dx; if (!foot.has(c)) ways.add(c); }
		const inRing = new Set([...ringSet, ...foot]);
		const exit = g => { const gx = g % W, gy = (g / W) | 0;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const c = (gy + dy) * W + gx + dx;
				if ((dx || dy) && !inRing.has(c) && floorAt(c) && !(blocked[l * W * H + c] & OCCUPIED)) return true; }
			return false; };
		const wallable = c => !(blocked[l * W * H + c] & (RESERVED | APPROACH)) && lootZone.has(c);
		let best = -1;
		for (const g of freeRing) {
			if (!ways.has(g) || (blocked[l * W * H + g] & RESERVED) || !exit(g)) continue;
			const others = freeRing.filter(c => c !== g);
			if (others.every(wallable) && (best < 0 || others.length < best)) { best = others.length; closableHow = { g, others }; }
		}
		return best;
	};
	const plainPickup = tpl => blockingCells(tpl, 0, 0).length === 1 && (!tpl.visitableFrom || tpl.visitableFrom.join('') === '++++-++++');
	const nearBuilding = (tpl, x, y, r) => {
		for (const [a, b] of blockingCells(tpl, x, y).concat(visitableCells(tpl, x, y)))
			for (let dy = -r; dy <= r; dy++)
				for (let dx = -r; dx <= r; dx++)
					if (bld.has((b + dy) * W + a + dx)) return true;
		return false;
	};
	const put = (type, tpl, opts, subtype, tryBudget = 32, pickFrom = null,
			noEdge = false, onlyPick = false) => {
		// the art real maps put on this zone's ground, or none: a frost well or a lean-to never stands
		// on dirt or lava (terrainArt.js; VMAPGEN_TERRAIN_ART=0 turns it off)
		if (TERRAIN_ART) {
			let art = artFor(type, subtype, tpl, terrain, rng);
			// A dwelling keeps its own art where real maps never stood it: the game's object table allows the creature
			// generators on any land (OBJECTS.TXT rows 17.62-65, the neutral dragons' among them), and the corpus rule
			// threw out every dragon dwelling of a one-level Coldshadow's Fantasy, whose dragon zones move from the
			// underground to dirt (K, 2026-10-01: no dragons above ground). VMAPGEN_DWELL_ANY_GROUND=0 refuses as before.
			if (art === null && /^creatureGenerator/.test(type) && process.env.VMAPGEN_DWELL_ANY_GROUND !== '0') art = tpl;
			if (art === null) { if (fillStat) { const k = 'terrain|' + type; fillStat[k] = (fillStat[k] || 0) + 1; } return null; }
			tpl = art;
		}
		const sliverBind = SLIVER_RULE
			&& rng() < (SLIVER_SHARE[sliverClass(type)] || 0);
		let edgeSkips = 0;
		for (let tries = 0; tries < tryBudget && free.length; tries++) {
			const usePick = pickFrom && pickFrom.length && (onlyPick || tries < tryBudget - 4);
			if (onlyPick && !usePick) break;
			const src = usePick ? pickFrom
				: (!noEdge && edgeCells.length && rng() < 0.75 ? edgeCells : free);
			const i = src[(rng() * src.length) | 0];
			if (i === undefined) continue;
			const rej = r => {
				// A rejected candidate is dead forever - the blocked grid only
				// grows - so keeping it in the candidate list wastes every
				// later try on it. Shared pools (mine edges, massif cells)
				// serve several templates: only an outright blocked cell is
				// dead for all of them, so that is all they prune. The
				// fitAnchors lists are per-template, and every gate here is
				// monotone, so any rejection prunes those.
				// 'sliver' is the one gate that is not monotone (a cell that
				// would leave a sliver now can be fine once its neighbour
				// fills), so it never prunes.
				if (usePick && r !== 'sliver'
						&& (r === 'flag' || pickFrom === fitCache.get(tpl))) {
					const pi = pickFrom.indexOf(i);
					if (pi >= 0) pickFrom.splice(pi, 1);
				}
				// A cell that comes back blocked is dead for every later
				// draw in this fill too, wherever it was drawn from; free
				// and the edge lists keep it otherwise because only the
				// anchor cell is spliced on a successful place.
				if (r === 'flag') {
					const fi = free.indexOf(i);
					if (fi >= 0) free.splice(fi, 1);
					if (!usePick) {
						const ei = edgeCells.indexOf(i);
						if (ei >= 0) edgeCells.splice(ei, 1);
					}
				}
				if (fillStat) {
					fillStat[r] = (fillStat[r] || 0) + 1;
					const k = r + '|' + type;
					fillStat[k] = (fillStat[k] || 0) + 1;
				}
				return true;
			};
			if (blocked[l * W * H + i] & 1) { rej('flag'); continue; }
			const x = i % W, y = (i / W) | 0;
			// an anchor the top-edge rule refuses costs no try (bounded): a zone along the top or left edge of a small map drew mostly such anchors
			// and was left nearly empty (36x36, three zones of about 220 tiles with 2 objects each, 2026-10-08)
			// (template zones only: the free layout's start balancing ran short with it on 36x36, 8 players, seed 2, the fill leaving its starts no room)
			if (crossesEdge(tpl, x, y)) { if (zoneMeta && edgeSkips++ < tryBudget * 6) tries--; rej('edge'); continue; }
			if (!footprintFits(tpl, x, y, l, W, H, blocked,
					REMOVABLE_TYPES.has(type))) { rej('fits'); continue; }
			// no picture over a monolith's or a gate's (markShadow, plan.js fillLevel): a pile or a dwelling drawn into one
			// reads as shut or half hidden (MapGen Dev's approach-shadow on 71886b1: 0.35 objects a monolith or gate, the engine's 0.02).
			// A guard keeps off too while it has other tries (three quarters of them): stacks standing in an entrance's picture crowded
			// the entrance's own guard (approach-tiles.test.js, 108x108 seed 3: 22 of 421 stacks within 2 tiles of another)
			// On with VMAPGEN_FILL_SHADOW=1 only: on by default it cleared K's 876637007 (objects under a picture 4 -> 0) but K's six cases
			// gained 4 FAIL lines (approach-open, flyer-open, free-standing; check79, 2026-10-14). Until that is worked out it stays opt-in.
			const shadowRule = FILL_SHADOW && (!MONSTER_TYPE.test(type) || tries < tryBudget * 0.75);
			if (shadowRule && pictureOnShadow(tpl, x, y, l, W, H, blocked)) { rej('shadow'); continue; }
			if (CLIP_RULE && tries < tryBudget * 0.75
					&& (MONSTER_TYPE.test(type) ? monsterClips(x, y) : inMonsterShadow(tpl, x, y))) { rej('clip'); continue; }
			// An object whose entrance has no open ground beside it is
			// scenery. Checking here rather than after the fact keeps the
			// count honest: the object is simply placed somewhere else.
			if (!entranceOpen(tpl, x, y, l, W, H, blocked, reachable, type === 'mine' && subtype === 'goldMine')) { rej('entrance'); continue; }
			// in a template zone a monster never stands over a road, a
			// corridor, a doorway or an entrance (reachOnReserved, the
			// engine's rule). The free layout keeps its roaming monsters on
			// the routes: its monster count and its starts' guards were
			// measured with them there, and on 36x36 for eight the rule left
			// two starts with no fight between them.
			if (zoneMeta && MONSTER_TYPE.test(type) && reachOnReserved(tpl, x, y, l, W, H, blocked)) { rej('road'); continue; }
			if (MONSTER_TYPE.test(type) && ((tries < tryBudget * 0.5 && guardCrowd(x, y)) || (tries < tryBudget * 0.9 && guardTightAt(x, y)))) { rej('crowd'); continue; }
			const walls = blockingCells(tpl, x, y).map(([a, b]) => b * W + a);
			// The engine lays a guarded pile only where its walls close (TreasurePlacer); ours walls it after, and a wall a road,
			// a door or another object needs stays open. In a template zone valuable loot takes a nook first (five or more of its
			// eight neighbours already blocked, no road or door beside it), for the first three quarters of its tries, so its
			// pocket has little left to wall (K, 2026-10-04: "loot out in the open without guards being appropriately backed by
			// blocker art").
			if (zoneMeta && POCKET_LOOT.test(type) && tries < tryBudget * 0.75 && closable(x, y) < 0) { rej('nook'); if (process.env.VMAPGEN_NOOK_TRACE) { const k = 'L' + l + (openMask ? 'cave' : ''); NOOK_T[k] = (NOOK_T[k] || 0) + 1; } continue; }
			if (type === 'prison' && PRISON_GAP > 0 && nearBuilding(tpl, x, y, PRISON_GAP)) { rej('prisonGap'); continue; }
			if (type === 'prison' && prisonBlocked(x, y)) { rej('prisonSpacing'); continue; }
			// Item 21: on a bound placement, a draw that would leave a one-cell
			// sliver beside the object is refused for the first three quarters
			// of the budget, so the object lands flush against blocking or out
			// in the open. The last quarter takes whatever fits, so counts do
			// not fall. Monsters are exempt: the engine posts guards in
			// one-wide entrances on purpose (corpus monsters leave 1.0 each).
			if (sliverBind && tries < tryBudget * 0.75
					&& sliverCount(walls, blocked, l, W, H) > 0) { rej('sliver'); continue; }
			// refuse a placement that would wall part of the map off
			if (connectivity && !connectivity.accepts(walls)) { rej('conn'); continue; }
			// refuse a placement that welds two masses into one - the corpus
			// keeps its masses distinct, and a pile standing in the gap
			// between two of them is exactly where they merge. Removable
			// objects get radius 1: a pile that welds two masses today goes
			// away when it is picked up, so it only needs to avoid gluing
			// masses face to face, where permanent objects keep the corpus's
			// one cell of air.
			if (weldsMasses(walls, blocked, l, W, H,
					REMOVABLE_TYPES.has(type) ? 1 : 2)) { rej('weld'); continue; }
			// i may have come from pickFrom, so it is not guaranteed to still
			// be in free; splice(-1, 1) would drop an unrelated cell.
			const fi = free.indexOf(i);
			if (fi >= 0) free.splice(fi, 1);
			// It has to come out of the massif pool too. Taking it out of
			// `free` alone was enough while `free` was the only source: an
			// anchor could never be offered twice. A pool entry that is never
			// removed can be drawn again, and if the template's anchor cell
			// carries no BLOCKED flag then footprintFits passes a second time
			// and two objects land on one tile with one instanceName. That is
			// how 108x108 seed 15 came back with a duplicate oakTrees_26_2_0
			// and was refused by the engine check.
			if (pickFrom) {
				const pi = pickFrom.indexOf(i);
				if (pi >= 0) pickFrom.splice(pi, 1);
			}
			const o = typeof opts === 'function' ? opts(x, y) : opts;
			const entry = objectEntry(type, x, y, l, tpl, o, subtype || 'object');
			out.push(entry);
			footprintBlock(tpl, x, y, l, W, H, blocked);
			markApproach(tpl, x, y, l, W, H, blocked);
			registerBuilding(type, tpl, x, y);
			if (type === 'prison') prisonsHere.push([x, y]);
			if (MONSTER_TYPE.test(type)) holdGuard(x, y);
			if (connectivity) connectivity.refresh();
			if (GUARD_CHANCE[type]) guardable.push({ entry, tpl });
			if (fillStat) fillStat['placed|' + type] = (fillStat['placed|' + type] || 0) + 1;
			return entry;
		}
		if (fillStat) fillStat['gaveup|' + type] = (fillStat['gaveup|' + type] || 0) + 1;
		return null;
	};

	// An object on ground held for it (planLevel holds a template zone's town
	// ground before the walls and ridges): only the fit, the entrance and the
	// map's connectivity are checked. The sliver and weld gates are left out,
	// because the masses laid since were laid around this very spot.
	const putHeld = (type, tpl, opts, subtype, i) => {
		const why = r => { if (process.env.VMAPGEN_TOWN_TRACE) console.error(`[town] held spot ${i % W},${(i / W) | 0} refused: ${r}`); return null; };
		if (blocked[l * W * H + i] & 1) return why('occupied');
		const x = i % W, y = (i / W) | 0;
		if (!footprintFits(tpl, x, y, l, W, H, blocked)) return why('fits');
		if (!entranceOpen(tpl, x, y, l, W, H, blocked, reachable)) return why('entrance');
		const walls = blockingCells(tpl, x, y).map(([a, b]) => b * W + a);
		if (connectivity && !connectivity.accepts(walls)) return why('connectivity');
		const fi = free.indexOf(i);
		if (fi >= 0) free.splice(fi, 1);
		const o = typeof opts === 'function' ? opts(x, y) : opts;
		const entry = objectEntry(type, x, y, l, tpl, o, subtype || 'object');
		out.push(entry);
		footprintBlock(tpl, x, y, l, W, H, blocked);
		markApproach(tpl, x, y, l, W, H, blocked);
		if (connectivity) connectivity.refresh();
		return entry;
	};

	// Validate-without-committing, for the portal pairs below: both anchors
	// must be legal before either lands, since a lone monolith is a dead
	// object and an unplaceable pair is worse than none.
	const fitsAt = (tpl, x, y, soft) => {
		if (!footprintFits(tpl, x, y, l, W, H, blocked, soft)) return false;
		if (!entranceOpen(tpl, x, y, l, W, H, blocked, reachable)) return false;
		const walls = blockingCells(tpl, x, y).map(([a, b]) => b * W + a);
		if (connectivity && !connectivity.accepts(walls)) return false;
		if (weldsMasses(walls, blocked, l, W, H, 2)) return false;
		return true;
	};
	const commit = (type, tpl, x, y, subtype, o) => {
		const entry = objectEntry(type, x, y, l, tpl, o, subtype || 'object');
		out.push(entry);
		footprintBlock(tpl, x, y, l, W, H, blocked);
		markApproach(tpl, x, y, l, W, H, blocked);
		if (connectivity) connectivity.refresh();
		const fi = free.indexOf(y * W + x);
		if (fi >= 0) free.splice(fi, 1);
		if (GUARD_CHANCE[type]) guardable.push({ entry, tpl });
		return entry;
	};
	// Two same-subtype monoliths: the engine links every instance of one
	// subtype into a two-way portal network, so a pair is the smallest unit
	// that does anything. B is validated against the world before A lands;
	// their footprints may not share a blocked cell.
	const putPair = (u, tries = 24) => {
		for (let t = 0; t < tries && free.length; t++) {
			const iA = free[(rng() * free.length) | 0];
			if (iA === undefined) break;
			const xA = iA % W, yA = (iA / W) | 0;
			if (!fitsAt(u.tpl, xA, yA, false)) continue;
			const aCells = new Set(blockingCells(u.tpl, xA, yA)
				.map(([a, b]) => b * W + a));
			for (let t2 = 0; t2 < tries && free.length; t2++) {
				const iB = free[(rng() * free.length) | 0];
				if (iB === undefined) break;
				if (iB === iA) continue;
				const xB = iB % W, yB = (iB / W) | 0;
				if (blockingCells(u.tpl, xB, yB)
						.some(([a, b]) => aCells.has(b * W + a))) continue;
				if (!fitsAt(u.tpl, xB, yB, false)) continue;
				// the pairId ties the ends together for the stranded sweep:
				// if one end lands sealed and is dropped, the other goes too
				// instead of standing alone as a dead portal
				const ea = commit(u.type, u.tpl, xA, yA, u.subtype);
				const eb = commit(u.type, u.tpl, xB, yB, u.subtype);
				ea.pairId = eb.pairId = `mono_${u.subtype}_${xA}_${yA}`;
				return true;
			}
		}
		return false;
	};

	// The TOWN biome's neutral town is placed back in planLevel beside the
	// player starts - by fillBiome time the ridge and wall passes have spent
	// ~60% of the zone and a 5x3 town fits nowhere (measured: zero fits in
	// three straight TOWN zones, census 0.59x vs corpus 1.16).
	// A template zone's town counts, per owner. zoneMeta towns still go through
	// put() here because a template can want a town in a zone that is not
	// TOWN class. With objectPools.towns (generate.js), each is a concrete town
	// of a faction the zone allows, as the engine writes it (zoneTowns.js): the
	// zone's first town of the zone's type, which is the owner's faction in a
	// player zone (whose main town is already down), the others rolled again
	// unless townsAreSameType. A faction with no town sprite, or no pool, keeps
	// the random-town placeholder: owned ones follow the owner's castle pick,
	// neutral ones alignmentToPlayer.
	// Declared before towns and mines: put()'s rejection pruning consults it to
	// tell per-template candidate lists from shared pools.
	const fitCache = new Map();
	/*
	 * Anchors that can actually hold a template's footprint, computed lazily
	 * the first time a template is drawn in this fill. The ridge and wall
	 * passes leave the open ground in medium pockets: measured on a 72x72,
	 * schoolOfWar's 4x4 mask had 0-14 legal anchors per biome against a
	 * `free` of 40-180, so 40 uniform draws almost never found one and the
	 * big-mask one-visit types emitted at 0.00-0.06 against the corpus's
	 * ~0.1-0.3/1k even though the class draws first. Drawing from the cells
	 * where the footprint can stand turns that lottery into a pick among
	 * real candidates; the other gates (connectivity, weld, the re-check of
	 * fits and entrance inside put()) still apply per draw. The set is a
	 * snapshot taken at first draw - entries stale as later objects land,
	 * which put() re-validates, and anchors it uses are consumed.
	 */
	// a guard can stand before an object anchored here: its approach tiles open, nothing reserved within two of them
	const guardableAt = (tpl, x, y) => {
		const base = l * W * H;
		const appr = [];
		for (const [vx, vy] of visitableCells(tpl, x, y)) for (const [dx, dy] of allowedDirs(tpl)) appr.push([vx + dx, vy + dy]);
		if (!appr.length) return false;
		for (const [ax, ay] of appr) {
			if (ax < 2 || ay < 2 || ax >= W - 2 || ay >= H - 2) return false;
			if (blocked[base + ay * W + ax] & (OCCUPIED | RESERVED)) return false;
			for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (blocked[base + (ay + dy) * W + ax + dx] & RESERVED) return false;
		}
		return true;
	};
	// every approach tile of an object anchored here has four open neighbours or fewer, not counting the object's own
	// footprint (the guard and the pile then take one or two more: a spur's end)
	const nookAt = (tpl, x, y) => {
		const base = l * W * H;
		const own = new Set(blockingCells(tpl, x, y).map(([a, b]) => b * W + a));
		const appr = [];
		for (const [vx, vy] of visitableCells(tpl, x, y)) for (const [dx, dy] of allowedDirs(tpl)) { const c = (vy + dy) * W + vx + dx; if (!own.has(c)) appr.push(c); }
		if (!appr.length) return false;
		return appr.every(c => {
			const cx = c % W, cy = (c / W) | 0;
			let n = 0;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue;
				const nx = cx + dx, ny = cy + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const k = ny * W + nx;
				if (!own.has(k) && !(blocked[base + k] & OCCUPIED)) n++;
			}
			return n <= 4;
		});
	};
	const fitAnchors = tpl => {
		let s = fitCache.get(tpl);
		if (!s) {
			// footprintFits, entranceOpen and weldsMasses for every free cell,
			// with the template's offsets worked out once and the masses
			// labelled once per snapshot (nothing is placed while it is
			// taken). Same answers; the per-cell floods were 80% of a 216x216
			// map's generation time (fuzz seed 23 case 12 profile, 2026-09-25).
			const base = l * W * H;
			const veto = OCCUPIED | RESERVED | APPROACH;
			const own = blockingCells(tpl, 0, 0).map(([a, b]) => [a, b]);
			const ownKey = new Set(own.map(([a, b]) => a + ',' + b));
			const vis = visitableCells(tpl, 0, 0);
			const doors = [];
			for (const [vx, vy] of vis)
				for (const [dx, dy] of allowedDirs(tpl))
					if (!ownKey.has((vx + dx) + ',' + (vy + dy))) doors.push([vx + dx, vy + dy]);
			let labels = null;
			s = free.filter(i => {
				const x = i % W, y = (i / W) | 0;
				for (const [a, b] of own) {
					const fx = x + a, fy = y + b;
					if (fx < 0 || fy < 0 || fx >= W || fy >= H) return false;
					if (blocked[base + fy * W + fx] & veto) return false;
				}
				if (vis.length) {
					let open = false;
					for (const [a, b] of doors) {
						const nx = x + a, ny = y + b;
						if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
						const c = ny * W + nx;
						if (blocked[base + c] & OCCUPIED) continue;
						if (reachable && !reachable[c]) continue;
						open = true;
						break;
					}
					if (!open) return false;
				}
				// Every entry here still gets the full gate set inside put();
				// weld is folded into the snapshot because it was the
				// dominant rejection on the compact masks - an arena draw
				// burned 38 of 40 tries on anchors straddling two masses.
				if (!labels) labels = blockedComponents(blocked, l, W, H);
				return !weldsMasses(own.map(([a, b]) => (y + b) * W + x + a),
					blocked, l, W, H, 2, labels);
			});
			fitCache.set(tpl, s);
		}
		return s;
	};

	if (zoneMeta && zoneMeta.towns) {
		const tp = objectPools && objectPools.towns;
		const types = tp ? zoneTownTypes(zoneMeta.spec, tp.factions) : [];
		// the owner's faction in a player zone; in any other the type planMap
		// rolled for it, which its terrain already follows
		let zoneType = tp && zoneMeta.ownerColor ? tp.pinned.get(zoneMeta.ownerColor) || null
			: (zoneMeta.townType || null);
		let inZone = zoneMeta.ownerColor ? 1 : 0;
		const sameType = !!(zoneMeta.spec && zoneMeta.spec.townsAreSameType);
		for (const want of zoneMeta.towns) {
			let faction = null;
			if (types.length) {
				if (!inZone || (sameType && zoneType)) faction = zoneType || types[(rng() * types.length) | 0];
				else faction = types[(rng() * types.length) | 0];
				if (!inZone) zoneType = faction;
			}
			const tpl = faction && townTemplate(faction, want.fort, tp.useMods);
			// on the ground planLevel held for it (the engine places a zone's
			// towns first), else from the cells where a town fits: 32 blind
			// draws, three in four on wall-hugging edge cells, lost a third of
			// 8XM8's neutral towns
			const spot = zoneMeta.townSpots && zoneMeta.townSpots.length ? zoneMeta.townSpots.shift() : null;
			if (spot !== null)
				for (const [a, b2] of blockingCells(OBJECT_TEMPLATES.randomTown, spot % W, (spot / W) | 0))
					blocked[l * W * H + b2 * W + a] &= ~(OCCUPIED | RESERVED);
			// put() spends its first draws on pickFrom and its last four on any
			// free cell, so five draws give the held spot one try
			const tryPut = (budget, pickFrom) => (tpl
				? put('town', tpl, () => ({ ...(want.owner ? { owner: want.owner } : {}), hasFort: !!want.fort }),
					faction.bare, budget, pickFrom, true)
				: put('randomTown', OBJECT_TEMPLATES.randomTown, (x, y) => {
					if (want.owner) return { owner: want.owner };
					const np = players.length ? nearest(players, x, y) : null;
					return np ? { alignmentToPlayer: np.color } : undefined;
				}, undefined, budget, pickFrom, true));
			const placed = (spot !== null && putHeld(tpl ? 'town' : 'randomTown', tpl || OBJECT_TEMPLATES.randomTown,
				tpl ? (() => ({ ...(want.owner ? { owner: want.owner } : {}), hasFort: !!want.fort }))
					: ((x, y) => {
						if (want.owner) return { owner: want.owner };
						const np = players.length ? nearest(players, x, y) : null;
						return np ? { alignmentToPlayer: np.color } : undefined;
					}),
				tpl ? faction.bare : undefined, spot))
				|| tryPut(60, fitAnchors(tpl || OBJECT_TEMPLATES.randomTown));
			if (!placed)
				console.error(`[gen] level ${l}: a ${zoneMeta.spec && zoneMeta.spec.id ? `zone ${zoneMeta.spec.id}` : 'zone'} town found no room`);
			if (process.env.VMAPGEN_TOWN_TRACE)
				console.error(`[town] zone ${zoneMeta.spec && zoneMeta.spec.id}: ${placed ? `placed at (${placed.x},${placed.y})` : 'none'}${spot !== null ? ', held spot' : ''}`);
			if (!placed) continue;
			inZone++;
			if (tpl) {
				const mods = townMods(faction, tp.useMods);
				if (mods.length) placed.mod = mods;
			}
			towns.push({ instanceName: placed.instanceName, x: placed.x, y: placed.y, l,
				gates: visitableCells(tpl || OBJECT_TEMPLATES.randomTown, placed.x, placed.y) });
		}
	}

	/*
	 * Mines before scenery: the massif packs below spend the same open
	 * ground a mine's footprint needs, and running scenery first starved
	 * the ask to ~30% landed (census measured 2.09 mines/1k against the
	 * corpus's 5.29). A mine is a functional object - the zone budget was
	 * already paid for it - so it gets first pick and the scenery wraps
	 * around it, which is also how the corpus reads: mines sit inside
	 * their biome's decor rather than in the gap the packs left over.
	 */
	// Corpus mines hug the border walls and towns that are already down;
	// the edgeCells list below does not exist yet, so mines get their own
	// pickFrom built from cells touching whatever is blocked so far. Same
	// reason as the 0.75 bump: a mine scattered on open ground is a roomy
	// cell lost, against a mass it is part of the mass's outline.
	const earlyEdge = free.filter(i => {
		const x = i % W, y = (i / W) | 0;
		for (let dy = -1; dy <= 1; dy++)
			for (let dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue;
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				if (blocked[l * W * H + ny * W + nx] & OCCUPIED) return true;
			}
		return false;
	});
	// Resources of a mine's own kind lie beside it, one to three, as the
	// engine's MinePlacer lays them (randomMap.json extraResourcesLimit, 3, on
	// the ring of cells around the mine). The late corpus carries 2.04 a mine
	// and ours carried 0.15 (mine_resources.js, 2026-09-27). They count
	// against the zone's loose resource piles below, which were calibrated with
	// the corpus's in them. VMAPGEN_MINE_EXTRAS=0 leaves them out.
	let mineExtras = 0;
	const MINE_KIND = Object.fromEntries(Object.entries(MINE_SUBTYPE).map(([k, v]) => [v, k]));
	const inThisZone = new Set(cells);
	const besideMine = e => {
		const kind = e && MINE_KIND[e.subtype];
		if (!kind || process.env.VMAPGEN_MINE_EXTRAS === '0' || !PILE_KINDS) return;
		const own = new Set(blockingCells(e.template, e.x, e.y).map(([a, b]) => b * W + a));
		const ring = [];
		for (const c of own) {
			const x = c % W, y = (c / W) | 0;
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const n = ny * W + nx;
					if (!own.has(n) && inThisZone.has(n) && !(blocked[l * W * H + n] & OCCUPIED) && !ring.includes(n)) ring.push(n);
				}
		}
		for (let k = 1 + ((rng() * 3) | 0); k > 0 && ring.length; k--)
			if (put('resource', pileTemplate(kind), undefined, kind, ring.length, ring, true, true)) mineExtras++;
	};
	// the start's own mines, placed before the fill (plan.js placeStarterMines)
	for (const e of preplaced) if (e.type === 'mine') besideMine(e);
	// the zone's free tiles nearest its centre, and those farthest from every object placed so far (towns, mines,
	// everything in `out`, the start's mines), for the mines' placement below
	const zcx = cells.reduce((a, c) => a + c % W, 0) / Math.max(1, cells.length), zcy = cells.reduce((a, c) => a + ((c / W) | 0), 0) / Math.max(1, cells.length);
	const nearCentre = k => free.slice().sort((a, b) => ((a % W - zcx) ** 2 + (((a / W) | 0) - zcy) ** 2) - ((b % W - zcx) ** 2 + (((b / W) | 0) - zcy) ** 2)).slice(0, k);
	const farthestFromObjects = k => {
		const pts = [];
		for (const o of [...out, ...preplaced, ...towns]) if (o && (o.l || 0) === l && Number.isFinite(o.x)) pts.push([o.x, o.y]);
		if (!pts.length) return free.slice(0, k);
		const d = c => { const x = c % W, y = (c / W) | 0; let m = Infinity; for (const [px, py] of pts) { const v = Math.max(Math.abs(px - x), Math.abs(py - y)); if (v < m) m = v; } return m; };
		const scored = free.map(c => [c, d(c)]);
		scored.sort((a, b) => b[1] - a[1]);
		return scored.slice(0, k).map(([c]) => c);
	};
	if (zoneMeta) {
		// A template zone gets the mines it lists and no others, as the
		// engine's MinePlacer does; a zone listing none used to draw its
		// class's random mines (Mini Nostalgia: 35 mines against the engine's
		// 16). The starter mines already placed near a start's town count
		// toward that start zone's wood and ore.
		// The engine places a zone's mines as required objects and gets them all
		// down; 48 draws on wall-hugging cells alone left Headquarters at 56 of
		// its 66 and Jebus Cross at 42 of 60, so a mine that finds no edge cell
		// takes one from the cells where it fits.
		const done = zoneMeta.minesDone || {};
		let missed = 0, asked = 0;
		for (const [res, count] of Object.entries(zoneMeta.mines || {})) {
			const subtype = MINE_SUBTYPE[res];
			if (!subtype) continue;
			const mt = mineTemplate(subtype, terrain);
			for (let i = done[res] || 0; i < count; i++) {
				asked++;
				// Where the engine puts them (MinePlacer, ObjectManager): a zone's first wood and first ore mine close to
				// its centre (closer than 12 tiles preferred), every other mine on the free tile farthest from every
				// object already down (OptimizeType::DISTANCE). Laid on random wall-side tiles, 0.74 of our towns had a
				// mine within 10 tiles against the engine's 0.44 (mapsight score, 2026-10-02). VMAPGEN_MINE_SPREAD=0
				// is the old draw.
				let pick = earlyEdge;
				if (process.env.VMAPGEN_MINE_SPREAD !== '0') {
					const close = (res === 'wood' || res === 'ore') && i === 0;
					pick = close ? nearCentre(14) : farthestFromObjects(16);
				}
				const e = put('mine', mt, undefined, subtype, 48, pick)
					|| put('mine', mt, undefined, subtype, 48, earlyEdge)
					|| put('mine', mt, undefined, subtype, 40, fitAnchors(mt), true);
				if (!e) missed++;
				else besideMine(e);
			}
		}
		if (missed)
			console.error(`[gen] level ${l}: zone ${zoneMeta.spec && zoneMeta.spec.id}: ${missed} of its `
				+ `${asked} mine(s) found no room`);
	} else {
		const mines = CLASS_MINES[cls] || CLASS_MINES[BIOME_CLASS.STANDARD];
		// A cave's content scale is set by how much of its floor objects
		// block, which left its mines at 0.54x the corpus's (12.8 a two-level
		// map underground against 23.6; fidelity lens, 32 two-level maps,
		// 2026-09-25). Mines take their own boost down there: 1.8 on a rate
		// that was spread over both levels, 0.9 now that each level gets the
		// full rate (plan.js p.mineRate), so the underground count is unchanged.
		const caveMines = openMask ? 0.9 : 1;
		const mineCount = Math.round(scale * (p.mineRate || 2.6) * mines.weight * p.mineDensity * caveMines);
		for (let i = 0; i < mineCount; i++) {
			const subtype = mines.pool[(rng() * mines.pool.length) | 0];
			besideMine(put('mine', mineTemplate(subtype, terrain), undefined, subtype, 48, earlyEdge));
		}
	}


	// First, with VMAPGEN_TPL_PILE_MODEL=engine, the zone's treasure piles as
	// the engine builds them (TPL_PILE_MODEL above): the pool its piles draw
	// from (TreasurePlacer::addAllPossibleObjects, with this zone's faction's
	// dwellings and creature boxes), and band by band, richest first, every pile
	// the density asks for, spending the pool's zone limits; the ones the zone
	// has room for land at their class's share. A landed pile's guard is sized
	// on what the pile is worth; the chests pass below takes their chests.
	let pileSim = null;
	// the pool this zone's piles draw from, as TreasurePlacer builds it
	// (piles.js zonePool): the engine model's piles, and with
	// VMAPGEN_TPL_PILE_VALUES=engine the uniform model's pile values
	const makePilePool = () => {
		const bands = zoneMeta.spec.treasure || [];
		const bare = f => String(f || 'neutral').toLowerCase().replace(/^.*:/, '');
		const faction = zoneMeta.faction || 'neutral';
		return pileZonePool(objectPools.pileCommon, {
			maxValue: bands.reduce((a, b) => Math.max(a, b.max || 0), 0),
			dwellings: (objectPools.engineDwellings || []).filter(d => d.faction === faction)
				.map(d => ({ value: d.value, prob: d.prob, fromRmg: d.fromRmg, dw: d })),
			creatures: (objectPools.guards || GUARD_POOL).filter(c => bare(c.faction) === faction),
			nativeZones: zoneMeta.nativeZones ?? 1, totalZones: zoneMeta.totalZones || 1,
			// ObjectDistributor::distributePrisons: the heroes the map can still imprison (the roster less 16 a player
			// kept for hiring) are shared across all its zones, ceil(left / zones left) each
			prisons: Math.ceil(Math.max(0, SPECIALS.prison.heroes.length - 16 * Math.max(1, players.length)) / Math.max(1, zoneMeta.zoneCount || 1)),
			// the objects with a template for this ground (piles.js groundsOf)
			terrain: ((objectPools.terrainNames && objectPools.terrainNames.get(terrain)) || {}).name || null,
		}, rng);
	};
	if (zoneMeta && zoneMeta.spec && TPL_PILE_MODEL === 'engine' && objectPools.pileCommon) {
		const bands = zoneMeta.spec.treasure || [];
		const pool = makePilePool();
		const gIdx = 1 + (zoneMeta.monsterShift || 0) + Math.max(-2, Math.min(2, Math.round(p.monsterStrength || 0)));
		const gPool = objectPools.guards ? zoneGuardPool(objectPools.guards, zoneMeta.spec) : undefined;
		const guarded = zoneMeta.spec.monsters !== 'none';
		pileSim = { landed: [] };
		// VMAPGEN_PILE_TRACE: every candidate pile's contents by landing class
		// (open, guarded, rich), landed or not, for fitting the three shares
		const tally = process.env.VMAPGEN_PILE_TRACE ? { open: {}, guarded: {}, rich: {} } : null;
		let afterRich = false, afterRichBand = false;
		for (const { band, byDensity, want } of templatePiles(bands, cells.length, (zoneMeta && zoneMeta.richScale) || 1)) {
			// a band under TPL_RICH_MIN placed after a richer one (a treasure zone's cheap last band: 1.5x the engine's chests
			// and random resources, 1.1x its guards) lands at TPL_PILE_LAND_CHEAP_AFTER_RICH of its share
			// the share a rich pile of this band lands at (a guarded pile of a band from TPL_RICH_MIN)
			const richShare = band.min >= TPL_VERY_RICH_MIN ? (zoneMeta.spec.type === 'treasure' ? TPL_PILE_LAND_VERY_RICH_TREASURE : TPL_PILE_LAND_VERY_RICH)
				: zoneMeta.spec.type === 'treasure' ? (l === 0 && !(Number(p.waterCoverage) > 0) ? TPL_PILE_LAND_RICH_TREASURE_SURFACE : TPL_PILE_LAND_RICH_TREASURE) : TPL_PILE_LAND_RICH;
			if (process.env.VMAPGEN_PILE_TRACE && band.min >= TPL_RICH_MIN) console.error(`[pileshare] zone ${zoneMeta.spec.id} ${zoneMeta.spec.type} level ${l} band ${band.min} rich share ${richShare}`);
			const later = afterRich && zoneMeta.spec.type !== 'treasure' ? TPL_PILE_LAND_AFTER_RICH
				: afterRichBand && band.min < TPL_RICH_MIN ? TPL_PILE_LAND_CHEAP_AFTER_RICH : 1;
			if (band.min >= TPL_VERY_RICH_MIN) afterRich = true;
			const followsRich = afterRichBand;
			if (band.min >= TPL_RICH_MIN) afterRichBand = true;
			let made = 0, empty = 0;
			while (made < byDensity && empty < byDensity) {
				const pile = preparePile(pool, band, rng);
				if (!pile.objects.length) { empty++; continue; }
				if (made < want) {
					const guard = guarded ? engineGuard(pile.value, gIdx, rng, false, gPool) : null;
					if (guard && gPool) guard.concrete = true;
					const cls = !guard ? 'open' : band.min >= TPL_RICH_MIN ? 'rich' : 'guarded';
					const share = cls === 'open' ? TPL_PILE_LAND_OPEN : cls === 'rich' ? richShare : TPL_PILE_LAND_GUARDED;
					if (tally) {
						const t = tally[cls];
						t.piles = (t.piles || 0) + 1;
						if (guard) t['guardLvl' + guard.level] = (t['guardLvl' + guard.level] || 0) + 1;
						for (const o of pile.objects) {
							const k = o.type === 'pandoraBox' || o.type === 'resource' ? `${o.type}:${o.key}` : o.type;
							t[k] = (t[k] || 0) + 1;
						}
					}
					const holdsDwelling = pile.objects.some(o => o.dw || /^creatureGenerator/.test(o.type || ''));
					// a pile holding a dwelling keeps its band's share: the later-band cuts (TPL_PILE_LAND_AFTER_RICH and the cheap
					// band's) model piles abandoned for room, and Coldshadow's junctions carry their neutral dragon dwellings in their
					// last band: cut, the dragons came out 4-9 a map against the engine's 8-14 (K's mods, 2026-10-03).
					// VMAPGEN_TPL_PILE_LAND_DWELLING=cut applies the cuts to them too.
					const landP = holdsDwelling && process.env.VMAPGEN_TPL_PILE_LAND_DWELLING !== 'cut' ? share : share * later;
					if (rng() < landP) pileSim.landed.push({ value: pile.value, band, guard, objects: pile.objects, followsRich });
				}
				made++;
			}
		}
		if (tally) console.error(`[pilejson] ${JSON.stringify({ zone: zoneMeta.spec.id, cells: cells.length, tally })}`);
		// A map far below its template's smallest size (K, 2026-10-08: "fewer guards and fewer piles is fine if absolutely necessary"): the template's
		// link and gate guards stay one per connection however small the map, and on a 36x36 Coldshadow's Fantasy a stack stood on every 13 walkable
		// tiles (the engine's own 144x144, 32), so guards crowded whatever their placement (25% of stacks within 2 of another). Below SMALL_F of the
		// template's tiles (a 36x36: 3% one level, 6% two) a zone keeps sqrt(f / 0.3) of its landed piles, half at least; on a 72x72 (13%) the cut
		// gained 0.5 points of crowding for 37% of the piles, so it stops at 10%; the cheapest go, each with its guard.
		const SMALL_F = 0.1;
		const lv = p.zonePlan && p.zonePlan.perLevel ? p.zonePlan.perLevel.length : 1;
		const f = p.zonePlan && p.zonePlan.minTiles ? W * H * lv / p.zonePlan.minTiles : 1;
		if (f < SMALL_F && pileSim.landed.length > 1) {
			const keep = Math.max(0.5, Math.sqrt(f / 0.3));
			const n = pileSim.landed.length, k = Math.max(1, Math.round(n * keep));
			const order = pileSim.landed.map((x, i) => i).sort((a, b) => pileSim.landed[b].value - pileSim.landed[a].value);
			const kept = new Set(order.slice(0, k));
			const cut = objectPools.__smallCut || (objectPools.__smallCut = { piles: 0, guards: 0, of: 0, f });
			cut.of += n; cut.piles += n - k; cut.guards += pileSim.landed.filter((x, i) => !kept.has(i) && x.guard).length;
			pileSim.landed = pileSim.landed.filter((x, i) => kept.has(i));
		}
		if (process.env.VMAPGEN_PILE_TRACE)
			console.error(`[pile] zone ${zoneMeta.spec.id} engine piles: ${pileSim.landed.length} landed, `
				+ `${pileSim.landed.filter(x => x.guard).length} guarded, `
				+ `${pileSim.landed.reduce((a, x) => a + x.objects.filter(o => o.type === 'treasureChest').length, 0)} chests`);
	}

	// What the engine's piles landed in this zone, by object type: what the zone holds, in the kinds and numbers its
	// template's bands ask for (a rich band draws the dear kinds, a poor one the cheap). The rate models these
	// replace were fitted to maps pooled across templates, which cannot tell a zone of one band from another's
	// (VMAPGEN_PILE_CONTENT=0 returns them). Harness, 2026-10-01: ours held 0.1 of the engine's magic wells,
	// mystical gardens, campfires and sanctuaries per zone and 5 x its Pandora's boxes.
	const pileMan = pileSim && process.env.VMAPGEN_PILE_CONTENT !== '0' ? new Map() : null;
	// the pile each drawn object came from (a prison takes its pile's guard below)
	const pileOf = new Map();
	if (pileMan)
		for (const pl of pileSim.landed)
			for (const o of pl.objects) {
				if (!pileMan.has(o.type)) pileMan.set(o.type, []);
				const item = { ...o, bandMin: pl.band ? pl.band.min : 0, followsRich: !!pl.followsRich };
				pileOf.set(item, pl);
				pileMan.get(o.type).push(item);
			}
	// the zone's loot multiplier (plan.js zoneMeta.loot) is how the rate models scaled a zone; the piles carry it in
	// their own bands, so only the player's lever remains of p.xDensity
	const lootDiv = zoneMeta && zoneMeta.loot > 0 ? zoneMeta.loot : 1;
	// What the engine's maps hold of each kind against what its piles draw (harness, 8 templates x 8 seeds, ours with
	// every other class within 7% of the engine's): the engine abandons some piles it cannot place, more of the
	// piles with a Pandora's box, and keeps 0.8 of its open loot
	const PILE_KEPT = { randomArtifactTreasure: 0.8, randomArtifactMinor: 0.8, randomArtifactMajor: 0.8, randomArtifactRelic: 0.8,
		treasureChest: 0.62, spellScroll: 0.8, campfire: 0.8, pandoraBox: 0.7 };   // chests 0.62 after the 93-template run (1.31 of the engine's at 0.8)
	const manCount = (type, lever = 1) => {
		// the kept share falls on the piles of the rich bands (from TPL_RICH_MIN) and of any band placed after one in its zone
		// (a treasure zone's cheap last band held 1.5x the engine's chests and random resources, 2026-10-03): the engine abandons the piles it
		// cannot place, and those are the big ones in crowded rich zones. Applied to every pile it left the start zones with
		// 0.4-0.7 of the engine's Pandora's boxes, scrolls and major artifacts (K's mods, 2026-10-03). VMAPGEN_PILE_KEPT=0
		// keeps everything, =all applies it to every band as before.
		// Off by default since 2026-10-03: the landing shares (TPL_PILE_LAND_*) now carry the engine's abandoned piles, and
		// the kept shares on top counted them twice (10 seeds against the engine with K's mods: high loot 0.82-0.84 of the
		// engine's in every zone type with them, 0.87-1.08 without; classfit error 1.31 -> 1.10). =rich and =all bring them back.
		const keptMode = process.env.VMAPGEN_PILE_KEPT || '0';
		const list = (pileMan && pileMan.get(type)) || [];
		const kept = keptMode === '0' ? list.length
			: list.reduce((a, o) => a + (keptMode === 'all' || o.bandMin >= TPL_RICH_MIN || o.followsRich ? (PILE_KEPT[type] ?? 1) : 1), 0);
		const n = kept * lever;
		return Math.floor(n) + (rng() < n % 1 ? 1 : 0);
	};

	// The utility long tail goes BEFORE scenery for the same reason mines
	// do: the four-to-seven-cell masks (schoolOfWar, arena, mercenaryCamp,
	// libraryOfEnlightenment) need open ground, and drawing after the packs
	// crowded it landed them at 0.00-0.06 against corpus ~0.1-0.3/1k. The
	// one-visit buildings stand on open ground in the corpus anyway - a
	// landmark in a clearing, not something packed against a mountain - so
	// noEdge open-cell draws match the real placement. Small-mask types
	// could wait for the packs, but splitting the pool in two buys nothing:
	// the whole class gets first pick and scenery wraps around it.
	//
	// Both pools are drawn up front and placed in one pass, biggest
	// footprint first: a schoolOfWar anchor is one cell in ~15 of open
	// ground while a shrine fits almost anywhere, so the rare anchors are
	// spent on the objects that can use nothing else. Drawing big-last fed
	// the small masks the cells the 4x4 needed and produced
	// fits|schoolOfWar:40+ rejections on traced maps.
	const landmark = [];
	if (pileMan) {
		// the zone's own landed buildings, each as the pile drew it: the utilities and the bonus buildings that
		// have a template here (a kind with none yet is left, see the harness's missing-kinds list)
		for (const type of pileMan.keys()) {
			if (type === 'crypt') continue;   // from the bank draw below, where the engine's piles put it
			const u = UTIL_POOL.find(x => x.type === type && !x.pair && type !== 'monolithTwoWay');
			const b = BONUS_POOL.find(x => x.type === type);
			let e = u || b;
			if (!e) {
				// a core kind with no art of ours: the game's own template for it (OBJECTS.TXT), the kind as drawn
				const o = pileMan.get(type)[0];
				let t = o.core && objectPools.h3Tpl ? objectPools.h3Tpl(o.classIndex, o.subIndex) : null;
				// a mod's kind: its own template, one allowed on this zone's ground (K, 2026-10-02: "a lot of mod content is
				// missing"; every mod kind the piles drew was dropped here, the engine's maps with his mods hold 0.2-0.7 of
				// each a 1000 tiles of start zone)
				if (!t && !o.core && o.tpls && o.tpls.length) {
					const tn = String(((objectPools.terrainNames && objectPools.terrainNames.get(terrain)) || {}).name || '').toLowerCase();
					const ok = x => !x.allowedTerrains || !x.allowedTerrains.length || x.allowedTerrains.some(a => String(a).slice(String(a).lastIndexOf(':') + 1).toLowerCase() === tn);
					const m = o.tpls.find(ok);
					if (m) t = { animation: m.animation, mask: m.mask, visitableFrom: m.visitableFrom };
				}
				if (!t || /^(resource|randomResource|treasureChest|campfire|pandoraBox|prison|obelisk|spellScroll|seerHut|randomArtifact|creatureBank|dragonUtopia|crypt|dwelling|monolith|subterraneanGate|mine|witchHut|learningStone|scholar|waterWheel|windmill|mysticalGarden)/.test(type)) continue;
				e = { type, subtype: o.subtype, tpl: t, generic: true };
			}
			for (let n = manCount(type, b ? p.bonusDensity : 1); n > 0; n--) landmark.push(e);
		}
	}
	for (let i = pileMan ? 0 : rare(fill.utils); i > 0; i--) {
		const u = pickUtil(rng);
		if (fillStat) {
			const k = 'draw|' + u.type + (u.pair ? '(pair)' : '');
			fillStat[k] = (fillStat[k] || 0) + 1;
		}
		// Zone-link portal pairs (queue 27, the Portal share lever) carry the
		// corpus's monolith rate on their own now; with the fill's pairs on
		// top, both ends inside one zone, the 29-map sweep ran 2.45x corpus.
		// The draw is still spent, so every other utility keeps its rate.
		if (u.pair) continue;
		// the Crypt comes from the bank draw now (economy.js CORE_BANKS), where
		// the engine's piles put it; the draw is spent the same way
		if (u.type === 'crypt') continue;
		landmark.push(u);
	}
	for (let i = pileMan ? 0 : Math.round(scale * fill.bonuses * p.bonusDensity); i > 0; i--) {
		const b = pickBonus(rng);
		if (fillStat) {
			const k = 'bdraw|' + b.type;
			fillStat[k] = (fillStat[k] || 0) + 1;
		}
		landmark.push(b);
	}
	// A draw paid for in one biome does not have to die there: the big
	// masks (schoolOfWar's 8-cell L, dragonUtopia's 7x7) fit nowhere in
	// most pockets, so an unplaced landmark is owed to the next biome's
	// pass and gets one try per biome until it lands or the map runs out.
	// objectPools is shared across every fillBiome call of the map.
	if (objectPools.__landmarkDebt)
		for (const o of objectPools.__landmarkDebt) landmark.push(o);
	landmark.sort((a, b) =>
		blockingCells(b.tpl, 0, 0).length - blockingCells(a.tpl, 0, 0).length);
	const owed = [];
	for (const o of landmark) {
		if (o.pair) { putPair(o); continue; }
		const e = BONUS_POOL.includes(o)
			? put(o.type, o.tpl,
				o.type === 'tavern' || o.type === 'altarOfSacrifice'
					? undefined : emptyRewardable(),
				o.subtype, 40, fitAnchors(o.tpl), true)
			: put(o.type, o.tpl,
				o.type === 'seerHut' ? seerHutOptions(rng)
					: (o.type === 'crypt' || o.type === 'redwoodObservatory' || o.generic)
						? emptyRewardable() : undefined,
				o.subtype, 40, fitAnchors(o.tpl), true);
		if (!e) owed.push(o);
	}
	objectPools.__landmarkDebt = owed;

	/*
	 * Scenery first, because it is the thing that decides where the space is.
	 *
	 * Real maps block 17.8 percent of their cells with terrain features and
	 * place 96.8 percent of that as multi-cell clusters: a 4x6 mountain, a 2x3
	 * lake, a stand of oaks. Ours blocked 5 percent, all of it single cells
	 * strung along biome borders, so a generated map read as an open field
	 * with confetti on it and gave the AI's pathfinder nothing to path around.
	 *
	 * The budget is a share of the biome's cells rather than a count, minus
	 * whatever is already blocked here, so a biome the barrier carving already
	 * walled in asks for less and a wide open one asks for more. Every
	 * placement still goes through put(), which refuses anything that would
	 * wall part of the level off, so a mountain range can never seal a region.
	 */
	if (p.decorDensity > 0) {
		// The scenery budget this stage used to spend - a floor-share
		// minus already-blocked cells - moved to the early pack pass in
		// planLevel, which runs before the ridge marking consumes the
		// interior. What remains here is the mid-tier mass pass and the
		// singles machinery below.
		/*
		 * Interior masses are whole packs harvested from the corpus: the
		 * scenery skeleton of a real blocked mass, replayed object for
		 * object. They now place in planLevel before the ridge marking
		 * spends the interior - by the time fill runs here the open
		 * ground is gone, and this stage measured want-60-placed-0 on
		 * every biome. The early pass lives in plan.js; this block only
		 * keeps the helpers the mid-tier pass below still uses.
		 *
		 * Each pack lands as one mass. Detached packs keep a moat from
		 * existing blocking; merge packs must face-touch it, which is how
		 * a corpus 72x72's census - one web at about half the blocking,
		 * several hundred-cell masses, then crumbs - falls out: the border
		 * network is the web, the detached packs are the second tier, and
		 * the functional objects placed afterward supply the crumbs.
		 */
		// Foreign blocking = any OCCUPIED cell.
		const foreignAt = (x, y, r) => {
			for (let dy = -r; dy <= r; dy++)
				for (let dx = -r; dx <= r; dx++) {
					if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					if (blocked[l * W * H + ny * W + nx] & OCCUPIED)
						return true;
				}
			return false;
		};
		// Commit a whole pack at anchor i. 'detached' packs keep at least one
		// free cell from existing blocking so they stay their own mass;
		// 'merge' packs must touch it and extend the web. Returns the placed
		// blocking cells so the caller can grow the merge frontier.
		const tryPack = (pack, i, mode) => {
			const x = i % W, y = (i / W) | 0;
			const cells = pack.cells.map(([dx, dy]) => [x + dx, y + dy]);
			for (const [bx, by] of cells) {
				if (bx < 0 || by < 0 || bx >= W || by >= H) return null;
				const c = by * W + bx;
				if (blocked[l * W * H + c]) return null;
				if (reachable && !reachable[c]) return null;
			}
			let touch = false;
			for (const [bx, by] of cells)
				if (foreignAt(bx, by, 1)) { touch = true; break; }
			if (mode === 'detached' && touch) return null;
			if (mode === 'merge' && !touch) return null;
			const walls = cells.map(([a, b]) => b * W + a);
			if (connectivity && !connectivity.accepts(walls)) return null;
			// a pack spanning a corridor mouth welds two masses - refuse
			if (weldsMasses(walls, blocked, l, W, H, 2)) return null;
			for (const o of pack.objects) {
				const tpl = { animation: o.animation, mask: o.mask };
				if (o.visitableFrom) tpl.visitableFrom = o.visitableFrom;
				out.push(objectEntry(o.type, x + o.dx, y + o.dy, l, tpl,
					undefined, o.subtype || 'object'));
				footprintBlock(tpl, x + o.dx, y + o.dy, l, W, H, blocked);
			}
			if (connectivity) connectivity.refresh();
			return cells;
		};
		// Mid-tier freestanding masses - the corpus's mountains, lakes and
		// tree stands sitting on open ground between the big webs, replayed
		// as small packs so the objects come out authored. The census had
		// our decor at 2.8x but mountain at 0.41x: we spent the budget on
		// one-cell fillers where the corpus spends five-to-fifteen-cell
		// masses. Same detached moat and weld rules as the pack pass.
		{
			let featCells = Math.round(area * p.decorDensity * 0.12);
			let miss = 0;
			while (featCells > 0 && miss < 10) {
				const prefer = rng() < 0.35 ? 'mountain' : null;
				const p = packFor(terrain, rng, 18 + rng() * 30, prefer);
				if (!p) break;
				let done = null;
				for (let t = 0; t < 40 && !done; t++) {
					const i = free[(rng() * free.length) | 0];
					if (i === undefined) break;
					done = tryPack(p, i, 'detached');
				}
				if (done) featCells -= p.size;
				else miss++;
			}
		}
		// With the masses down, the ground beside them is where the
		// corpus puts its pickups, mines and monsters.
		edgeCells = free.filter(i => {
			const x = i % W, y = (i / W) | 0;
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					if (!dx && !dy) continue;
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					if (blocked[l * W * H + ny * W + nx] & OCCUPIED)
						return true;
				}
			return false;
		});
	}

	// Town biomes get exactly one neutral randomTown, placed with the mines
	// far above - a 6x6 footprint cannot wait for the packs to finish.
	// A template zone's town counts are placed up with the TOWN-class town.

	// Creature-level band per class: town-adjacent dwellings should be cheap
	// recruits, deep-loot biomes hold the high tiers. minLevel/maxLevel are
	// options on randomDwelling itself (CGDwelling::randomizeLevel rolls
	// nextInt(min,max)-1). Band edges jitter per dwelling so maps vary.
	const TIER_BANDS = {
		[BIOME_CLASS.PLAYER]:    [1, 4],
		[BIOME_CLASS.TOWN]:      [1, 3],
		[BIOME_CLASS.HIGH_LOOT]: [5, 7],
		[BIOME_CLASS.STANDARD]:  [2, 5],
		[BIOME_CLASS.LOW_LOOT]:  [1, 4],
	};
	const [tierLo, tierHi] = TIER_BANDS[cls] || TIER_BANDS[BIOME_CLASS.STANDARD];

	// K, 2026-09-30: "Creature generation structures should either: be located in a town biome, in which case
	// they should be a generation structure for the biome's town; be located in a regular open loot area, in
	// which case they should be completely random; be located in a high loot open loot area in which case they
	// should be higher tiers (say 5-7); be based on a map template specific parameter, in which case the
	// parameter stands." A zone with a town of a known faction draws that faction's dwellings only (the nearest
	// level it has when it has none of the one asked); any other zone draws from every faction.
	const zf = zoneFaction || (zoneMeta && zoneMeta.faction && zoneMeta.faction !== 'neutral' ? zoneMeta.faction : null);
	const dwellingFaction = d => (objectPools.dwellingFactions && objectPools.dwellingFactions.get(`${d.type}|${d.subtype}`)) || null;
	// K, 2026-10-08: "creature generation dwellings in town zones (and HARD AND FAST RULE FOR PLAYER START TOWNS) do not match the biome's town ...
	// for neutral towns, probably 50%/50% related or 75%/25% related, favoring the biome town's own". A player start's zone takes its town's
	// dwellings only; a neutral town's zone takes them three times in four and another town's faction the fourth (the lead's pick of 75/25).
	// Zones without a town keep the faction they had. Always on.
	const ownShare = zoneMeta ? (zoneMeta.ownerColor ? 1 : (zoneMeta.towns && zoneMeta.towns.length ? 0.75 : 1))
		: (Number.isFinite(p.dwellOwnShare) ? p.dwellOwnShare : 1);
	const otherFaction = d => { const f = dwellingFaction(d); return !!f && f !== zf && f !== 'neutral'; };
	// a dwelling of another town's faction near the level of the one it stands in for
	const otherDwelling = (lvl, pool) => {
		const cands = pool.filter(otherFaction);
		if (!cands.length) return null;
		const gap = Math.min(...cands.map(d => Math.abs((d.level || 1) - lvl)));
		const near = cands.filter(d => Math.abs((d.level || 1) - lvl) === gap);
		return near[(rng() * near.length) | 0];
	};
	const pickDwellingFor = lvl => {
		if (!zf || !objectPools.dwellingFactions) return pickDwelling(lvl, rng, objectPools.dwellings);
		if (ownShare < 1 && rng() >= ownShare) { const o = otherDwelling(lvl, DWELLING_POOL.concat(objectPools.dwellings || [])); if (o) return o; }
		const pool = DWELLING_POOL.concat(objectPools.dwellings || []).filter(d => dwellingFaction(d) === zf);
		if (!pool.length) return pickDwelling(lvl, rng, objectPools.dwellings);
		let near = pool.filter(d => d.level === lvl);
		if (!near.length) {
			const gap = Math.min(...pool.map(d => Math.abs(d.level - lvl)));
			near = pool.filter(d => Math.abs(d.level - lvl) === gap);
		}
		let roll = rng() * near.reduce((a, d) => a + (d.weight || 1), 0);
		for (const d of near) { roll -= d.weight || 1; if (roll <= 0) return d; }
		return near[0];
	};

	// The count grows with the pool, as the bank count does and for the same
	// reason: fill.dwellings is calibrated on the core pool alone, and each
	// dwelling type an install adds brings its own rarity to the engine's
	// draw. A core-only map is unchanged.
	const dwellPoolWeight = CORE_DWELLING_WEIGHT
		+ (objectPools.dwellings || []).reduce((a, d) => a + (d.weight || 1), 0);
	// Rounded stochastically, so the expected count is exactly the product
	// below. A zone's share is often a fraction of one, and Math.round made
	// the count nonlinear: the density factor that took the mod pool to the
	// corpus left core-only maps at 0.69x the corpus's core dwellings
	// (lens runs T8 and T2, 2026-09-25).
	// A template zone's dwellings as the engine's treasure piles draw them
	// (TreasurePlacer::addDwellings). Only the dwellings of the zone's own town
	// type compete (neutral creatures' in a neutral zone), each priced at its
	// rmg value, or its creature's AI value x growth, times 1 + native zones /
	// all zones + native zones / 2, at its rarity or 40; one priced by rmg above
	// the zone's richest band is left out. A pile of a band holds one at
	// Zd / (Zd + TPL_DWELL_K), Zd the odds the band admits (a pile of desired
	// value D takes D/4 to D, economy.js bandEligibility), and which one by
	// those odds; the player's lever scales the count, a theme (--theme) takes
	// its share as the other model's draw does.
	// Two seeds of the 11 late maps (lens t41L and t42L, K 16) against the zone
	// model it replaces: dwellings a map 36.8 and 38.6 (corpus 36.9, the old
	// 46.1 and 46.7), the dwellings row's error 0.466 -> 0.218 and 0.462 ->
	// 0.201, the kind mix 0.570 -> 0.554 and 0.635 -> 0.602, every row's mean
	// |log ratio| 0.1667 -> 0.1664 and 0.2038 -> 0.1891. Core dwellings read
	// lower (0.6-0.7x): the corpus's own players started Tower and Dungeon, and
	// the lens rolls starts at random. VMAPGEN_TPL_DWELL_MODEL=zone is the old.
	//
	let dwellPicks = null;
	if (pileSim && process.env.VMAPGEN_TPL_DWELL_MODEL !== 'zone') {
		// the engine's piles decide the dwellings as they decide everything else the zone holds (TreasurePlacer::
		// addDwellings puts them in the same pool): a dwelling too cheap for the zone's rich bands still lands as
		// the remainder of a pile, which the one-draw model below never gave (Coldshadow's neutral junctions, whose
		// Crystal, Azure, Rust and Fairy dragon dwellings it dropped; harness, 2026-10-01)
		const drawn = pileSim.landed.flatMap(pl => pl.objects.filter(o => o.type === 'dwelling' && o.dw));
		const want = drawn.length * (p.dwellingLever ?? 1);
		const th = objectPools.themeDwellings;
		dwellPicks = [];
		for (let n = Math.floor(want) + (rng() < want % 1 ? 1 : 0), i = 0; n > 0; n--, i++) {
			const d = drawn[i % drawn.length].dw;
			dwellPicks.push(th && th.pool.length && rng() < th.share ? nearestLevelDwelling(th.pool, d.level || 1, rng) || d : d);
		}
	} else if (zoneMeta && zoneMeta.spec && process.env.VMAPGEN_TPL_DWELL_MODEL !== 'zone'
			&& objectPools.engineDwellings && objectPools.engineDwellings.length) {
		const bands = zoneMeta.spec.treasure || [];
		const maxV = bands.reduce((a, b) => Math.max(a, b.max || 0), 0);
		const mod = 1 + (zoneMeta.nativeZones ?? 1) / (zoneMeta.totalZones || 1) + (zoneMeta.nativeZones ?? 1) / 2;
		const own = objectPools.engineDwellings
			.filter(d => d.faction === (zoneMeta.faction || 'neutral') && !(d.fromRmg && d.value > maxV))
			.map(d => ({ d, v: d.value * mod, odds: d.prob / 100 }));
		dwellPicks = [];
		for (const { band, count } of own.length ? templatePiles(bands, cells.length, (zoneMeta && zoneMeta.richScale) || 1) : []) {
			const w = own.map(x => x.odds * bandEligibility(x.v, band));
			const Z = w.reduce((a, b) => a + b, 0);
			if (!(Z > 0)) continue;
			const e = count * Z / (Z + TPL_DWELL_K) * (p.dwellingLever ?? 1);
			for (let n = Math.floor(e) + (rng() < e % 1 ? 1 : 0); n > 0; n--) {
				let r = rng() * Z, k = 0;
				while (k < w.length - 1 && (r -= w[k]) > 0) k++;
				const th = objectPools.themeDwellings;
				dwellPicks.push(th && th.pool.length && rng() < th.share
					? nearestLevelDwelling(th.pool, own[k].d.level || 1, rng) || own[k].d : own[k].d);
			}
		}
	}
	// a neutral town's zone: one in four of its drawn dwellings from another town's faction (ownShare above)
	if (dwellPicks && zf && ownShare < 1 && objectPools.engineDwellings) {
		const others = objectPools.engineDwellings.filter(d => d.tpl && d.faction !== zf && d.faction !== 'neutral');
		for (let i = 0; i < dwellPicks.length; i++) {
			if (rng() < ownShare || !others.length) continue;
			const lvl = dwellPicks[i].level || 1;
			const gap = Math.min(...others.map(d => Math.abs((d.level || 1) - lvl)));
			const near = others.filter(d => Math.abs((d.level || 1) - lvl) === gap);
			dwellPicks[i] = near[(rng() * near.length) | 0];
		}
	}
	const dwellExpect = scale * fill.dwellings * p.dwellingDensity
		* dwellPoolWeight / CORE_DWELLING_WEIGHT * (zoneMeta ? 1 : FREE_DWELL_SCALE);
	// The template's signature dwellings: the neutral dwellings its rich zones (a band from 50000) can draw, worth that
	// much or more (Coldshadow's Crystal, Azure, Faerie and Rust dragon dwellings). plan.js ensureSignatureDwelling keeps
	// one on every map. A small map's zone merge can fold the zones that carry them into a town zone, whose dwellings
	// are its town's (36x36 one level, 2026-10-03), so the candidates come from the pool, not from what landed.
	if (zoneMeta && zoneMeta.spec && (zoneMeta.spec.treasure || []).some(t => (t.min || 0) >= TPL_VERY_RICH_MIN)) {
		(objectPools.__richZones || (objectPools.__richZones = new Set())).add(zoneMeta.spec.id);
		if (!objectPools.__sigCands) {
			const maxV = (zoneMeta.spec.treasure || []).reduce((m, t) => Math.max(m, t.max || 0), 0);
			const neutral = (objectPools.engineDwellings || []).filter(d => d.faction === 'neutral' && d.tpl && d.value <= maxV * 2);
			// worth a quarter of the most valuable or more: K's mods give the four dragons 26433 to 78845 and the next 3072
			const best = neutral.reduce((m, d) => Math.max(m, d.value || 0), 0);
			objectPools.__sigCands = neutral.filter(d => (d.value || 0) >= best / 4);
			if (process.env.VMAPGEN_SIG_TRACE) console.error('[sig] neutral dwellings by value: ' + neutral.slice().sort((x, y) => y.value - x.value).slice(0, 14).map(d => `${d.subtype}=${d.value}`).join(' '));
		}
		const own = dwellPicks && dwellPicks.find(d => objectPools.__sigCands.includes(d));
		if (own && !objectPools.__sigDw) objectPools.__sigDw = own;
	}
	// the level's rock as the cave checker reads it (1 = rock), for pocket walls closed as rock (putLoot, sealTarget)
	const caveRock = openMask && p.caveChecker ? Uint8Array.from(openMask, v => (v ? 0 : 1)) : null;
	// rock that closes a pile's pocket: the later passes that shape the cave for its art (cavefit.js) do not open it again
	const sealRock = c => { (openMask.sealed || (openMask.sealed = new Uint8Array(W * H)))[c] = 1; };
	// valuable loot in a template zone draws first from the zone's nooks (lootNook), where its pocket closes
	// tiles inside walled piles kept for the zone's cheap loot (putLoot, intoSlot); VMAPGEN_CHEAP_SLOTS=0 walls them all
	// underground, in a zone of 300 tiles or more: on the surface of one-level maps the slots shut zones off (36x36 seed 3; 144 one level
	// 5p seed 749107, an idle start zone swept empty, MapGen Dev's sweep), cause not found
	const cheapSlots = [], CHEAP_SLOTS = openMask && cells.length >= 300 ? Number(process.env.VMAPGEN_CHEAP_SLOTS ?? 2) : 0;
	// a cheap pickup into the next free slot of a walled pile, or null
	const intoSlot = (type, tpl, opts, subtype) => {
		// the art real maps put on this ground, as put takes it (terrainArt.js)
		if (TERRAIN_ART) { const art = artFor(type, subtype, tpl, terrain, rng); if (art === null) return null; tpl = art; }
		while (cheapSlots.length) {
			const c = cheapSlots.shift(), x = c % W, y = (c / W) | 0;
			if (blocked[l * W * H + c] & OCCUPIED) continue;
			if (!footprintFits(tpl, x, y, l, W, H, blocked, true)) continue;
			// the fill's connectivity counts a pickup as a wall: a slot some way still runs through stays empty
			if (connectivity && !connectivity.accepts([c])) continue;
			const entry = objectEntry(type, x, y, l, tpl, opts, subtype || 'object');
			out.push(entry);
			footprintBlock(tpl, x, y, l, W, H, blocked);
			markApproach(tpl, x, y, l, W, H, blocked);
			if (connectivity) connectivity.refresh();
			const fi = free.indexOf(c);
			if (fi >= 0) free.splice(fi, 1);
			RING_T.slotFilled = (RING_T.slotFilled || 0) + 1;
			return entry;
		}
		return null;
	};
	const putCheap = (type, tpl, opts, subtype) => intoSlot(type, tpl, opts, subtype) || put(type, tpl, opts, subtype);
	// within: only these anchors, and only where the pocket closes with its guard's tile clear of the other stacks (a template dwelling, below)
	const putLoot = (type, tpl, opts, subtype, within = null) => {
		// the free layout walls a dwelling's pocket too (within); its loose loot keeps the old draw
		if (!zoneMeta && !within) return put(type, tpl, opts, subtype);
		const how = new Map();
		const nook = plainPickup(tpl) ? closable : (x, y) => closableFor(tpl, x, y);
		const spots = (within || free).filter(c => { const k = nook(c % W, (c / W) | 0); if (k >= 0) how.set(c, closableHow); return k >= 0; });
		const spaced = spots.filter(c => { const g = how.get(c).g; return !guardCrowd(g % W, (g / W) | 0); });
		const spaced3 = spaced.length ? spaced : spots.filter(c => { const g = how.get(c).g; return !guardTightAt(g % W, (g / W) | 0); });
		if (within && !spaced3.length) return null;
		const e = within ? put(type, tpl, opts, subtype, 40, spaced3, true, true)
			: put(type, tpl, opts, subtype, 32, spaced3.length ? spaced3 : spots.length ? spots : null);
		if (process.env.VMAPGEN_RING_TRACE) { RING_T.calls = (RING_T.calls || 0) + 1; RING_T['spots ' + (spots.length ? 'some' : 'none')] = (RING_T['spots ' + (spots.length ? 'some' : 'none')] || 0) + 1; if (e) RING_T.placed = (RING_T.placed || 0) + 1; if (e && how.has(e.y * W + e.x)) RING_T.closable = (RING_T.closable || 0) + 1; }
		// the engine lays the pile, its guard's tile and the wall round it as one: the ring's other free tiles are walled now,
		// before later objects take them, and the guard's tile is kept as an approach
		if (e && how.has(e.y * W + e.x)) {
			e.__walled = [e.x, e.y];
			const note = (w, k) => { RING_T[k] = (RING_T[k] || 0) + 1; (e.__ringLog || (e.__ringLog = [])).push([w % W, (w / W) | 0, k]); };
			const { g, others } = how.get(e.y * W + e.x);
			// one tile closed, as rock in a cave or with a one-tile obstacle; false when it stays open
			const wall = w => {
				// in a cave the wall closes as rock where the rock's art fits no worse (as sealTarget does)
				if (caveRock && process.env.VMAPGEN_SEAL_ROCK !== '0' && openMask[w] && (!connectivity || connectivity.accepts([w]))) {
					const wx = w % W, wy = (w / W) | 0;
					const was = p.caveChecker.around(caveRock, W, H, wx, wy, 2);
					caveRock[w] = 1;
					if (p.caveChecker.around(caveRock, W, H, wx, wy, 2) <= was) {
						openMask[w] = 0; sealRock(w);
						blocked[l * W * H + w] |= OCCUPIED;
						if (connectivity) connectivity.refresh();
						note(w, 'rock');
						const fi = free.indexOf(w);
						if (fi >= 0) free.splice(fi, 1);
						return true;
					}
					caveRock[w] = 0;
				}
				let st = singleTemplate(terrain, rng);
				// a mod terrain has no one-tile art (highlands, dunes, wasteland, sand: K's 252 had 33 of 54 dear piles open in a
				// highlands zone, 2026-10-05): on the surface a core one-tile piece stands in, and the scenery retile redraws it in
				// the zone's own sets with the same blocked tile (retile.js keeps blocked cells identical)
				if ((!st || !st.tpl.mask || st.tpl.mask.length !== 1 || st.tpl.mask[0].length !== 1) && !caveRock && process.env.VMAPGEN_RING_STANDIN !== '0') {
					const alt = singleTemplate('dt', rng);
					if (alt && alt.tpl.mask && alt.tpl.mask.length === 1 && alt.tpl.mask[0].length === 1) st = alt;
				}
				if (!st || !st.tpl.mask || st.tpl.mask.length !== 1 || st.tpl.mask[0].length !== 1) {
					// a mod terrain has no one-tile art: in a cave the tile closes as rock all the same
					if (caveRock && openMask[w] && (!connectivity || connectivity.accepts([w]))) {
						caveRock[w] = 1; openMask[w] = 0; sealRock(w);
						blocked[l * W * H + w] |= OCCUPIED;
						if (connectivity) connectivity.refresh();
						note(w, 'rock, no art');
						const fi = free.indexOf(w);
						if (fi >= 0) free.splice(fi, 1);
						return true;
					}
					note(w, 'noArt ' + terrain); return false;
				}
				if (connectivity && !connectivity.accepts([w])) { note(w, 'refused'); return false; }
				note(w, 'walls');
				const rw = objectEntry(st.type, w % W, (w / W) | 0, l, st.tpl, {}, st.subtype);
				rw.__ring = true;
				out.push(rw);
				footprintBlock(st.tpl, w % W, (w / W) | 0, l, W, H, blocked);
				if (connectivity) connectivity.refresh();
				const fi = free.indexOf(w);
				if (fi >= 0) free.splice(fi, 1);
				return true;
			};
			// The engine's pile is several objects behind one guard (TreasurePlacer): up to two ring tiles beside the guard's tile
			// stay free for the cheap loot laid later (cheapSlots), each walled on its outer side, so the guard covers them too.
			// Without them the guard covered the dear object alone and the zone's cheap loot lay open (low loot open 71% -> 84%
			// against the engine's 64%, 2026-10-05).
			const P = e.y * W + e.x;
			const near = (a, b) => Math.max(Math.abs(a % W - b % W), Math.abs(((a / W) | 0) - ((b / W) | 0))) <= 1;
			const slots = [], extra = [];
			for (const sl of others) {
				if (slots.length >= CHEAP_SLOTS || !near(sl, g)) continue;
				const sx = sl % W, sy = (sl / W) | 0, outer = [];
				let ok = true;
				for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1; dx++) {
					const n = (sy + dy) * W + sx + dx;
					if ((!dx && !dy) || near(n, P) || near(n, g) || extra.includes(n)) continue;
					if (!floorAt(n) || (blocked[l * W * H + n] & OCCUPIED)) continue;
					if ((blocked[l * W * H + n] & (RESERVED | APPROACH)) || !lootZone.has(n)) { ok = false; break; }
					outer.push(n);
				}
				if (ok) { slots.push(sl); extra.push(...outer); }
			}
			for (const w of others) if (!slots.includes(w)) wall(w);
			for (const w of extra) if (!wall(w))
				// an outer wall that would not close leaves its slot open to the zone: the slot is walled instead
				for (const sl of slots.slice()) if (near(sl, w)) { slots.splice(slots.indexOf(sl), 1); wall(sl); }
			for (const sl of slots) { blocked[l * W * H + sl] |= APPROACH; cheapSlots.push(sl); RING_T.slots = (RING_T.slots || 0) + 1; }
			blocked[l * W * H + g] |= APPROACH;
			e.__guardAt = [g % W, (g / W) | 0];
			holdGuard(g % W, (g / W) | 0);
		}
		return e;
	};
	const dwellCount = dwellPicks ? dwellPicks.length
		: Math.floor(dwellExpect) + (rng() < dwellExpect % 1 ? 1 : 0);
	for (let i = dwellCount; i > 0; i--) {
		if (dwellPicks) {
			const d = dwellPicks[i - 1];
			// where a guard can stand: every approach tile open and no road, doorway or apron within two of it. Laid
			// anywhere, 0.55 of our dwellings ended with their approach on a road or covered, and their pile guard found no
			// tile (seal trace, 2026-10-02); the engine keeps its piles off the roads (TreasurePlacer). Falls back to any
			// anchor. VMAPGEN_DWELL_GUARDABLE=0 is the old draw.
			// never beside another dwelling: the engine's never stand within 2 tiles of each other, 0.15 of ours did
			// (2026-10-02; VMAPGEN_DWELL_APART=0 allows it)
			const dwellsHere = out.filter(o => (o.l || 0) === l && /^creatureGenerator|Dwelling/.test(o.type));
			const apart = c => process.env.VMAPGEN_DWELL_APART === '0'
				|| !dwellsHere.some(o => Math.max(Math.abs(o.x - c % W), Math.abs(o.y - ((c / W) | 0))) <= 3);
			const anchors = fitAnchors(d.tpl).filter(apart);
			const good = process.env.VMAPGEN_DWELL_GUARDABLE === '0' ? [] : anchors.filter(c => guardableAt(d.tpl, c % W, (c / W) | 0));
			// in a nook first: half the engine's dwellings stand at the end of a spur, every approach tile with three
			// walkable neighbours or fewer (mapsight), ours 0.16 (2026-10-02). VMAPGEN_DWELL_NOOK=0 skips the preference.
			const nooks = process.env.VMAPGEN_DWELL_NOOK === '0' ? [] : good.filter(c => nookAt(d.tpl, c % W, (c / W) | 0));
			// underground, the tunnel ends first: a dwelling within 3 tiles of a spline cave's dead end (VMAPGEN_DWELL_ENDS=0)
			const ends = openMask && openMask.leaves && process.env.VMAPGEN_DWELL_ENDS !== '0'
				? good.filter(c => openMask.leaves.some(q => Math.max(Math.abs(q % W - c % W), Math.abs(((q / W) | 0) - ((c / W) | 0))) <= 3)) : [];
			// first a pocket that walls shut round it with one tile left for its guard, clear of the other stacks: the engine's dwellings stand
			// in closed pockets with the guard in the mouth (60% closed, the ring the mouth for 80%; pile_structure.js), and ours, laid in the
			// open, were left with corners a blocker would cut and a second guard would crowd (16 to 31% open, 2026-10-08).
			// VMAPGEN_DWELL_POCKET=0 skips it.
			const sealedAt = good.length && process.env.VMAPGEN_DWELL_POCKET !== '0' ? putLoot(d.type, d.tpl, undefined, d.subtype, good) : null;
			const e = sealedAt
				|| (ends.length ? put(d.type, d.tpl, undefined, d.subtype, 40, ends, true) : null)
				|| (nooks.length ? put(d.type, d.tpl, undefined, d.subtype, 40, nooks, true) : null)
				|| (good.length ? put(d.type, d.tpl, undefined, d.subtype, 40, good, true) : null)
				|| put(d.type, d.tpl, undefined, d.subtype, 40, anchors, true);
			if (e && d.mod) e.mod = d.mod;
			continue;
		}
		// Corpus maps write resolved dwellings; ours were all the
		// randomDwelling placeholder, which is why the census reads a single
		// dwelling subtype where the corpus has seventy. Mostly concrete,
		// drawn from the level band the placeholder would have rolled; a
		// thin placeholder share keeps the faction-following variety.
		if (zf || rng() < 0.85) {
			const lvl = Math.max(1, Math.min(7,
				tierLo + ((rng() * (tierHi - tierLo + 1)) | 0)));
			// a creature theme (--theme) draws its share from the family's
			// dwellings, the one nearest the level wanted
			const th = objectPools.themeDwellings;
			const d = th && th.pool.length && rng() < th.share
				? nearestLevelDwelling(th.pool, lvl, rng)
				: pickDwellingFor(lvl);
			// a walled pocket with the guard's tile in its mouth first, as a template zone's dwellings (the free layout's dwellings stood open on
			// 40 to 58% of them once a second guard beside the first was refused, 2026-10-08)
			const goodF = d && process.env.VMAPGEN_DWELL_POCKET !== '0' ? fitAnchors(d.tpl).filter(c => guardableAt(d.tpl, c % W, (c / W) | 0)) : [];
			const e = d && ((goodF.length ? putLoot(d.type, d.tpl, undefined, d.subtype, goodF) : null)
				|| put(d.type, d.tpl, undefined, d.subtype, 40, fitAnchors(d.tpl), true));
			if (e) {
				// a mod dwelling keeps its mod, so the header declares it,
				// the same as a mod bank
				if (d.mod) e.mod = d.mod;
				continue;
			}
		}
		const d = FILL_TYPES.dwellings[0];
		// Faction-variable creep source: the dwelling inherits the faction
		// of its linked town at load (CGDwelling::randomizeFaction).
		put(d.type, d.tpl, (x, y) => {
			const o = {
				minLevel: Math.max(1, tierLo + ((rng() * 2) | 0) - 1),
				maxLevel: Math.min(7, tierHi - ((rng() * 2) | 0) + 1),
			};
			if (o.minLevel > o.maxLevel) o.minLevel = o.maxLevel;
			if (towns.length) o.sameAsTown = nearest(towns, x, y).instanceName;
			return o;
		});
	}
	// Buildings, unlike pickups, stand on open ground in the corpus - a witch
	// hut is its own landmark, not something packed against a mountain - so
	// they draw from open cells (noEdge) rather than the mass-edge pool.
	const skillPool = FILL_TYPES.skillStructures;
	const skillW = skillPool.reduce((a, s) => a + s.w, 0);
	if (pileMan) {
		for (const s of skillPool) for (let n = manCount(s.type); n > 0; n--) put(s.type, s.tpl, undefined, s.subtype, 40, fitAnchors(s.tpl), true);
		for (const g of FILL_TYPES.resourceGenerators) for (let n = manCount(g.type); n > 0; n--) put(g.type, g.tpl, undefined, g.subtype, 40, fitAnchors(g.tpl), true);
	} else {
	for (let i = rare(fill.skills); i > 0; i--) {
		let roll = rng() * skillW, s = skillPool[0];
		for (const e of skillPool) { roll -= e.w; if (roll <= 0) { s = e; break; } }
		put(s.type, s.tpl, undefined, s.subtype, 40, fitAnchors(s.tpl), true);
	}
	for (let i = rare(fill.generators); i > 0; i--) {
		const g = FILL_TYPES.resourceGenerators[(rng() * FILL_TYPES.resourceGenerators.length) | 0];
		put(g.type, g.tpl, undefined, g.subtype, 40, fitAnchors(g.tpl), true);
	}
	}
	// Creature banks ("dungeon structures"): concrete mod-aware ids from the
	// live index - no placeholder type exists in the engine. Emission carries
	// the config's own template so modded banks render correctly.
	// Core banks always available; modded ones join them when the live asset
	// index turned up a template for them.
	// Weighted by each bank's rate (economy.js bankRate), core's and the mods'
	// on one scale.
	//
	// Only the banks this zone can hold, as the engine's treasure pool admits
	// them (TreasurePlacer::addCommonObjects, ObjectDistributor): a template
	// that may stand on the zone's ground, where one naming no terrains takes
	// any passable land; a value no higher than the zone's richest pile; and
	// no more to a zone or a map than its rmg limits. Water banks used to land
	// on grass and a swamp-only bank on snow (2026-09-26).
	const ground = objectPools.terrainNames && objectPools.terrainNames.get(terrain);
	const groundName = ground ? ground.name : null;
	const groundLand = ground ? ground.land : terrain !== 'wt';
	// A free-layout zone has no treasure bands, so its class stands in for the
	// richest pile a template zone of that kind has: across the corpus's
	// templates a start zone's is 15000 (median; 22000 at the 90th percentile),
	// a treasure zone's 30000 (20000 at the 25th), a junction's 100000
	// (.tmp\opus\zone_max.js, 2026-09-26). A Treasure Cave (30000) never sits by
	// a start in the engine; a utopia (10000) can.
	const zoneMax = zoneMeta && zoneMeta.spec && (zoneMeta.spec.treasure || []).length
		? Math.max(...zoneMeta.spec.treasure.map(t => t.max || 0))
		: (FREE_ZONE_MAX[cls] || Infinity);
	const unscoped = n => String(n).slice(String(n).lastIndexOf(':') + 1).toLowerCase();
	// the template for this ground: one that names it first, as
	// getMostSpecificTemplates prefers, else one that takes any land
	const bankTemplate = b => {
		if (b.rmg && b.rmg.value > zoneMax) return null;
		const tpls = b.tpls || [{ raw: b.tpl, terrains: b.terrains || null }];
		const named = groundName && tpls.find(t => t.terrains && t.terrains.some(n => unscoped(n) === groundName));
		if (named) return named;
		const any = groundLand && tpls.find(t => !t.terrains);
		return any || null;
	};
	const bankPool = [];
	for (const b of (objectPools.coreBanks || CORE_BANKS).concat(objectPools.banks || [])) {
		const tpl = bankTemplate(b);
		if (tpl) bankPool.push({ b, tpl });
	}
	const bankWeight = bankPool.reduce((a, e) => a + (e.b.weight || 1), 0);
	const bankKey = b => `${b.type || 'creatureBank'}.${b.subtype}`;
	const mapBanks = objectPools.__bankCount || (objectPools.__bankCount = new Map());
	const zoneBanks = new Map();
	const underLimit = b => !b.rmg
		|| ((b.rmg.zoneLimit === undefined || (zoneBanks.get(bankKey(b)) || 0) < b.rmg.zoneLimit)
			&& (b.rmg.mapLimit === undefined || (mapBanks.get(bankKey(b)) || 0) < b.rmg.mapLimit));
	// a creature theme (--theme) draws its share from the family's banks
	const themeBanks = objectPools.themeBanks;
	// band: a template zone's treasure band, where only the banks its piles can
	// hold compete (economy.js bankBandWeight); none: the zone's whole pool
	const pickBank = band => {
		if (themeBanks && themeBanks.pool.length && rng() < themeBanks.share) {
			const b = themeBanks.pool[(rng() * themeBanks.pool.length) | 0];
			const tpl = underLimit(b) && (!band || bankBandWeight(b, band) > 0)
				&& (!eligWeight || (eligWeight.get(b) || 0) > 0) && bankTemplate(b);
			if (tpl) return { b, tpl };
		}
		const w = e => (band ? bankBandWeight(e.b, band)
			: eligWeight ? (eligWeight.get(e.b) || 0) : (e.b.weight || 1));
		const open = bankPool.filter(e => underLimit(e.b) && w(e) > 0);
		let roll = rng() * open.reduce((a, e) => a + w(e), 0);
		for (const e of open) { roll -= w(e); if (roll <= 0) return e; }
		return open[0] || null;
	};
	// The count grows with the pool, as in the engine, where every bank type
	// an install offers adds its own rarity to the draw. fill.banks is
	// calibrated on the core pool alone, so a core-only map is unchanged.
	// With a mod pool the count used to stay put and the mod banks only
	// displaced core ones: 0.51 of the corpus's banks with this install's
	// mods declared (fidelity lens run T4, 2026-09-25).
	// A template zone's bank count comes from its piles (TPL_BANK_P_LOW/HIGH,
	// calibrated), and its mix from the banks its piles can hold: each bank's
	// rate scaled by how often this zone's bands admit its value against the
	// corpus average (economy.js bandEligibility, BANK_ELIG_AT). A cheap bank
	// never lands in a zone of 45000-75000 piles and a Treasure Cave never in a
	// start zone, where a zone-wide draw ran the Treasure Cave at 0.15 of the
	// late corpus (lens run t21). VMAPGEN_TPL_BANK_MODE=zone draws from the whole
	// pool; =band draws band by band at Z / (Z + TPL_BANK_K) a pile, which lands
	// the right Treasure Caves but 1.26x the banks, rising with value (t24L).
	const bankDraws = [];
	const tplMode = process.env.VMAPGEN_TPL_BANK_MODE || 'elig';
	let eligWeight = null;
	const bandP = band => (band.min < TPL_BANK_RICH_MIN ? TPL_BANK_P_LOW : TPL_BANK_P_HIGH);
	// each bank's weight in a zone with these piles ([{ band, count }]): its rate
	// times how often these bands admit its value, against the corpus average,
	// both weighted as BANK_ELIG_AT is (pile count x the band's bank rate)
	const mixByAdmission = piles => {
		const spend = piles.reduce((a, { band, count }) => a + count * bandP(band), 0);
		const m = new Map();
		for (const { b } of bankPool) {
			const v = b.rmg && b.rmg.value;
			if (!v || !spend) { m.set(b, b.weight || 1); continue; }
			const here = piles.reduce((a, { band, count }) => a + count * bandP(band) * bandEligibility(v, band), 0) / spend;
			m.set(b, (b.weight || 0) * here / bankEligAt(v));
		}
		return m;
	};
	if (zoneMeta && zoneMeta.spec && process.env.VMAPGEN_TPL_BANK_PILES !== '0') {
		const piles = templatePiles(zoneMeta.spec.treasure, cells.length, zoneMeta.richScale || 1);
		let expect = 0;
		for (const { band, count } of piles) {
			if (tplMode !== 'band') {
				expect += count * bandP(band) * bankWeight / CORE_BANK_WEIGHT;
				continue;
			}
			const Z = bankPool.reduce((a, x) => a + bankBandWeight(x.b, band), 0);
			const e = count * Z / (Z + TPL_BANK_K);
			for (let n = Math.floor(e) + (rng() < e % 1 ? 1 : 0); n > 0; n--) bankDraws.push(band);
		}
		if (tplMode !== 'band')
			for (let n = Math.floor(expect) + (rng() < expect % 1 ? 1 : 0); n > 0; n--) bankDraws.push(null);
		if (tplMode === 'elig') eligWeight = mixByAdmission(piles);
	} else {
		for (let n = Math.round(scale * fill.banks * bankWeight / CORE_BANK_WEIGHT
			* (zoneMeta ? 1 : FREE_BANK_SCALE)); n > 0; n--) bankDraws.push(null);
		// VMAPGEN_FREE_BANK_BANDS=1 mixes a free-layout zone's banks by the bands
		// its class stands in for (FREE_ZONE_BANDS). Off: the free layout puts
		// most of its banks in standard zones, which those bands make rich, and
		// the late corpus's banks under 2000 fell to 0.25 and those of 6001-12000
		// rose to 1.87 (lens run f26L, 2026-09-26); the zone-wide draw lands 1.03
		// with every value within 11% but the top (f22)
		if (!zoneMeta && FREE_ZONE_BANDS[cls] && process.env.VMAPGEN_FREE_BANK_BANDS === '1')
			eligWeight = mixByAdmission(FREE_ZONE_BANDS[cls].map(band => ({ band, count: band.density })));
	}
	// a zone with landed piles takes the banks they drew, each as drawn (kind and number); the rate model above
	// stands for a zone with none (a free layout)
	const bankPicks = pileMan ? ['creatureBank', 'dragonUtopia', 'crypt'].flatMap(t => (pileMan.get(t) || []).filter(() => (t !== 'dragonUtopia' || rng() < UTOPIA_LAND) && rng() < 0.86).map(o => {
		const sub = String(o.key).slice(String(o.key).lastIndexOf('.') + 1);
		return bankPool.find(x => x.b.subtype === sub && (x.b.type || 'creatureBank') === t) || null;
	})).filter(Boolean) : null;
	const bankCount = pileMan ? bankPicks.length : bankDraws.length;
	for (const band of pileMan ? bankPicks : bankPool.length ? bankDraws : []) {
		const pick = pileMan ? band : pickBank(band);
		if (!pick) continue;
		const b = pick.b;
		// a walled pocket with its guard's tile in the mouth first, as a dwelling's (K, 2026-10-08: stacks beside banks that close nothing; a walker
		// took 40% of the banks with a stack beside them, the engine's 2%); VMAPGEN_BANK_POCKET=0 skips it
		const bankOpts = b.rewardable ? emptyRewardable() : undefined;
		const e = (zoneMeta && process.env.VMAPGEN_BANK_POCKET !== '0' ? putLoot(b.type || 'creatureBank', pick.tpl.raw, bankOpts, b.subtype, fitAnchors(pick.tpl.raw).slice()) : null)
			|| put(b.type || 'creatureBank', pick.tpl.raw, bankOpts, b.subtype, 40, fitAnchors(pick.tpl.raw), true);
		if (e) {
			zoneBanks.set(bankKey(b), (zoneBanks.get(bankKey(b)) || 0) + 1);
			mapBanks.set(bankKey(b), (mapBanks.get(bankKey(b)) || 0) + 1);
		}
		// keep the source mod on the entry so the header can declare exactly
		// the mods this map actually uses: the bank's, or the template's when
		// a mod brings the art for this ground (New Pavilion's dunes crypt)
		if (e && (pick.tpl.mod || b.mod)) e.mod = pick.tpl.mod || b.mod;
		if (process.env.VMAPGEN_BANK_TRACE)
			console.error(`[bank] ${b.mod ? 'mod' : 'core'} ${b.subtype} ${e ? 'placed' : 'failed'} zone ${zoneMeta && zoneMeta.spec ? zoneMeta.spec.id : cls} count ${bankCount}`);
		// A failed utopia draw is owed to the next biome's landmark pass,
		// which runs before that biome's scenery - the only stage a 7x7
		// footprint has room for. Same debt the landmark types carry.
		if (!e && b.type === 'dragonUtopia')
			(objectPools.__landmarkDebt
				|| (objectPools.__landmarkDebt = [])).push(b);
	}

	// Utilities moved up ahead of the scenery block - see the comment there.

	// Artifacts scaled by global density * class fill * area. Richness leans
	// by class too: the corpus's far bands are where the major and relic
	// tiers live (1961 relics and 2936 majors sit at dist 32+ across the 71
	// maps, against 6 in our bands before the bump).
	const ART_RICHNESS_CLASS = {
		[BIOME_CLASS.PLAYER]: -0.2, [BIOME_CLASS.LOW_LOOT]: -0.1,
		[BIOME_CLASS.TOWN]: 0, [BIOME_CLASS.STANDARD]: 0.1,
		[BIOME_CLASS.HIGH_LOOT]: 0.4,
	};
	const richness = Math.min(1, Math.max(0,
		p.artifactRichness + (ART_RICHNESS_CLASS[cls] || 0)));
	// zone distance caps at 3: the corpus far-band mix (~26% relics) is the
	// target, and a graph deeper than three hops does not make it deeper.
	const zd = Math.min(3, zoneDist == null ? 0 : Math.min(zoneDist, 3));
	const artifactCount = pileMan ? 0 : Math.round(area * p.artifactDensity * fill.artifacts * 10);
	if (pileMan) {
		// Artifact quality on a template: the piles' own tiers are 1x (the default slider). Away from it the major and relic counts are
		// leaned by the factor the free layout uses (4 either way at the slider's ends) and the total stays the piles' own, so the
		// quality moves the mix and not the number. At the default nothing changes, not a random draw. VMAPGEN_ART_LEAN_TPL=0 leaves the piles' tiers.
		const tplLean = Number.isFinite(p.artifactRichness) && process.env.VMAPGEN_ART_LEAN_TPL !== '0'
			? 2 ** ((p.artifactRichness - BIOME_DEFAULTS.artifactRichness) * 4) : 1;
		const artLever = p.artifactDensity / BIOME_DEFAULTS.artifactDensity / lootDiv;
		const putTier = t => {
			if (rng() < 0.03) putLoot('artifact', OBJECT_TEMPLATES.randomArtifact, undefined, SEER_ARTIFACTS[(rng() * SEER_ARTIFACTS.length) | 0]);
			else putLoot(t.type, t.tpl);
		};
		if (tplLean === 1) {
			for (const t of ART_TIERS) for (let n = manCount(t.type, artLever); n > 0; n--) putTier(t);
		} else {
			const counts = ART_TIERS.map(t => manCount(t.type, artLever));
			const weight = ART_TIERS.map((t, i) => counts[i] * (/Major|Relic/.test(t.type) ? tplLean : 1));
			const total = counts.reduce((a, b) => a + b, 0), wsum = weight.reduce((a, b) => a + b, 0);
			let carry = 0;
			ART_TIERS.forEach((t, i) => {
				const want = wsum ? total * weight[i] / wsum + carry : 0, n = Math.floor(want + 1e-9);
				carry = want - n;
				for (let k = n; k > 0; k--) putTier(t);
			});
		}
	}
	for (let i = 0; i < artifactCount; i++) {
		// ~3% of artifacts write concrete (type 'artifact', subtype a named
		// id) rather than tier placeholders - same pool the seer-hut quests
		// draw from. Ran 2.41x corpus at 10%, still 1.89x at 5%.
		if (rng() < 0.03) {
			putLoot('artifact', OBJECT_TEMPLATES.randomArtifact,
				undefined, SEER_ARTIFACTS[(rng() * SEER_ARTIFACTS.length) | 0]);
			continue;
		}
		// the Artifact quality lever leans the major and relic weights by a factor of 4 either way (2 ** 4 x the slider's distance
		// from its default of 0.5, so 1 at the default and the same map); the class shifts above stay as they were
		const lean = Number.isFinite(p.artifactRichness) ? 2 ** ((p.artifactRichness - BIOME_DEFAULTS.artifactRichness) * 4) : 1;
		const t = pickArtifactTier(richness, rng, zd, lean);
		putLoot(t.type, t.tpl);
	}

	// Mines moved up ahead of the scenery block - see the comment there.

	// Spell scrolls. The biggest single thing real maps had that we did not:
	// 3.55 per 1000 cells. The spell has to be named, because an unresolvable
	// identifier falls back to spell 0 rather than to a random one.
	if (SPELL_SCROLL && SPELL_SCROLL.spells.length)
		for (let i = pileMan ? manCount('spellScroll', p.pickupDensity / lootDiv) : Math.round(scale * fill.scrolls * p.pickupDensity); i > 0; i--) {
			const spell = SPELL_SCROLL.spells[(rng() * SPELL_SCROLL.spells.length) | 0];
			put(SPELL_SCROLL.type, SPELL_SCROLL.tpl, { spell }, SPELL_SCROLL.subtype);
		}

	// Pickups. Corpus maps write resolved piles two times in three
	// (concrete resource subtypes 15.87/1k against 7.94/1k of
	// randomResource, census of the 71 maps). Split the same total between
	// concrete kinds at corpus shares and the true placeholder, which the
	// engine resolves at game start.
	const pileTpl = pileTemplate('randomResource');
	const pickKind = () => {
		let total = 0;
		for (const k in PILE_KINDS) total += PILE_KINDS[k];
		let roll = rng() * total;
		for (const k in PILE_KINDS) { roll -= PILE_KINDS[k]; if (roll <= 0) return k; }
		return 'gold';
	};
	// the resources already lying beside the mines are the first concrete piles
	let besideLeft = mineExtras;
	if (pileMan) {
		// the piles' own resources, each kind as drawn
		const lever = p.resourceDensity / lootDiv;
		for (const o of pileMan.get('resource') || []) {
			if (rng() >= lever && lever < 1) continue;
			const kind = String(o.key).slice(String(o.key).lastIndexOf('.') + 1);
			// the engine's piles and its mines' extra resources are separate draws (MinePlacer, TreasurePlacer): no pile
			// resource is taken back for one beside a mine (taken back, the map held 0.55 of the engine's loose resources with
			// K's mods, 2026-10-03); the rate model below still counts them, as it was fitted with them in
			putCheap('resource', pileTemplate(kind), undefined, kind);
		}
		for (let n = manCount('randomResource', lever); n > 0; n--) putCheap('randomResource', pileTpl, undefined, 'randomResource');
	}
	for (let i = pileMan ? 0 : Math.round(scale * fill.piles * p.resourceDensity); i > 0; i--) {
		if (PILE_KINDS && rng() < 0.667) {
			const kind = pickKind();
			if (besideLeft > 0) { besideLeft--; continue; }
			putCheap('resource', pileTemplate(kind), undefined, kind);
		} else
			putCheap('randomResource', pileTpl, undefined, 'randomResource');
	}
	// Treasure chests: every chest subtype the map may use (generate.js
	// objectPools.chests) that has a template for this ground, drawn by rarity
	// and value; the late corpus splits its chests 22% core, 33% spell stones,
	// 22% each treasure pile and 1% lost wagon, which these weights give. The
	// count stays the calibrated one (CHEST_GROWTH, above).
	// A mod chest is written with the empty rewardable options the corpus
	// gives every chest, so the engine rolls its reward from its own config.
	const chestTpl = chestTemplate();
	const chestPool = [];
	for (const c of objectPools.chests || []) {
		const tpl = bankTemplate(c);
		if (tpl) chestPool.push({ c, tpl, w: (c.rmg.rarity / 1000) * chestValueRate(c.rmg.value) });
	}
	const chestRarity = chestPool.reduce((a, e) => a + e.c.rmg.rarity, 0);
	const chestScale = CHEST_GROWTH && chestPool.length ? CHEST_K * Math.pow(chestRarity / 1000, CHEST_GAMMA) : 1;
	const chestW = chestPool.reduce((a, e) => a + e.w, 0);
	const putChest = pick => {
		if (!pick) { putCheap('treasureChest', chestTpl, undefined, 'treasureChest'); return; }
		const e = putCheap('treasureChest', pick.tpl.raw, pick.c.core ? undefined : emptyRewardable(), pick.c.subtype);
		if (e && (pick.tpl.mod || pick.c.mod)) e.mod = pick.tpl.mod || pick.c.mod;
	};
	if (pileSim) {
		// the landed piles' own chests, each kind as the pile drew it (a kind
		// with no art for this ground stands in as core's chest); the player's
		// lever scales the count
		const drawn = pileSim.landed.flatMap(pl => pl.objects.filter(o => o.type === 'treasureChest'));
		const bySubtype = new Map(chestPool.map(e => [e.c.subtype, e]));
		const want = drawn.length * p.pickupDensity / (pileMan ? lootDiv : 1);
		const n = Math.floor(want) + (rng() < want % 1 ? 1 : 0);
		for (let i = 0; i < n && drawn.length; i++) {
			const key = String(drawn[i % drawn.length].key);
			putChest(bySubtype.get(key.slice(key.lastIndexOf('.') + 1)) || bySubtype.get('treasureChest'));
		}
	} else {
		for (let i = Math.round(scale * fill.chests * p.pickupDensity * chestScale); i > 0; i--) {
			if (!chestPool.length) { putChest(null); continue; }
			let roll = rng() * chestW, pick = chestPool[chestPool.length - 1];
			for (const e of chestPool) { roll -= e.w; if (roll <= 0) { pick = e; break; } }
			putChest(pick);
		}
	}
	const fireTpl = campfireTemplate();
	for (let i = pileMan ? manCount('campfire', p.pickupDensity / lootDiv) : Math.round(scale * fill.campfires * p.pickupDensity); i > 0; i--)
		putCheap('campfire', fireTpl, undefined, 'campfire');

	// One-visit buildings are placed with the utilities above the scenery
	// pass: most give a hero something permanent the first time and nothing
	// after, which is the case the AI's memory of spent objects is meant to
	// handle, so a map without any leaves that untested.

	// The three objects a real map has that take more than a template.
	// Pandora's box carries its reward block in options, a prison names the
	// hero inside it (drawn without replacement from a per-map pool, so no
	// hero is imprisoned twice), and an obelisk only counts the map's puzzle
	// progress - planMap buries the grail they point at once placement stops.
	// These run rare enough that per-biome Math.round floors them to zero on
	// anything smaller than a large map (an obelisk at 0.5/1000 in a 300-cell
	// biome is 0.15), so they use the shared stochastic rounding.
	// Corpus two-level maps put 55% of their pandoras, half their prisons and
	// 45% of their obelisks underground even though only a third of the open
	// ground is down there - the deep levels are where the treasure zones
	// live. Multiplying the underground rates reproduces that split.
	const uMul = l > 0 ? { pandora: 3, prison: 3, obelisk: 2.5 } : null;
	const pandoraTpl = pandoraTemplate();
	for (let i = pileMan ? manCount('pandoraBox') : rare(fill.pandoras * (uMul ? uMul.pandora : 1)); i > 0; i--)
		putLoot('pandoraBox', pandoraTpl, pandoraOptions(rng));
	const prisonPile = new Map();
	if (fill.prisons || (pileMan && pileMan.has('prison'))) {
		if (!objectPools.prisonHeroes)
			objectPools.prisonHeroes = makePrisonHeroPool(players.length, rng);
		// Prisons by tier (K, 2026-10-07: "the highest-yielding prisons would be in high loot areas behind significant guards"; the
		// engine's rule, TreasurePlacer::addPrisons and HotA's template format: tier values 2500, 5000, 10000, 20000 and 30000 for 0, 5000,
		// 15000, 90000 and 500000 experience, a tier only where the zone's treasure reaches its value). The piles draw them by that rule
		// (piles.js addPrisons), so each prison takes the tier of the prison its pile drew, and the pile's guard (sized on the pile's
		// value) stands at it below. Before this the tier was a corpus roll that ignored the zone: 500000-experience prisons in start
		// zones 12 of 45, and their guards no stronger than a tier-0 prison's (2026-10-08 assessment). The count stays (K, 2026-10-04).
		const tiers = pileMan ? (pileMan.get('prison') || []).slice() : [];
		for (let i = pileMan ? manCount('prison') : rare(fill.prisons * (uMul ? uMul.prison : 1)); i > 0; i--) {
			const hero = objectPools.prisonHeroes.pop();
			if (!hero) break;
			const src = tiers.length ? tiers.splice((rng() * tiers.length) | 0, 1)[0] : null;
			// a start zone's prison keeps to the low tiers (K, 2026-10-07: "starter biomes get lower tiered prisons, with higher tiered ones
			// landing in high loot zones"): the engine's value rule let Coldshadow's rich start zones draw 90000 (MapGen Dev's check, 2026-10-09)
			const startZone = cls === BIOME_CLASS.PLAYER || !!(zoneMeta && zoneMeta.spec && /^(playerStart|cpuStart)$/.test(zoneMeta.spec.type));
			let exp = src ? PRISON_TIER_EXP[src.value] : undefined;
			if (startZone && exp > 15000) exp = 15000;
			const opts = exp === undefined ? prisonOptions(hero, rng) : (exp ? { gender: -1, type: hero, experience: exp } : { gender: -1, type: hero });
			// the free layout's corpus roll keeps to the same low tiers in a start zone
			if (startZone && opts.experience > 15000) opts.experience = 15000;
			const e = src ? putLoot('prison', prisonTemplate(), opts, 'prison') : put('prison', prisonTemplate(), opts, 'prison');
			if (e && src && pileOf.get(src)) prisonPile.set(e, pileOf.get(src));
		}
	}
	const obeliskTpl = obeliskTemplate(terrain);
	for (let i = pileMan ? manCount('obelisk') : rare(fill.obelisks * (uMul ? uMul.obelisk : 1)); i > 0; i--)
		if (put('obelisk', obeliskTpl))
			objectPools.obeliskCount = (objectPools.obeliskCount || 0) + 1;

	// A handful of still-open reachable cells per biome, recorded for planMap
	// to bury the grail in. Collected after everything else has claimed its
	// space, since a hero has to stand on the cell to dig.
	const grailSpots = objectPools.grailCandidates || (objectPools.grailCandidates = []);
	for (let k = 8; k > 0 && free.length; k--) {
		const i = free[(rng() * free.length) | 0];
		grailSpots.push({ x: i % W, y: (i / W) | 0, l });
	}

	// ---- monsters, last, because most of them guard something -------------
	//
	// The budget is the one calibrated against the map corpus. What changed is
	// where it goes. Three quarters of the monsters in real random maps stand
	// on the approach to something worth taking (6964 of 9252 measured across
	// 26 maps); ours were placed entirely at random, so a player had no way to
	// read a map and guards protected nothing. Now most of the budget is spent
	// on the objects, chosen in proportion to how often each kind is guarded in
	// those same maps, and the rest still roams.
	const monsterTpl = FILL_TYPES.creeps[0].tpl;
	// weak/strong shift the creep tier; monsters:"none" already zeroed the
	// budget through guardScale on p.guardDensity
	// monsterStrength (player lever, whole creature levels) stacks on it
	const monsterShift = (zoneMeta ? (zoneMeta.monsterShift || 0) : 0)
		+ Math.round(p.monsterStrength || 0);
	// A free zone's budget pays for the guards already standing in its
	// doorways (p.doorGuards, half of each on its borders): the budget was
	// measured against maps whose monster count includes their link guards,
	// and set while every doorway guard was being lost (plan.js), so with
	// them back the free layout ran 1.13x the corpus's monsters. A template
	// zone's link guards are the template's, over its own treasure guards,
	// as in the engine.
	const guardBudget = Math.max(0, Math.round(scale * fill.creeps * p.guardDensity
		- (zoneMeta ? 0 : p.doorGuards || 0)));
	// objectGuardShare (default OBJECT_GUARD_SHARE, 0.75): the rest roams
	const guardShare = Number.isFinite(p.objectGuardShare) ? p.objectGuardShare : OBJECT_GUARD_SHARE;
	const wantGuards = Math.round(guardBudget * guardShare);

	// weighted sample without replacement: smallest -log(u)/w wins.
	// mineGuardWeight / lootGuardWeight scale the corpus odds per kind (1 =
	// as measured), and the per-context toggles (guardTreasure, guardMines,
	// guardDwellings) switch a context off; a kind at 0 is never guarded and
	// its share of the budget roams instead.
	const guardWeight = g => (GUARD_CHANCE[g.entry.type] || 0.1)
		* guardContextWeight(g.entry.type, p);
	if (SEAL_TRACE) for (const g of guardable) SEAL_TRACE['guardable ' + g.entry.type] = (SEAL_TRACE['guardable ' + g.entry.type] || 0) + 1;
	const ranked = guardable
		.map(g => ({ ...g, key: -Math.log(rng() || 1e-9) / guardWeight(g) }))
		.filter(g => Number.isFinite(g.key))
		.sort((a, b) => a.key - b.key);

	/** Post a monster on a cell beside `target`'s entrance; `preset` is an
	 * engine-rule guard (level and count) for a template zone. */
	const postGuard = ({ entry, tpl }, preset = null, seal = false, gather = 0, retried = false) => {
		// a guard already stands beside its visiting tile (another pile's, a mine's): this one goes to the next object (a dwelling keeps its own: its
		// approach is five tiles wide and one neighbour's ring left most of it open, 25 to 39% of dwellings on K's maps)
		if (!(entry.__guardAt && entry.__walled) && !/^creatureGenerator/.test(entry.type) && !(entry.type === 'prison' && entry.options && entry.options.experience >= 90000) && guardBeside(tpl, entry.x, entry.y)) { if (SEAL_TRACE) SEAL_TRACE['guard shared'] = (SEAL_TRACE['guard shared'] || 0) + 1; return false; }
		// A guard watches the approach its target's visitableFrom permits.
		// Standing on a forbidden side of a front-facing building guards
		// nothing: the engine will not let a hero come at it that way anyway.
		const tdirs = allowedDirs(tpl);
		const spots = [];
		for (const [vx, vy] of visitableCells(tpl, entry.x, entry.y))
			for (const [dx, dy] of tdirs)
				spots.push([vx + dx, vy + dy, vx, vy]);
		for (let k = spots.length - 1; k > 0; k--) {
			const j = (rng() * (k + 1)) | 0;
			[spots[k], spots[j]] = [spots[j], spots[k]];
		}
		// the spot whose ring covers the most of the target's approach first, so the guard seals it rather than
		// standing at one end with the rest open (VMAPGEN_GUARD_COVER=0 keeps the shuffled order)
		if (process.env.VMAPGEN_GUARD_COVER !== '0') {
			const unc = ([gx, gy]) => spots.filter(([ax, ay]) => Math.abs(ax - gx) > 1 || Math.abs(ay - gy) > 1).length;
			const u = new Map(spots.map(s => [s, unc(s)]));
			spots.sort((a, b) => u.get(a) - u.get(b));
		}
		// the side of the target that leaves it, and everything else beside the guard, in view (monsterClips)
		if (CLIP_RULE) {
			const clipped = new Map(spots.map(s => [s, monsterClips(s[0], s[1]) ? 1 : 0]));
			spots.sort((a, b) => clipped.get(a) - clipped.get(b));
		}
		// a spot clear of every other guard's 5x5 first (the register above)
		// a dwelling's approach is up to five tiles wide: its guard takes the tile that covers most of it, keeping only the 3-tile floor
		const wide = /^creatureGenerator/.test(entry.type);
		// a prison of 90000 experience or more is never left without its guard for want of a spaced tile (K, 2026-10-07: "the highest-yielding
		// prisons would be in high loot areas behind significant guards"; 19 to 27% of them stood unguarded when the spacing refused every tile)
		const mustGuard = entry.type === 'prison' && entry.options && entry.options.experience >= 90000;
		{ const cr = new Map(spots.map(sp => [sp, guardTightAt(sp[0], sp[1]) ? 2 : !wide && guardCrowd(sp[0], sp[1]) ? 1 : 0])); spots.sort((a, b) => cr.get(a) - cr.get(b)); }
		// what the guard is meant to block: its target and its approach
		const targetApproach = new Set(spots.map(([ax, ay]) => ay * W + ax));
		for (const [vx, vy] of visitableCells(tpl, entry.x, entry.y)) targetApproach.add(vy * W + vx);
		// With a pocket to seal, every tile that passes is a candidate and the one whose pocket leaks least wins
		// (sealLeaks); the first that passed often had a road or a neighbour's way in on its far side
		// (VMAPGEN_SEAL_SPOT=0 takes the first, as before).
		const pocketing = seal && SEAL_POCKETS && zoneMeta && SEAL_SPOT;
		// With a pocket to seal, the entrances of loose loot round the target do not refuse a guard: that loot joins the
		// pile (sealPlanRing absorbs it). Roads, doorways and other objects' entrances still do. A dwelling's guard was
		// refused for a pickup beside it 37 times a map (2026-10-02). VMAPGEN_GUARD_PILE_OK=0 refuses as before.
		let pileAround = null;
		if (pocketing && process.env.VMAPGEN_GUARD_PILE_OK !== '0') {
			pileAround = new Set(targetApproach);
			for (const o of out) {
				if (o === entry || (o.l || 0) !== l || !o.template || pocketed.has(o) || !POCKETABLE.test(o.type)) continue;
				if (Math.abs(o.x - entry.x) > 4 || Math.abs(o.y - entry.y) > 4) continue;
				for (const [vx, vy] of visitableCells(o.template, o.x, o.y)) pileAround.add(vy * W + vx);
			}
		}
		// a pile walled as it was laid (putLoot) has one tile left open for its guard: the guard stands there, as the engine's does
		if (entry.__guardAt && entry.__walled && entry.__walled[0] === entry.x && entry.__walled[1] === entry.y) {
			const [gx, gy] = entry.__guardAt;
			const walls = blockingCells(monsterTpl, gx, gy).map(([a, b]) => b * W + a);
			// the guard's reach must not take in a road, a door or another entrance (a town's way out ran past one, 2026-10-05)
			const ok = footprintFits(monsterTpl, gx, gy, l, W, H, blocked, true) && (!connectivity || connectivity.accepts(walls))
				&& !(zoneMeta && reachOnReserved(monsterTpl, gx, gy, l, W, H, blocked, pileAround || targetApproach))
				&& entranceOpen(monsterTpl, gx, gy, l, W, H, blocked, reachable);
			RING_T[ok ? 'guard on its tile' : 'guard tile refused'] = (RING_T[ok ? 'guard on its tile' : 'guard tile refused'] || 0) + 1;
			if (ok) { pocketed.add(entry); return placeGuardAt(gx, gy, true); }
		}
		const fits = [];
		const why = SEAL_TRACE && (seal || entry.type === 'mine') ? {} : null;
		const no = k => { if (why) why[k] = (why[k] || 0) + 1; };
		for (const [gx, gy, vx, vy] of spots) {
			if (gx < 0 || gy < 0 || gx >= W || gy >= H) continue;
			// monsters are removable: the guard may stand on the approach
			// cell itself, which is what guarding means
			if (!footprintFits(monsterTpl, gx, gy, l, W, H, blocked, true)) {
				no('no room');
				if (why && /^creatureGenerator/.test(entry.type)) {
					const f = blocked[l * W * H + gy * W + gx];
					const on = out.find(o => (o.l || 0) === l && blockingCells(o.template, o.x, o.y).some(([a2, b2]) => a2 === gx && b2 === gy));
					const k = on ? 'on ' + on.type.replace(/\d+$/, '') + (pocketed.has(on) ? ' (pocketed)' : '') : (f & RESERVED ? 'reserved' : f & OCCUPIED ? 'blocked, no fill object' : 'other');
					SEAL_TRACE['dwelling approach ' + k] = (SEAL_TRACE['dwelling approach ' + k] || 0) + 1;
				}
				continue;
			}
			// but in a template zone not over a road, a corridor, a doorway
			// or another entrance (the free layout's guards, as in put)
			if (zoneMeta && reachOnReserved(monsterTpl, gx, gy, l, W, H, blocked, pileAround || targetApproach)) { no('road, door or entrance in reach'); continue; }
			// A guard that cannot be approached is a wall, not a guard.
			if (!entranceOpen(monsterTpl, gx, gy, l, W, H, blocked, reachable)) { no('guard unapproachable'); continue; }
			// The guard must not be the only way in. A monster is blocked and
			// visitable, so taking the last open cell beside an entrance turns
			// the object it is guarding into scenery, and the stranded sweep
			// would then throw both of them away. Only directions the target
			// permits count.
			const own = new Set(blockingCells(monsterTpl, gx, gy)
				.map(([a, b]) => b * W + a));
			let stillOpen = false;
			for (const [dx, dy] of tdirs) {
				const nx = vx + dx, ny = vy + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const c = ny * W + nx;
				if (own.has(c) || (blocked[l * W * H + c] & OCCUPIED)) continue;
				if (reachable && !reachable[c]) continue;
				stillOpen = true;
				break;
			}
			if (!stillOpen && !(seal && SEAL_POCKETS && zoneMeta)) continue;
			const walls = blockingCells(monsterTpl, gx, gy).map(([a, b]) => b * W + a);
			if (connectivity && !connectivity.accepts(walls)) { no('would cut the zone'); continue; }
			// a pocket's guard is meant to join the walls round its pile: that is what seals it, and the fight removes it.
			// The weld test refused 43 dwelling guards and 38 bank guards a map in the tunnels (2026-10-02).
			// VMAPGEN_GUARD_WELD_OK=0 applies the test to pocket guards as before.
			if (!(pocketing && process.env.VMAPGEN_GUARD_WELD_OK !== '0') && weldsMasses(walls, blocked, l, W, H, 2)) { no('welds masses'); continue; }
			if (pocketing) { if (!fits.some(([x, y]) => x === gx && y === gy)) fits.push([gx, gy]); continue; }
			if (!mustGuard && !wide && guardTightAt(gx, gy)) { no('crowded'); continue; }
			return placeGuardAt(gx, gy);
		}
		if (!fits.length) {
			// a pickup laid on the target's approach after it (pickups may cover an approach) leaves the guard no tile:
			// move the one on the tile that would cover most of the approach, and try once more (a dwelling's pile guard
			// failed this way 50 times a map, 2026-10-02; VMAPGEN_GUARD_CLEAR=0 gives up as before)
			if (seal && !retried && process.env.VMAPGEN_GUARD_CLEAR !== '0') {
				for (const [gx, gy] of spots) {
					if (gx < 0 || gy < 0 || gx >= W || gy >= H) continue;
					const on = out.filter(o => (o.l || 0) === l && o.x === gx && o.y === gy && movable(o));
					if (on.length !== 1 || !relocate(on[0], entry)) continue;
					if (SEAL_TRACE) SEAL_TRACE['guard tile cleared'] = (SEAL_TRACE['guard tile cleared'] || 0) + 1;
					return postGuard({ entry, tpl }, preset, seal, gather, true);
				}
			}
			if (why) for (const k of Object.keys(why)) SEAL_TRACE[`guard failed ${entry.type}: ${k}`] = (SEAL_TRACE[`guard failed ${entry.type}: ${k}`] || 0) + 1;
			return false;
		}
		if (CLIP_RULE) { const clear = fits.filter(([gx, gy]) => !monsterClips(gx, gy)); if (clear.length) fits.splice(0, fits.length, ...clear); }
		// a pile's guard with only tiles beside another stack goes to the next object instead (postPileGuard walks on)
		{ const clear = fits.filter(([gx, gy]) => !guardCrowd(gx, gy)), clear3 = fits.filter(([gx, gy]) => !guardTightAt(gx, gy));
			if (clear.length && !wide) fits.splice(0, fits.length, ...clear); else if (clear3.length) fits.splice(0, fits.length, ...clear3); else if (seal && !mustGuard) return false; }
		let best = fits[0], bestN = Infinity;
		for (const [gx, gy] of fits) {
			const n = sealLeaks(sealPlan(entry, gx, gy));
			if (n < bestN) { bestN = n; best = [gx, gy]; if (!n) break; }
		}
		if (connectivity && !connectivity.accepts(blockingCells(monsterTpl, best[0], best[1]).map(([a, b]) => b * W + a))) return false;
		return placeGuardAt(best[0], best[1]);

		function placeGuardAt(gx, gy, ringed = false) {
			const tier = preset ? preset.level : creepTier(cls, rng,
				(GUARD_VALUE_BUMP[entry.type] || 0) + monsterShift);
			const guardEntry = objectEntry(`randomMonsterLevel${tier}`, gx, gy, l, monsterTpl,
				preset ? { character: 'hostile', amount: scaledAmount(preset.amount, p) } : monsterOptions(tier, p, rng),
				'object');
			// the creature the engine's rule picked, for generate.js to write
			if (preset && preset.concrete) guardEntry.guardCreature = preset.creature;
			if (process.env.VMAPGEN_SRC_TRACE && guardCrowd(gx, gy)) guardEntry.__src = (ringed ? "ringed" : pocketing ? "pocket" : "first") + "-" + entry.type.replace(/:.*/, "") + "<crowded";
			out.push(guardEntry);
			holdGuard(gx, gy);
			footprintBlock(monsterTpl, gx, gy, l, W, H, blocked);
			markApproach(monsterTpl, gx, gy, l, W, H, blocked);
			if (connectivity) connectivity.refresh();
			const idx = free.indexOf(gy * W + gx);
			if (idx >= 0) free.splice(idx, 1);
			if (seal && SEAL_POCKETS && zoneMeta && !ringed) { if (gather > 0) gatherPile(tpl, entry, gx, gy, gather); sealTarget(tpl, entry, gx, gy); }
			return true;
		}
	};

	/**
	 * Wall a pocket round `entry` and the unguarded loot packed beside it, so the guard at (gx, gy) is the way in, as the
	 * engine's piles are (TreasurePlacer: the pile's border blocked, the guard on its entrance). The inside is the guard's
	 * tile and the group's approach tiles joined to it; every open tile touching the inside gets a one-tile obstacle,
	 * except tiles in the guard's ring (stepping there is the fight), tiles another object needs as its way in, doors,
	 * roads and entrances, and tiles whose blocking would cut the zone.
	 */
	const pocketed = new Set();
	const GROUPABLE = /^(resource|randomResource|treasureChest|campfire|randomArtifact|artifact|spellScroll|pandoraBox|prison|creatureGenerator|creatureBank|dragonUtopia)/;
	// the engine's piles hold its one-visit buildings too (TreasurePlacer's shrines, scholars, stones, schools, temples):
	// 0.29 of them sealed behind a guard on Coldshadow's Fantasy against ours 0.10, and a shrine beside a pocket was the
	// commonest tile a pocket could not close (seed 1: 90 of 383). VMAPGEN_SEAL_BUILDINGS=0 leaves them out.
	const POCKETABLE = process.env.VMAPGEN_SEAL_BUILDINGS === '0' ? GROUPABLE
		: /^(resource|randomResource|treasureChest|campfire|randomArtifact|artifact|spellScroll|pandoraBox|prison|creatureGenerator|creatureBank|dragonUtopia|shrine|scholar|learningStone|schoolOf|temple|starAxis|gardenOfRevelation|mysticalGarden|magicWell|magicSpring|watchTower|redwoodObservatory|pillarOfFire|libraryOfEnlightenment|witchHut|treeOfKnowledge|arena|mercenaryCamp|marlettoTower|oasis|fountain|idolOfFortune|swanPond|faerieRing|stables|wateringHole|sanctuary|obelisk|corpse|wagon|warriorsTomb|skeleton)/;
	// The engine's pile is its objects side by side behind one guard (TreasurePlacer). Ours lays loot out one object at
	// a time, so a guard closed one object and the rest of its pile lay open elsewhere: a guard closing 3+ objects on
	// 0.17 of Coldshadow's Fantasy guards against the engine's 0.43, and 0.6 of its high loot open (tools/mapsight
	// score 2026-10-01). Here up to `n` loose one-tile pickups of this zone, nearest first, move onto the target's own
	// approach tiles on the far side from the guard, where a hero in the guard's ring reaches them and nowhere else
	// does once the pocket is walled. VMAPGEN_SEAL_GATHER=0 leaves the loot where it was laid.
	const zoneCellSet = new Set(cells);
	// the level's rock as the cave checker reads it (1 = rock), for pocket walls closed as rock (sealTarget)
	const gatherPile = (tpl, entry, gx, gy, n) => {
		const base = l * W * H;
		const ent = ENTRANCES.get(blocked);
		const ring = c => Math.abs(c % W - gx) <= 1 && Math.abs(((c / W) | 0) - gy) <= 1;
		// never a tile another object comes at its entrance from (a gate's one open approach tile, a mine's)
		const others = new Set();
		for (const o of out) {
			if (o === entry || (o.l || 0) !== l || !o.template || !o.template.mask || Math.abs(o.x - entry.x) > 10 || Math.abs(o.y - entry.y) > 10) continue;
			const ot = { mask: o.template.mask, visitableFrom: o.template.visitableFrom };
			for (const [vx, vy] of visitableCells(ot, o.x, o.y)) for (const [dx, dy] of allowedDirs(ot)) others.add((vy + dy) * W + vx + dx);
		}
		for (const ex of preplaced || []) if (ex && ex.template && ex.template.mask) {
			const ot = { mask: ex.template.mask, visitableFrom: ex.template.visitableFrom };
			for (const [vx, vy] of visitableCells(ot, ex.x, ex.y)) for (const [dx, dy] of allowedDirs(ot)) others.add((vy + dy) * W + vx + dx);
		}
		const spots = [];
		for (const [vx, vy] of visitableCells(tpl, entry.x, entry.y))
			for (const [dx, dy] of allowedDirs(tpl)) {
				const x = vx + dx, y = vy + dy, c = y * W + x;
				if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1 || ring(c) || !zoneCellSet.has(c) || others.has(c)) continue;
				if (blocked[base + c] & (OCCUPIED | RESERVED)) continue;
				if (ent && ent.has(base + c)) continue;
				spots.push(c);
			}
		// farthest from the guard first: those are the tiles the pocket wall would otherwise have to close
		spots.sort((a, b) => ((b % W - gx) ** 2 + (((b / W) | 0) - gy) ** 2) - ((a % W - gx) ** 2 + (((a / W) | 0) - gy) ** 2));
		const one = o => { if (!o.template || !o.template.mask) return false; const b = blockingCells(o.template, o.x, o.y); return b.length === 1 && b[0][0] === o.x && b[0][1] === o.y; };
		const loose = out.filter(o => o !== entry && (o.l || 0) === l && GROUPABLE.test(o.type) && !pocketed.has(o) && !o.__walled && one(o)
			&& /^(resource|randomResource|treasureChest|campfire|randomArtifact|artifact|spellScroll|pandoraBox)/.test(o.type)
			&& zoneCellSet.has(o.y * W + o.x) && (Math.abs(o.x - entry.x) > 3 || Math.abs(o.y - entry.y) > 3)
			// a relic, a major artifact or a Pandora's box is never a pile's filler: it stands two tiles behind the guard, out of the
			// reach of "a monster beside it", where it should be the pile's target with the guard at its own approach (the engine's
			// guarded share of these is 0.56 to 0.76, ours stood near 0.41 with the dearest loot gathered behind other targets)
			&& !/^(randomArtifactRelic|randomArtifactMajor|pandoraBox)$/.test(o.type))
			// the dearest first (POCKET_RANK), the nearest among equals: a pile holds the zone's prizes, not whatever lay
			// closest (VMAPGEN_GATHER_DEAR=0 takes the nearest only)
			.sort((a, b) => (process.env.VMAPGEN_GATHER_DEAR === '0' ? 0 : (POCKET_RANK[a.type] || 50) - (POCKET_RANK[b.type] || 50))
				|| ((a.x - entry.x) ** 2 + (a.y - entry.y) ** 2) - ((b.x - entry.x) ** 2 + (b.y - entry.y) ** 2));
		let moved = 0;
		for (const c of spots) {
			if (moved >= n || !loose.length) break;
			if (blocked[base + c] & (OCCUPIED | RESERVED)) continue;
			const o = loose.shift();
			const old = o.y * W + o.x;
			blocked[base + old] &= ~OCCUPIED;
			if (connectivity) connectivity.refresh();
			if (connectivity && !connectivity.accepts([c])) {
				blocked[base + old] |= OCCUPIED;
				connectivity.refresh();
				continue;
			}
			blocked[base + c] |= OCCUPIED;
			if (connectivity) connectivity.refresh();
			o.x = c % W; o.y = (c / W) | 0;
			const fi = free.indexOf(c);
			if (fi >= 0) free.splice(fi, 1);
			free.push(old);
			moved++;
		}
		if (SEAL_TRACE) SEAL_TRACE.gathered = (SEAL_TRACE.gathered || 0) + moved;
	};
	/**
	 * The pocket as the guard's ring (SEAL_MODEL ring, the default). A pocket is sealed when every way to its objects
	 * passes a tile of the guard's 3x3. So each object of the group must have an approach tile in the ring, or a short
	 * path from the ring (the pocket's floor, P); every other approach tile of the group, and every open tile beside
	 * the floor, is blocked. The wide model (SEAL_MODEL=wide) flooded through all the group's approach tiles and walled
	 * round the lot, and one tile of that long wall a neighbour or a road needed left the pocket open: Coldshadow's
	 * Fantasy sealed 0.3 of its high loot against the engine's 0.84 (tools/mapsight score, 2026-10-01).
	 */
	const sealPlanRing = (entry, gx, gy, t = () => {}) => {
		const key = (x, y) => y * W + x;
		const open = c => !(blocked[l * W * H + c] & OCCUPIED);
		const approachOf = o => {
			const ot = { mask: o.template.mask, visitableFrom: o.template.visitableFrom };
			const set = new Set();
			for (const [vx, vy] of visitableCells(ot, o.x, o.y))
				for (const [dx, dy] of allowedDirs(ot)) { const x = vx + dx, y = vy + dy; if (x >= 0 && y >= 0 && x < W && y < H) set.add(key(x, y)); }
			return set;
		};
		const R = new Set([key(gx, gy)]);
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			const x = gx + dx, y = gy + dy;
			if (x >= 0 && y >= 0 && x < W && y < H && open(key(x, y))) R.add(key(x, y));
		}
		const P = new Set();
		const appr = new Map();
		const A = o => { if (!appr.has(o)) appr.set(o, approachOf(o)); return appr.get(o); };
		// whether o can be visited from the ring or the floor, adding up to two floor tiles when that takes it
		const reach = o => {
			const a = A(o);
			for (const c of a) if (R.has(c) || P.has(c)) return true;
			const from = new Map();
			let front = [...R, ...P];
			for (const c of front) from.set(c, -1);
			for (let d = 0; d < 2; d++) {
				const next = [];
				for (const c of front) {
					const x = c % W, y = (c / W) | 0;
					for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
						const nx = x + dx, ny = y + dy;
						if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
						const n = key(nx, ny);
						if (from.has(n) || !open(n)) continue;
						from.set(n, c);
						if (a.has(n)) { for (let k = n; k >= 0 && !R.has(k) && !P.has(k); k = from.get(k)) P.add(k); return true; }
						next.push(n);
					}
				}
				front = next;
			}
			return false;
		};
		const group = [entry];
		reach(entry);
		const near = out.filter(o => o !== entry && (o.l || 0) === l && o.template && POCKETABLE.test(o.type) && !pocketed.has(o)
			&& Math.abs(o.x - entry.x) <= 3 && Math.abs(o.y - entry.y) <= 3)
			.sort((a, b) => (Math.abs(a.x - entry.x) + Math.abs(a.y - entry.y)) - (Math.abs(b.x - entry.x) + Math.abs(b.y - entry.y)));
		for (const o of near) if (reach(o)) group.push(o);
		let wall, needed, needBy;
		for (let pass = 0; pass < 4; pass++) {
			const inG = new Set(group);
			needed = new Set(); needBy = new Map();
			for (const o of out) {
				if (inG.has(o) || (o.l || 0) !== l || !o.template || Math.abs(o.x - entry.x) > 10 || Math.abs(o.y - entry.y) > 10) continue;
				for (const c of A(o)) { needed.add(c); if (!needBy.has(c)) needBy.set(c, []); needBy.get(c).push(o); }
			}
			wall = new Set();
			for (const o of group) for (const c of A(o)) if (!R.has(c) && !P.has(c) && open(c)) wall.add(c);
			for (const c of P) {
				const x = c % W, y = (c / W) | 0;
				for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
					const nx = x + dx, ny = y + dy;
					if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const n = key(nx, ny);
					if (!R.has(n) && !P.has(n) && open(n)) wall.add(n);
				}
			}
			if (!SEAL_ABSORB) break;
			// loose loot whose way in is one of these tiles joins the pocket when the ring reaches it
			const join = [];
			for (const c of wall) for (const o of needBy.get(c) || [])
				if (!inG.has(o) && !join.includes(o) && POCKETABLE.test(o.type) && !pocketed.has(o)
					&& Math.abs(o.x - entry.x) <= 5 && Math.abs(o.y - entry.y) <= 5 && reach(o)) join.push(o);
			if (!join.length) break;
			group.push(...join);
			t('absorbed', join.length);
		}
		return { group, near: group.slice(1), wall, needed, groupAppr: new Set(), needBy };
	};
	// the pocket a guard at (gx, gy) would close round `entry`: the group, its inside and the wall round it
	const sealPlan = (entry, gx, gy, t = () => {}) => SEAL_MODEL === 'wide' ? sealPlanWide(entry, gx, gy, t) : sealPlanRing(entry, gx, gy, t);
	const sealPlanWide = (entry, gx, gy, t = () => {}) => {
		const key = (x, y) => y * W + x;
		const approachOf = o => {
			const ot = { mask: o.template.mask, visitableFrom: o.template.visitableFrom };
			const set = new Set();
			for (const [vx, vy] of visitableCells(ot, o.x, o.y))
				for (const [dx, dy] of allowedDirs(ot)) { const x = vx + dx, y = vy + dy; if (x >= 0 && y >= 0 && x < W && y < H) set.add(key(x, y)); }
			return set;
		};
		const near = out.filter(o => o !== entry && (o.l || 0) === l && o.template && GROUPABLE.test(o.type) && !pocketed.has(o)
			&& Math.abs(o.x - entry.x) <= 3 && Math.abs(o.y - entry.y) <= 3);
		const group = [entry, ...near];
		const groupAppr = new Set();
		const open = c => !(blocked[l * W * H + c] & OCCUPIED);
		const ring = new Set();
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const x = gx + dx, y = gy + dy; if (x >= 0 && y >= 0 && x < W && y < H) ring.add(key(x, y)); }
		let inside, needed, wall, needBy;
		// Loose loot whose way in is a tile of the wall joins the pocket instead (SEAL_ABSORB, the default): the
		// engine's pile holds its objects together behind one guard, and ours, laid out one by one, left the wall open
		// wherever a neighbour's approach crossed it (Coldshadow's Fantasy seed 1: 1182 of the wall's tiles).
		for (let pass = 0; pass < 4; pass++) {
			for (const o of group) for (const c of approachOf(o)) groupAppr.add(c);
			inside = new Set([key(gx, gy)]);
			const st = [key(gx, gy)];
			while (st.length) {
				const c = st.pop(), x = c % W, y = (c / W) | 0;
				for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
					const nx = x + dx, ny = y + dy;
					if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const n = key(nx, ny);
					if (inside.has(n) || !groupAppr.has(n) || !open(n)) continue;
					inside.add(n); st.push(n);
				}
			}
			needed = new Set(); needBy = new Map();
			for (const o of out) {
				if (group.includes(o) || (o.l || 0) !== l || !o.template || Math.abs(o.x - entry.x) > 10 || Math.abs(o.y - entry.y) > 10) continue;
				for (const c of approachOf(o)) { needed.add(c); if (!needBy.has(c)) needBy.set(c, []); needBy.get(c).push(o); }
			}
			wall = new Set();
			for (const c of inside) {
				const x = c % W, y = (c / W) | 0;
				for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
					const nx = x + dx, ny = y + dy;
					if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const n = key(nx, ny);
					if (inside.has(n) || ring.has(n) || !open(n)) continue;
					wall.add(n);
				}
			}
			if (!SEAL_ABSORB) break;
			const join = new Set();
			for (const c of wall) for (const o of needBy.get(c) || [])
				if (GROUPABLE.test(o.type) && !pocketed.has(o) && Math.abs(o.x - entry.x) <= 6 && Math.abs(o.y - entry.y) <= 6) join.add(o);
			if (!join.size) break;
			for (const o of join) group.push(o);
			t('absorbed', join.size);
		}
		const wide = { group, near, wall, needed, groupAppr };
		// The tight pocket: the target alone, its own approach tiles outside the guard's ring blocked. A wide wall
		// that one road tile or a neighbour's way in leaves open is an open pocket; the tight one has a few tiles to
		// close, mostly ones no one else needs. The fewer leaks wins, the wide one on a tie (it keeps the loot
		// together). VMAPGEN_SEAL_TIGHT=0 keeps the wide pocket only.
		if (!SEAL_TIGHT) return wide;
		const own = approachOf(entry);
		const tWall = new Set([...own].filter(c => !ring.has(c) && open(c)));
		const tNeeded = new Set();
		for (const o of out) {
			if (o === entry || (o.l || 0) !== l || !o.template || Math.abs(o.x - entry.x) > 10 || Math.abs(o.y - entry.y) > 10) continue;
			for (const c of approachOf(o)) tNeeded.add(c);
		}
		const tight = { group: [entry], near: [], wall: tWall, needed: tNeeded, groupAppr: new Set(), tight: true };
		return sealLeaks(tight) < sealLeaks(wide) ? tight : wide;
	};
	// wall tiles the seal would have to leave open: the pocket's leaks
	const sealLeaks = P => {
		let n = 0;
		const ent = ENTRANCES.get(blocked);
		for (const c of P.wall)
			if (P.needed.has(c) || P.groupAppr.has(c) || (blocked[l * W * H + c] & RESERVED) || (ent && ent.has(l * W * H + c))) n++;
		return n;
	};
	// a pickup's mask is two tiles wide ("VA", "VV/VA"), the left one only drawn: one blocking tile, at its anchor
	const oneTile = o => { if (!o.template || !o.template.mask) return false; const b = blockingCells(o.template, o.x, o.y); return b.length === 1 && b[0][0] === o.x && b[0][1] === o.y; };
	const movable = o => !pocketed.has(o) && !o.__walled && oneTile(o) && /^(resource|randomResource|treasureChest|campfire|randomArtifact|artifact|spellScroll)/.test(o.type);
	// a one-tile pickup to a free tile of the zone at least five tiles from `from`, next to no entrance or approach
	const relocate = (o, from) => {
		const base = l * W * H;
		const old = o.y * W + o.x;
		for (let tries = 0; tries < 40 && free.length; tries++) {
			const c = free[(rng() * free.length) | 0];
			const x = c % W, y = (c / W) | 0;
			if (Math.max(Math.abs(x - from.x), Math.abs(y - from.y)) < 5 || x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
			if (blocked[base + c] & (OCCUPIED | RESERVED | APPROACH)) continue;
			if (!zoneCellSet.has(c)) continue;
			let clear = true;
			const ent = ENTRANCES.get(blocked);
			for (let dy = -1; dy <= 1 && clear; dy++) for (let dx = -1; dx <= 1; dx++) {
				const k = c + dy * W + dx;
				if (ent && ent.has(base + k)) { clear = false; break; }
				if (blocked[base + k] & (RESERVED | APPROACH)) { clear = false; break; }
			}
			if (!clear) continue;
			blocked[base + old] &= ~OCCUPIED;
			if (connectivity) connectivity.refresh();
			if (connectivity && !connectivity.accepts([c])) { blocked[base + old] |= OCCUPIED; if (connectivity) connectivity.refresh(); continue; }
			blocked[base + c] |= OCCUPIED;
			if (connectivity) connectivity.refresh();
			markApproach(o.template, x, y, l, W, H, blocked);
			o.x = x; o.y = y;
			const fi = free.indexOf(c);
			if (fi >= 0) free.splice(fi, 1);
			free.push(old);
			return true;
		}
		return false;
	};
	// The engine finds a place where a pile closes (TreasurePlacer: the pile's border blocked, its guard on the one way
	// in, never beside a road); ours placed the loot first. A one-tile target whose pocket would leak where it lies moves
	// to the free tile of its zone, among up to 60 nooks (3+ blocked neighbours, no road or door within two tiles), whose
	// pocket closes with the fewest open tiles. VMAPGEN_SEAL_RESITE=0 leaves it where it was laid.
	const resite = (g, spotFor) => {
		const { entry } = g;
		if (!oneTile(entry) || pocketed.has(entry) || entry.__walled) return false;
		const base = l * W * H;
		const leaksAt = () => { const s = spotFor(g); return s ? sealLeaks(sealPlan(entry, s[0], s[1])) : Infinity; };
		let best = leaksAt();
		if (best === 0) return false;
		const homeX = entry.x, homeY = entry.y, home = homeY * W + homeX;
		const nook = c => {
			const x = c % W, y = (c / W) | 0;
			if (x < 2 || y < 2 || x >= W - 2 || y >= H - 2 || !zoneCellSet.has(c)) return false;
			if (blocked[base + c] & (OCCUPIED | RESERVED | APPROACH)) return false;
			let walls = 0;
			for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
				const f = blocked[base + c + dy * W + dx];
				if (f & RESERVED) return false;
				if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && (dx || dy) && (f & OCCUPIED)) walls++;
			}
			return walls >= 3;
		};
		const cand = [];
		for (let tries = 0; tries < 400 && cand.length < 60 && free.length; tries++) {
			const c = free[(rng() * free.length) | 0];
			if (nook(c) && !cand.includes(c)) cand.push(c);
		}
		let bestC = -1;
		blocked[base + home] &= ~OCCUPIED;
		for (const c of cand) {
			blocked[base + c] |= OCCUPIED;
			entry.x = c % W; entry.y = (c / W) | 0;
			const n = leaksAt();
			blocked[base + c] &= ~OCCUPIED;
			if (n < best) { best = n; bestC = c; if (!n) break; }
		}
		entry.x = homeX; entry.y = homeY;
		if (bestC < 0) { blocked[base + home] |= OCCUPIED; return false; }
		if (connectivity) connectivity.refresh();
		if (connectivity && !connectivity.accepts([bestC])) { blocked[base + home] |= OCCUPIED; if (connectivity) connectivity.refresh(); return false; }
		blocked[base + bestC] |= OCCUPIED;
		if (connectivity) connectivity.refresh();
		entry.x = bestC % W; entry.y = (bestC / W) | 0;
		markApproach(entry.template, entry.x, entry.y, l, W, H, blocked);
		const fi = free.indexOf(bestC);
		if (fi >= 0) free.splice(fi, 1);
		free.push(home);
		if (SEAL_TRACE) SEAL_TRACE.resited = (SEAL_TRACE.resited || 0) + 1;
		return true;
	};
	const sealTarget = (tpl, entry, gx, gy) => {
		const T = SEAL_TRACE; const t = (k, n = 1) => { if (T) T[k] = (T[k] || 0) + n; };
		t('targets'); t('target ' + entry.type);
		const { group, near, wall, needed, groupAppr, needBy } = sealPlan(entry, gx, gy, t);
		let leaked = 0;
		for (const c of wall) {
			const cx = c % W, cy = (c / W) | 0;
			leaked++;
			// a loose one-tile pickup whose way in is this tile moves elsewhere in the zone, and the tile is walled
			// (VMAPGEN_SEAL_MOVE=0 leaves it): loose resources beside a pocket were its commonest open tile after the
			// shrines (seed 1: 125 of 299)
			if (needed.has(c) && SEAL_MOVE && needBy) {
				const movers = (needBy.get(c) || []).slice();
				if (T) for (const o of movers) if (!movable(o)) t('not movable: ' + (pocketed.has(o) ? 'pocketed ' : '') + o.type.replace(/\d+$/, ''));
				if (movers.length && movers.every(o => movable(o))) {
					if (movers.every(o => relocate(o, entry))) { needed.delete(c); t('moved a pickup away', movers.length); }
					else t('relocation failed');
				}
			}
			if (needed.has(c)) { t('another object uses it'); if (T && needBy) for (const o of needBy.get(c) || []) t('needed by ' + o.type.replace(/\d+$/, '')); continue; }
			if (groupAppr.has(c)) { t('a grouped object needs it'); continue; }
			const f = blocked[l * W * H + c];
			if (f & RESERVED) { t('reserved door or road'); continue; }
			if (ENTRANCES.get(blocked) && ENTRANCES.get(blocked).has(l * W * H + c)) { t('an entrance'); continue; }
			// In a cave the wall closes as rock where the rock's terrain art fits no worse, as the engine's cave walls
			// are rock with few obstacles; one-tile obstacles made our tunnels read as cluttered (underground pieces
			// 950 at 2.2 tiles against the engine's 520 at 3.4, 2026-10-02). VMAPGEN_SEAL_ROCK=0 always uses an obstacle.
			if (caveRock && process.env.VMAPGEN_SEAL_ROCK !== '0' && openMask[c]) {
				const was = p.caveChecker.around(caveRock, W, H, cx, cy, 2);
				caveRock[c] = 1;
				const now = p.caveChecker.around(caveRock, W, H, cx, cy, 2);
				if (now <= was && (!connectivity || connectivity.accepts([c]))) {
					openMask[c] = 0; sealRock(c);
					blocked[l * W * H + c] |= OCCUPIED;
					if (connectivity) connectivity.refresh();
					const fi = free.indexOf(c);
					if (fi >= 0) free.splice(fi, 1);
					t('sealed tile'); t('sealed by rock');
					leaked--;
					continue;
				}
				caveRock[c] = 0;
			}
			const s = singleTemplate(terrain, rng);
			if (!s || !s.tpl.mask || s.tpl.mask.length !== 1 || s.tpl.mask[0].length !== 1) { t('no single-tile art'); continue; }
			if (connectivity && !connectivity.accepts([c])) { t('connectivity'); continue; }
			t('sealed tile');
			leaked--;
			out.push(objectEntry(s.type, cx, cy, l, s.tpl, {}, s.subtype));
			footprintBlock(s.tpl, cx, cy, l, W, H, blocked);
			if (connectivity) connectivity.refresh();
			const fi = free.indexOf(c);
			if (fi >= 0) free.splice(fi, 1);
		}
		for (const o of group) pocketed.add(o);
		if (near.length) t('grouped objects', near.length);
		t(leaked ? 'pockets left open' : 'pockets closed');
	};

	let posted = 0;
	if (zoneMeta && zoneMeta.spec) {
		// Template zone: the guards the engine would post here. A mine is
		// guarded on its own value; every treasure pile the engine would make
		// (floor(tiles * density / 400) per band, TreasurePlacer::
		// createTreasures, each worth a value inside its band) gets one guard
		// sized by the rule above, and a pile it would leave unguarded stays
		// unguarded. Our objects are not piles, so each pile's guard stands by
		// the next object the ranking offers. The engine's maps have no roaming
		// monsters. "Monster tier" moves the map strength the way the engine's
		// weak / strong setting does, and its Normal is the engine's weak:
		// every corpus map was made on weak monsters (their description
		// lines say so), and the preset is calibrated to that corpus.
		const bands = zoneMeta.spec.treasure || [];
		const idx = 1 + (zoneMeta.monsterShift || 0)
			+ Math.max(-2, Math.min(2, Math.round(p.monsterStrength || 0)));
		const onMines = ranked.filter(g => g.entry.type === 'mine');
		const byPiles = ranked.filter(g => g.entry.type !== 'mine');
		// With objectPools.guards (generate.js; the default), the
		// guard is picked from the creatures this zone allows and written as
		// that creature, as the engine writes it.
		const concrete = !!(objectPools && objectPools.guards);
		const zonePool = concrete ? zoneGuardPool(objectPools.guards, zoneMeta.spec) : undefined;
		const zoneGuard = value => {
			const guard = engineGuard(value, idx, rng, false, zonePool);
			if (guard && concrete) guard.concrete = true;
			return guard;
		};
		// The Monster count slider on a template map (it only fed the free layout's budget, so 0x and 3x gave the same 17 monsters a
		// 1000 tiles, sweep 2026-10-04): below 1x each pile and mine guard stands with that chance; above 1x each posted guard brings a
		// roaming monster with chance (slider - 1), so 2x doubles them. Plain behaviour; 1x is untouched.
		const thin = () => userGuardDensity < 1 && rng() >= userGuardDensity;
		// Guarding vs roaming on a template map (K, 2026-10-05: every lever acts on every template; it read the free layout only): the engine's
		// monsters all guard, which is the lever's default 0.75. Below it each posted guard brings roaming monsters, on average 0.75 / share - 1 up to
		// 2, so a share of 0.375 is half of the monsters roaming and 0.25 and below two roamers a guard. The guards stay, so no pile is left open.
		const crowd = lvl => {
			const tier = Math.max(1, Math.min(4, lvl - 1));
			if (userGuardDensity > 1 && rng() < Math.min(1, userGuardDensity - 1))
				put(`randomMonsterLevel${tier}`, monsterTpl, monsterOptions(tier, p, rng));
			if (guardShare < OBJECT_GUARD_SHARE) {
				const e = Math.min(2, OBJECT_GUARD_SHARE / Math.max(guardShare, 0.01) - 1);
				for (let n = Math.floor(e) + (rng() < e - Math.floor(e) ? 1 : 0); n > 0; n--)
					put(`randomMonsterLevel${tier}`, monsterTpl, monsterOptions(tier, p, rng));
			}
		};
		// Mine guard weight on a template map: it only ordered the mines, so 4x equalled 1x and the guards stood at every setting.
		// Below 1x a mine keeps the engine's guard with that chance; above 1x a mine the engine leaves unguarded (its value too low
		// for a guard) gets one with chance (weight - 1) / 3, sized as a mine worth (1 + weight) times as much. 1x is untouched.
		const mineW = Number.isFinite(p.mineGuardWeight) ? p.mineGuardWeight : 1;
		for (const g of onMines) {
			if (thin()) continue;
			if (mineW < 1 && rng() >= mineW) continue;
			const mineValue = MINE_RMG_VALUE[g.entry.subtype] || 3500;
			let guard = zoneGuard(mineValue);
			if (!guard && mineW > 1 && rng() < Math.min(1, (mineW - 1) / 3)) guard = zoneGuard(mineValue * (1 + mineW));
			if (SEAL_TRACE) { const k = 'mine ' + g.entry.subtype + (guard ? '' : ' no guard by value'); SEAL_TRACE[k] = (SEAL_TRACE[k] || 0) + 1; }
			if (guard && postGuard(g, guard)) { posted++; crowd(guard.level); }
		}
		// The engine asks for floor(tiles * density / 400) piles per band but
		// keeps each pile clear of other objects: minDistance = sqrt(min(value,
		// 30000) / 10 / density so far), richest band first
		// (TreasurePlacer.cpp:987). It compares that against the tile's
		// SQUARED distance to the nearest object (ObjectManager::
		// updateDistances keeps distanceSqr), so the spacing in cells is its
		// square root, and about tiles / minDistance piles fit. Read as a
		// linear distance until 2026-09-26, which let a rich band (45000 and
		// up, spacing 5.6 cells) land 0-2 piles a zone where the engine lands
		// most of its count: Coldshadow's Fantasy had 33 level-7 guards a map
		// against the corpus's 76. VMAPGEN_PILE_ROOM=linear is the old reading.
		// TPL_PILE_SHARE is what then lands, measured against the corpus with
		// the fidelity lens.
		let next = 0;
		const usedTarget = new Set();
		// where postGuard would most likely stand for a target: the free approach tile covering most of the approach
		const spotFor = ({ entry, tpl }) => {
			const sp = [];
			for (const [vx, vy] of visitableCells(tpl, entry.x, entry.y)) for (const [dx, dy] of allowedDirs(tpl)) sp.push([vx + dx, vy + dy]);
			const unc = ([gx, gy]) => sp.filter(([ax, ay]) => Math.abs(ax - gx) > 1 || Math.abs(ay - gy) > 1).length;
			sp.sort((a, b) => unc(a) - unc(b));
			return sp.find(([gx, gy]) => gx >= 0 && gy >= 0 && gx < W && gy < H && footprintFits(monsterTpl, gx, gy, l, W, H, blocked, true)) || null;
		};
		let rankOrder = null, rankNext = 0;
		const postPileGuard = (guard, pile = null) => {
			if (thin()) return;
			if (process.env.VMAPGEN_PILE_TRACE) console.error(`[pile]   guard level ${guard.level} strength ${guard.strength}`);
			let done = false;
			// the guard stands by what its pile is worth most in: an artifact pile's guard by an artifact, a
			// Pandora's box's by a box (our objects are not clustered into piles, so the nearest thing to the engine's
			// pile is the placed object of the pile's dearest kind); with none left, by the next in the ranking
			if (SEAL_POCKETS) {
				// dearest unguarded object first (POCKET_RANK), the pile's guard on its entrance
				if (!rankOrder) rankOrder = byPiles.map((g, j) => j).sort((x, y) => (POCKET_RANK[byPiles[x].entry.type] || 50) - (POCKET_RANK[byPiles[y].entry.type] || 50));
				// of the next SEAL_LOOK candidates in that order, the one whose pocket closes tightest (fewest wall
				// tiles left open, sealLeaks): the engine places a pile where its border can close, and ours, placed
				// first and guarded after, left 0.72 of its high loot open (Coldshadow's Fantasy, tools/mapsight
				// score 2026-10-01). VMAPGEN_SEAL_LOOK=1 is the plain rank order.
				while (!done) {
					const cand = [];
					// candidates of the first one's rank only: a leaky dwelling lost to cheaper loot in the window every
					// time and was left unguarded when the guards ran out (0.21 of dwellings, against the engine's 0.06;
					// VMAPGEN_SEAL_SAME_RANK=0 mixes ranks as before)
					const rankOf = j => POCKET_RANK[byPiles[j].entry.type] || 50;
					let firstRank = null;
					for (let q = rankNext; q < rankOrder.length && cand.length < SEAL_LOOK; q++) {
						const j = rankOrder[q];
						if (usedTarget.has(j) || pocketed.has(byPiles[j].entry)) continue;
						if (firstRank === null) firstRank = rankOf(j);
						else if (process.env.VMAPGEN_SEAL_SAME_RANK !== '0' && rankOf(j) !== firstRank) break;
						cand.push(j);
					}
					if (!cand.length) break;
					let pick = cand[0];
					if (cand.length > 1) {
						let best = Infinity;
						for (const j of cand) {
							const s = spotFor(byPiles[j]);
							if (!s) continue;
							const n = sealLeaks(sealPlan(byPiles[j].entry, s[0], s[1]));
							if (n < best) { best = n; pick = j; if (!n) break; }
						}
					}
					usedTarget.add(pick);
					if (SEAL_RESITE) resite(byPiles[pick], spotFor);
					while (rankNext < rankOrder.length && (usedTarget.has(rankOrder[rankNext]) || pocketed.has(byPiles[rankOrder[rankNext]].entry))) rankNext++;
					done = postGuard(byPiles[pick], guard, true, SEAL_GATHER ? Math.min(3, pile && pile.objects ? pile.objects.length - 1 : 0) : 0);
				}
			} else {
				const top = pile && pile.objects && pile.objects.length ? pile.objects.reduce((a, o) => (o.value > a.value ? o : a)) : null;
				if (top) {
					const k = byPiles.findIndex((g, j) => !usedTarget.has(j) && g.entry.type === top.type);
					if (k >= 0) { usedTarget.add(k); done = postGuard(byPiles[k], guard, true); }
				}
				while (!done && next < byPiles.length) {
					if (usedTarget.has(next)) { next++; continue; }
					usedTarget.add(next);
					done = postGuard(byPiles[next++], guard, true);
				}
			}
			// more guarded piles than objects to stand by: the guard is dropped, as the engine drops a pile no tile takes. It used to stand
			// anywhere in the zone, beside nothing (cloud Brief I fix 1, 2026-10-09: the one source of stacks that close nothing by construction)
			if (!done) { objectPools.__pileGuardDropped = (objectPools.__pileGuardDropped || 0) + 1; }
			if (done) { posted++; crowd(guard.level); }
			else if (process.env.VMAPGEN_PILE_TRACE) console.error(`[pile]   guard level ${guard.level} DROPPED: no cell`);
		};
		if (pileSim) {
			// the engine's piles (VMAPGEN_TPL_PILE_MODEL=engine, above): each
			// landed pile's guard, sized on what that pile is worth
			// a prison stands behind its own pile's guard first, so the guard rises with the prison's tier
			const guardDone = new Set();
			for (const [e, pl] of prisonPile) {
				if (!pl.guard || guardDone.has(pl)) { if (process.env.VMAPGEN_PRISON_TRACE) console.error(`[prison] (${e.x},${e.y}) exp ${(e.options && e.options.experience) || 0}: ${pl.guard ? "pile guard used" : "pile has no guard"}`); continue; }
				const j = byPiles.findIndex(g => g.entry === e);
				if (j < 0 || usedTarget.has(j)) continue;
				if (thin()) { guardDone.add(pl); continue; }
				usedTarget.add(j);
				const okP = postGuard(byPiles[j], pl.guard, true);
				if (process.env.VMAPGEN_PRISON_TRACE) console.error(`[prison] (${e.x},${e.y}) L${l} exp ${(e.options && e.options.experience) || 0} walled ${!!e.__walled} guard ${pl.guard ? pl.guard.strength : 0}: ${okP ? "posted" : "NOT posted"}`);
				if (okP) { guardDone.add(pl); posted++; crowd(pl.guard.level); }
			}
			for (const pl of pileSim.landed) if (pl.guard && !guardDone.has(pl)) postPileGuard(pl.guard, pl);
			if (SEAL_TRACE && zoneMeta.spec) {
				const dw = byPiles.filter(g => /^creatureGenerator/.test(g.entry.type)).length;
				const dwDone = byPiles.filter(g => /^creatureGenerator/.test(g.entry.type) && pocketed.has(g.entry)).length;
				SEAL_TRACE['zone ' + zoneMeta.spec.id + ' guards/dwellings/dwellings pocketed'] = `${pileSim.landed.filter(x => x.guard).length}/${dw}/${dwDone}`;
			}
			// Every valuable pile the engine's pile count left unguarded gets its own guard and pocket, as the engine guards each
			// pile worth more than minGuardedValue and lays it only where it closes (TreasurePlacer). Ours ran out of pile guards
			// before the dear loot was all covered, and guardhigh.js then stood a guard beside the rest with no wall: on K's 252
			// underground 199 high piles open beside a guard, the engine's maps 3 to 24 (K, 2026-10-04).
			// Guards on treasure Off: none of these either (MapGen Dev, k13: 5-12% of dear loot kept a guard with Off)
			if (onOff(p.guardTreasure)) for (let j = 0; j < byPiles.length; j++) {
				const g = byPiles[j];
				if (usedTarget.has(j) || pocketed.has(g.entry) || !/^(randomArtifactRelic|randomArtifactMajor|pandoraBox|artifact)$/.test(g.entry.type)) continue;
				if (thin()) continue;
				const guard = zoneGuard(spentValue(g.entry));
				if (!guard) continue;
				usedTarget.add(j);
				if (SEAL_RESITE) resite(g, spotFor);
				if (postGuard(g, guard, true, 0)) { posted++; crowd(guard.level); }
			}
			// The engine's unguarded loot lies in small piles too; ours, laid one by one, was single pickups strewn over
			// the floor (side-by-side crops, Coldshadow underground, 2026-10-02). A loose one-tile pickup with no other
			// pickup within 2 tiles moves beside the nearest loose one of its zone (within 20 tiles), onto a free tile
			// that is no road, apron or other object's way in, and never cuts the zone. VMAPGEN_CLUSTER_LOOSE=0 leaves them.
			if (SEAL_POCKETS && process.env.VMAPGEN_CLUSTER_LOOSE !== '0') {
				const base = l * W * H;
				// valuable piles stay where they were laid walled in for their guard (putLoot); the rest gathers
				const pick = o => oneTile(o) && /^(resource|randomResource|treasureChest|campfire|randomArtifactTreasure)/.test(o.type);
				const loose = out.filter(o => (o.l || 0) === l && pick(o) && !pocketed.has(o) && zoneCellSet.has(o.y * W + o.x));
				for (let i = loose.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; [loose[i], loose[j]] = [loose[j], loose[i]]; }
				const others = new Set();
				for (const o of out) {
					if ((o.l || 0) !== l || !o.template || !o.template.mask || pick(o)) continue;
					const ot = { mask: o.template.mask, visitableFrom: o.template.visitableFrom };
					for (const [vx, vy] of visitableCells(ot, o.x, o.y)) for (const [dx, dy] of allowedDirs(ot)) others.add((vy + dy) * W + vx + dx);
				}
				let clustered = 0;
				for (const o of loose) {
					const near = out.some(q => q !== o && (q.l || 0) === l && pick(q) && Math.max(Math.abs(q.x - o.x), Math.abs(q.y - o.y)) <= 2);
					if (near) continue;
					// a share of the lone ones only: all of them put 0.83 of low loot beside another against the engine's
					// 0.74 (VMAPGEN_CLUSTER_SHARE, default 0.6)
					if (rng() >= Number(process.env.VMAPGEN_CLUSTER_SHARE || 0.6)) continue;
					let tgt = null, td = 21;
					for (const q of loose) { if (q === o) continue; const d = Math.max(Math.abs(q.x - o.x), Math.abs(q.y - o.y)); if (d < td) { td = d; tgt = q; } }
					if (!tgt) continue;
					const old = o.y * W + o.x;
					let moved = false;
					for (let r = 1; r <= 2 && !moved; r++)
						for (let dy = -r; dy <= r && !moved; dy++) for (let dx = -r; dx <= r && !moved; dx++) {
							if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
							const x = tgt.x + dx, y = tgt.y + dy;
							if (x < 2 || y < 2 || x >= W - 2 || y >= H - 2) continue;
							const c = y * W + x;
							if (c === old || !zoneCellSet.has(c) || others.has(c)) continue;
							if (blocked[base + c] & (OCCUPIED | RESERVED)) continue;
							blocked[base + old] &= ~OCCUPIED;
							if (connectivity) connectivity.refresh();
							if (connectivity && !connectivity.accepts([c])) { blocked[base + old] |= OCCUPIED; if (connectivity) connectivity.refresh(); continue; }
							blocked[base + c] |= OCCUPIED;
							if (connectivity) connectivity.refresh();
							markApproach(o.template, x, y, l, W, H, blocked);
							o.x = x; o.y = y;
							const fi = free.indexOf(c); if (fi >= 0) free.splice(fi, 1);
							free.push(old);
							moved = true; clustered++;
						}
				}
				if (SEAL_TRACE) SEAL_TRACE['loose pickups clustered'] = (SEAL_TRACE['loose pickups clustered'] || 0) + clustered;
			}
		} else {
			// VMAPGEN_TPL_PILE_VALUES=engine: each pile sized on what a pile the
			// engine builds in that band is worth (piles.js preparePile: objects
			// drawn until the value drawn is spent, an even chance to stop once
			// past the band's floor), which sits low in the band, where the
			// uniform draw spreads evenly across it (B4: the engine's piles of
			// 3000-6000 guarded 31%, the even draw 61%)
			const valuePool = TPL_PILE_VALUES === 'engine' && objectPools.pileCommon ? makePilePool() : null;
			for (const { band: t, count, d, byDensity, byRoom } of templatePiles(bands, cells.length, (zoneMeta && zoneMeta.richScale) || 1)) {
				if (process.env.VMAPGEN_PILE_TRACE)
					console.error(`[pile] zone ${zoneMeta.spec.id} band ${t.min}-${t.max} density ${t.density}: cells ${cells.length}, d ${d.toFixed(1)}, by density ${byDensity}, by room ${byRoom}, placing ${count}`);
				for (let k = count; k > 0; k--) {
					const v = valuePool ? preparePile(valuePool, t, rng).value : t.min + Math.floor(rng() * (t.max - t.min + 1));
					if (!(v > 0)) continue;
					const guard = zoneGuard(v);
					if (guard) postPileGuard(guard);
				}
			}
		}
	} else {
		// the richest loot first: each relic, major artifact and Pandora's box is guarded at the real maps' rate
		const guardedHere = new Set();
		if (process.env.VMAPGEN_HIGH_LOOT_GUARD !== '0')
			for (const g of ranked) {
				const share = HIGH_LOOT_GUARDED[g.entry.type];
				if (!share || guardContextWeight(g.entry.type, p) <= 0) continue;
				if (rng() < Math.min(1, share * guardContextWeight(g.entry.type, p)) && postGuard(g)) { posted++; guardedHere.add(g); }
			}
		for (const g of ranked) {
			if (posted >= wantGuards) break;
			if (guardedHere.has(g)) continue;
			if (postGuard(g)) posted++;
		}
		// whatever the guard pass could not place still roams, so the monster
		// count stays on the calibrated budget
		// K, 2026-09-30: "high tier monsters standing by serving no purpose". A real map's monster of level 5 to 7
		// stands on the approach to something 97% of the time; ours roamed at 82%. What roams is a low tier.
		for (let i = guardBudget - posted; i > 0; i--) {
			const tier = process.env.VMAPGEN_ROAM_CAP === '0' ? creepTier(cls, rng, monsterShift) : Math.min(4, creepTier(cls, rng, monsterShift));
			put(`randomMonsterLevel${tier}`, monsterTpl, monsterOptions(tier, p, rng));
		}
	}

	// Settle pass: cap the deep notches and one-cell pinches the accretion
	// leaves behind. A free cell boxed in on most sides, or sitting in the
	// one-cell gap between two masses, can never be part of a free 2x2, so
	// it counts against roominess without giving anyone room to move. A
	// single-cell feature there turns dead ground into mass, which raises
	// the blocked share and the roomy share at once - measured on 72x72 the
	// notches outnumbered the corridor pinches four to one, so the notches
	// are where the roominess lives.
	if (p.decorDensity > 0) {
		const nb = (x, y) => {
			let n = 0;
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					if (!dx && !dy) continue;
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					if (blocked[l * W * H + ny * W + nx] & OCCUPIED) n++;
				}
			return n;
		};
		// A free cell is roomy exactly when it sits in a free 2x2, which is
		// the metric the corpus is graded by. The settle fills the ones that
		// fail every 2x2 they belong to: mass-edge scallops, pocket mouths,
		// corridor pinches. nb thresholds the fill to cells sharing a face
		// with a mass, so isolated singles are never manufactured.
		const base = l * W * H;
		const occ = i => !!(blocked[base + i] & OCCUPIED);
		const unroomy = (x, y) => {
			for (const [dx, dy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) {
				const ox = x + dx, oy = y + dy;
				if (ox < 0 || oy < 0 || ox + 1 >= W || oy + 1 >= H) continue;
				const i0 = oy * W + ox;
				if (!occ(i0) && !occ(i0 + 1) && !occ(i0 + W) && !occ(i0 + W + 1))
					return false;
			}
			return true;
		};
		/*
		 * A pocket fill is only safe if the cell is not a bridge: the
		 * connectivity guard defends the MAIN region, but a cell that is the
		 * last pinch into a side pocket loses nothing the guard can see -
		 * filling it seals the pocket. Four seeds came back with players
		 * islanded that way. Local test instead: the free cells adjacent to
		 * the candidate must still reach each other within a small window
		 * once it is removed. Bounded BFS over a 7x7 window, candidate
		 * excluded.
		 */
		const bridgeFree = fill => {
			const excl = new Set(fill);
			let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
			for (const i of fill) {
				const x = i % W, y = (i / W) | 0;
				if (x < x0) x0 = x; if (x > x1) x1 = x;
				if (y < y0) y0 = y; if (y > y1) y1 = y;
			}
			const freeNb = [];
			for (const i of fill) {
				const cx = i % W, cy = (i / W) | 0;
				for (let dy = -1; dy <= 1; dy++)
					for (let dx = -1; dx <= 1; dx++) {
						if (!dx && !dy) continue;
						const nx = cx + dx, ny = cy + dy;
						if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
						const n = ny * W + nx;
						if (excl.has(n)) continue;
						if (!(blocked[base + n] & OCCUPIED)) freeNb.push(n);
					}
			}
			if (freeNb.length < 2) return true;   // dead end, never a bridge
			const want = new Set(freeNb);
			const st = [freeNb[0]];
			want.delete(freeNb[0]);
			while (st.length && want.size) {
				const c = st.pop(), x = c % W, y = (c / W) | 0;
				for (let dy = -1; dy <= 1; dy++)
					for (let dx = -1; dx <= 1; dx++) {
						if (!dx && !dy) continue;
						const nx = x + dx, ny = y + dy;
						// the window keeps the walk local: a corridor that
						// loops around a mass end reconnects further out and
						// reads as a bridge here, which errs toward not
						// filling rather than toward sealing
						if (nx < x0 - 3 || nx > x1 + 3
								|| ny < y0 - 3 || ny > y1 + 3)
							continue;
						if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
						const n = ny * W + nx;
						if (excl.has(n)) continue;
						if (blocked[base + n] & OCCUPIED) continue;
						if (want.delete(n)) st.push(n);
					}
			}
			return want.size === 0;
		};
		let settled = 0, welds = 0;
		// Weld fills merge two masses, which is corpus-true but unbounded
		// merging ran one seed to 29 components and a largest share at the
		// super-mass ceiling. A small budget keeps the mergers it pays for.
		const weldCap = Math.max(1, Math.round(area * 0.0015));
		// One sweep leaves new notches where a fill boxes in its neighbour, so
		// run it to a fixpoint; later passes take the shallower pockets the
		// first pass exposed. The cap is loose on purpose: the pass can only
		// ever fire on cells that are already non-roomy, so its ceiling is the
		// pocket supply, not this number - the corpus fills these notches to
		// ~80% roomy while we were leaving ~200 of them open per map.
		// Tried 0.03 against the decor census skew (shrub 4x / flowers 6x /
		// grassHills 4.4x corpus): the skew did not move but roominess fell
		// to 66.8% against the corpus's 83.3. The small-piece overshoot is
		// the price of filling the notches; it is the item-4 fringe, not a
		// rate to tune here.
		const settleCap = Math.max(1, Math.round(area * 0.05));
		for (let pass = 0; pass < 3 && settled < settleCap; pass++) {
			const need = pass === 0 ? 4 : pass === 1 ? 3 : 2;
			let any = false;
			// ascending: the domino pair looks RIGHT, and the right cell must
			// still be unfilled when the left one is visited
			for (let k = 0; k < cells.length && settled < settleCap; k++) {
				const i = cells[k];
				if (blocked[base + i]) continue;   // any flag: occupied/reserved/approach
				// no reachable check: the pockets this pass exists for are
				// the sealed ones - a notch walled off from the hero is still
				// dead ground that reads as mass once filled, and the corpus
				// fills them. connectivity.accepts below proves the fill
				// cannot cut anything else off.
				// (functional objects keep their reachable checks - a chest
				// nobody can reach is a different matter.)
				const x = i % W, y = (i / W) | 0;
				if (!unroomy(x, y)) { if (fillStat) fillStat.settleRoomy = (fillStat.settleRoomy || 0) + 1; continue; }
				if (nb(x, y) < need) { if (fillStat) fillStat.settleNb = (fillStat.settleNb || 0) + 1; continue; }
				// Pair the fill with the pocket cell to its right when one
				// fits: the corpus spends a nook as a 2-cell domino, we were
				// spending two singles. All the gates run on the pair as one
				// fill, since two independent bridge checks cannot see that
				// filling both halves of a two-wide corridor seals it.
				const nx = x + 1;
				const jr = (nx < W && !(blocked[base + y * W + nx]))
					? y * W + nx : -1;
				if (jr >= 0 && unroomy(nx, y) && nb(nx, y) >= need) {
					const d = dominoTemplate(terrain, rng);
					if (d) {
						const ax = nx + (d.anchorDx || 0), ay = y + (d.anchorDy || 0);
						const own = blockingCells(d.tpl, ax, ay)
							.map(([a, b]) => b * W + a);
						const isWeld = weldsMasses([i, jr], blocked, l, W, H, 2);
						if (own.length === 2
								&& own.includes(i) && own.includes(jr)
								&& (!isWeld || welds < weldCap)
								&& footprintFits(d.tpl, ax, ay, l, W, H, blocked)
								&& bridgeFree([i, jr])
								&& (!connectivity || connectivity.accepts([i, jr]))) {
							if (isWeld) welds++;
							out.push(objectEntry(d.type, ax, ay, l, d.tpl,
								undefined, d.subtype));
							footprintBlock(d.tpl, ax, ay, l, W, H, blocked);
							if (connectivity) connectivity.refresh();
							settled += 2; any = true;
							continue;
						}
					}
				}
				// 5c experiment: a notch is often an L - this cell plus the
				// two open cells diagonally adjacent through it. Spend one
				// L-tromino on the lot instead of up to three singles. Only
				// cells that already fail roomy join the fill, and every
				// gate that guards a single guards the piece as one unit -
				// bridgeFree on the whole set, weldCap on the weld test.
				if (process.env.VMAPGEN_TROMINO) {
					let done = false;
					for (const [bx, by] of [[x, y], [x - 1, y],
							[x, y - 1], [x - 1, y - 1]]) {
						if (done || bx < 0 || by < 0
								|| bx + 1 >= W || by + 1 >= H) continue;
						const box = [by * W + bx, by * W + bx + 1,
							(by + 1) * W + bx, (by + 1) * W + bx + 1];
						const fill = box.filter(k => k === i
							|| (!blocked[base + k]
								&& unroomy(k % W, (k / W) | 0)));
						if (fill.length < 3 || !fill.includes(i)) continue;
						for (let t = 0; t < 6 && !done; t++) {
							const d = trominoTemplate(terrain, rng);
							if (!d) break;
							// try anchoring each blocking cell on each fill
							// target; keep the piece only when every cell
							// lands inside the box's open notches. Anchor is
							// bottom-right of the mask and rows may differ in
							// length: mask cell (j,row) lands at
							// (ax - (rowLen-1-j), ay - (maskH-1-row)).
							const mh = d.tpl.mask.length;
							const bc = [];
							d.tpl.mask.forEach((row, r) =>
								String(row).split('').forEach((ch, j) => {
									if ('BHAT'.includes(ch))
										bc.push([j, r, String(row).length]);
								}));
							for (const tgt of fill) {
								if (done) break;
								const tx = tgt % W, ty = (tgt / W) | 0;
								for (const [bj, br, rl] of bc) {
									const ax = tx + (rl - 1 - bj),
										ay = ty + (mh - 1 - br);
									const own = blockingCells(d.tpl, ax, ay)
										.map(([a, b]) => b * W + a);
									if (own.length < 2 || !own.includes(i)
											|| !own.every(k => fill.includes(k)))
										continue;
									const isWeld = weldsMasses(own, blocked,
										l, W, H, 2);
									if (isWeld && welds >= weldCap) continue;
									if (!footprintFits(d.tpl, ax, ay,
											l, W, H, blocked)) continue;
									if (!bridgeFree(own)) continue;
									if (connectivity
											&& !connectivity.accepts(own))
										continue;
									if (isWeld) welds++;
									out.push(objectEntry(d.type, ax, ay, l,
										d.tpl, undefined, d.subtype));
									footprintBlock(d.tpl, ax, ay, l, W, H,
										blocked);
									if (connectivity) connectivity.refresh();
									settled += own.length;
									any = true; done = true;
									break;
								}
							}
						}
					}
					if (done) continue;
				}
				// The lone pebble is the item-4 fringe: before spending a
				// one-cell object, try a domino/L piece whose OTHER cells
				// are all already blocked - the notch merges into the mass
				// edge it sits against instead of reading as a lone rock on
				// open ground. Only `i` is newly blocked, so the single's
				// own gates (bridge, connectivity, weld cap) still apply.
				// Overlapping blocking cells is legal: 28% of every corpus
				// mask cell is covered by more than one object.
				let merged = false;
				for (let t = 0; t < 8 && !merged; t++) {
					const m = mergedTemplate(terrain, rng);
					if (!m) break;
					const mh = m.tpl.mask.length;
					for (const [bj, br, rl] of m.cells) {
						const ax = x + (rl - 1 - bj), ay = y + (mh - 1 - br);
						const own = blockingCells(m.tpl, ax, ay);
						let ok = own.length >= 2, saw = false;
						for (const [cx, cy] of own) {
							const ci = cy * W + cx;
							if (ci === i) { saw = true; continue; }
							if (cx < 0 || cy < 0 || cx >= W || cy >= H
									|| !(blocked[base + ci] & OCCUPIED)
									|| (blocked[base + ci]
										& (RESERVED | APPROACH))) {
								ok = false; break;
							}
						}
						if (!ok || !saw) continue;
						if (!bridgeFree([i])) continue;
						if (connectivity && !connectivity.accepts([i])) continue;
						const isWeld = weldsMasses([i], blocked, l, W, H, 2);
						if (isWeld && welds >= weldCap) continue;
						if (isWeld) welds++;
						out.push(objectEntry(m.type, ax, ay, l, m.tpl,
							undefined, m.subtype));
						footprintBlock(m.tpl, ax, ay, l, W, H, blocked);
						if (connectivity) connectivity.refresh();
						settled++; any = true; merged = true;
						break;
					}
				}
				if (merged) continue;
				const s = singleTemplate(terrain, rng);
				if (!s) break;
				if (!footprintFits(s.tpl, x, y, l, W, H, blocked)) { if (fillStat) fillStat.settleFits = (fillStat.settleFits || 0) + 1; continue; }
				if (!bridgeFree([i])) { if (fillStat) fillStat.settleBridge = (fillStat.settleBridge || 0) + 1; continue; }
				if (connectivity && !connectivity.accepts([i])) { if (fillStat) fillStat.settleConn = (fillStat.settleConn || 0) + 1; continue; }
				// A notch fill that touches two masses welds them - and a
				// pocket deep enough to sit between two masses is exactly
				// where the corpus welds (its packs merge freely). Bounded by
				// weldCap so a wall of pocket fills cannot collapse the mass
				// count on one seed.
				if (weldsMasses([i], blocked, l, W, H, 2)) {
					if (welds >= weldCap) { if (fillStat) fillStat.settleWeld = (fillStat.settleWeld || 0) + 1; continue; }
					welds++;
				}
				out.push(objectEntry(s.type, x, y, l, s.tpl, undefined, s.subtype));
				footprintBlock(s.tpl, x, y, l, W, H, blocked);
				if (connectivity) connectivity.refresh();
				settled++; any = true;
			}
			if (!any) break;
		}
		if (DECOR_TRACE && settled)
			console.error(`[decor] l${l} settled ${settled} notch/pinch cell(s)`);
	}

	// Cave scenery. A carved level gets no border walls, packs or ridge
	// marks, so its floor carried 1.4% scenery against the corpus's 14.5%.
	// The engine turns blocked cave ground into rock terrain and covers what
	// is left beside it with small obstacles (RockPlacer.cpp, ObstaclePlacer):
	// corpus cave pieces average 3.1 cells and sit against the rock. Grow
	// pieces from cells touching the wall until the zone's floor carries that
	// share. Each piece is anchored so one of its blocking cells lands on a
	// floor cell touching the rock, stays inside the zone, keeps the open
	// ground around it in one piece locally and passes the connectivity
	// guard, so no piece can close a tunnel. put()'s mass-weld rule is not
	// used here: it keeps surface masses apart, but in a 2-4 cell tunnel a
	// piece on one wall is always within two cells of the other, and it held
	// the first version of this pass to 4.6%. The retile pass re-arts the
	// result with the zone's own obstacle sets.
	if (openMask && p.decorDensity > 0) {
		const base = l * W * H;
		const inZone = new Set(cells);
		const isBlk = c => (blocked[base + c] & OCCUPIED) !== 0;
		let have = 0;
		for (const o of out)
			if (DECOR_TYPE_SET.has(o.type) && o.template)
				have += blockingCells(o.template, o.x, o.y).length;
		let want = Math.round(area * DECOR_BLOCKED_SHARE_UNDERGROUND) - have;
		const touchesWall = i => {
			const x = i % W, y = (i / W) | 0;
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					if (!dx && !dy) continue;
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) return true;
					if (isBlk(ny * W + nx)) return true;
				}
			return false;
		};
		// the open cells around the piece must stay one piece within two
		// cells of it, so a piece never pinches a tunnel shut locally
		const localOk = own => {
			const excl = new Set(own);
			let x0 = W, y0 = H, x1 = -1, y1 = -1;
			const nb = [];
			for (const k of own) {
				const kx = k % W, ky = (k / W) | 0;
				x0 = Math.min(x0, kx - 2); y0 = Math.min(y0, ky - 2);
				x1 = Math.max(x1, kx + 2); y1 = Math.max(y1, ky + 2);
				for (let dy = -1; dy <= 1; dy++)
					for (let dx = -1; dx <= 1; dx++) {
						const nx = kx + dx, ny = ky + dy;
						if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
						const n = ny * W + nx;
						if (!excl.has(n) && !isBlk(n)) nb.push(n);
					}
			}
			if (nb.length < 2) return true;
			const want2 = new Set(nb), seen = new Set([nb[0]]), st = [nb[0]];
			want2.delete(nb[0]);
			while (st.length && want2.size) {
				const c = st.pop(), cx = c % W, cy = (c / W) | 0;
				for (let dy = -1; dy <= 1; dy++)
					for (let dx = -1; dx <= 1; dx++) {
						const nx = cx + dx, ny = cy + dy;
						if (nx < x0 || ny < y0 || nx > x1 || ny > y1) continue;
						if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
						const n = ny * W + nx;
						if (seen.has(n) || excl.has(n) || isBlk(n)) continue;
						seen.add(n); want2.delete(n); st.push(n);
					}
			}
			return want2.size === 0;
		};
		// Notches first: a floor cell with many blocked neighbours is ground
		// no hero crosses anyway, and filling it keeps the cave roomy where a
		// piece standing out into a tunnel would narrow it. Draws favour the
		// most-enclosed wall cells, re-ranked as the rock line moves.
		const enclosure = i => {
			const x = i % W, y = (i / W) | 0;
			let n = 0;
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					if (!dx && !dy) continue;
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H || isBlk(ny * W + nx)) n++;
				}
			return n;
		};
		const rank = list => list.map(i => [i, enclosure(i) + rng() * 2])
			.sort((a, b) => b[1] - a[1]).map(e => e[0]);
		let wall = rank(cells.filter(i => !isBlk(i) && touchesWall(i)));
		let miss = 0, placed = 0;
		while (want > 0 && miss < 80 && wall.length) {
			const i = wall[Math.min(wall.length - 1, (rng() * rng() * wall.length) | 0)];
			const c = rng() < Number(process.env.VMAPGEN_CAVE_SINGLE_SHARE ?? 0.3) ? singleTemplate(terrain, rng) : clusterTemplate(terrain, rng);
			if (!c) break;
			const offs = blockingCells(c.tpl, 0, 0);
			for (let k = offs.length - 1; k > 0; k--) {
				const j = (rng() * (k + 1)) | 0;
				const t = offs[k]; offs[k] = offs[j]; offs[j] = t;
			}
			let done = false;
			for (const [ox, oy] of offs) {
				const ax = (i % W) - ox, ay = ((i / W) | 0) - oy;
				if (ax < 0 || ay < 0 || ax >= W || ay >= H) continue;
				const raw = blockingCells(c.tpl, ax, ay);
				if (raw.some(([a, b]) => a < 0 || b < 0 || a >= W || b >= H)) continue;
				const own = raw.map(([a, b]) => b * W + a);
				if (!own.every(k => inZone.has(k))) continue;
				if (!footprintFits(c.tpl, ax, ay, l, W, H, blocked)) continue;
				if (!localOk(own)) continue;
				if (connectivity && !connectivity.accepts(own)) continue;
				out.push(objectEntry(c.type, ax, ay, l, c.tpl, undefined, c.subtype));
				footprintBlock(c.tpl, ax, ay, l, W, H, blocked);
				if (connectivity) connectivity.refresh();
				want -= own.length;
				placed++; done = true;
				break;
			}
			if (done) {
				miss = 0;
				if (placed % 8 === 0)
					wall = rank(cells.filter(k => !isBlk(k) && touchesWall(k)));
			} else miss++;
		}
		if (DECOR_TRACE)
			console.error(`[decor] l${l} cave scenery: ${placed} piece(s), ${Math.max(0, want)} cell(s) short`);
	}

	if (fillStat)
		console.error(`[fill] l${l} ${cls} ${JSON.stringify(fillStat)}`);

	// Budget honesty: report what the zone actually spent against what its
	// class asked for. A zone too small or too crowded for its budget used
	// to under-place silently, which is how the far-field gradient stayed
	// flat while looking tuned.
	if (BUDGET_TRACE) {
		const target = (zoneMeta ? null
			: (CLASS_VALUE_CELL[cls] || CLASS_VALUE_CELL[BIOME_CLASS.STANDARD]))
			* area;
		let spent = 0;
		for (const o of out) spent += spentValue(o);
		if (target)
			console.error(`[budget] l${l} ${cls} cells=${area} `
				+ `target=${Math.round(target)} spent=${Math.round(spent)} `
				+ `(${Math.round(spent / target * 100)}%)`);
	}

	return out;
}

module.exports = {
	GUARD_GAP, fillBiome, FILL_TYPES, CLASS_FILL, pickArtifactTier,
	footprintCells, blockingCells, footprintFits, footprintBlock, visitableCells,
	entranceOpen, pictureOnShadow, markShadow, shadowAt, reserveCell, makeConnectivityGuard, floodFrom, OCCUPIED, RESERVED,
	APPROACH, allowedDirs, markApproach, weldsMasses, REMOVABLE_TYPES, MONSTER_OPTIONS,
	monsterOptions, scaledAmount, STACK_RANGE,
	sliverCount, engineGuard, lootGuard, scaledLinkGuard, zoneGuardPool, nearestLevelDwelling, creepTier, reachOnReserved };
