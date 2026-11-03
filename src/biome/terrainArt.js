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
function artFor(type, subtype, tpl, short, rng, keepOwn = true) {
	// a mod's ground answers as the core ground it is nearest (setKin); what the corpus refuses there falls back to the mod-ground rule
	// the kin's draws come from a stream of their own (KIN_RNG) and the old answer is drawn as before, so the shared stream moves exactly as it
	// did and the fix changes art only (the Reviewer, 2026-11-03: the shared draws moved 2,571 of 2,846 objects on K's seed)
	if (false && !CORE[short] && KIN.has(short)) { const old = modGroundArt(type, tpl, byType.get(`${type}|${subtype || 'object'}`) || byType.get(`${type}|${type}`), rng); if (old === null) return null; const r = artFor(type, subtype, tpl, KIN.get(short).short, KIN_RNG, false); return r === null ? old : r; }
	const terrain = CORE[short];
	const arts = byType.get(`${type}|${subtype || 'object'}`) || byType.get(`${type}|${type}`);
	if (!terrain) return modGroundArt(type, tpl, arts, rng);
	if (!arts) return gameTable(type, tpl, terrain);
	const seen = arts.reduce((a, x) => a + x.n, 0);
	if (seen < MIN_SEEN) return gameTable(type, tpl, terrain);
	const ok = arts.map(a => ({ a, w: allowed(a, terrain) })).filter(x => x.w > 0);
	// a ground the type never stood on counts against it only when real maps gave it the chance: a type
	// seen 40 times has no say about a ground that carries 1 object in 100
	if (!ok.length) return seen * ((FILE.totals || {})[terrain] || 0) / TOTAL >= MIN_CHANCE ? null : tpl;
	// the art asked for is kept when real maps stand it on this ground
	// (on a mod ground, answered as its kin, the art is drawn by how often real maps stood each on the kin: the grass ore pit stands on rough now and then, and kept as asked it was still most of plateau's mines)
	const own = keepOwn && tpl && tpl.animation ? ok.find(x => x.a.anim === String(tpl.animation).toLowerCase()) : null;
	if (own) return tpl;
	let roll = rng() * ok.reduce((s, x) => s + x.w, 0);
	for (const x of ok) { roll -= x.w; if (roll <= 0) return { animation: x.a.anim, mask: x.a.mask, visitableFrom: x.a.visitableFrom }; }
	const x = ok[0];
	return { animation: x.a.anim, mask: x.a.mask, visitableFrom: x.a.visitableFrom };
}


// Where the corpus has no say (a type seen fewer than MIN_SEEN times, or never), the game's own table does: an art OBJECTS.TXT lists keeps
// to the grounds its rows name, as the engine's canBePlacedAt does; an art it does not list (a mod's) stays as asked. K, 2026-10-22: "Oasis
// in dirt, where it shouldnt be" (the oasis AVXosis0 is sand only there; the corpus had six sightings). VMAPGEN_ART_GAME_TABLE=0 off.
let ART_TERRAINS;
// the pickups' rows name dirt only, and the game places them on every ground (the corpus: gold, ore, scrolls, random artifacts everywhere)
const PICKUP_TYPES = /^(resource|randomResource|treasureChest|campfire|randomArtifact|artifact|spellScroll|pandoraBox|seaChest|prison|monster|randomMonster|hero|randomHero)/;
function gameTable(type, tpl, terrain) {
	if (process.env.VMAPGEN_ART_GAME_TABLE === '0' || !tpl || !tpl.animation || PICKUP_TYPES.test(String(type || ''))) return tpl;
	if (ART_TERRAINS === undefined) {
		try { ART_TERRAINS = require('../parser/h3data').h3ArtTerrains(require('./pictures').spriteRoots()); } catch (e) { ART_TERRAINS = new Map(); }
	}
	const set = ART_TERRAINS.get(String(tpl.animation).toLowerCase().replace(/\.def$/, ''));
	return !set || set.has(terrain) ? tpl : null;
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

// A mod's ground and the core ground it is nearest (K, 2026-11-02, item 22: "the map generator is trying to figure out what type of town
// it is and match a generation type to a terrain type it doesn't implicitly know"; the grass ore pit with its green rim stood on plateau,
// a newtown-terrains ground the corpus knows nothing of, because a mine keeps the art it was asked for on mod ground). Read from the
// ground's own terrains.json, no list of mods: a ground that plays a core ground's music is that ground's kin (plateau plays Rough.mp3,
// fiery land Lava.mp3, mead land and terrace Grass.mp3); otherwise the core land ground whose minimap colour is nearest. Water, rock
// and impassable grounds have no kin. VMAPGEN_MOD_GROUND_KIN=0 keeps the old rule (every mod ground answers with the art asked for).
const KIN = new Map();
let KIN_RNG = Math.random;
function setKin(terrains, seed = 1) {
	KIN.clear();
	let h = ((Number(seed) || 1) ^ 0x6b1d3) >>> 0 || 1;
	KIN_RNG = () => { h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0; return h / 4294967296; };
	if (process.env.VMAPGEN_MOD_GROUND_KIN === '0' || !terrains) return '';
	const core = new Map();
	for (const [short, t] of terrains) if (CORE[short] && String(t.name || '').startsWith('core:')) core.set(short, t);
	const land = [...core].filter(([short]) => short !== 'sb');
	const said = [];
	for (const [short, t] of terrains) {
		if (CORE[short] || core.has(short) || !(Number(t.moveCost) > 0) || (t.types || []).some(x => /water|rock/i.test(String(x)))) continue;
		const music = new Set((t.music || []).map(m => String(m).toLowerCase().replace(/^.*[\/]/, '')));
		let kin = land.find(([, c]) => (c.music || []).some(m => music.has(String(m).toLowerCase().replace(/^.*[\/]/, ''))));
		let how = 'music';
		if (!kin && Array.isArray(t.minimap)) {
			const pool = (t.allowedLayers || []).some(x => /sub/i.test(String(x))) && !(t.allowedLayers || []).some(x => /surface/i.test(String(x))) ? [...core] : land;
			let bd = Infinity;
			for (const e of pool) { const m = e[1].minimap; if (!Array.isArray(m)) continue; const d = (m[0] - t.minimap[0]) ** 2 + (m[1] - t.minimap[1]) ** 2 + (m[2] - t.minimap[2]) ** 2; if (d < bd) { bd = d; kin = e; } }
			how = 'colour';
		}
		if (!kin) continue;
		KIN.set(short, { short: kin[0], how });
		said.push(`${short}->${CORE[kin[0]]} (${how})`);
	}
	return said.join(', ');
}
const kinOf = short => (KIN.get(short) || {}).short || null;
/**
 * After placement, an object on a mod ground takes its kin's art where that art has the same footprint (mask and visitableFrom), so
 * nothing moves and no other draw changes (the Reviewer, 2026-11-03: drawn during placement, the kin moved 2,491 of 2,846 objects on
 * K's seed). objects: the map's list; groundAt(o) -> the two-letter ground under its visiting tile; mineArt(subtype, kin) -> the
 * mine template the table gives the kin. Returns the number swapped.
 */
function kinSwap(objects, groundAt, mineArt) {
	let n = 0;
	if (!KIN.size) return 0;
	const same = (a, b) => JSON.stringify(a.mask) === JSON.stringify(b.mask) && JSON.stringify(a.visitableFrom || null) === JSON.stringify(b.visitableFrom || null);
	for (const o of objects) {
		if (!o || !o.template || !o.template.animation || /[/]/.test(String(o.template.animation))) continue;
		const g = groundAt(o), k = g && !CORE[g] ? kinOf(g) : null;
		if (!k) continue;
		let cand = null;
		if (o.type === 'mine') cand = mineArt(o.subtype, k);
		else { const r = artFor(o.type, o.subtype, o.template, k, KIN_RNG, false); if (r && r !== o.template) cand = r; }
		if (!cand || !cand.animation || String(cand.animation).toLowerCase() === String(o.template.animation).toLowerCase()) continue;
		if (!same(cand, o.template)) continue;
		o.template = { ...o.template, animation: cand.animation };
		n++;
	}
	return n;
}

module.exports = { artFor, violates, CORE, artNeutral, essential, setKin, kinOf, kinSwap };
