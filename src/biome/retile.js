/**
 * retile.js - cover a set of blocked cells with obstacle art the way the
 * engine's own RMG does (vendor\vcmi\lib\mapping\ObstacleProxy.cpp,
 * createObstacles + getWeightedObjects).
 *
 * The engine decides WHICH cells are blocked first and only then picks art for
 * them: take a blocked tile, try the biggest obstacles first in every offset
 * that puts one of their blocking cells on that tile, keep the best-scoring
 * placement, and only drop to a smaller size when nothing of this size scores
 * above zero. The result is few large pieces with small ones at the leftovers.
 * Assembling a mass out of whatever fits as it grows gives the opposite mix,
 * which is what the census shows: 2-cell pieces at 4.8x the corpus rate.
 *
 * Scoring is the engine's, term for term:
 *   weight = size + covered - overlap * size
 * where `covered` counts the piece's blocking cells still waiting for art and
 * `overlap` counts cells another retiled piece already covers. A clean fit
 * scores 2*size; one cell of overlap still scores size-1 > 0, which is how the
 * corpus ends up sharing ~8% of its blocking cells between two obstacles
 * (legal: the engine keeps a blocker list per tile, see vmap_overlap.js).
 * A piece may never block a cell outside `allowed` or leave its region, so the
 * blocked set after retiling is exactly the blocked set before it.
 *
 * Tile order: the engine walks an std::unordered_set, i.e. hash order, which is
 * unrelated to geometry. A seeded random permutation stands in for it.
 */
'use strict';

/** Blocking offsets of a mask relative to its anchor (bottom-right), engine geometry. */
function blockedOffsets(mask) {
	const out = [];
	const mh = mask.length;
	for (let i = 0; i < mh; i++) {
		const row = String(mask[i]);
		for (let j = 0; j < row.length; j++)
			if ('BHAT'.includes(row[j]))
				out.push([-(row.length - 1 - j), -(mh - 1 - i)]);
	}
	return out;
}

/**
 * Group templates by blocking size, biggest first. Each entry needs
 * {type, animation, mask}; anything with a visitable cell is refused, since
 * scenery that a hero can visit is not scenery. `dedupe` false keeps repeats:
 * the engine draws sets with replacement and a set drawn twice puts its
 * templates in the size group twice, which doubles their odds.
 */
function sizeGroups(templates, dedupe = true) {
	const bySize = new Map();
	const seen = new Set();
	for (const t of templates) {
		const mask = t.mask.map(String);
		if (mask.some(r => /[AT]/.test(r))) continue;
		const key = t.animation.toLowerCase() + '|' + mask.join('/');
		if (dedupe && seen.has(key)) continue;
		seen.add(key);
		const offs = blockedOffsets(mask);
		if (!offs.length) continue;
		const e = { type: t.type, animation: t.animation, mask, offs };
		// a mod's obstacle can be a subtype of its own (core's are all "object")
		if (t.subtype && t.subtype !== 'object') e.subtype = t.subtype;
		if (!bySize.has(offs.length)) bySize.set(offs.length, []);
		bySize.get(offs.length).push(e);
	}
	return [...bySize.entries()].sort((a, b) => b[0] - a[0]);
}

function shuffle(arr, rng) {
	const a = arr.slice();
	for (let i = a.length - 1; i > 0; i--) {
		const j = (rng() * (i + 1)) | 0;
		const t = a[i]; a[i] = a[j]; a[j] = t;
	}
	return a;
}

/**
 * Cover every cell with allowed[c] === 1 using art from groupsFor(region[c]).
 *
 *   W, H        level size
 *   allowed     Uint8Array(W*H): 1 where a piece may block
 *   region      Int32Array(W*H): a piece's blocking cells must share one id
 *   groupsFor   region id -> sizeGroups(...) result (cache it; called often)
 *   rng         () => [0,1)
 *
 * Returns { placed: [{x, y, type, animation, mask, cells}], uncovered: [c] }.
 * `uncovered` are cells no piece could reach without leaving the allowed set;
 * the caller decides what to do with them (the engine leaves them bare).
 */
function retile({ W, H, allowed, region, groupsFor, rng }) {
	const N = W * H;
	// 0 = not ours, 1 = waiting for art, 2 = covered
	const state = new Uint8Array(N);
	const order = [];
	for (let c = 0; c < N; c++) if (allowed[c]) { state[c] = 1; order.push(c); }
	const scan = shuffle(order, rng);
	const placed = [], uncovered = [];
	// Variety (K, 2026-10-03, a giant map: "a lot of terrain blocker repetition that looks really bad...we need to ensure
	// variety and as much random variation as possible along borders"): a piece's score loses half its size for each
	// piece of the same art already anchored within REP_R tiles, so four twins near by score it out and another piece or
	// size takes the spot. Our masses are bigger and more solid than the engine's, so its own scoring alone stamped one
	// best-fitting piece across them (decorrepeat.js on a giant map: 21 of one piece within 6 tiles; the engine's worst 9).
	// VMAPGEN_DECOR_REPEAT sets the penalty per twin as a share of size (0.5; 0 off), VMAPGEN_DECOR_REPEAT_R the reach (6).
	const REP = Number(process.env.VMAPGEN_DECOR_REPEAT ?? 0.5), REP_R = Number(process.env.VMAPGEN_DECOR_REPEAT_R || 6);
	const bucket = new Map(), BK = 8;
	const bkey = (x, y) => ((y / BK) | 0) * 100000 + ((x / BK) | 0);
	const twins = (anim, ax, ay) => {
		if (!REP) return 0;
		let n = 0;
		for (let by = ((ay - REP_R) / BK) | 0; by <= ((ay + REP_R) / BK | 0); by++)
			for (let bx = ((ax - REP_R) / BK) | 0; bx <= ((ax + REP_R) / BK | 0); bx++)
				for (const q of bucket.get(by * 100000 + bx) || [])
					if (q.anim === anim && Math.abs(q.x - ax) <= REP_R && Math.abs(q.y - ay) <= REP_R) n++;
		return n;
	};

	for (const t of scan) {
		if (state[t] !== 1) continue;
		const tx = t % W, ty = (t / W) | 0, reg = region[t];
		const groups = groupsFor(reg) || [];
		let maxWeight = -Infinity;
		let cands = [];
		for (const [size, temps] of groups) {
			for (const e of shuffle(temps, rng)) {
				for (const [odx, ody] of e.offs) {
					// anchor so that this blocking offset lands on t
					const ax = tx - odx, ay = ty - ody;
					if (ax < 0 || ay < 0 || ax >= W || ay >= H) continue;
					let cb = 0, ov = 0, ok = true;
					for (const [dx, dy] of e.offs) {
						const x = ax + dx, y = ay + dy;
						if (x < 0 || y < 0 || x >= W || y >= H) { ok = false; break; }
						const c = y * W + x;
						if (!allowed[c] || region[c] !== reg) { ok = false; break; }
						if (state[c] === 1) cb++; else ov++;
					}
					if (!ok) continue;
					const weight = size + cb - ov * size - (REP ? REP * size * twins(e.animation, ax, ay) : 0);
					if (weight > maxWeight) {
						maxWeight = weight;
						cands = [[e, ax, ay]];
						if (weight > 0) break;
					} else if (weight === maxWeight) cands.push([e, ax, ay]);
				}
			}
			if (maxWeight > 0) break;
		}
		if (!cands.length) { uncovered.push(t); continue; }
		const [e, ax, ay] = cands[(rng() * cands.length) | 0];
		const cells = [];
		for (const [dx, dy] of e.offs) {
			const c = (ay + dy) * W + (ax + dx);
			state[c] = 2;
			cells.push(c);
		}
		if (REP) { const k = bkey(ax, ay); if (!bucket.has(k)) bucket.set(k, []); bucket.get(k).push({ anim: e.animation, x: ax, y: ay }); }
		placed.push({ x: ax, y: ay, type: e.type, animation: e.animation,
			mask: e.mask, cells, ...(e.subtype ? { subtype: e.subtype } : {}) });
	}
	return { placed, uncovered };
}

/*
 * The engine's obstacle sets, snapshotted by `! LLM Files\Tools\
 * build_decor_sets.js` from config/biomes.json joined with harvested masks.
 * terrain -> objectType -> [{name, factions, templates}].
 */
let SETS = {};
try { SETS = require('./decor.sets.json').sets || {}; } catch (e) { SETS = {}; }

/*
 * The mods' own obstacle sets, added for each map from the asset index
 * (generate.js): a mod declares them in its "biomes" files exactly as core
 * does in config/biomes.json, for core terrains (HotA's palms and dunes on
 * sand, glaciers on snow) and for its own. The engine keeps one list per
 * object type, core's sets first and then each mod's in load order, and a
 * zone draws from them all alike. Same shape as SETS; cleared before each map
 * so one install's sets never reach a map made for another in this process.
 */
let MOD_SETS = {};
function registerModSet(terrain, objectType, set) {
	const byType = MOD_SETS[terrain] || (MOD_SETS[terrain] = {});
	(byType[objectType] || (byType[objectType] = [])).push(set);
}
function clearModSets() { MOD_SETS = {}; }
/** H3's own obstacle templates by def name (lowercase), from the core sets' snapshot: what a mod's set may name. */
function coreSetTemplates() {
	const out = new Map();
	for (const byType of Object.values(SETS))
		for (const list of Object.values(byType))
			for (const s of list)
				for (const t of s.templates || [])
					if (!out.has(t.animation.toLowerCase())) out.set(t.animation.toLowerCase(), t);
	return out;
}
function setsFor(terrain) {
	const core = SETS[terrain], mods = MOD_SETS[terrain];
	if (!mods) return core;
	const out = {};
	for (const t of new Set([...Object.keys(core || {}), ...Object.keys(mods)]))
		out[t] = [...((core && core[t]) || []), ...(mods[t] || [])];
	return out;
}

const nextInt = (lo, hi, rng) => lo + ((rng() * (hi - lo + 1)) | 0);   // inclusive, as vstd::RNG
const nextItem = (arr, rng) => arr[(rng() * arr.length) | 0];

/**
 * One zone's obstacle templates, drawn the way ObstacleProxy::prepareBiome
 * draws them: one mountain set, one or two tree sets, one lake-or-crater set,
 * one or two rock sets, one to (3 - rock sets) plant sets, then three to five
 * small sets from structures and animals topped up with "other". Tree, rock and
 * plant sets are drawn with replacement, as nextItem does. Fewer than three
 * sets falls back to every obstacle for the terrain ("old method").
 *
 * Faction-gated sets are left out: the engine offers them only to zones whose
 * town faction matches, core has one (swampTreesOnGrass, fortress), and our
 * zones carry no faction outside the player starts.
 */
function zoneTemplates(terrain, rng) {
	const S = setsFor(terrain);
	if (!S) return require('./decor').terrainDecorTemplates(terrain);
	const open = list => (list || []).filter(s => !s.factions || !s.factions.length);
	const chosen = [];
	const mountains = open(S.mountain);
	if (mountains.length) chosen.push(nextItem(mountains, rng));
	const trees = open(S.tree);
	for (let i = 0, n = Math.min(trees.length, nextInt(1, 2, rng)); i < n; i++)
		chosen.push(nextItem(trees, rng));
	const large = [...open(S.lake), ...open(S.crater)];
	if (large.length) chosen.push(nextItem(large, rng));
	const rocks = open(S.rock);
	const rockCount = Math.min(rocks.length, nextInt(1, 2, rng));
	for (let i = 0; i < rockCount; i++) chosen.push(nextItem(rocks, rng));
	const plants = open(S.plant);
	for (let i = 0, n = Math.min(plants.length, nextInt(1, Math.max(3 - rockCount, 2), rng)); i < n; i++)
		chosen.push(nextItem(plants, rng));
	const maxSmall = Math.min(5, Math.max(3, 9 - chosen.length));
	let small = nextInt(3, maxSmall, rng);
	const smallSets = shuffle([...open(S.structure), ...open(S.animal)], rng);
	const other = shuffle(open(S.other), rng);
	while (small > 0) {
		if (smallSets.length) { chosen.push(smallSets.pop()); small--; }
		else if (!other.length) break;
		if (small > 0 && other.length) { chosen.push(other.pop()); small--; }
	}
	if (chosen.length < 3)
		return Object.values(S).flat().flatMap(s => s.templates);
	return chosen.flatMap(s => s.templates);
}

/**
 * Re-cover one level's scenery with engine-style obstacle art.
 *
 *   objects        the plan's object list (other levels pass through untouched)
 *   zone, biomeTerrain  cell -> zone id, zone id -> terrain short code
 *   isScenery(o)   which objects are art the retile may replace
 *   blockingCells(tpl, x, y) -> [[x, y], ...]
 *   entry(type, x, y, l, tpl) -> a new object
 *
 * Cells a functional object also blocks stay with that object. A cell no set
 * can cover without leaving its zone keeps the original piece that covered it,
 * so the blocked set after is exactly the blocked set before.
 */
function retileLevel({ objects, zone, biomeTerrain, W, H, l, rng, isScenery,
	blockingCells, entry }) {
	const N = W * H;
	const keep = new Uint8Array(N), allowed = new Uint8Array(N);
	const scenery = [], rest = [];
	for (const o of objects)
		((o.l || 0) === l && isScenery(o) ? scenery : rest).push(o);
	const mark = (o, arr) => {
		for (const [x, y] of blockingCells(o.template, o.x, o.y))
			if (x >= 0 && y >= 0 && x < W && y < H) arr[y * W + x] = 1;
	};
	for (const o of rest) if ((o.l || 0) === l) mark(o, keep);
	for (const o of scenery) mark(o, allowed);
	for (let c = 0; c < N; c++) if (keep[c]) allowed[c] = 0;

	const region = Int32Array.from(zone);
	// A zone draws its obstacle sets once per DECOR_SET_AREA tiles (VMAPGEN_DECOR_SET_AREA, 2500): the engine draws once
	// whatever the zone's size, which is variety enough for its zones at the template's own sizes (about 1500 to 2800
	// tiles at XL) and far too little for a giant map's (5000 to 8000), where a handful of pieces covered every mass
	// (K, 2026-10-03). At XL a zone still draws once, as the engine's do.
	const AREA = Number(process.env.VMAPGEN_DECOR_SET_AREA || 2500);
	const areaOf = new Map();
	for (let c = 0; c < N; c++) areaOf.set(zone[c], (areaOf.get(zone[c]) || 0) + 1);
	const cache = new Map();
	const groupsFor = z => {
		if (!cache.has(z)) {
			const rounds = Math.max(1, Math.round((areaOf.get(z) || 0) / AREA));
			const temps = [];
			for (let i = 0; i < rounds; i++) temps.push(...zoneTemplates(biomeTerrain[z], rng));
			cache.set(z, sizeGroups(temps, false));
		}
		return cache.get(z);
	};
	const r = retile({ W, H, allowed, region, groupsFor, rng });

	const unc = new Set(r.uncovered);
	const kept = unc.size ? scenery.filter(o => blockingCells(o.template, o.x, o.y)
		.some(([x, y]) => x >= 0 && y >= 0 && x < W && y < H && unc.has(y * W + x))) : [];
	const placed = r.placed.map(p =>
		entry(p.type, p.x, p.y, l, { animation: p.animation, mask: p.mask }, p.subtype || 'object'));
	if (process.env.VMAPGEN_DECOR_TRACE) {
		// which pass each piece came from: the retile's own, kept where no set fits, or never scenery to it
		const tally = (list, f) => { const m = new Map(); for (const o of list) { const k = String((o.template && o.template.animation) || o.animation || '?').split('/').pop(); m.set(k, (m.get(k) || 0) + 1); } return [...m].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([k, v]) => `${k}:${v}`).join(' '); };
		const restScen = rest.filter(o => (o.l || 0) === l && o.template && o.template.mask && !o.template.mask.some(r2 => /[AT]/.test(r2)));
		console.error(`[decor] level ${l}: retiled ${tally(r.placed)} | kept ${tally(kept)} | untouched non-visitable ${tally(restScen)}`);
		// where single-tile pieces come from: the blocked clusters handed in (8-way) by size, against the pieces placed by size
		const seen = new Uint8Array(N), comp = { 1: 0, 2: 0, '3-4': 0, '5-8': 0, '9+': 0 }, pcs = { 1: 0, 2: 0, '3-4': 0, '5-8': 0, '9+': 0 };
		const bin = n => n === 1 ? 1 : n === 2 ? 2 : n <= 4 ? '3-4' : n <= 8 ? '5-8' : '9+';
		for (let c = 0; c < N; c++) {
			if (!allowed[c] || seen[c]) continue;
			let n = 0; const q = [c]; seen[c] = 1;
			while (q.length) {
				const k = q.pop(); n++;
				const x = k % W, y = (k / W) | 0;
				for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
					const u = x + dx, v = y + dy;
					if (u < 0 || v < 0 || u >= W || v >= H) continue;
					const m = v * W + u;
					if (allowed[m] && !seen[m]) { seen[m] = 1; q.push(m); }
				}
			}
			comp[bin(n)]++;
		}
		for (const p of r.placed) pcs[bin(blockedOffsets(p.mask).length)]++;
		console.error(`[decor] level ${l}: blocked clusters handed in ${JSON.stringify(comp)} | pieces placed ${JSON.stringify(pcs)}`);
	}
	return { objects: [...rest, ...kept, ...placed], before: scenery.length,
		after: kept.length + placed.length, kept: kept.length };
}

module.exports = { retile, retileLevel, zoneTemplates, sizeGroups, blockedOffsets,
	registerModSet, clearModSets, coreSetTemplates };
