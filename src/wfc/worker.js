/**
 * worker.js - Node worker_threads entry: solves one 32x32 chunk.
 * Receives {chunkId, ox, oy, w, h, numTiles, weights, compatBits, forced, seed}
 * over the port; replies {chunkId, tiles: Int32Array} or {chunkId, error}.
 */
'use strict';

const { parentPort } = require('worker_threads');
const { solve, buildCompat } = require('./solver');
const { BitSet } = require('./bitset');

function compatFromBits(numTiles, compatBits) {
	// compatBits[d][t] = Uint32Array words for tile t's allowed neighbors in dir d
	const compat = Array.from({ length: numTiles }, () => new Array(4));
	for (let d = 0; d < 4; d++) {
		for (let t = 0; t < numTiles; t++) {
			const b = new BitSet(numTiles);
			b.words.set(compatBits[d][t]);
			compat[t][d] = b;
		}
	}
	return compat;
}

parentPort.on('message', msg => {
	try {
		const { chunkId, w, h, numTiles, weights, compatBits, forced, domainBits,
			levelDomainBits, seed } = msg;
		const compat = compatFromBits(numTiles, compatBits);
		const forcedMap = new Map(forced);
		// domainBits: [[cellIdx, words[]], ...] multi-tile domain restrictions
		let domains = null;
		if (domainBits) {
			domains = new Map();
			for (const [idx, words] of domainBits) {
				const b = new BitSet(numTiles);
				b.words.set(words);
				domains.set(idx, b);
			}
		}
		let tiles = solve({ width: w, height: h, numTiles, weights, compat,
			seed, forced: forcedMap, domains });
		let fellBack = false;
		if (tiles === null && domains) {
			// Biome domains deadlocked. Retry so the chunk still fills, but only
			// over the terrain this LEVEL may legally hold: the previous
			// fallback dropped every restriction, which let surface-only
			// terrain onto an underground level and threw the biome terrain
			// plan away without saying anything. The caller is told, because a
			// level whose terrain ignores its own plan is worth knowing about.
			const levelMask = new Map();
			if (levelDomainBits) {
				const b = new BitSet(numTiles);
				b.words.set(levelDomainBits);
				for (let i = 0; i < w * h; i++) levelMask.set(i, b);
			}
			tiles = solve({ width: w, height: h, numTiles, weights, compat,
				seed: seed + 977, forced: forcedMap,
				domains: levelMask.size ? levelMask : null });
			fellBack = tiles !== null;
		}
		if (tiles === null) {
			parentPort.postMessage({ chunkId, error: 'contradiction-exhausted' });
		} else {
			parentPort.postMessage({ chunkId, tiles: Array.from(tiles), fellBack });
		}
	} catch (err) {
		parentPort.postMessage({ chunkId: msg.chunkId, error: String(err && err.stack || err) });
	}
});
