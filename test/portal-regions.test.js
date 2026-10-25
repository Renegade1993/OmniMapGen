/**
 * portal-regions.test.js - portalregions.js on a built plan (the Opus Reviewer's content read of rel-0318: panel N no144x2 s8303, one start holding 2.8 times
 * the content of the other because its region ran through an unguarded portal pair). A 40x16 level: start A's room on the left, start B's on the right, a
 * third room between them walled off from both, and a monolith pair joining A's room to the third; the third holds four mines. A reaches them (through the
 * pair), B does not: the pass guards the end in A's room and A's region falls back to its own room. A level whose third room holds nothing has its starts
 * within 2.2 and is left alone.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const content = require('../src/biome/content');
const { OBJECT_TEMPLATES } = require('../src/stitch/zones');
const { BIOME_DEFAULTS } = require('../src/biome/biomes');
const { xorshift } = require('../src/wfc/solver');
const { balancePortalRegions } = require('../src/biome/portalregions');

const W = 40, H = 16, N = W * H;
const { OCCUPIED, visitableCells, allowedDirs, blockingCells } = content;
const ONE = { animation: 'x', mask: ['A'], visitableFrom: ['+++', '+-+', '+++'] };
const entry = (type, x, y, extra = {}) => ({ instanceName: `${type}_${x}_${y}_0`, l: 0, x, y, type, subtype: extra.subtype || 'object', template: extra.template || ONE, options: extra.options });

function level(opts) {
	const blocked = new Uint8Array(N);
	const zone = new Int16Array(N);
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
		zone[y * W + x] = x < 12 ? 0 : x < 26 ? 2 : x < 28 ? 1 : 1;
		if (x === 12 || x === 13 || x === 26 || x === 27) { blocked[y * W + x] |= OCCUPIED; zone[y * W + x] = x < 20 ? 0 : 1; }
	}
	const objects = [
		entry('randomTown', 3, 3, { template: OBJECT_TEMPLATES.randomTown, options: { owner: 'red' } }),
		entry('randomTown', 35, 3, { template: OBJECT_TEMPLATES.randomTown, options: { owner: 'blue' } }),
	];
	for (const x of [5, 6, 7]) objects.push(entry('resource', x, 9));
	for (const x of [31, 32, 33]) objects.push(entry('resource', x, 9));
	if (opts.mines) for (const x of [16, 18, 20, 22]) objects.push(entry('mine', x, 9, { subtype: 'goldMine' }));
	objects.push(entry('monolithTwoWay', 8, 12, { subtype: 'monolith1' }));
	objects.push(entry('monolithTwoWay', opts.farInB ? 36 : 15, 12, { subtype: 'monolith1' }));
	for (const o of objects) for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) if (fx >= 0 && fy >= 0 && fx < W && fy < H) blocked[fy * W + fx] |= OCCUPIED;
	return { plans: [{ objects, zone, p: {} }], blocked };
}

function run(opts) {
	const { plans, blocked } = level(opts);
	const before = plans[0].objects.length;
	const out = balancePortalRegions({
		plans, levels: 1, W, H, blocked, params: { ...BIOME_DEFAULTS }, rng: xorshift(12345),
		approachCells: (tpl, x, y, l, W2, H2, b) => {
			const r = [];
			for (const [vx, vy] of visitableCells(tpl, x, y)) for (const [dx, dy] of allowedDirs(tpl)) {
				const nx = vx + dx, ny = vy + dy;
				if (nx >= 0 && ny >= 0 && nx < W2 && ny < H2 && !(b[l * W2 * H2 + ny * W2 + nx] & OCCUPIED)) r.push(ny * W2 + nx);
			}
			return r;
		},
		townDoorCells: (objs, l, W2, H2, b, t) => new Set([(t.y + 1) * W2 + t.x]),
		blockingCells, footprintFits: content.footprintFits, reserveCell: content.reserveCell, markApproach: content.markApproach,
		objectEntry: (type, x, y, l, tpl, subtype, o) => ({ instanceName: `${type}_${x}_${y}_${l}`, l, x, y, type, subtype, template: tpl, options: o }),
		engineGuard: content.engineGuard, scaledLinkGuard: content.scaledLinkGuard, scaledAmount: content.scaledAmount, OBJECT_TEMPLATES, OCCUPIED,
	});
	return { out, added: plans[0].objects.slice(before), plan: plans[0] };
}

test('a start whose region runs through a monolith pair into four mines the other cannot reach gets that end guarded', () => {
	const r = run({ mines: true });
	assert.ok(r.out.ratio0 > 2.2, `before: ${r.out.ratio0}`);
	assert.ok(r.added.length >= 1 && r.added.every(o => /^randomMonster/.test(o.type)), `guards added: ${r.added.map(o => o.type)}`);
	assert.ok(r.added.some(o => Math.abs(o.x - 8) <= 3 && Math.abs(o.y - 12) <= 3), 'a guard stands at the end in the first start\'s room');
	assert.ok(r.out.ratio1 <= 1.8, `after: ${r.out.ratio1}`);
});

test('a level whose starts are within 2.2 and share nothing through portals is left alone', () => {
	const r = run({ mines: false });
	assert.strictEqual(r.added.length, 0);
	assert.ok(r.out.ratio0 <= 2.2, `ratio ${r.out.ratio0}`);
});
