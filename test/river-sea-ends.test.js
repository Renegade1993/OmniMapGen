/**
 * river-sea-ends.test.js - on a level with a sea a river runs between water and water or another river, never to the map edge (K,
 * 2026-10-12, his XL Mediterranean on Coldshadow: "strange creek beginning and ends"; 6 of his rivers' 9 ends lay on the map edge,
 * the engine's own Coldshadow 144 with water has none there). rivernet.js routeRivers on a 40x40 level with a 16x16 sea in the middle.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { routeRivers } = require('../src/biome/rivernet');

const xorshift = seed => { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; };

test('a sea level: rivers are laid, and none touches the map edge', () => {
	const W = 40, H = 40, water = new Uint8Array(W * H);
	for (let y = 12; y < 28; y++) for (let x = 12; x < 28; x++) water[y * W + x] = 1;
	let laid = 0;
	for (let seed = 1; seed <= 6; seed++) {
		const cells = routeRivers(W, H, xorshift(seed), 0.03, { water });
		laid += cells.size;
		for (const c of cells) {
			const x = c % W, y = (c / W) | 0;
			assert.ok(x > 0 && y > 0 && x < W - 1 && y < H - 1, `seed ${seed}: river on the edge at (${x},${y})`);
		}
	}
	assert.ok(laid > 0, 'no river laid at all');
});
