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
					const weight = size + cb - ov * size;
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
		placed.push({ x: ax, y: ay, type: e.type, animation: e.animation,
			mask: e.mask, cells });
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
	const S = SETS[terrain];
	if (!S) return [];
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
	const cache = new Map();
	const groupsFor = z => {
		if (!cache.has(z)) cache.set(z, sizeGroups(zoneTemplates(biomeTerrain[z], rng), false));
		return cache.get(z);
	};
	const r = retile({ W, H, allowed, region, groupsFor, rng });

	const unc = new Set(r.uncovered);
	const kept = unc.size ? scenery.filter(o => blockingCells(o.template, o.x, o.y)
		.some(([x, y]) => x >= 0 && y >= 0 && x < W && y < H && unc.has(y * W + x))) : [];
	const placed = r.placed.map(p =>
		entry(p.type, p.x, p.y, l, { animation: p.animation, mask: p.mask }));
	return { objects: [...rest, ...kept, ...placed], before: scenery.length,
		after: kept.length + placed.length, kept: kept.length };
}

module.exports = { retile, retileLevel, zoneTemplates, sizeGroups, blockedOffsets };
