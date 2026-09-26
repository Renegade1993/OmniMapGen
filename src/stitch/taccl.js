/**
 * taccl.js - Tile Arc Consistent Correlation Length.
 *
 * Measures how far a tile's choice constrains its neighborhood under the
 * adjacency constraint set. For each tile type we measure the propagation
 * radius of AC-3 when that tile is forced at the center of a test grid; the
 * max over the dictionary is L_TACCL. Stitch-block width W = 2*L + K where K
 * is the largest object footprint width in the mod dictionary.
 */
'use strict';

const { BitSet } = require('../wfc/bitset');
const { ac3 } = require('../wfc/solver');

/**
 * For a forced tile at grid center, AC-3 carves a "cone of influence" — cells
 * whose domains shrink. The max graph distance to any shrunk cell is that
 * tile's correlation length.
 */
function tileCorrelationLength(tileId, numTiles, compat, maxRadius = 16) {
	const W = 2 * maxRadius + 1, H = W;
	const cx = maxRadius, cy = maxRadius;
	const domains = Array.from({ length: W * H }, () => BitSet.full(numTiles));
	const cIdx = cy * W + cx;
	domains[cIdx].words.fill(0);
	domains[cIdx].set(tileId);

	// Snapshot original popcounts
	const before = domains.map(d => d.popcount());
	if (!ac3(domains, W, H, compat)) return maxRadius; // contradiction = max reach
	let far = 0;
	for (let i = 0; i < W * H; i++) {
		if (domains[i].popcount() < before[i]) {
			const dx = Math.abs((i % W) - cx);
			const dy = Math.abs(((i / W) | 0) - cy);
			far = Math.max(far, Math.max(dx, dy));
		}
	}
	return far;
}

/**
 * Compute L_TACCL over the sampled tile dictionary (sample at most
 * `sampleSize` ids to bound the cost), and the stitch width W = 2*L + K.
 */
function computeTaccl(numTiles, compat, maxFootprintWidth, sampleSize = 24) {
	let L = 1;
	const step = Math.max(1, Math.floor(numTiles / sampleSize));
	for (let t = 0; t < numTiles; t += step) {
		L = Math.max(L, tileCorrelationLength(t, numTiles, compat));
	}
	return {
		L,
		stitchWidth: 2 * L + Math.max(1, maxFootprintWidth),
	};
}

module.exports = { computeTaccl, tileCorrelationLength };
