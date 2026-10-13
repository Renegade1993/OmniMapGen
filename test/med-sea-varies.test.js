/**
 * med-sea-varies.test.js - the open layout's Mediterranean sea is an oval on few seeds and always leaves land to the map's edges (K,
 * 2026-10-12, a six-player open Mediterranean: "strange ovular central ocean....it should definitely be the exception not the rule";
 * 144x144 at 45% water over 50 seeds: oval-like 21 before, 8 after). 30 seeds, 96x96, 45% water, six starts on a ring: the largest sea's
 * radius round its centroid varies by a coefficient of 0.08 or more on at least three in four seeds, and no water lies within 3 tiles
 * of an edge.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const water = require('../src/biome/water');

test('open Mediterranean, 30 seeds: the sea varies and keeps a land ring', () => {
	const W = 96, H = 96, shapeIdx = water.WATER_SHAPES.findIndex(s => s.id === 'mediterranean');
	const starts = Array.from({ length: 6 }, (_, i) => ({ x: Math.round(W / 2 + 0.42 * W * Math.cos(i * Math.PI / 3)), y: Math.round(H / 2 + 0.42 * H * Math.sin(i * Math.PI / 3)) }));
	let varied = 0;
	for (let seed = 1; seed <= 30; seed++) {
		const m = water.buildWaterPlan(W, H, { waterCoverage: 0.45, waterShape: shapeIdx }, starts, seed).mask;
		for (let c = 0; c < W * H; c++) {
			const x = c % W, y = (c / W) | 0;
			if (m[c]) assert.ok(Math.min(x, y, W - 1 - x, H - 1 - y) >= 3, `seed ${seed}: water at (${x},${y}) by the edge`);
		}
		let cx = 0, cy = 0, n = 0;
		for (let c = 0; c < W * H; c++) if (m[c]) { cx += c % W; cy += (c / W) | 0; n++; }
		cx /= n; cy /= n;
		const rad = new Float64Array(72);
		for (let c = 0; c < W * H; c++) if (m[c]) { const x = c % W - cx, y = ((c / W) | 0) - cy, k = Math.floor(((Math.atan2(y, x) + Math.PI) / (2 * Math.PI)) * 72) % 72; rad[k] = Math.max(rad[k], Math.hypot(x, y)); }
		const mean = rad.reduce((a, v) => a + v, 0) / 72, cv = Math.sqrt(rad.reduce((a, v) => a + (v - mean) ** 2, 0) / 72) / mean;
		if (cv >= 0.08) varied++;
	}
	assert.ok(varied >= 23, `varied ${varied} of 30`);
});
