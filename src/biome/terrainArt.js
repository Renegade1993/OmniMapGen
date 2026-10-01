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
	if (!terrain) return tpl;
	const arts = byType.get(`${type}|${subtype || 'object'}`) || byType.get(`${type}|${type}`);
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

module.exports = { artFor, violates, CORE };
