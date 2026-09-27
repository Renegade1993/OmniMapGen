/**
 * decor.js - the terrain features that give a map its shape.
 *
 * The generator used to place scenery one cell at a time along biome borders
 * and nowhere else, drawing from about ten pieces of art. Measured against the
 * 71 installed RMG maps that is wrong in two ways at once:
 *
 *   - real maps block 17.8 percent of their cells with scenery, ours blocked 5
 *   - real maps place 96.8 percent of it as multi-cell clusters, ours 0
 *
 * A 4x6 mountain, a 2x3 lake, a stand of oaks: those are what make a Heroes 3
 * map read as terrain with lanes through it rather than an open field with
 * confetti on it. They also matter for play, because they are what forces a
 * hero down one path instead of another, and the AI's pathfinding only gets
 * exercised on a map that has paths.
 *
 * Templates are harvested from the corpus, keyed by the terrain they stood on,
 * and filtered to core art only: no animation path here contains a slash, so a
 * map using them needs no mods. See decor.templates.json.
 *
 * Placement goes through the normal object path in content.js, which already
 * bounds-checks the footprint, refuses a placement that would wall part of the
 * level off, and skips cells another object owns. Nothing here may place
 * anything itself.
 */
'use strict';

const DATA = require('./decor.templates.json');

/*
 * 2026-09-23 census rebalance against the repointed 75-map corpus
 * (MapsArchive union with the four live maps). The harvested pool
 * weights put the corpus's own mix in, but placement attrition and our
 * terrain mix skew what lands: mass pieces (mountain, canyon) and the
 * thin special types run under, one-cell singles over by an order of
 * magnitude. Multiplying each pool entry's weight by the measured
 * ours/corpus ratio, capped so nothing is pushed past corpus, moves the
 * emitted mix toward the real one. Packs are exempt: they are whole
 * authored masses drawn uniformly, not a type lottery.
 */
const TYPE_REWEIGHT = {
	// LOW against corpus. mushrooms/subterraneanRocks/lavaLake were at
	// 15/15/8 while they existed only under 'sb'; the 2026-09-23 harvest
	// re-harvested them into every terrain pool at corpus share, so they
	// no longer need a multiplier.
	mountain: 2.2, pineTrees: 1.8, deadVegetation: 1.8,
	canyon: 3.0, trees: 1.4,
	// HIGH against corpus - mostly the one-cell fringe the settle pass
	// spends leftovers on, so the cuts are deep.
	grassHills: 0.20, shrub: 0.25, flowers: 0.25, stump: 0.12,
	skull: 0.30, dirtHills: 0.35, swampFoliage: 0.25, crater: 0.45,
	oakTrees: 0.6,
	rock: 0.40, lake: 0.45, lavaFlow: 0.50, cactus: 0.35, volcano: 0.45,
	desertHills: 0.55, outcropping: 0.70, sandDune: 0.60,
	frozenLake: 0.70, mound: 0.90,
};
for (const sec of ['clusters', 'single'])
	for (const terr in (DATA[sec] || {}))
		for (const e of DATA[sec][terr])
			if (TYPE_REWEIGHT[e.type]) e.weight *= TYPE_REWEIGHT[e.type];
// Mushroom groves are a subterranean feature: the corpus puts 1991 of its
// 2393 mushrooms on level 1. The harvested sb pools carry them thin, so
// the underground channels emit 0.3x corpus while the type already sits
// inside every terrain pool at corpus share.
for (const e of DATA.clusters.sb || [])
	if (e.type === 'mushrooms' || e.type === 'subterraneanRocks')
		e.weight *= 2.5;
// audit loop: a further mushrooms x1.8 moved 0.47->0.42 - the weight is
// not the constraint, the thin sb floor is (8.2% vs corpus 19.6%).
// Left at the 2.5x step.
for (const e of DATA.single.sb || [])
	if (e.type === 'subterraneanRocks') e.weight *= 1.5;

/**
 * Share of a level's cells real maps cover with scenery.
 *
 * 30.7 percent, measured over the 40 corpus maps within a factor of two of
 * 108x108 by area: 68.16 decorations per 1000 cells, 5.03 blocking cells each,
 * overlapping only 1.08 to 1. A first pass used 17.8, which came from pooling
 * all 71 corpus maps including the 216x216s, and density falls off hard with
 * map size, so that figure understated a normal map by nearly half.
 *
 * Nearly a third of the map impassable sounds like a lot and is what Heroes 3
 * maps are: terrain with corridors through it rather than a field. Border
 * barriers already contribute, so the fill asks for the difference rather than
 * the whole thing, and content.js works that out from what is already blocked
 * in the biome it is filling.
 */
const DECOR_BLOCKED_SHARE = 0.78;

/*
 * Raising this to 0.45 was tried on 2026-09-21 and reverted. It is recorded
 * here because the quantity it targets is genuinely short and the obvious fix
 * made the map worse UNDER THE OLD PLACEMENT.
 *
 * Counting unique blocked cells against walkable floor, real surfaces run
 * 55.6% (33 corpus maps of 4k-12k cells) and ours ran 42.9%. Raising the share
 * to 0.45 closed that to 54.0%. Every other number got worse:
 *
 *   72x72, against five corpus maps of the same 5184 cells
 *                        corpus      ours 0.31   ours 0.45
 *     blocked cells      2938-3232   2224        2799
 *     blocked components 39-73       92          32
 *     largest component  43.6-83.8%  58.6%       95.2%
 *     free cells         2073 mean   2960        2385
 *     free cells in a free 2x2  81.1%  76.5%     61.7%
 *
 * Real maps hold LESS open ground than we do and it is far ROOMIER. They put
 * their blocking in about fifty discrete masses with wide ground between;
 * the old scattered-disc placement spread into one connected web that frayed
 * the open space into corridors, so the budget was the wrong lever THEN.
 *
 * Reinstated on 2026-09-21 after interior masses switched to accretion
 * (content.js, the frontier growth that the border pass already used): new
 * cells join an existing mass instead of spawning a new tendril, so the same
 * share no longer frays the open ground. If roominess ever collapses again,
 * check whether placement has regressed to scatter before touching this.
 */

/**
 * The same share for a carved underground, which is a different number.
 *
 * Measured over the corpus's 32 two-level maps, counting every blocking cell
 * against the walkable floor rather than against the whole level: the surface
 * runs 55.7% of its floor occupied, the underground 33.1%. A cave is tunnels
 * through rock, so the floor it does have stays comparatively clear, and
 * asking for the surface's share down there buried it (44.9% on a 96x96).
 *
 * Scenery is budgeted before the functional content goes in, so this asks for
 * the difference rather than the whole 33.1%: mines, banks, dwellings and
 * guards land on about 17% of an underground floor on their own.
 */
const DECOR_BLOCKED_SHARE_UNDERGROUND = 0.17;

/** Mean blocking cells per cluster on `terrain`, for turning a share into a count. */
const clusterSize = terrain => {
	const pool = DATA.clusters[terrain];
	if (!pool || !pool.length) return 5;
	return pool.reduce((a, e) => a + e.weight * e.cells, 0) || 5;
};

function weightedPick(pool, rng, minCells = 0) {
	if (!pool || !pool.length) return null;
	if (minCells > 0) {
		const big = pool.filter(e => e.cells >= minCells);
		if (big.length) pool = big;
	}
	let roll = rng() * pool.reduce((a, e) => a + e.weight, 0);
	for (const e of pool) { roll -= e.weight; if (roll <= 0) return e; }
	return pool[pool.length - 1];
}

/**
 * A free-standing terrain feature for `terrain`, or null if we have none.
 *
 * Terrains we have no data for (modded ones, water, rock) return null and the
 * caller places nothing, which is the right answer: inventing art for a
 * terrain we have never seen a real map decorate is how the previous set ended
 * up with six animation names that exist in no config file anywhere.
 */
function clusterTemplate(terrain, rng) {
	const pick = weightedPick(DATA.clusters[terrain], rng);
	if (!pick) return null;
	const tpl = { animation: pick.animation, mask: pick.mask };
	if (pick.visitableFrom) tpl.visitableFrom = pick.visitableFrom;
	return { type: pick.type, subtype: pick.subtype || 'object', tpl };
}

/**
 * Up to `n` clusters for `terrain`, biggest footprint first.
 *
 * For building a biome wall out of real terrain instead of a line of one-cell
 * ornaments. The caller places one only where every blocking cell of it falls
 * on a cell the wall already owns, so a mountain here can never block anything
 * the wall was not already blocking, and connectivity is untouched.
 */
function wallClusters(terrain, rng, n = 6, minCells = 0) {
	const pool = DATA.clusters[terrain];
	if (!pool || !pool.length) return [];
	const picked = [];
	for (let i = 0; i < n; i++) {
		// draw big pieces preferentially: a corpus mass is built out of
		// five-to-thirteen-cell mountains, not the two-cell crumbs that
		// dominate the pool by raw count. Bias the draw by cell size so
		// mass-sized pieces get a turn before the weight lottery runs.
		const e = weightedPick(pool, rng, minCells);
		if (!e) break;
		picked.push(e);
	}
	picked.sort((a, b) => b.cells - a.cells);
	return picked.map(e => {
		const tpl = { animation: e.animation, mask: e.mask };
		if (e.visitableFrom) tpl.visitableFrom = e.visitableFrom;
		return { type: e.type, subtype: e.subtype || 'object', tpl, cells: e.cells };
	});
}

/**
 * A horizontal two-cell piece for `terrain`, for pocket fills. The corpus
 * spends its nooks as 2-cell dominoes where we were spending two singles;
 * same blocked cells, half the objects. Only horizontal pieces exist in the
 * harvested pools - vertical pockets keep singles.
 */
function dominoTemplate(terrain, rng) {
	const pool = (DATA.clusters[terrain] || []).filter(e => {
		if (e.cells !== 2) return false;
		const bl = [];
		e.mask.forEach((row, i) => String(row).split('').forEach((ch, j) => {
			if ('BHAT'.includes(ch)) bl.push([j, i]);
		}));
		// a horizontal domino: two cells side by side on one row
		return bl.length === 2 && bl[0][1] === bl[1][1]
			&& bl[1][0] === bl[0][0] + 1;
	});
	if (!pool.length) return null;
	const pick = weightedPick(pool, rng);
	if (!pick) return null;
	// Anchoring is bottom-right of the mask; find where the RIGHT cell of
	// the pair sits so the caller can place the piece over two given cells.
	const w = pick.mask[0].length, h = pick.mask.length;
	let rj = -1, ri = -1;
	pick.mask.forEach((row, i) => String(row).split('').forEach((ch, j) => {
		if ('BHAT'.includes(ch) && j > rj) { rj = j; ri = i; }
	}));
	return { type: pick.type, subtype: pick.subtype || 'object',
		tpl: { animation: pick.animation, mask: pick.mask },
		anchorDx: w - 1 - rj, anchorDy: h - 1 - ri };
}

/**
 * A 2-3 cell piece for `terrain`, bent preferred: L-trominoes and dominoes
 * for leftover notches the single-cell fallback would spend one object each
 * on. Pool order matters less than geometry here, so the caller supplies the
 * cells it wants covered and keeps the piece only if they all land inside.
 */
function trominoTemplate(terrain, rng) {
	const pool = (DATA.clusters[terrain] || []).filter(e => {
		if (e.cells < 2 || e.cells > 3) return false;
		const bl = [];
		e.mask.forEach((row, i) => String(row).split('').forEach((ch, j) => {
			if ('BHAT'.includes(ch)) bl.push([j, i]);
		}));
		if (bl.length !== e.cells) return false;
		const xs = bl.map(b => b[0]), ys = bl.map(b => b[1]);
		const w = Math.max(...xs) - Math.min(...xs) + 1;
		const h = Math.max(...ys) - Math.min(...ys) + 1;
		return w <= 2 && h <= 2;   // domino, corner domino, or L-tromino
	});
	if (!pool.length) return null;
	const pick = weightedPick(pool, rng);
	if (!pick) return null;
	const w = pick.mask[0].length, h = pick.mask.length;
	let rj = -1, ri = -1;
	pick.mask.forEach((row, i) => String(row).split('').forEach((ch, j) => {
		if ('BHAT'.includes(ch) && j > rj) { rj = j; ri = i; }
	}));
	return { type: pick.type, subtype: pick.subtype || 'object',
		tpl: { animation: pick.animation, mask: pick.mask },
		anchorDx: w - 1 - rj, anchorDy: h - 1 - ri };
}

/**
 * A small piece (domino or L-tromino, any harvested orientation) for
 * covering a cell whose neighbours are already blocked. The corpus's lone
 * leftover reads as part of the mass it sits against; ours was a one-cell
 * object on open ground, which is most of the item-4 fringe. `cells` lists
 * the piece's blocking cells so the caller can anchor any of them on the
 * cell it wants covered - the rest must land on ground already blocked.
 */
function mergedTemplate(terrain, rng) {
	const pool = (DATA.clusters[terrain] || []).filter(e => {
		if (e.cells < 2 || e.cells > 3) return false;
		const bl = [];
		e.mask.forEach((row, i) => String(row).split('').forEach((ch, j) => {
			if ('BHAT'.includes(ch)) bl.push([j, i]);
		}));
		if (bl.length !== e.cells) return false;
		const xs = bl.map(b => b[0]), ys = bl.map(b => b[1]);
		return Math.max(...xs) - Math.min(...xs) <= 1
			&& Math.max(...ys) - Math.min(...ys) <= 1;
	});
	if (!pool.length) return null;
	const pick = weightedPick(pool, rng);
	if (!pick) return null;
	const cells = [];
	pick.mask.forEach((row, i) => String(row).split('').forEach((ch, j) => {
		if ('BHAT'.includes(ch)) cells.push([j, i, String(row).length]);
	}));
	return { type: pick.type, subtype: pick.subtype || 'object',
		tpl: { animation: pick.animation, mask: pick.mask }, cells };
}

/** One-cell blocking art for `terrain`, for the border barrier pass. */
function singleTemplate(terrain, rng) {
	const pick = weightedPick(DATA.single[terrain], rng);
	if (!pick) return null;
	return { type: pick.type, subtype: pick.subtype || 'object',
		tpl: { animation: pick.animation, mask: pick.mask } };
}

/**
 * Whole obstacle packs mined out of the corpus: the scenery skeleton of a
 * real blocked mass, objects kept in their authored relative positions.
 * A pack places as one unit and keeps the mass outline a real map's pack
 * had - flat flanks and pocket mouths instead of the cell-by-cell scallops
 * accreted clusters produce. decor.packs.json is generated by the harvest
 * script; if it is absent the caller falls back to cluster accretion.
 */
let PACKS = {};
try { PACKS = require('./decor.packs.json'); } catch (e) { PACKS = {}; }

/**
 * A pack for `terrain` near `targetCells` blocking cells, or null.
 * Candidates within [target*0.55, target*1.6] are considered and the
 * closest-fit among up to a dozen draws wins, so the caller's budget is
 * met without splitting a pack across two lobes.
 */
function packFor(terrain, rng, targetCells, preferType) {
	const pool = PACKS[terrain];
	if (!pool || !pool.length) return null;
	// preferType biases the draw toward packs that carry it: mountain ran
	// 0.74x corpus because a size-fit-only draw treats a dirt-hill pack and
	// a mountain pack as interchangeable. Among the twelve candidates a
	// preferred pack wins unless another fits twice as close.
	let best = null, bd = Infinity;
	for (let t = 0; t < 12; t++) {
		const p = pool[(rng() * pool.length) | 0];
		let d = Math.abs(p.size - targetCells);
		if (preferType
				&& p.objects.some(o => o.type === preferType)) d *= 0.5;
		if (d < bd && p.size <= targetCells * 1.6) { bd = d; best = p; }
	}
	return best;
}

/** Every distinct decoration type in the table, for tests and tooling. */
const DECOR_TYPES = [...new Set(
	[...Object.values(DATA.clusters), ...Object.values(DATA.single)]
		.flat().map(e => e.type))].sort();

// the terrains the harvest covers; a mod terrain gets its pools at run time
const CORE_TERRAINS = Object.keys(DATA.clusters);
const registered = new Set();

/**
 * Scenery for a terrain the harvest has none for: the obstacles its mods
 * bring (generate.js reads them out of the asset index), as the engine's
 * ObstaclePlacer takes every obstacle whose template allows the ground. Without
 * them a mod terrain got no packs, no wall pieces and no clusters, and its
 * zones came out strewn with the same four one-cell dirt ornaments (flowers,
 * shrub and rock at 16, 5 and 3 times the corpus's rate), where the corpus's
 * mod terrains carry 94-100% their mods' own art at core terrains' density
 * (2026-09-26). `clusters` and `single` take the harvested entries' shape
 * ({ type, subtype, animation, mask, weight, cells }); `packs`, when given,
 * the packs' ({ size, cells, objects }). A terrain the harvest covers keeps its
 * own pools and packs; clearTerrainDecor undoes every registration, so one
 * map's install cannot leak into the next map made in the same process.
 */
function registerTerrainDecor(terrain, { clusters = [], single = [], packs = [] } = {}) {
	if (CORE_TERRAINS.includes(terrain)) return false;
	DATA.clusters[terrain] = clusters;
	DATA.single[terrain] = single;
	if (!PACKS[terrain] || registered.has(terrain)) PACKS[terrain] = packs;
	registered.add(terrain);
	return true;
}
function clearTerrainDecor() {
	for (const t of registered) {
		delete DATA.clusters[t];
		delete DATA.single[t];
	}
	// packs the harvest had for a terrain (wasteland) stay; the rest go
	for (const t of registered) if (!HARVESTED_PACK_TERRAINS.has(t)) delete PACKS[t];
	registered.clear();
}
const HARVESTED_PACK_TERRAINS = new Set(Object.keys(PACKS));

module.exports = {
	clusterTemplate, singleTemplate, dominoTemplate, trominoTemplate,
	mergedTemplate,
	wallClusters, clusterSize, packFor,
	registerTerrainDecor, clearTerrainDecor,
	DECOR_BLOCKED_SHARE_UNDERGROUND,
	DECOR_BLOCKED_SHARE, DECOR_TYPES,
	TERRAINS: CORE_TERRAINS,
};
