/**
 * guard-gradient.test.js - the Guard gradient lever (guardGradient; the Template Factory's coverage table, 2026-10-16: 99 of the engine's 181
 * templates guard the starts' links more weakly than the rest). boundaries.js placeChokeGuards: at 0 the guards are as before; at 1 a free
 * layout's start link is two creature levels lower and its deepest link two higher, and a template's link strengths run from a third to
 * three times their own.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { placeChokeGuards } = require('../src/biome/boundaries');
const { BIOME_CLASS } = require('../src/biome/biomes');
const { xorshift } = require('../src/wfc/solver');

// a chain: start 0 - 1 - 2 - 3 - 4, every link a two-cell doorway
const chain = () => [0, 1, 2, 3].map(i => ({ a: i, b: i + 1, kind: 'openNoRoad', hole: [i * 10, i * 10 + 1] }));
const classes = [BIOME_CLASS.PLAYER, BIOME_CLASS.STANDARD, BIOME_CLASS.STANDARD, BIOME_CLASS.STANDARD, BIOME_CLASS.STANDARD];

const meanLevels = grad => {
	const sum = [0, 0, 0, 0], n = [0, 0, 0, 0];
	for (let seed = 1; seed <= 200; seed++) {
		const gs = placeChokeGuards(chain(), classes, xorshift(seed), { chokeGuardRatio: 1, guardGradient: grad }, null);
		for (const g of gs) { const k = g.edge[0]; sum[k] += g.level; n[k]++; }
	}
	return sum.map((s, k) => s / n[k]);
};

test('free layout: at Guard gradient 1 the start link is weaker and the deepest stronger than at 0', () => {
	const flat = meanLevels(0), steep = meanLevels(1);
	assert.ok(steep[0] < flat[0] - 0.5, `start link (level 1 is the floor) ${steep[0].toFixed(2)} against ${flat[0].toFixed(2)}`);
	assert.ok(steep[3] > flat[3] + 1, `deepest link ${steep[3].toFixed(2)} against ${flat[3].toFixed(2)}`);
	assert.ok(steep[0] < steep[1] && steep[1] <= steep[2] && steep[2] < steep[3], `rising with depth: ${steep.map(v => v.toFixed(2)).join(', ')}`);
});

test('free layout: Guard gradient 0 draws exactly what the generator drew before the lever', () => {
	const old = process.env.VMAPGEN_GUARD_GRADIENT;
	try {
		const a = placeChokeGuards(chain(), classes, xorshift(7), { chokeGuardRatio: 1, guardGradient: 0 }, null);
		process.env.VMAPGEN_GUARD_GRADIENT = '0';
		const b = placeChokeGuards(chain(), classes, xorshift(7), { chokeGuardRatio: 1, guardGradient: 1 }, null);
		assert.deepStrictEqual(a, b);
	} finally {
		if (old === undefined) delete process.env.VMAPGEN_GUARD_GRADIENT; else process.env.VMAPGEN_GUARD_GRADIENT = old;
	}
});

test('template: link strengths scale from about a third at the start to about three times at the deepest', () => {
	const info = new Map(chain().map(o => [o.a * 100000 + o.b, { guard: 20000 }]));
	const amounts = grad => {
		const gs = placeChokeGuards(chain(), classes, xorshift(3), { guardGradient: grad, tplAreaShare: 1 }, info);
		return Object.fromEntries(gs.map(g => [g.edge[0], { level: g.level, amount: g.amount }]));
	};
	const flat = amounts(0), steep = amounts(1);
	const power = r => r && r.amount * Math.pow(2, r.level);   // creature level weighs heavily: compare amount x 2^level
	assert.ok(power(steep[0]) < power(flat[0]), `start link ${JSON.stringify(steep[0])} against ${JSON.stringify(flat[0])}`);
	assert.ok(power(steep[3]) > power(flat[3]), `deepest link ${JSON.stringify(steep[3])} against ${JSON.stringify(flat[3])}`);
	// weakened, never removed (the Opus Reviewer, pass 106: Coldshadow's start links lost their guards at 1)
	const weak = new Map(chain().map(o => [o.a * 100000 + o.b, { guard: 6000 }]));
	const edges = grad => new Set(placeChokeGuards(chain(), classes, xorshift(3), { guardGradient: grad, tplAreaShare: 1 }, weak).map(g => g.edge[0]));
	const at0 = edges(0), at1 = edges(1);
	for (const e of at0) assert.ok(at1.has(e), `the link from zone ${e} is guarded at 0 and at 1 (at 0: ${[...at0]}, at 1: ${[...at1]})`);
	assert.ok(at0.has(0), 'the start link is guarded at 0 in this setup');
});
