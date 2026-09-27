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
	pandoraOptions, prisonOptions, makePrisonHeroPool,
	UTIL_POOL, pickUtil, DWELLING_POOL, pickDwelling, PILE_KINDS, seerHutOptions,
	SEER_ARTIFACTS, emptyRewardable,
} = require('./economy');
const { zoneTownTypes, townTemplate, townMods } = require('./zoneTowns');
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

/*
 * Cave content density. Measured 2026-09-24 per floor cell of carved levels
 * (vmap_leveldensity.js, LEVEL 1, 71-map corpus vs 29-map sweep): functional
 * objects block 24.5% of our cave floor against the corpus's 18.6%, while
 * scenery blocks 1.4% against 14.5%. The fill's per-1000-cell rates were
 * tuned on the surface; a cave spends them on a third of the ground.
 */
const CAVE_CONTENT_SCALE = 18.6 / 24.5;
const { MINE_SUBTYPE } = require('../rmg/template');

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
/**
 * The treasure piles a template zone lands, band by band, richest first, as
 * TreasurePlacer::createTreasures asks for them: floor(tiles * density / 400)
 * a band, as many as fit at the band's spacing (see the guard pass for the
 * squared reading), times the share the engine actually lands.
 * Returns [{ band, want, count }] in that order.
 */
function templatePiles(bands, cellCount) {
	const linearRoom = process.env.VMAPGEN_PILE_ROOM === 'linear';
	const out = [];
	let totalDensity = 0;
	for (const t of [...(bands || [])].sort((a, b) => b.max - a.max)) {
		totalDensity += t.density || 0;
		if (!totalDensity) continue;
		const minDistance = Math.max(1, Math.sqrt(Math.min(t.min, 30000) / 10 / totalDensity));
		const d = linearRoom ? minDistance : Math.sqrt(minDistance);
		const byDensity = Math.floor(cellCount * (t.density || 0) / 400);
		const byRoom = Math.floor(cellCount / (d * d));
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
// The same for a template zone's dwellings in the engine model
// (VMAPGEN_TPL_DWELL_MODEL=engine, fillBiome): everything else a pile could
// take, against the odds of the zone's own dwellings its band admits.
const TPL_DWELL_K = Number(process.env.VMAPGEN_TPL_DWELL_K) || 4;
// Free layout only: the bank and dwelling rates were calibrated while the
// stranded sweep still dropped everything behind a pickup or a guard (19-31
// objects a 108x108 map). With that fixed (2026-09-26) the free-layout lens
// read banks 1.19 and dwellings 1.18 of the corpus, so both come down by that
// much; template maps take their counts from the zone and stay as they were.
const FREE_BANK_SCALE = Number(process.env.VMAPGEN_FREE_BANK_SCALE) || 0.84;
const FREE_DWELL_SCALE = Number(process.env.VMAPGEN_FREE_DWELL_SCALE) || 0.85;
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
};

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

function pickArtifactTier(richness, rng, zd = 0) {
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
		0.65 * (1 + zd * 0.2),                    // major
		0.10 + richness * 0.05 + zd * 0.20,       // relic, rare near home
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
function entranceOpen(tpl, x, y, l, W, H, blocked, reachable) {
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
			const c = ny * W + nx;
			if (own.has(c)) continue;                  // its own walls do not count
			if (blocked[l * W * H + c] & OCCUPIED) continue;
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

function reserveCell(blocked, l, W, H, cell) {
	if (cell >= 0 && cell < W * H) blocked[l * W * H + cell] |= RESERVED;
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
			const after = floodFrom(blocked, l, W, H, pickSeed(), scratch);
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
			seedCell = pickSeed();
			count = floodFrom(blocked, l, W, H, seedCell, flags);
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
function footprintFits(tpl, x, y, l, W, H, blocked, soft = false) {
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
function fillBiome(cls, cells, blocked, W, H, l, rng, params, towns = [], players = [], objectPools = {}, terrain = 'gr', reachable = null, connectivity = null, zoneMeta = null, openMask = null, zoneDist = null) {
	const p = { ...BIOME_DEFAULTS, ...params };
	// A template zone overrides the free-running densities: its treasure bands
	// become a loot multiplier and its monsters field a guard one. Both are
	// already resolved by the caller against the template's own median.
	if (zoneMeta) {
		p.resourceDensity *= zoneMeta.loot;
		p.pickupDensity   *= zoneMeta.loot;
		p.artifactDensity *= zoneMeta.loot;
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
	const put = (type, tpl, opts, subtype, tryBudget = 32, pickFrom = null,
			noEdge = false) => {
		const sliverBind = SLIVER_RULE
			&& rng() < (SLIVER_SHARE[sliverClass(type)] || 0);
		for (let tries = 0; tries < tryBudget && free.length; tries++) {
			const usePick = pickFrom && pickFrom.length && tries < tryBudget - 4;
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
			if (!footprintFits(tpl, x, y, l, W, H, blocked,
					REMOVABLE_TYPES.has(type))) { rej('fits'); continue; }
			// An object whose entrance has no open ground beside it is
			// scenery. Checking here rather than after the fact keeps the
			// count honest: the object is simply placed somewhere else.
			if (!entranceOpen(tpl, x, y, l, W, H, blocked, reachable)) { rej('entrance'); continue; }
			const walls = blockingCells(tpl, x, y).map(([a, b]) => b * W + a);
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
			if (connectivity) connectivity.refresh();
			if (GUARD_CHANCE[type]) guardable.push({ entry, tpl });
			return entry;
		}
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
				if (!put('mine', mt, undefined, subtype, 48, earlyEdge)
						&& !put('mine', mt, undefined, subtype, 40, fitAnchors(mt), true))
					missed++;
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
			put('mine', mineTemplate(subtype, terrain), undefined, subtype, 48, earlyEdge);
		}
	}


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
	for (let i = rare(fill.utils); i > 0; i--) {
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
	for (let i = Math.round(scale * fill.bonuses * p.bonusDensity); i > 0; i--) {
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
					: (o.type === 'crypt' || o.type === 'redwoodObservatory')
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
		[BIOME_CLASS.HIGH_LOOT]: [4, 7],
		[BIOME_CLASS.STANDARD]:  [2, 5],
		[BIOME_CLASS.LOW_LOOT]:  [1, 4],
	};
	const [tierLo, tierHi] = TIER_BANDS[cls] || TIER_BANDS[BIOME_CLASS.STANDARD];

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
	// VMAPGEN_TPL_DWELL_MODEL=engine: a template zone's dwellings as the engine's
	// treasure piles draw them (TreasurePlacer::addDwellings). Only the
	// dwellings of the zone's own town type compete (neutral creatures' in a
	// neutral zone), each priced at its rmg value, or its creature's AI value x
	// growth, times 1 + native zones / all zones + native zones / 2, at its
	// rarity or 40; one priced by rmg above the zone's richest band is left out.
	// A pile of a band holds one at Zd / (Zd + TPL_DWELL_K), Zd the odds the
	// band admits (a pile of desired value D takes D/4 to D, economy.js
	// bandEligibility), and which one by those odds.
	let dwellPicks = null;
	if (zoneMeta && zoneMeta.spec && process.env.VMAPGEN_TPL_DWELL_MODEL === 'engine'
			&& objectPools.engineDwellings && objectPools.engineDwellings.length) {
		const bands = zoneMeta.spec.treasure || [];
		const maxV = bands.reduce((a, b) => Math.max(a, b.max || 0), 0);
		const mod = 1 + (zoneMeta.nativeZones || 1) / (zoneMeta.totalZones || 1) + (zoneMeta.nativeZones || 1) / 2;
		const own = objectPools.engineDwellings
			.filter(d => d.faction === (zoneMeta.faction || 'neutral') && !(d.fromRmg && d.value > maxV))
			.map(d => ({ d, v: d.value * mod, odds: d.prob / 100 }));
		dwellPicks = [];
		for (const { band, count } of own.length ? templatePiles(bands, cells.length) : []) {
			const w = own.map(x => x.odds * bandEligibility(x.v, band));
			const Z = w.reduce((a, b) => a + b, 0);
			if (!(Z > 0)) continue;
			const e = count * Z / (Z + TPL_DWELL_K);
			for (let n = Math.floor(e) + (rng() < e % 1 ? 1 : 0); n > 0; n--) {
				let r = rng() * Z, k = 0;
				while (k < w.length - 1 && (r -= w[k]) > 0) k++;
				dwellPicks.push(own[k].d);
			}
		}
	}
	const dwellExpect = scale * fill.dwellings * p.dwellingDensity
		* dwellPoolWeight / CORE_DWELLING_WEIGHT * (zoneMeta ? 1 : FREE_DWELL_SCALE);
	const dwellCount = dwellPicks ? dwellPicks.length
		: Math.floor(dwellExpect) + (rng() < dwellExpect % 1 ? 1 : 0);
	for (let i = dwellCount; i > 0; i--) {
		if (dwellPicks) {
			const d = dwellPicks[i - 1];
			const e = put(d.type, d.tpl, undefined, d.subtype, 40, fitAnchors(d.tpl), true);
			if (e && d.mod) e.mod = d.mod;
			continue;
		}
		// Corpus maps write resolved dwellings; ours were all the
		// randomDwelling placeholder, which is why the census reads a single
		// dwelling subtype where the corpus has seventy. Mostly concrete,
		// drawn from the level band the placeholder would have rolled; a
		// thin placeholder share keeps the faction-following variety.
		if (rng() < 0.85) {
			const lvl = Math.max(1, Math.min(7,
				tierLo + ((rng() * (tierHi - tierLo + 1)) | 0)));
			// a creature theme (--theme) draws its share from the family's
			// dwellings, the one nearest the level wanted
			const th = objectPools.themeDwellings;
			const d = th && th.pool.length && rng() < th.share
				? nearestLevelDwelling(th.pool, lvl, rng)
				: pickDwelling(lvl, rng, objectPools.dwellings);
			const e = d && put(d.type, d.tpl, undefined, d.subtype, 40,
				fitAnchors(d.tpl), true);
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
	for (let i = rare(fill.skills); i > 0; i--) {
		let roll = rng() * skillW, s = skillPool[0];
		for (const e of skillPool) { roll -= e.w; if (roll <= 0) { s = e; break; } }
		put(s.type, s.tpl, undefined, s.subtype, 40, fitAnchors(s.tpl), true);
	}
	for (let i = rare(fill.generators); i > 0; i--) {
		const g = FILL_TYPES.resourceGenerators[(rng() * FILL_TYPES.resourceGenerators.length) | 0];
		put(g.type, g.tpl, undefined, g.subtype, 40, fitAnchors(g.tpl), true);
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
		const piles = templatePiles(zoneMeta.spec.treasure, cells.length);
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
	const bankCount = bankDraws.length;
	for (const band of bankPool.length ? bankDraws : []) {
		const pick = pickBank(band);
		if (!pick) continue;
		const b = pick.b;
		const e = put(b.type || 'creatureBank', pick.tpl.raw, b.rewardable ? emptyRewardable() : undefined,
			b.subtype, 40, fitAnchors(pick.tpl.raw), true);
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
	const artifactCount = Math.round(area * p.artifactDensity * fill.artifacts * 10);
	for (let i = 0; i < artifactCount; i++) {
		// ~3% of artifacts write concrete (type 'artifact', subtype a named
		// id) rather than tier placeholders - same pool the seer-hut quests
		// draw from. Ran 2.41x corpus at 10%, still 1.89x at 5%.
		if (rng() < 0.03) {
			put('artifact', OBJECT_TEMPLATES.randomArtifact,
				undefined, SEER_ARTIFACTS[(rng() * SEER_ARTIFACTS.length) | 0]);
			continue;
		}
		const t = pickArtifactTier(richness, rng, zd);
		put(t.type, t.tpl);
	}

	// Mines moved up ahead of the scenery block - see the comment there.

	// Spell scrolls. The biggest single thing real maps had that we did not:
	// 3.55 per 1000 cells. The spell has to be named, because an unresolvable
	// identifier falls back to spell 0 rather than to a random one.
	if (SPELL_SCROLL && SPELL_SCROLL.spells.length)
		for (let i = Math.round(scale * fill.scrolls * p.pickupDensity); i > 0; i--) {
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
	for (let i = Math.round(scale * fill.piles * p.resourceDensity); i > 0; i--) {
		if (PILE_KINDS && rng() < 0.667) {
			const kind = pickKind();
			put('resource', pileTemplate(kind), undefined, kind);
		} else
			put('randomResource', pileTpl, undefined, 'randomResource');
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
	for (let i = Math.round(scale * fill.chests * p.pickupDensity * chestScale); i > 0; i--) {
		if (!chestPool.length) { put('treasureChest', chestTpl, undefined, 'treasureChest'); continue; }
		let roll = rng() * chestW, pick = chestPool[chestPool.length - 1];
		for (const e of chestPool) { roll -= e.w; if (roll <= 0) { pick = e; break; } }
		const e = put('treasureChest', pick.tpl.raw, pick.c.core ? undefined : emptyRewardable(), pick.c.subtype);
		if (e && (pick.tpl.mod || pick.c.mod)) e.mod = pick.tpl.mod || pick.c.mod;
	}
	const fireTpl = campfireTemplate();
	for (let i = Math.round(scale * fill.campfires * p.pickupDensity); i > 0; i--)
		put('campfire', fireTpl, undefined, 'campfire');

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
	for (let i = rare(fill.pandoras * (uMul ? uMul.pandora : 1)); i > 0; i--)
		put('pandoraBox', pandoraTpl, pandoraOptions(rng));
	if (fill.prisons) {
		if (!objectPools.prisonHeroes)
			objectPools.prisonHeroes = makePrisonHeroPool(players.length, rng);
		for (let i = rare(fill.prisons * (uMul ? uMul.prison : 1)); i > 0; i--) {
			const hero = objectPools.prisonHeroes.pop();
			if (!hero) break;
			put('prison', prisonTemplate(), prisonOptions(hero, rng), 'prison');
		}
	}
	const obeliskTpl = obeliskTemplate(terrain);
	for (let i = rare(fill.obelisks * (uMul ? uMul.obelisk : 1)); i > 0; i--)
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
	const guardBudget = Math.round(scale * fill.creeps * p.guardDensity);
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
	const ranked = guardable
		.map(g => ({ ...g, key: -Math.log(rng() || 1e-9) / guardWeight(g) }))
		.filter(g => Number.isFinite(g.key))
		.sort((a, b) => a.key - b.key);

	/** Post a monster on a cell beside `target`'s entrance; `preset` is an
	 * engine-rule guard (level and count) for a template zone. */
	const postGuard = ({ entry, tpl }, preset = null) => {
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
		for (const [gx, gy, vx, vy] of spots) {
			if (gx < 0 || gy < 0 || gx >= W || gy >= H) continue;
			// monsters are removable: the guard may stand on the approach
			// cell itself, which is what guarding means
			if (!footprintFits(monsterTpl, gx, gy, l, W, H, blocked, true)) continue;
			// A guard that cannot be approached is a wall, not a guard.
			if (!entranceOpen(monsterTpl, gx, gy, l, W, H, blocked, reachable)) continue;
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
			if (!stillOpen) continue;
			const walls = blockingCells(monsterTpl, gx, gy).map(([a, b]) => b * W + a);
			if (connectivity && !connectivity.accepts(walls)) continue;
			if (weldsMasses(walls, blocked, l, W, H, 2)) continue;
			const tier = preset ? preset.level : creepTier(cls, rng,
				(GUARD_VALUE_BUMP[entry.type] || 0) + monsterShift);
			const guardEntry = objectEntry(`randomMonsterLevel${tier}`, gx, gy, l, monsterTpl,
				preset ? { character: 'hostile', amount: preset.amount } : monsterOptions(tier, p, rng),
				'object');
			// the creature the engine's rule picked, for generate.js to write
			if (preset && preset.concrete) guardEntry.guardCreature = preset.creature;
			out.push(guardEntry);
			footprintBlock(monsterTpl, gx, gy, l, W, H, blocked);
			markApproach(monsterTpl, gx, gy, l, W, H, blocked);
			if (connectivity) connectivity.refresh();
			const idx = free.indexOf(gy * W + gx);
			if (idx >= 0) free.splice(idx, 1);
			return true;
		}
		return false;
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
		for (const g of onMines) {
			const guard = zoneGuard(MINE_RMG_VALUE[g.entry.subtype] || 3500);
			if (guard && postGuard(g, guard)) posted++;
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
		for (const { band: t, count, d, byDensity, byRoom } of templatePiles(bands, cells.length)) {
			if (process.env.VMAPGEN_PILE_TRACE)
				console.error(`[pile] zone ${zoneMeta.spec.id} band ${t.min}-${t.max} density ${t.density}: cells ${cells.length}, d ${d.toFixed(1)}, by density ${byDensity}, by room ${byRoom}, placing ${count}`);
			for (let k = count; k > 0; k--) {
				const guard = zoneGuard(t.min + Math.floor(rng() * (t.max - t.min + 1)));
				if (!guard) continue;
				if (process.env.VMAPGEN_PILE_TRACE) console.error(`[pile]   guard level ${guard.level} strength ${guard.strength}`);
				let done = false;
				while (!done && next < byPiles.length) done = postGuard(byPiles[next++], guard);
				// more guarded piles than objects to stand by: the guard still
				// stands in the zone
				if (!done) {
					const e = put(`randomMonsterLevel${guard.level}`, monsterTpl,
						{ character: 'hostile', amount: guard.amount });
					if (e && guard.concrete) e.guardCreature = guard.creature;
					done = !!e;
				}
				if (done) posted++;
			}
		}
	} else {
		for (const g of ranked) {
			if (posted >= wantGuards) break;
			if (postGuard(g)) posted++;
		}
		// whatever the guard pass could not place still roams, so the monster
		// count stays on the calibrated budget
		for (let i = guardBudget - posted; i > 0; i--) {
			const tier = creepTier(cls, rng, monsterShift);
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
			const c = rng() < 0.3 ? singleTemplate(terrain, rng) : clusterTemplate(terrain, rng);
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

module.exports = { fillBiome, FILL_TYPES, CLASS_FILL, pickArtifactTier,
	footprintCells, blockingCells, footprintFits, footprintBlock, visitableCells,
	entranceOpen, reserveCell, makeConnectivityGuard, floodFrom, OCCUPIED, RESERVED,
	APPROACH, allowedDirs, markApproach, weldsMasses, REMOVABLE_TYPES, MONSTER_OPTIONS,
	monsterOptions, STACK_RANGE,
	sliverCount, engineGuard, zoneGuardPool, nearestLevelDwelling };
