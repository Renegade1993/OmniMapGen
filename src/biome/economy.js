/**
 * economy.js - mines, resource piles and early-game pickups.
 *
 * Why this module exists: the generator used to emit no economy objects at
 * all. A map with no sawmill and no ore pit cannot support construction past
 * the first few buildings, so neither a human nor the AI can actually play it.
 * A real VCMI RMG map of comparable size carries a few hundred resource
 * objects and a dozen or more mines.
 *
 * Templates come from economy.templates.json, harvested from 71 installed RMG
 * maps rather than guessed. Mine art is terrain specific in Heroes 3 (a
 * sawmill on snow is a different def from a sawmill on grass), so the table
 * maps terrain shortId to animation per mine subtype and falls back to the
 * grass def for terrains it has never seen, including modded ones. Only core
 * defs are listed, so nothing here depends on a mod being enabled.
 */
'use strict';

const DATA = require('./economy.templates.json');
const { BIOME_CLASS } = require('./biomes');

/** Build a vmap template record for a mine of `subtype` standing on `terrain`. */
function mineTemplate(subtype, terrain) {
	const byTerrain = DATA.mineTerrainAnim[subtype] || {};
	const animation = byTerrain[terrain] || DATA.mineDefaultAnim[subtype];
	const t = DATA.templates[animation];
	return { animation, mask: t.mask, visitableFrom: t.visitableFrom };
}

/** Template for a resource pile. `kind` is 'randomResource' or a resource id. */
function pileTemplate(kind) {
	const animation = DATA.pileAnim[kind];
	const t = DATA.templates[animation];
	return { animation, mask: t.mask, visitableFrom: t.visitableFrom };
}

function simpleTemplate(animation) {
	const t = DATA.templates[animation];
	return { animation, mask: t.mask, visitableFrom: t.visitableFrom };
}

const chestTemplate = () => simpleTemplate(DATA.chestAnim);
const campfireTemplate = () => simpleTemplate(DATA.campfireAnim);

/**
 * The seven creature banks that ship with Heroes 3, ready to place.
 *
 * These could not be emitted before. The generator only ever placed banks it
 * found templates for in the live asset index, and no core bank carries one
 * there: their art is defined inside the game's LOD archives rather than in
 * any readable config file, so the pool came out empty and no bank appeared on
 * any generated map. Harvesting the records out of real random maps gets round
 * that. Modded banks still come from the index as before, so both kinds now
 * appear together.
 */
/**
 * The one-visit buildings: shrines, stat boosters, magic wells.
 *
 * These are worth having for more than flavor. Most of them work once per
 * hero and then give nothing, which is exactly the case OmniAI's learning
 * memory tracks as a depleted instance. Without any on the map, that whole
 * path never runs and never gets tested. Shrines and the Tree of Knowledge in
 * particular are named in the learning store's one-shot list.
 *
 * Weighted so a level 1 shrine is common and a Library of Enlightenment is a
 * once-a-map find, which is how the installed map corpus reads.
 */
// Mix corrections on top of the harvested weights, read size-matched at the
// sizes K plays (surface per floor cell, 108x108 / 144x144 vs corpus,
// 2026-09-24): level 2 shrines 1.79 / 1.92x, level 3 shrines 1.33 / 1.56x,
// star axis 1.67 / 1.30x, mercenary camps 1.30 / 1.69x. Only types off in
// the same direction at both sizes are touched; the rest read inside their
// count noise. Temples (0.58 / 0.75x) got x1.5 in the first try and landed
// 1.38 / 2.22x: trimming the others already shifts their share onto every
// untouched type, so temples are left alone and mercenary camps, which
// landed 0.65 / 0.88x at x0.67, take x0.85.
const BONUS_REWEIGHT = { shrineOfMagicLevel2: 0.55, shrineOfMagicLevel3: 0.7,
	starAxis: 0.67, mercenaryCamp: 0.85 };
const BONUS_POOL = DATA.bonuses.map(b => ({
	type: b.type,
	subtype: b.subtype,
	weight: b.weight * (BONUS_REWEIGHT[b.type] || 1),
	tpl: { animation: b.animation, mask: b.mask, visitableFrom: b.visitableFrom },
}));
const BONUS_WEIGHT_TOTAL = BONUS_POOL.reduce((a, b) => a + b.weight, 0);

/** Weighted pick from BONUS_POOL. */
function pickBonus(rng) {
	let roll = rng() * BONUS_WEIGHT_TOTAL;
	for (const b of BONUS_POOL) {
		roll -= b.weight;
		if (roll <= 0) return b;
	}
	return BONUS_POOL[0];
}

/**
 * The banks, plus the Dragon Utopia.
 *
 * A utopia behaves like a bank and is handled by the same CBank code, but it
 * is its OWN object type rather than a creatureBank subtype, which is why it
 * never appeared: the pool only ever emitted `creatureBank`. Real maps run it
 * at 0.41 per 1000 cells against 6.2 for the banks proper, so one bank in
 * fifteen is a utopia.
 */
/**
 * How many of a bank the engine lands on a map, from its rmg entry: rarity
 * over 100 times a rate for its value. TreasurePlacer draws a pile's objects
 * by rarity from those worth between a quarter of what the pile still wants
 * and all of it, and a bank, entered from below, only as the pile's one large
 * object (prepareTreasurePile, getRandomObject). So a bank worth about what a
 * rich pile holds (9000-10000) lands most often, and a cheap one competes with
 * every resource and minor artifact. Fitted per 100 rarity on the corpus maps
 * made with this install's mods (the 11 since 2026-08-26), where the value
 * alone sorts 40 banks from five mods: 1500-3500 about 5, 5000 11.5, 9000-9500
 * 16.4, 13500 11.6, 30000 7.3 (bank_tally.js, 2026-09-26).
 */
const BANK_RATE_AT = [[0, 5], [3500, 5.5], [4200, 8], [5000, 11.5], [8000, 12.6], [9000, 16.4],
	[10500, 16], [13500, 11.6], [30000, 7.3], [60000, 4]];
function bankRate(rmg) {
	if (!rmg || !(rmg.value > 0) || !(rmg.rarity > 0)) return 0;
	const v = rmg.value;
	let rate = BANK_RATE_AT[BANK_RATE_AT.length - 1][1];
	for (let i = 1; i < BANK_RATE_AT.length; i++) {
		const [v1, r1] = BANK_RATE_AT[i];
		if (v > v1) continue;
		const [v0, r0] = BANK_RATE_AT[i - 1];
		rate = r0 + (r1 - r0) * (v - v0) / (v1 - v0);
		break;
	}
	return rmg.rarity / 100 * rate;
}

// Core's own rmg entries for its banks (config/objects/creatureBanks.json), what
// an engine without mods weighs them by. A map that declares its mods takes the
// install's patched entries from the index instead (HotA puts the Imp Cache at
// 1500), in generate.js.
const CORE_BANK_RMG = {
	cyclopsStockpile: { value: 3000, rarity: 100 }, dwarvenTreasury: { value: 2000, rarity: 100 },
	griffinConservatory: { value: 2000, rarity: 100 }, impCache: { value: 5000, rarity: 100 },
	medusaStore: { value: 1500, rarity: 100 }, nagaBank: { value: 3000, rarity: 100 },
	dragonFlyHive: { value: 9000, rarity: 100 }, dragonUtopia: { value: 10000, rarity: 100 },
};
// The terrains a core bank's template allows, where that is not every land
// terrain. Core templates come from the game's own Objects.txt (H3ab_bmp.lod
// over H3bitmap.lod), which the index never reads. The Medusa Store's
// (AVXbnk50) lists the seven surface terrains without subterranean, and fewer
// than eight is a list rather than "any land" (ObjectTemplate::readTxt), which
// also shuts it out of every mod terrain; the corpus's 205 agree. Every other
// core bank and the utopia take any land.
const CORE_BANK_TERRAINS = {
	medusaStore: ['dirt', 'sand', 'grass', 'snow', 'swamp', 'rough', 'lava'],
};

const CORE_BANKS = DATA.coreBanks.map(b => ({
	type: 'creatureBank',
	subtype: b.subtype,
	rmg: CORE_BANK_RMG[b.subtype],
	weight: bankRate(CORE_BANK_RMG[b.subtype]) || 1,
	tpl: { animation: b.animation, mask: b.mask, visitableFrom: b.visitableFrom },
	...(CORE_BANK_TERRAINS[b.subtype] ? { terrains: CORE_BANK_TERRAINS[b.subtype] } : {}),
}));
if (DATA.dragonUtopia)
	CORE_BANKS.push({
		type: 'dragonUtopia', subtype: DATA.dragonUtopia.subtype,
		rmg: CORE_BANK_RMG.dragonUtopia,
		// Its measured rate rather than the value curve's 16: the engine fails
		// to fit its 7x5 footprint often, and real maps hold 7.1 a map (the
		// same corpus as bankRate). Failed draws here are owed to a later
		// landmark pass (content.js), which keeps ours near its weight.
		weight: 7.1,
		tpl: { animation: DATA.dragonUtopia.animation, mask: DATA.dragonUtopia.mask,
			visitableFrom: DATA.dragonUtopia.visitableFrom },
	});
// The Crypt comes out of the same treasure piles as the banks (rmg 1000,
// rarity 100). Drawn from the utility pool it ran at 1.18 of the corpus on the
// free layout and 0.59 on templates (lens runs f19, t20). Its core templates
// stand on five terrains (Objects.txt: AVXgyne0 dirt, grass and swamp,
// AVXgysn0 snow, AVXgyds0 sand), so none is underground, on rough or lava, or
// on a mod terrain but New Pavilion's dunes, which brings its own template
// (generate.js adds a mod's templates on a map that declares its mods); the
// corpus's 397 agree. The engine randomises its reward from an empty
// rewardable config.
{
	const vf = ['---', '+-+', '+++'];
	const crypt = { type: 'crypt', subtype: 'crypt', rmg: { value: 1000, rarity: 100 }, rewardable: true,
		tpls: [
			{ raw: { animation: 'AVXgyne0', mask: ['VVV', 'BAB'], visitableFrom: vf }, terrains: ['grass', 'dirt', 'swamp'] },
			{ raw: { animation: 'AVXgysn0', mask: ['VVVV', 'VBAB'], visitableFrom: vf }, terrains: ['snow'] },
			{ raw: { animation: 'AVXgyds0', mask: ['VVVV', 'VBAB'], visitableFrom: vf }, terrains: ['sand'] },
		] };
	crypt.weight = bankRate(crypt.rmg);
	crypt.tpl = crypt.tpls[0].raw;
	CORE_BANKS.push(crypt);
}

/**
 * A spell scroll, carrying one of the 66 core spells real maps put on them.
 *
 * The spell has to be named. CMapLoaderJson reads `options.spell` and falls
 * back to spell 0 when it cannot resolve the identifier, so an unset spell is
 * not a random spell, it is Magic Arrow every time. Only core spells are
 * listed: a modded spell on a map that declares no mods is a scroll nobody
 * else can read.
 */
const SPELL_SCROLL = DATA.spellScroll ? {
	type: 'spellScroll',
	subtype: DATA.spellScroll.subtype,
	spells: DATA.spellScroll.spells,
	tpl: { animation: DATA.spellScroll.animation, mask: DATA.spellScroll.mask,
		visitableFrom: DATA.spellScroll.visitableFrom },
} : null;

/**
 * Concrete structures the generator places with its own template.
 *
 * These are not placeholders. CGObjectInstance::setType only swaps in the
 * engine's own template when randomizeMapObjects resolves a random object, so
 * for everything here the game draws exactly the record we write. The previous
 * set was written from memory (avlstrn1, avtschlr, avtmystg, avtwwhel0,
 * avtwwind0, and a witch hut whose animation name contained a space), and none
 * of those names exists in any config file or in any of the 71 real maps. Four
 * of the six also carried the wrong mask, so the generator reserved cells the
 * real building does not use and modelled an entrance where it has none.
 */
const STRUCTURES = {};
for (const [name, t] of Object.entries(DATA.structures))
	STRUCTURES[name] = { animation: t.animation, mask: t.mask, visitableFrom: t.visitableFrom };

/** Canonical subtype per structure; see the note in economy.templates.json. */
const STRUCTURE_SUBTYPE = { ...DATA.structureSubtype };

/**
 * A one-cell blocking decoration appropriate to `terrain`.
 *
 * Barriers are laid a cell at a time along a biome border, so a real mountain
 * (four rows and up) cannot be used, and the old stand-ins blocked their tile
 * while drawing nothing at all. These are the one-cell decorations real maps
 * use, keyed by the terrain under them, so a border on snow gets snow shrubs
 * and a border underground gets subterranean rock.
 */
function barrierTemplate(terrain, rng) {
	const pool = DATA.barriers[terrain] || DATA.barrierDefault;
	const pick = pool[((rng ? rng() : 0) * pool.length) | 0] || pool[0];
	return { type: pick.type, subtype: 'object',
		tpl: { animation: pick.animation, mask: ['B'] } };
}

/**
 * The utility long tail: one-visit buildings, quest huts, markets, camps and
 * the paired portals real maps scatter. Harvested with core art only.
 *
 * monolithTwoWay entries are portals: the engine links all instances of one
 * subtype into a single two-way network, so they only work in pairs. A lone
 * monolith is scenery that does nothing; the fill pairs them.
 */
// The corpus harvest carries HotA portal subtypes (monolith7 and up) whose
// animation is core art but whose subtype the core config does not know:
// vmap_engine_check refused 19 of 29 maps on 2026-09-22 over monolith27,
// monolith49 et al. Only monolith1-6 are valid; the rest are dropped, and
// the core six keep the whole weight of the pool.
const CORE_MONOLITH = new Set(['monolith1', 'monolith2', 'monolith3',
	'monolith4', 'monolith5', 'monolith6']);
const UTIL_POOL = (DATA.utilities || [])
	.filter(u => u.type !== 'monolithTwoWay' || CORE_MONOLITH.has(u.subtype))
	.map(u => ({
		type: u.type, subtype: u.subtype, weight: u.weight,
		pair: u.type === 'monolithTwoWay',
		tpl: { animation: u.animation, mask: u.mask,
			visitableFrom: u.visitableFrom },
	}));
const UTIL_WEIGHT_TOTAL = UTIL_POOL.reduce((a, b) => a + b.weight, 0);
function pickUtil(rng) {
	let roll = rng() * UTIL_WEIGHT_TOTAL;
	for (const u of UTIL_POOL) { roll -= u.weight; if (roll <= 0) return u; }
	return UTIL_POOL[0];
}

/**
 * Concrete dwellings, tagged with the level of the creature they produce
 * (resolved through config/objects/dwellings.json at harvest time). The
 * corpus writes resolved dwellings rather than the randomDwelling
 * placeholder; emitting a mix of both matches what a real map file holds
 * while keeping the placeholder for level-band control.
 */
const DWELLING_POOL = (DATA.concreteDwellings || []).map(d => ({
	type: d.type, subtype: d.subtype, level: d.level, weight: d.weight,
	tpl: { animation: d.animation, mask: d.mask, visitableFrom: d.visitableFrom },
}));
/**
 * extra: mod-sourced dwellings from the live install (generate.js's
 * `dwellings`, gated the same way as the bank pool - only populated when the
 * map declares its mods). DWELLING_POOL alone is core-only (78 entries,
 * confirmed zero mod content by direct check, fidelity lens 2026-09-25);
 * without `extra` this is unchanged from before.
 */
function pickDwelling(level, rng, extra) {
	const pool = extra && extra.length
		? DWELLING_POOL.concat(extra).filter(d => d.level === level)
		: DWELLING_POOL.filter(d => d.level === level);
	if (!pool.length) return null;
	let total = 0;
	for (const d of pool) total += d.weight;
	let roll = rng() * total;
	for (const d of pool) { roll -= d.weight; if (roll <= 0) return d; }
	return pool[0];
}

/** Resource kinds a concrete pile may carry, with corpus shares. */
const PILE_KINDS = DATA.pileKinds || null;

/**
 * A seer hut's quest: a core artifact to fetch and a reward for it.
 *
 * The corpus asks for one specific artifact - a mod-scoped id in half of
 * cases, which a core-only map cannot name, so the pool below holds the
 * core ids corpus huts actually ask for. Rewards split roughly even
 * between experience and gold in the corpus's amounts.
 */
const SEER_ARTIFACTS = [
	'badgeOfCourage', 'pendantOfDispassion', 'glyphOfGallantry',
	'necklaceOfSwiftness', 'breastplateOfPetrifiedWood', 'ladybirdOfLuck',
	'shieldOfTheDwarvenLords', 'cardsOfProphecy', 'pendantOfDeath',
	'pendantOfFreeWill', 'pendantOfHoliness', 'crestOfValor',
	'helmOfTheAlabasterUnicorn', 'spiritOfOppression',
	'hourglassOfTheEvilHour', 'cloverOfFortune', 'pendantOfLife',
	'pendantOfTotalRecall',
];
const SEER_EXP = [5000, 10000, 10000, 15000, 20000];
const SEER_GOLD = [2000, 3000, 4000, 5000, 6000];

function seerHutOptions(rng) {
	const pick = a => a[(rng() * a.length) | 0];
	const reward = {
		creatures: [], creaturesChange: [], heroExperience: 0, heroLevel: 0,
		manaDiff: 0, manaOverflowFactor: 0, manaPercentage: -1,
		movePercentage: -1, movePoints: 0, primary: [0, 0, 0, 0],
		secondary: [], spellCast: { level: 0 },
	};
	if (rng() < 0.5) reward.heroExperience = pick(SEER_EXP);
	else reward.resources = { gold: pick(SEER_GOLD) };
	return {
		quest: {
			completedText: { ...META_NULL }, firstVisitText: { ...META_NULL },
			limiter: {
				allOf: [], anyOf: [],
				artifacts: [`core:${pick(SEER_ARTIFACTS)}`],
				creatures: [], dayOfWeek: 0, daysPassed: 0,
				heroExperience: 0, heroLevel: -1, manaPercentage: 0,
				manaPoints: 0, movePercentage: 0, movePoints: 0,
				noneOf: [], primary: [0, 0, 0, 0], secondary: [],
			},
			nextVisitText: { ...META_NULL },
		},
		rewardable: {
			info: [{
				limiter: {
					allOf: [], anyOf: [], creatures: [], dayOfWeek: 0,
					daysPassed: 0, heroExperience: 0, heroLevel: -1,
					manaPercentage: 0, manaPoints: 0, noneOf: [],
					primary: [0, 0, 0, 0], secondary: [],
				},
				message: { ...META_NULL },
				reward,
				visitType: 1,
			}],
			infoWindowType: 0,
			onSelect: { ...META_NULL },
			resetParameters: { period: 0 },
			selectMode: 'selectFirst',
			visitMode: 'unlimited',
		},
	};
}

/**
 * Which mines a biome class may hold, and its share of the map's mine budget.
 *
 * `weight` multiplies the planner's per-player mine rate, so the whole table
 * shifts together when a map has more players or less room. Weights average
 * near 1 so the map-wide total stays on the per-player budget.
 *
 * The split follows the Nostalgia convention the rest of the generator
 * mirrors: the zone a player starts in carries the cheap construction
 * resources, filler zones carry more of them, and the special resources that
 * gate high tier buildings sit in the loot zones where they have to be fought
 * for. Gold mines are the strongest single objective on any map, so they stay
 * out of the starting zone and concentrate in high loot territory.
 */
const CLASS_MINES = {
	// 2026-09-23 mix rebalance vs the 75-map corpus: sawmill/orePit ran
	// ~2.4x corpus while crystalCavern/gemPond sat at ~0.5x, so the filler
	// and loot pools give the special mines more turns. The player row
	// keeps its construction-mine lean - a start zone should not gate
	// building behind a crystal cavern.
	// gemPond joins the start zone: gems gate the mage guild, corpus puts a
	// special mine in the ring sometimes, and it was the last LOW row at
	// 0.30x after the gold rebalance crowded the special-mine slots.
	[BIOME_CLASS.PLAYER]:    { weight: 0.75, pool: ['sawmill', 'orePit', 'sawmill', 'orePit', 'sulfurDune', 'gemPond'] },
	// audit loop: crystalCavern 0.58x - every other special mine is in
	// band, so the non-player rows give it a second slot.
	// fidelity lens, 2026-09-25: sulfurDune 0.53x, the worst of the seven,
	// while alchemistLab/crystalCavern (fixed the same way above) read
	// 0.84-0.94x - it never got the second-slot correction its peers did.
	// Corpus wants sulfurDune level with alchemistLab (5.7 each); doubled
	// here the same way, not a new mechanism.
	[BIOME_CLASS.TOWN]:      { weight: 1.00, pool: ['sawmill', 'orePit', 'goldMine', 'sulfurDune', 'sulfurDune', 'alchemistLab', 'alchemistLab', 'crystalCavern', 'crystalCavern', 'gemPond', 'goldMine'] },
	// Census pass 2: landed shares ran saw 28 / ore 24 / gold 4 vs corpus
	// 22/22/12. The doubled crystalCavern/gemPond traded for a second
	// goldMine, LOW_LOOT gains one, and the loot rows lean gold harder -
	// the start-zone exclusion plus the always-sawmill/orePit starter pair
	// halve gold's blended share before a draw ever happens.
	[BIOME_CLASS.STANDARD]:  { weight: 1.00, pool: ['sawmill', 'orePit', 'goldMine', 'alchemistLab', 'alchemistLab', 'sulfurDune', 'sulfurDune', 'crystalCavern', 'crystalCavern', 'gemPond', 'goldMine'] },
	[BIOME_CLASS.HIGH_LOOT]: { weight: 1.35, pool: ['goldMine', 'crystalCavern', 'gemPond', 'gemPond', 'sulfurDune', 'alchemistLab', 'goldMine'] },
	[BIOME_CLASS.LOW_LOOT]:  { weight: 1.15, pool: ['sawmill', 'orePit', 'alchemistLab', 'sulfurDune', 'crystalCavern', 'crystalCavern', 'gemPond', 'goldMine'] },
};

/**
 * Mines a single player's share of the map should work out to, counting the
 * two starter mines. Measured from the installed map corpus: a 36x36 two
 * player map runs about 12 mines per 1000 cells and a 216x216 runs about 1,
 * which is the same thing said twice once you divide by player count.
 * Raised 7 -> 9 on 2026-09-22: the census puts the corpus at 3.63 mines
 * per 1000 cells on a 72x72 and placement attrition lands only ~60% of
 * the budget, so the ask has to run ahead of the target. Then 9 -> 12 the
 * same day: mines now place before the scenery packs and land ~50% of the
 * ask (census 0.63x corpus), so the budget follows the measured rate.
 * 16 -> 11 on 2026-09-23: against the repointed 75-map pool the landed
 * total ran 1.90x (sawmill 2.47, orePit 2.35) - the earlier readings were
 * the small-pool's under-counted mines. Still above the nominal share
 * because attrition lands only part of the ask. 11 -> 9 same pass:
 * landed 1.65x after the mix rebalance. 9 -> 6 on the post-landmark census:
 * landed total still ran 1.48x corpus (sawmill 1.89, orePit 1.63) now that
 * candidate anchors convert better - the same pruning that fixed the
 * landmarks also lands more of the mine ask. 6 -> 5 tried on audit pass
 * 5: mine class dropped to 1.07x but the far-band zone value fell from
 * 0.96x to 0.85x because mines carry value the zone budget does not
 * respend (count-driven, not mix-weight). Reverted: the zone gradient
 * is worth more than the class count.
 */
const MINES_PER_PLAYER = 6;

/**
 * The three objects a real map carries that need more than a template.
 *
 * A pandora's box has to carry its reward block: CRewardableObject reads
 * options.rewardable.info[] and an empty one is a box that gives nothing,
 * which the corpus never produces (0 of 3972). A prison names the hero
 * inside it in options.type; without it setHeroTypeName gets an empty string
 * and the prison frees nobody. An obelisk has no options at all but only
 * means anything on a map that buries a grail, so fillBiome counts the
 * obelisks it places and planMap adds the grail once the map has stopped
 * moving.
 *
 * All art is core: corpus prisons use the HotA def in three quarters of
 * cases but the vanilla AVXprsn0 is what the other quarter uses, and it is
 * the only one that exists on an install without mods. Obelisk art follows
 * the terrain under the anchor, harvested the same way as the mines.
 */
const SPECIALS = DATA.specials;

function specialTemplate(name) {
	const t = SPECIALS[name];
	return { animation: t.animation, mask: t.mask, visitableFrom: t.visitableFrom };
}
const pandoraTemplate = () => specialTemplate('pandoraBox');
const prisonTemplate = () => specialTemplate('prison');

function obeliskTemplate(terrain) {
	const S = SPECIALS.obelisk;
	return { animation: S.terrainAnim[terrain] || S.defaultAnim,
		mask: S.mask, visitableFrom: S.visitableFrom };
}

/** Weighted pick over a {key: weight} table, returns the key. */
function weightedKey(weights, rng) {
	let total = 0;
	for (const k in weights) total += weights[k];
	let roll = rng() * total;
	for (const k in weights) { roll -= weights[k]; if (roll <= 0) return k; }
	return Object.keys(weights)[0];
}

const PANDORA_CREATURE_TOTAL = SPECIALS.pandoraCreatures.reduce((a, r) => a + r[2], 0);
function pandoraCreature(rng) {
	let roll = rng() * PANDORA_CREATURE_TOTAL;
	for (const row of SPECIALS.pandoraCreatures) {
		roll -= row[2];
		if (roll <= 0) return { type: row[0], amount: row[1] };
	}
	const r = SPECIALS.pandoraCreatures[0];
	return { type: r[0], amount: r[1] };
}

// The union of both harvested spell pools: what scrolls carry plus what
// pandora lists carried. All core identifiers, all resolvable without mods.
const PANDORA_SPELLS = [...new Set(
	[...(DATA.spellScroll ? DATA.spellScroll.spells : []), ...SPECIALS.pandoraSpells])];

const META_NULL = { exactStrings: null, localStrings: null, message: null,
	numbers: null, stringsTextID: null };

/**
 * The options block the corpus writes on every one-visit building: the
 * reward is the object type's own config, so info stays empty (measured
 * 2026-09-23 over the 75-map corpus - every shrine, school, arena, crypt
 * and garden carries it, 0 exceptions). The corpus's exceptions among the
 * types the pools emit: tavern and altarOfSacrifice get no options at all,
 * and in the utility pool only crypt and redwoodObservatory carry it.
 */
function emptyRewardable() {
	return {
		rewardable: {
			info: [], infoWindowType: 0,
			onSelect: { ...META_NULL },
			resetParameters: { period: 0 },
			selectMode: 'selectFirst', visitMode: 'unlimited',
		},
	};
}

/**
 * A pandora's box options block, in the shape the engine writes.
 *
 * The four reward kinds are the only ones the corpus ever produces, at the
 * shares it produces them: experience 47%, creatures 30%, spells 12%, gold
 * 11%. The amounts are the RMG scheme from TreasurePlacer.cpp: gold and
 * experience run i*5000 for i in 1..4, creatures are (type, amount) pairs at
 * their observed corpus frequency, and a spell reward is a list of 12, 15 or
 * 60 core spell identifiers.
 */
function pandoraOptions(rng) {
	const S = SPECIALS.pandoraBox;
	const reward = {
		creatures: [], creaturesChange: [], heroExperience: 0, heroLevel: 0,
		manaDiff: 0, manaOverflowFactor: 0, manaPercentage: -1,
		movePercentage: -1, movePoints: 0, primary: [0, 0, 0, 0],
		secondary: [], spellCast: { level: 0 },
	};
	const kind = weightedKey(S.rewardWeights, rng);
	if (kind === 'experience')
		reward.heroExperience = +weightedKey(S.expWeights, rng);
	else if (kind === 'gold')
		reward.resources = { gold: +weightedKey(S.goldWeights, rng) };
	else if (kind === 'creatures')
		reward.creatures = [pandoraCreature(rng)];
	else if (kind === 'spells') {
		const pool = [...PANDORA_SPELLS];
		for (let i = pool.length - 1; i > 0; i--) {
			const j = (rng() * (i + 1)) | 0;
			[pool[i], pool[j]] = [pool[j], pool[i]];
		}
		reward.spells = pool.slice(0,
			Math.min(+weightedKey(S.spellListSizes, rng), pool.length));
	}
	return {
		guardMessage: { ...META_NULL },
		rewardable: {
			info: [{
				limiter: {
					allOf: [], anyOf: [], creatures: [], dayOfWeek: 0,
					daysPassed: 0, heroExperience: 0, heroLevel: -1,
					manaPercentage: 0, manaPoints: 0, noneOf: [],
					primary: [0, 0, 0, 0], secondary: [],
				},
				message: { ...META_NULL },
				reward,
				visitType: 1,
			}],
			infoWindowType: 0,
			onSelect: { ...META_NULL },
			resetParameters: { period: 0 },
			selectMode: 'selectFirst',
			visitMode: 'unlimited',
		},
	};
}

/**
 * A prison's options: the hero inside it. CGHeroInstance reads options.type
 * as the hero type name, so it has to be a real core identifier. The hero is
 * drawn by the caller from a shared per-map pool, because the same hero in
 * two prisons would free the same person twice.
 */
function prisonOptions(hero, rng) {
	const opts = { gender: -1, type: hero };
	const exp = +weightedKey(SPECIALS.prison.expWeights, rng);
	if (exp) opts.experience = exp;
	return opts;
}

/**
 * The per-map prison hero pool: the 144-hero core roster, shuffled, minus
 * the reserve PrisonHeroPlacer::init keeps for players to hire (16 each).
 * Drawn with pop(), so no hero is imprisoned twice.
 */
function makePrisonHeroPool(playerCount, rng) {
	const roster = [...SPECIALS.prison.heroes];
	for (let i = roster.length - 1; i > 0; i--) {
		const j = (rng() * (i + 1)) | 0;
		[roster[i], roster[j]] = [roster[j], roster[i]];
	}
	return roster.slice(0, Math.max(0, roster.length - 16 * Math.max(1, playerCount)));
}

/**
 * Mines guaranteed next to every player start, in placement order. Wood and
 * ore are what the first week of construction actually consumes, so they are
 * placed unconditionally and close. Without them the opening is decided by
 * whatever the starting resource grant happens to be.
 */
const STARTER_MINES = ['sawmill', 'orePit'];

module.exports = {
	mineTemplate, pileTemplate, chestTemplate, campfireTemplate,
	CLASS_MINES, STARTER_MINES, MINES_PER_PLAYER, CORE_BANKS, bankRate,
	BONUS_POOL, pickBonus,
	STRUCTURES, STRUCTURE_SUBTYPE, barrierTemplate, SPELL_SCROLL,
	pandoraTemplate, prisonTemplate, obeliskTemplate,
	pandoraOptions, prisonOptions, makePrisonHeroPool, SPECIALS,
	UTIL_POOL, pickUtil, DWELLING_POOL, pickDwelling, PILE_KINDS,
	seerHutOptions, SEER_ARTIFACTS, emptyRewardable,
	RESOURCE_KINDS: Object.keys(DATA.pileAnim).filter(k => k !== 'randomResource'),
};
