/**
 * water-zone-cap.test.js - Normal water on a template keeps ground in every zone (K, 2026-10-10, 180x180 Coldshadow's Fantasy with Mediterranean
 * water at 45%: the middle zones were wet to 70% and two of them drowned, "extremely strange"). adoptWater takes the most of a zone the radius rule
 * may wet; buildAdoptedPlan tries 0.7 down to 0.55 until every zone of 60 cells or more keeps 40% land, the amount falling short when it must.
 * Mediterranean is the exception since K's reference (2026-10-11, the Age of Empires map wikis): one central sea, the land round it to the edges.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { adoptWater, buildAdoptedPlan, WATER_SHAPES } = require('../src/biome/water');
const { xorshift } = require('../src/wfc/solver');

const W = 120, H = 120;
const zoneOf = new Int32Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) zoneOf[y * W + x] = ((y / 30) | 0) * 4 + ((x / 30) | 0);
const shape = WATER_SHAPES.findIndex(s => s.id === 'mediterranean');
// the zone cap holds for the layouts that wet each zone's own outer part (Continental here); Mediterranean makes one central sea (K's reference, below)
const cont = WATER_SHAPES.findIndex(s => s.id === 'continental');

const wetShare = mask => {
	const wet = new Array(16).fill(0), area = new Array(16).fill(0);
	for (let c = 0; c < W * H; c++) { area[zoneOf[c]]++; if (mask[c]) wet[zoneOf[c]]++; }
	return wet.map((n, z) => n / area[z]);
};

test('adoptWater takes no more of a zone than the cap given, at any scale', () => {
	assert.ok(cont >= 0);
	const forced = new Uint8Array(W * H);
	for (const seed of [1, 2, 3]) {
		const loose = wetShare(adoptWater(W, H, zoneOf, 'normal', xorshift(seed * 7919), forced, null, cont, 8, 0.95));
		const capped = wetShare(adoptWater(W, H, zoneOf, 'normal', xorshift(seed * 7919), forced, null, cont, 8, 0.55));
		assert.ok(Math.max(...capped) <= 0.62, `seed ${seed}: the wettest zone is ${Math.round(100 * Math.max(...capped))}% water`);
		assert.ok(Math.max(...loose) > 0.7, `seed ${seed}: without the cap a zone goes ${Math.round(100 * Math.max(...loose))}% (the case the cap is for)`);
	}
});

test('Mediterranean water at 45% is one sea in the middle with land round it to the edges (K, 2026-10-11, the Age of Empires reference)', () => {
	const starts = [{ x: 15, y: 15 }, { x: 105, y: 15 }, { x: 15, y: 105 }, { x: 105, y: 105 }];
	for (const seed of [1, 2, 3]) {
		const plan = buildAdoptedPlan(W, H, zoneOf, 'normal', starts, seed, null, null, shape, 0.45);
		const m = plan.mask;
		// the biggest water body (four ways) holds most of the water, and its middle is near the map's
		const seen = new Uint8Array(W * H);
		let best = [], total = 0;
		for (let c = 0; c < W * H; c++) {
			if (!m[c]) continue;
			total++;
			if (seen[c]) continue;
			const body = [c]; seen[c] = 1;
			for (let h = 0; h < body.length; h++) {
				const x = body[h] % W, y = (body[h] / W) | 0;
				for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
					const u = x + dx, v = y + dy, n = v * W + u;
					if (u >= 0 && v >= 0 && u < W && v < H && m[n] && !seen[n]) { seen[n] = 1; body.push(n); }
				}
			}
			if (body.length > best.length) best = body;
		}
		const cx = best.reduce((a2, c) => a2 + c % W, 0) / best.length, cy = best.reduce((a2, c) => a2 + ((c / W) | 0), 0) / best.length;
		assert.ok(best.length >= 0.8 * total, `seed ${seed}: the biggest water body is ${Math.round(100 * best.length / total)}% of the water`);
		assert.ok(Math.hypot(cx - W / 2, cy - H / 2) <= 0.12 * W, `seed ${seed}: the sea's middle is at (${cx.toFixed(0)},${cy.toFixed(0)})`);
		// the band along the edges is land
		let band = 0, wetBand = 0;
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (x < 8 || y < 8 || x >= W - 8 || y >= H - 8) { band++; if (m[y * W + x]) wetBand++; }
		assert.ok(wetBand <= 0.1 * band, `seed ${seed}: ${Math.round(100 * wetBand / band)}% of the edge band is water`);
		assert.ok(plan.coverage > 0.3, `seed ${seed}: the amount reached ${plan.coverage.toFixed(2)}`);
	}
});
