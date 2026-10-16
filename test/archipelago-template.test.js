/**
 * archipelago-template.test.js - on a template map the Archipelago layout makes islands with the water content at Normal (the lead's
 * ruling, 2026-10-14, after MapGen Dev's gap table: Archipelago with K's default content Normal made ONE land mass on 18 of 18 Coldshadow
 * maps; only content Islands made islands). The layout button makes its layout; the content and the amount change how much water.
 * buildAdoptedPlan: an island layout gives the zone-edge sea, no dry slice and an island plan (shipyards and boats) whatever the content.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildAdoptedPlan, WATER_SHAPES } = require('../src/biome/water');

const W = 120, H = 120;
const zoneOf = new Int32Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) zoneOf[y * W + x] = ((y / 30) | 0) * 4 + ((x / 30) | 0);
const starts = [{ x: 15, y: 15 }, { x: 105, y: 15 }, { x: 15, y: 105 }, { x: 105, y: 105 }];
const ARCH = WATER_SHAPES.findIndex(s => s.id === 'archipelago'), LAKES = WATER_SHAPES.findIndex(s => s.id === 'lakes');
// land masses (eight ways) of 20 tiles or more, and the one each start stands on
const masses = m => {
	const lab = new Int32Array(W * H).fill(-1), size = [];
	for (let c = 0; c < W * H; c++) {
		if (m[c] || lab[c] >= 0) continue;
		const id = size.length, q = [c]; lab[c] = id; let n = 0;
		while (q.length) { const v = q.pop(); n++; const x = v % W, y = (v / W) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const u = x + dx, w = y + dy, k = w * W + u; if (u >= 0 && w >= 0 && u < W && w < H && !m[k] && lab[k] < 0) { lab[k] = id; q.push(k); } } }
		size.push(n);
	}
	return { big: size.filter(n => n >= 20).length, of: starts.map(s => lab[s.y * W + s.x]) };
};

test('Archipelago with content Normal: an island for each start and more islands besides, at the amount asked', () => {
	assert.ok(ARCH >= 0);
	for (const seed of [1, 2, 3]) {
		const plan = buildAdoptedPlan(W, H, zoneOf, 'normal', starts, seed, null, null, ARCH, 0.45);
		const { big, of } = masses(plan.mask);
		assert.ok(big >= 8, `seed ${seed}: ${big} land masses`);
		assert.strictEqual(new Set(of).size, 4, `seed ${seed}: the four starts on four islands`);
		assert.strictEqual(plan.islands, true, 'an island plan: shipyards and boats for the starts');
		const wet = plan.mask.reduce((a, v) => a + v, 0) / (W * H);
		assert.ok(Math.abs(wet - 0.45) <= 0.06, `seed ${seed}: ${Math.round(100 * wet)}% water against 45% asked`);
	}
});

test('Lakes with content Normal stays one land mass, as before', () => {
	const { big } = masses(buildAdoptedPlan(W, H, zoneOf, 'normal', starts, 1, null, null, LAKES, 0.25).mask);
	assert.strictEqual(big, 1);
});

test('VMAPGEN_ADOPT_ISLE_SHAPE=0 is the old rule: Archipelago with Normal content is one land mass', () => {
	process.env.VMAPGEN_ADOPT_ISLE_SHAPE = '0';
	try { assert.strictEqual(masses(buildAdoptedPlan(W, H, zoneOf, 'normal', starts, 1, null, null, ARCH, 0.45).mask).big, 1); }
	finally { delete process.env.VMAPGEN_ADOPT_ISLE_SHAPE; }
});

// how round the land masses are: the perimeter of a digital disc of the same area over the island's own 4-way perimeter (MapGen Dev's
// island_shape.js measure; about 1 for a pixel circle, lower for a ragged coast)
const roundness = m => {
	const lab = new Int32Array(W * H).fill(-1), out = [];
	for (let c = 0; c < W * H; c++) {
		if (m[c] || lab[c] >= 0) continue;
		const q = [c], cells = []; lab[c] = out.length;
		while (q.length) { const v = q.pop(); cells.push(v); const x = v % W, y = (v / W) | 0; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) { const u = x + dx, w = y + dy, k = w * W + u; if (u >= 0 && w >= 0 && u < W && w < H && !m[k] && lab[k] < 0) { lab[k] = out.length; q.push(k); } } }
		if (cells.length < 30) { out.push(null); continue; }
		const set = new Set(cells); let P = 0;
		for (const v of cells) { const x = v % W, y = (v / W) | 0; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const u = x + dx, w = y + dy; if (u < 0 || w < 0 || u >= W || w >= H || !set.has(w * W + u)) P++; } }
		out.push(8 * Math.sqrt(cells.length / Math.PI) / P);
	}
	return out.filter(v => v !== null);
};

test('the Island shape lever: ragged islands are less round than round ones, every start still on its own (K, 2026-10-14: "islands should be way less strictly circular")', () => {
	const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
	let r0 = 0, r1 = 0;
	for (const seed of [1, 2, 3]) {
		const round = buildAdoptedPlan(W, H, zoneOf, 'normal', starts, seed, null, null, ARCH, 0.45, null, 0);
		const rag = buildAdoptedPlan(W, H, zoneOf, 'normal', starts, seed, null, null, ARCH, 0.45, null, 1);
		r0 += mean(roundness(round.mask)); r1 += mean(roundness(rag.mask));
		assert.strictEqual(new Set(masses(rag.mask).of).size, 4, `seed ${seed}: the four starts on four islands`);
	}
	assert.ok(r1 < r0 - 0.05, `mean roundness ragged ${(r1 / 3).toFixed(2)} against round ${(r0 / 3).toFixed(2)}`);
});

// every zone keeps its share of land: Voronoi zones at 144 (narrow middle zones, as the template's are), ragged islands. Cut by the distance
// alone, the strait and the inlets left zones 33 to 40% land, and the islet rule drowned the whole island of a zone of 272 to 364 cells (the
// Opus Reviewer, passes 69 and 71: K's 144 six-player options, Archipelago, seed 2042393646, 6 zones under 40% with ragged islands)
test('Archipelago, ragged islands on narrow zones: every zone keeps 45% land or more, none drowned (VMAPGEN_ISLE_GROW=0: the old cut)', () => {
	const VW = 144, VH = 144;
	let s = 7; const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
	const pts = []; for (let i = 0; i < 22; i++) pts.push([8 + rnd() * 128, 8 + rnd() * 128]);
	const vz = new Int32Array(VW * VH);
	for (let y = 0; y < VH; y++) for (let x = 0; x < VW; x++) { let b = 0, bd = Infinity; pts.forEach(([px, py], i) => { const d = (px - x) ** 2 + (py - y) ** 2; if (d < bd) { bd = d; b = i; } }); vz[y * VW + x] = b; }
	const vs = [0, 1, 2, 3, 4, 5].map(i => ({ x: Math.round(pts[i][0]), y: Math.round(pts[i][1]) }));
	const lowest = seed => {
		const plan = buildAdoptedPlan(VW, VH, vz, 'normal', vs, seed, null, null, ARCH, 0.45, null, 1);
		const n = new Map(), land = new Map();
		for (let c = 0; c < VW * VH; c++) { n.set(vz[c], (n.get(vz[c]) || 0) + 1); if (!plan.mask[c]) land.set(vz[c], (land.get(vz[c]) || 0) + 1); }
		return Math.min(...[...n].map(([z, k]) => (land.get(z) || 0) / k));
	};
	for (const seed of [1, 2, 3]) assert.ok(lowest(seed) >= 0.45, `seed ${seed}: a zone keeps ${Math.round(100 * lowest(seed))}% land`);
	process.env.VMAPGEN_ISLE_GROW = '0';
	try { assert.ok([1, 2, 3].some(seed => lowest(seed) < 0.4), 'the old cut leaves a zone under 40% land'); } finally { delete process.env.VMAPGEN_ISLE_GROW; }
});
