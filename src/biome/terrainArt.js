/**
 * terrainArt.js - the art a building has on the ground it stands on.
 *
 * K, 2026-09-30: a frost well and a lean-to on dirt and lava biomes. The game gives most
 * buildings one template per ground (a frost well for snow, a plain one for grass, a
 * rough one for lava and caves) and some have no template for a ground at all (the
 * lean-to is snow only). The harvest behind economy.templates.json kept one art per type,
 * so a type stood on any ground in whatever art it had kept.
 *
 * objectTerrains.json (tools/harvest_object_terrains.js) holds, for every art the 71 real
 * maps carry, how many times it stood on each core terrain. artFor() answers a placement
 * with the art real maps put on that ground, drawn by how often they did, or null when
 * real maps never put the type there.
 */
'use strict';

const FILE = require('./objectTerrains.json');
const DATA = FILE.art;
const TOTAL = Object.values(FILE.totals || {}).reduce((a, b) => a + b, 0) || 1;

// the two-letter codes of the core terrains (config/terrains.json shortIdentifier)
const CORE = { dt: 'dirt', sa: 'sand', gr: 'grass', sn: 'snow', sw: 'swamp', rg: 'rough', sb: 'subterra', lv: 'lava' };

const byType = new Map();               // "type|subtype" -> arts
for (const [anim, e] of Object.entries(DATA)) {
	const k = `${e.type}|${e.subtype}`;
	if (!byType.has(k)) byType.set(k, []);
	byType.get(k).push({ anim, mask: e.mask, visitableFrom: e.visitableFrom, n: e.n, terrains: e.terrains });
}

// A type seen fewer times than this has no say: too few to tell a rule from a stray.
const MIN_SEEN = 20;
// On one ground at least this many times, or this share of its sightings, to count as allowed there.
const MIN_ON = 2, MIN_SHARE = 0.02;
// the sightings real maps would have given it on that ground, had it stood there as often as anything
const MIN_CHANCE = 3;

/**
 * short: the zone's terrain code ('gr', 'lv', ...); anything that is not a core terrain (a mod's)
 * has no data and keeps the art asked for.
 * Returns the template {animation, mask, visitableFrom} to place, the one given when nothing is
 * known, or null when real maps never stood this type on that ground.
 */
function artFor(type, subtype, tpl, short, rng) {
	const terrain = CORE[short];
	const arts = byType.get(`${type}|${subtype || 'object'}`) || byType.get(`${type}|${type}`);
	if (!terrain) return modGroundArt(type, tpl, arts, rng);
	if (!arts) return tpl;
	const seen = arts.reduce((a, x) => a + x.n, 0);
	if (seen < MIN_SEEN) return tpl;
	const ok = arts.map(a => ({ a, w: allowed(a, terrain) })).filter(x => x.w > 0);
	// a ground the type never stood on counts against it only when real maps gave it the chance: a type
	// seen 40 times has no say about a ground that carries 1 object in 100
	if (!ok.length) return seen * ((FILE.totals || {})[terrain] || 0) / TOTAL >= MIN_CHANCE ? null : tpl;
	// the art asked for is kept when real maps stand it on this ground
	const own = tpl && tpl.animation ? ok.find(x => x.a.anim === String(tpl.animation).toLowerCase()) : null;
	if (own) return tpl;
	let roll = rng() * ok.reduce((s, x) => s + x.w, 0);
	for (const x of ok) { roll -= x.w; if (roll <= 0) return { animation: x.a.anim, mask: x.a.mask, visitableFrom: x.a.visitableFrom }; }
	const x = ok[0];
	return { animation: x.a.anim, mask: x.a.mask, visitableFrom: x.a.visitableFrom };
}


// Ground a mod adds (highlands, deadland, dunes, wasteland, stardust...) has no corpus data, and an art kept as asked stood a snow
// well in a highlands biome (K, 2026-10-03/04: "still seeing the frozen well in a highlands biome"; the 72x72 map s28307801 had
// AVXwlsn0, snow only, at (65,65)). The game's rule for ground a template does not name is the template's "any land" case: an art
// the original table lets stand on every land ground. The corpus says which arts those are: one that real maps stood on at least
// NEUTRAL_MIN different core grounds. On mod ground a type keeps its art if that one is neutral, takes a neutral art of the type
// otherwise, and is refused when it has none (the landmark is owed to the next biome). What a map cannot be without (mines,
// towns, dwellings, gates, monoliths) keeps the art it was asked for. VMAPGEN_MOD_GROUND_ART=0 keeps every art as asked.
const NEUTRAL_MIN = 4;
const ESSENTIAL = /^(mine|town|randomTown|creatureGenerator|creatureBank|dragonUtopia|subterraneanGate|monolith|obelisk|shipyard|boat|seerHut|questGuard|borderGate|keymasterTent|prison|spellScroll|artifact|randomArtifact|treasureChest|pandoraBox|resource|campfire|sign|garrison|witchHut|scholar|waterWheel|windmill|mysticalGarden|learningStone)/i;
function neutral(a) {
	return Object.values(a.terrains).filter(c => c >= MIN_ON).length >= NEUTRAL_MIN;
}
function modGroundArt(type, tpl, arts, rng) {
	if (process.env.VMAPGEN_MOD_GROUND_ART === '0' || ESSENTIAL.test(String(type || ''))) return tpl;
	// an art out of a mod's own folder (hota/wasteland/..., hota/deadland/...) was drawn for that mod's ground; only the game's own arts are in question
	if (tpl && /[\/]/.test(String(tpl.animation || ''))) return tpl;
	if (!arts) return tpl;
	const seen = arts.reduce((a, x) => a + x.n, 0);
	if (seen < MIN_SEEN) return tpl;
	const ok = arts.filter(neutral);
	if (!ok.length) return null;
	if (tpl && tpl.animation && ok.some(a => a.anim === String(tpl.animation).toLowerCase())) return tpl;
	const total = ok.reduce((s, a) => s + a.n, 0);
	let roll = rng() * total;
	for (const a of ok) { roll -= a.n; if (roll <= 0) return { animation: a.anim, mask: a.mask, visitableFrom: a.visitableFrom }; }
	return { animation: ok[0].anim, mask: ok[0].mask, visitableFrom: ok[0].visitableFrom };
}

function allowed(art, terrain) {
	const c = art.terrains[terrain] || 0;
	return c >= MIN_ON || c / art.n >= MIN_SHARE ? c : 0;
}

/** True when real maps never stood this art on that ground although it had the chance (the metrics' test). */
function violates(type, subtype, animation, short) {
	const terrain = CORE[short];
	if (!terrain || !animation) return false;
	const arts = byType.get(`${type}|${subtype || 'object'}`) || byType.get(`${type}|${type}`);
	const a = arts && arts.find(x => x.anim === String(animation).toLowerCase());
	if (!a || a.n < MIN_SEEN) return false;
	return allowed(a, terrain) === 0 && a.n * ((FILE.totals || {})[terrain] || 0) / TOTAL >= MIN_CHANCE;
}

// Whether an art stands on enough different core grounds in the corpus to be fit for ground the corpus knows nothing about.
function artNeutral(animation) {
	const a = DATA[String(animation || '').toLowerCase().replace(/\.def$/, '')];
	if (!a) return null;
	return Object.values(a.terrains).filter(c => c >= MIN_ON).length >= NEUTRAL_MIN;
}
const essential = type => ESSENTIAL.test(String(type || ''));

module.exports = { artFor, violates, CORE, artNeutral, essential };
