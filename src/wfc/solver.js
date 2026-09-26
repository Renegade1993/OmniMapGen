/**
 * solver.js - AC-3 + Wave Function Collapse over BitSet domains.
 *
 * Grid of W*H cells, each holding a BitSet of candidate tile ids. Seed with
 * constraints (biome maps, adjacency rules), propagate to arc consistency
 * with AC-3, then collapse lowest-entropy cells weighted by tile frequency.
 * Contradiction triggers restart with a new seed, bounded by maxRestarts.
 */
'use strict';

const { BitSet } = require('./bitset');

const DIRS = [ [0, -1], [1, 0], [0, 1], [-1, 0] ]; // N E S W (y-down grid)

/**
 * Adjacency rules: compat[d] is a per-direction compatibility matrix.
 * compat[a][d] is a BitSet of tile ids allowed as the d-neighbor of tile a.
 * Built once from the dictionary (same-terrain adjacency + biome borders).
 */
function buildCompat(numTiles, allowedPairs) {
	const compat = Array.from({ length: numTiles }, () =>
		DIRS.map(() => new BitSet(numTiles)));
	for (const [a, dir, b] of allowedPairs) {
		compat[a][dir].set(b);
	}
	return compat;
}

/**
 * AC-3 propagation on the grid. domains is an array of BitSet (row-major).
 * Returns true if arc-consistent, false on a wiped-out domain.
 */
function ac3(domains, W, H, compat) {
	const queue = [];
	const inQueue = new Uint8Array(W * H);
	for (let i = 0; i < W * H; i++) { queue.push(i); inQueue[i] = 1; }

	while (queue.length) {
		const cell = queue.pop();
		inQueue[cell] = 0;
		const cx = cell % W, cy = (cell / W) | 0;
		for (let d = 0; d < 4; d++) {
			const nx = cx + DIRS[d][0], ny = cy + DIRS[d][1];
			if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
			const nIdx = ny * W + nx;
			// For each candidate in the neighbor domain, it must have at least
			// one supporting candidate in this cell's domain.
			const nDom = domains[nIdx];
			let removedAny = false;
			for (const nb of nDom.indices()) {
				let supported = false;
				for (const cb of domains[cell].indices()) {
					if (compat[cb][d].get(nb)) { supported = true; break; }
				}
				if (!supported) {
					nDom.clear(nb);
					removedAny = true;
				}
			}
			if (removedAny) {
				if (nDom.isEmpty()) return false;
				for (let e = 0; e < 4; e++) {
					const px = nx + DIRS[e][0], py = ny + DIRS[e][1];
					if (px < 0 || py < 0 || px >= W || py >= H) continue;
					const pIdx = py * W + px;
					if (!inQueue[pIdx]) { queue.push(pIdx); inQueue[pIdx] = 1; }
				}
			}
		}
	}
	return true;
}

/**
 * Weighted collapse of one cell: pick a candidate proportionally to its
 * weight, set the domain to that singleton.
 */
function collapseCell(domain, weights, rng) {
	let total = 0;
	for (const i of domain.indices()) total += weights[i];
	if (total <= 0) { domain.clear(domain.firstSet()); return; }
	let pick = rng() * total;
	for (const i of domain.indices()) {
		pick -= weights[i];
		if (pick <= 0) {
			const keep = i;
			domain.words.fill(0);
			domain.set(keep);
			return;
		}
	}
	const last = domain.firstSet();
	domain.words.fill(0);
	domain.set(last);
}

/**
 * Deterministic xorshift32 RNG so runs are reproducible from a seed.
 */
function xorshift(seed) {
	let s = seed >>> 0 || 0x9E3779B9;
	return () => {
		s ^= s << 13; s >>>= 0;
		s ^= s >> 17;
		s ^= s << 5; s >>>= 0;
		return s / 4294967296;
	};
}

/**
 * Solve one chunk. opts: {width, height, numTiles, weights, compat, seed,
 * forced: Map<cellIndex, tileId>, domains: Map<cellIndex, BitSet>,
 * maxRestarts}
 * `forced` pins single tiles; `domains` restricts cells to a multi-tile set
 * (used for biome terrain families). Returns Int32Array row-major, or null.
 */
function solve(opts) {
	const { width: W, height: H, numTiles, weights, compat, seed = 1,
		forced = new Map(), domains: domainMasks = null, maxRestarts = 8 } = opts;

	for (let attempt = 0; attempt < maxRestarts; attempt++) {
		const rng = xorshift(seed + attempt * 0x10001);
		const domains = Array.from({ length: W * H }, () => BitSet.full(numTiles));
		if (domainMasks)
			for (const [idx, mask] of domainMasks)
				domains[idx].and(mask);
		for (const [idx, tile] of forced) {
			domains[idx].words.fill(0);
			domains[idx].set(tile);
		}
		if (!ac3(domains, W, H, compat)) continue;

		const out = new Int32Array(W * H).fill(-1);
		let remaining = W * H;
		let ok = true;
		while (remaining > 0) {
			// Lowest entropy cell (min popcount > 1)
			let best = -1, bestCount = Infinity;
			for (let i = 0; i < W * H; i++) {
				const c = domains[i].popcount();
				if (c > 1 && c < bestCount) { bestCount = c; best = i; }
			}
			if (best < 0) break; // all singleton
			collapseCell(domains[best], weights, rng);
			if (!ac3(domains, W, H, compat)) { ok = false; break; }
			remaining--;
		}
		if (!ok) continue;

		for (let i = 0; i < W * H; i++) out[i] = domains[i].firstSet();
		return out;
	}
	return null;
}

module.exports = { solve, ac3, buildCompat, xorshift, DIRS };
