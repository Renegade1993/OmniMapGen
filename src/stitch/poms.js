/**
 * poms.js - Punch Out Model Synthesis chunk merging.
 *
 * Chunks are solved independently; seams between neighbors can disagree on
 * shared boundary tiles. POMS overlap: each chunk is generated with an overlap
 * margin of W = 2*L_TACCL + K tiles; when two chunks meet, the overlap band is
 * re-solved locally with both neighbors' edge constraints, then stochastic
 * erosion (probability P_erode) softens the seam so it does not read as a
 * straight line.
 */
'use strict';

const { BitSet } = require('../wfc/bitset');
const { solve, buildCompat } = require('../wfc/solver');
const { xorshift } = require('../wfc/solver');

/**
 * Merge chunk solutions into the global grid, then repair each internal
 * boundary band by re-solving it as a narrow strip constrained by both sides.
 *
 * chunks: [{ox, oy, w, h, tiles: Int32Array}] covering the grid.
 * grid: Int32Array(mapW*mapH) filled in place.
 * stitchW: boundary band width from TACCL.
 * pErode: probability of boundary-cell randomization before re-solve.
 */
function mergeChunks(chunks, mapW, mapH, numTiles, weights, compat, stitchW, pErode, seed = 1) {
	const grid = new Int32Array(mapW * mapH).fill(-1);
	for (const c of chunks) {
		for (let y = 0; y < c.h; y++)
			for (let x = 0; x < c.w; x++)
				grid[(c.oy + y) * mapW + (c.ox + x)] = c.tiles[y * c.w + x];
	}

	const rng = xorshift(seed);
	const boundaries = [];
	// Internal vertical seams
	for (const c of chunks) {
		const right = c.ox + c.w;
		if (right < mapW) boundaries.push({ axis: 'v', at: right, from: c.oy, to: c.oy + c.h });
		const bottom = c.oy + c.h;
		if (bottom < mapH) boundaries.push({ axis: 'h', at: bottom, from: c.ox, to: c.ox + c.w });
	}

	for (const b of boundaries) {
		const r = bandRect(b, mapW, mapH, stitchW);
		repairBand(grid, mapW, r.x, r.y, r.w, r.h, numTiles, weights, compat, rng, pErode);
	}
	return grid;
}

/** Rect for one boundary band. */
function bandRect(b, mapW, mapH, stitchW) {
	const half = Math.max(1, stitchW >> 1);
	if (b.axis === 'v') {
		const x0 = Math.max(0, b.at - half), x1 = Math.min(mapW, b.at + half);
		return { x: x0, y: b.from, w: x1 - x0, h: Math.min(mapH, b.to) - b.from };
	}
	const y0 = Math.max(0, b.at - half), y1 = Math.min(mapH, b.at + half);
	return { x: b.from, y: y0, w: Math.min(mapW, b.to) - b.from, h: y1 - y0 };
}

function rectsOverlap(a, b) {
	return a.x < b.x + b.w && b.x < a.x + a.w &&
		a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Greedy conflict-free grouping: bands in a round never share a cell. */
function groupBands(rects) {
	const rounds = [];
	for (const r of rects) {
		let placed = false;
		for (const round of rounds) {
			if (round.every(o => !rectsOverlap(r, o))) {
				round.push(r); placed = true; break;
			}
		}
		if (!placed) rounds.push([r]);
	}
	return rounds;
}

/** Erode + force current tiles for a band rect (consumes rng in band order). */
function buildForced(grid, mapW, r, rng, pErode) {
	const forced = new Map();
	for (let i = 0; i < r.w * r.h; i++) {
		const lx = i % r.w, ly = (i / r.w) | 0;
		if (rng() < pErode) continue;
		forced.set(i, grid[(r.y + ly) * mapW + (r.x + lx)]);
	}
	return forced;
}

/**
 * Async variant: band repairs are dispatched through `solveBand(rect, forced,
 * seed) -> Promise<Int32Array|null>`. Non-overlapping bands run in the same
 * round; rounds run in boundary order so later bands see earlier repairs -
 * identical semantics to the serial mergeChunks.
 */
async function mergeChunksAsync(chunks, mapW, mapH, numTiles, weights, compat,
	stitchW, pErode, seed, solveBand) {
	const grid = new Int32Array(mapW * mapH).fill(-1);
	for (const c of chunks) {
		for (let y = 0; y < c.h; y++)
			for (let x = 0; x < c.w; x++)
				grid[(c.oy + y) * mapW + (c.ox + x)] = c.tiles[y * c.w + x];
	}

	const rng = xorshift(seed);
	const boundaries = [];
	for (const c of chunks) {
		const right = c.ox + c.w;
		if (right < mapW) boundaries.push({ axis: 'v', at: right, from: c.oy, to: c.oy + c.h });
		const bottom = c.oy + c.h;
		if (bottom < mapH) boundaries.push({ axis: 'h', at: bottom, from: c.ox, to: c.ox + c.w });
	}

	// Seeds drawn in boundary order for determinism; forced maps are built
	// lazily per round so bands see repairs from earlier rounds.
	const jobs = boundaries.map(b => ({
		r: bandRect(b, mapW, mapH, stitchW),
		seed: (rng() * 0x7FFFFFFF) | 0,
	}));

	for (const round of groupBands(jobs.map(j => j.r))) {
		const roundJobs = jobs.filter(j => round.includes(j.r));
		// forced maps must reflect repairs from earlier rounds; rebuild them.
		for (const j of roundJobs)
			j.forced = buildForced(grid, mapW, j.r, rng, pErode);
		const solved = await Promise.all(roundJobs.map(j => solveBand(j.r, j.forced, j.seed)));
		for (let k = 0; k < roundJobs.length; k++) {
			const tiles = solved[k];
			if (!tiles) continue;
			const { r } = roundJobs[k];
			for (let i = 0; i < r.w * r.h; i++) {
				const lx = i % r.w, ly = (i / r.w) | 0;
				grid[(r.y + ly) * mapW + (r.x + lx)] = tiles[i];
			}
		}
	}
	return grid;
}

/**
 * Re-solve one rectangular band in place. Cells inside the band get domains
 * from their current tile (post-erosion); cells just outside act as fixed
 * constraints via `forced`.
 */
function repairBand(grid, mapW, bx, by, w, h, numTiles, weights, compat, rng, pErode) {
	const forced = new Map();
	const cells = w * h;
	for (let i = 0; i < cells; i++) {
		const lx = i % w, ly = (i / w) | 0;
		const gIdx = (by + ly) * mapW + (bx + lx);
		if (rng() < pErode) continue; // erode: leave unconstrained
		forced.set(i, grid[gIdx]);
	}
	const tiles = solve({
		width: w, height: h, numTiles, weights, compat,
		seed: (rng() * 0x7FFFFFFF) | 0, forced, maxRestarts: 4,
	});
	if (!tiles) return; // keep original band if repair fails
	for (let i = 0; i < cells; i++) {
		const lx = i % w, ly = (i / w) | 0;
		grid[(by + ly) * mapW + (bx + lx)] = tiles[i];
	}
}

module.exports = { mergeChunks, mergeChunksAsync };
