/**
 * piles.js - the engine's treasure piles, simulated (VCMI lib/rmg/modificators
 * TreasurePlacer.cpp and ObjectDistributor.cpp).
 *
 * A template zone's treasure comes in piles. For each band {min, max,
 * density}, richest first, the engine asks for floor(tiles * density / 400)
 * of them and builds each with prepareTreasurePile: a desired value drawn in
 * [min, max], then objects drawn by rarity from those worth between a quarter
 * of what is left and all of it, until less than 100 is left, with an even
 * chance to stop each time the pile has reached min. A pile is worth what its
 * objects add up to, which is at most the value drawn and often not far over
 * min, and that sum is what the engine guards (isGuardNeededForTreasure,
 * ObjectManager::addGuard). A pile holds at most one object that cannot be
 * visited from the top (a bank, a dwelling, a shrine), and every object's zone
 * limit is spent as the zone's piles take it.
 */
'use strict';

// config/randomMap.json
const PRISON_VALUES = [2500, 5000, 10000, 20000, 30000];
const SCROLL_VALUES = [500, 2000, 3000, 4000, 5000];
const PANDORA = { gold: 5000, experience: 6000, spells: 2500, school: 15000, spell60: 30000,
	creatures: [5000, 7000, 9000, 12000, 16000, 21000, 27000] };
const SEER_HUT_VALUE = 500;

// TreasurePlacer::addCommonObjects leaves these to their own add functions
const OWN_POOL = new Set(['prison', 'creatureGeneratorCommon', 'creatureGeneratorSpecial',
	'spellScroll', 'pandoraBox', 'pandora', 'seerHut']);
// H3 templates come from OBJECTS.TXT, and ObjectTemplate::readTxt makes one
// visitable from the top only for class 2-5 (creature, hero, artifact,
// resource: the chest is class 5, the Pandora's box 4) and 15 named objects
// (isOnVisitableFromTopList); everything else is visited from below
const H3_TOP = new Set(['resource', 'randomResource', 'treasureChest', 'artifact', 'randomArtifact',
	'randomArtifactTreasure', 'randomArtifactMinor', 'randomArtifactMajor', 'randomArtifactRelic',
	'spellScroll', 'pandoraBox', 'flotsam', 'seaChest', 'shipwreckSurvivor', 'buoy', 'oceanBottle',
	'boat', 'whirlpool', 'garrisonHorizontal', 'garrisonVertical', 'scholar', 'campfire',
	'borderGuard', 'borderGate', 'questGuard', 'corpse']);
// core objects whose H3 templates allow only water
const H3_WATER = new Set(['flotsam', 'seaChest', 'shipwreckSurvivor', 'buoy', 'oceanBottle',
	'shipwreck', 'derelictShip', 'sirens', 'mermaid', 'magellansMaps', 'whirlpool']);

const topVisitable = t => !(t.raw && Array.isArray(t.raw.visitableFrom))
	|| String(t.raw.visitableFrom[0] || '').charAt(1) === '+';

/**
 * Every object the engine's common pool can take, from the asset index:
 * non-static, an rmg value, not one of the objects with a pool of their own.
 * Core objects follow their H3 templates; a mod's follow its own. useMods
 * false keeps core only, as a map that declares no mods does.
 * Returns [{ key, type, value, probability, zoneLimit, mapLimit, large, water }],
 * water 'only' | 'never'.
 */
function commonPool(objects, useMods = true) {
	const out = [];
	for (const [key, o] of objects) {
		if (o.overrides || !o.rmg || !(o.rmg.value > 0) || o.handler === 'static') continue;
		if (OWN_POOL.has(o.type)) continue;
		const core = String(key).startsWith('core:');
		if (!core && !useMods) continue;
		let large, water;
		if (core) {
			large = !H3_TOP.has(o.type);
			water = H3_WATER.has(o.type) ? 'only' : 'never';
		} else {
			const tpls = (o.templates || []).filter(t => t.raw && t.raw.animation);
			if (!tpls.length) continue;   // the engine needs a template to place it
			large = tpls.some(t => !topVisitable(t));
			const onWater = t => Array.isArray(t.allowedTerrains) && t.allowedTerrains.length === 1
				&& t.allowedTerrains[0] === 'water';
			water = tpls.every(onWater) ? 'only' : 'never';
		}
		out.push({ key, type: o.type, value: o.rmg.value, probability: o.rmg.rarity || 0,
			zoneLimit: o.rmg.zoneLimit, mapLimit: o.rmg.mapLimit, large, water });
	}
	return out;
}

/**
 * The pool one zone's piles draw from, each entry with its own count left.
 * common: commonPool's list. opts:
 *   maxValue    the zone's richest band's max (TreasurePlacer drops dearer objects)
 *   water       the zone is a water zone (no dwellings, boxes or scrolls)
 *   dwellings   the zone faction's dwellings [{ value, prob, fromRmg }], priced
 *               as generate.js prices them, before the native-zone modifier
 *   creatures   the zone faction's creatures [{ aiValue, level }] (the creature boxes)
 *   nativeZones, totalZones   zones of the zone's faction, and all zones
 *   mapZones    zones sharing a map-limited object (default totalZones)
 *   prisons     the zone's prison allowance (default 1)
 *   seerHuts    quest artifacts the zone has room for (default 1; 0 without links)
 * rng: for the map-limited objects' share. Sorted by value, as the engine sorts.
 */
function zonePool(common, opts = {}, rng = Math.random) {
	const maxValue = opts.maxValue || 0;
	const water = !!opts.water;
	const total = opts.totalZones || 1, native = opts.nativeZones || 0;
	const pool = [];
	const add = (e, left) => { if (left > 0 && e.value > 0 && e.value <= maxValue) pool.push({ ...e, left }); };
	for (const e of common) {
		if (water ? e.water === 'never' : e.water === 'only') continue;
		if (e.mapLimit !== undefined) {
			// ObjectDistributor: ceil(limit / zones) to each zone that can take it, in
			// a shuffled order until the limit runs out; one zone gets it at that rate
			const zones = opts.mapZones || total;
			const per = Math.ceil(e.mapLimit / zones);
			const share = Math.min(1, e.mapLimit / (per * zones));
			if (!(per > 0) || rng() >= share) continue;
			add(e, Math.min(per, e.zoneLimit === undefined ? Infinity : e.zoneLimit));
			continue;
		}
		add(e, e.zoneLimit === undefined ? Infinity : e.zoneLimit);
	}
	if (!water) {
		// addDwellings: value x (1 + native / all + native / 2)
		const mod = 1 + native / total + native / 2;
		for (const d of opts.dwellings || []) {
			if (d.fromRmg && d.value > maxValue) continue;
			add({ key: 'dwelling', type: 'dwelling', value: Math.floor(d.value * mod), probability: d.prob, large: true }, Infinity);
		}
		// addPandoraBoxes
		for (let i = 1; i < 5; i++) {
			add({ key: 'pandoraGold', type: 'pandoraBox', value: i * PANDORA.gold, probability: 5, large: false }, Infinity);
			add({ key: 'pandoraExperience', type: 'pandoraBox', value: i * PANDORA.experience, probability: 20, large: false }, Infinity);
		}
		for (const c of opts.creatures || []) {
			const n = creatureCount(c);
			if (n) add({ key: 'pandoraCreatures', type: 'pandoraBox', value: Math.floor(c.aiValue * n * (1 + native / total)), probability: 3, large: false }, Infinity);
		}
		for (let i = 1; i <= 5; i++)
			add({ key: 'pandoraSpells', type: 'pandoraBox', value: (i + 1) * PANDORA.spells, probability: 2, large: false }, Infinity);
		for (let i = 0; i < 4; i++)
			add({ key: 'pandoraSchool', type: 'pandoraBox', value: PANDORA.school, probability: 2, large: false }, Infinity);
		add({ key: 'pandoraSpell60', type: 'pandoraBox', value: PANDORA.spell60, probability: 2, large: false }, Infinity);
		// addSeerHuts: placed at 500 whatever the reward, one quest artifact each
		for (let i = 0; i < (opts.seerHuts === undefined ? 1 : opts.seerHuts); i++)
			add({ key: 'seerHut', type: 'seerHut', value: SEER_HUT_VALUE, probability: 3, large: true }, 1);
		// addScrolls
		SCROLL_VALUES.forEach(v => add({ key: 'spellScroll', type: 'spellScroll', value: v, probability: 30, large: false }, Infinity));
	}
	// addPrisons: the allowance goes to the dearest first
	let prisonsLeft = opts.prisons === undefined ? 1 : opts.prisons;
	for (let i = PRISON_VALUES.length - 1; i >= 0; i--) {
		if (PRISON_VALUES[i] > maxValue) continue;
		const n = Math.ceil(prisonsLeft / (i + 1));
		prisonsLeft -= n;
		add({ key: 'prison', type: 'prison', value: PRISON_VALUES[i], probability: 30, large: true }, n);
	}
	pool.sort((a, b) => a.value - b.value);
	return pool;
}

// TreasurePlacer::creatureToCount (the rules of the game's own Pandora's boxes)
function creatureCount(c) {
	if (!(c.aiValue > 0)) return 0;
	const tier = Math.min(PANDORA.creatures.length, Math.max(1, c.level || 1)) - 1;
	let n = Math.floor(PANDORA.creatures[tier] / c.aiValue);
	if (n < 1) return 0;
	if (n <= 5) return n;
	if (n <= 12) return Math.ceil(n / 2) * 2;
	if (n <= 50) return Math.round(n / 5) * 5;
	return Math.round(n / 10) * 10;
}

// TreasurePlacer::getRandomObject: worth a quarter of what is left up to all
// of it, by probability; a large object only while the pile has none
function randomObject(pool, desired, current, allowLarge, rng) {
	const maxVal = desired - current, minVal = Math.floor(0.25 * (desired - current));
	let total = 0;
	const cands = [];
	for (const o of pool) {
		if (o.value > maxVal) break;
		if (o.large && !allowLarge) continue;
		if (o.value >= minVal && o.left > 0 && o.probability > 0) {
			total += o.probability;
			cands.push([total, o]);
		}
	}
	if (!cands.length) return null;
	const r = 1 + Math.floor(rng() * total);
	for (const [t, o] of cands) if (t >= r) return o;
	return cands[cands.length - 1][1];
}

/** One pile, as prepareTreasurePile builds it: { desired, value, objects }. */
function preparePile(pool, band, rng = Math.random) {
	const desired = band.min + Math.floor(rng() * (band.max - band.min + 1));
	const objects = [];
	let value = 0, large = false;
	while (value <= desired - 100) {
		const o = randomObject(pool, desired, value, !large, rng);
		if (!o) break;
		if (o.large) large = true;
		objects.push(o);
		o.left--;
		value += o.value;
		if (value >= band.min && rng() < 0.5) break;
	}
	return { desired, value, objects };
}

/**
 * A zone's piles, band by band, richest first, as createTreasures asks for
 * them: floor(cells * density / 400) a band, an empty pile counted against
 * the same number of tries. Returns [{ band, count, piles }].
 */
function zonePiles(pool, bands, cells, rng = Math.random) {
	const out = [];
	for (const band of [...(bands || [])].sort((a, b) => b.max - a.max)) {
		const count = Math.floor(cells * (band.density || 0) / 400);
		const piles = [];
		let emergency = 0;
		while (piles.length < count && emergency < count) {
			const p = preparePile(pool, band, rng);
			if (!p.objects.length) { emergency++; continue; }
			piles.push(p);
		}
		out.push({ band, count, piles });
	}
	return out;
}

module.exports = { commonPool, zonePool, preparePile, zonePiles, creatureCount,
	PRISON_VALUES, SCROLL_VALUES, PANDORA, SEER_HUT_VALUE };
