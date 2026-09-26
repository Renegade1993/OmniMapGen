/**
 * retile.test.js
 *
 * Pins the retile pass (src/biome/retile.js) to the two properties the rest of
 * the generator relies on: the cells it blocks are exactly the cells it was
 * given, and no piece crosses a zone line. Connectivity, reachability and the
 * seal checks all ran before it, so either property breaking would ship a map
 * those checks never saw.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { retile, retileLevel, zoneTemplates, sizeGroups } = require('../src/biome/retile');
const { blockingCells } = require('../src/biome/content');
const { xorshift } = require('../src/wfc/solver');

const POOL = [
	{ type: 'mountain', animation: 'm4', mask: ['VVV', 'VBB', 'VBB'] },   // 2x2
	{ type: 'rock', animation: 'r2', mask: ['BB'] },
	{ type: 'rock', animation: 'r1', mask: ['B'] },
];

function blob(W, H, cells) {
	const a = new Uint8Array(W * H);
	for (const [x, y] of cells) a[y * W + x] = 1;
	return a;
}

test('retile blocks exactly the allowed cells, biggest pieces first', () => {
	const W = 8, H = 8;
	// a 4x4 square plus a one-cell tail
	const cells = [[7, 7]];
	for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) cells.push([x, y]);
	const allowed = blob(W, H, cells);
	const region = new Int32Array(W * H);
	const groups = sizeGroups(POOL);
	const r = retile({ W, H, allowed, region, groupsFor: () => groups, rng: xorshift(7) });
	const got = new Uint8Array(W * H);
	for (const p of r.placed)
		for (const c of p.cells) { assert.ok(allowed[c], 'piece blocks a cell outside the set'); got[c] = 1; }
	assert.deepStrictEqual([...got], [...allowed], 'blocked set changed');
	assert.strictEqual(r.uncovered.length, 0);
	// a 4x4 square admits four 2x2 pieces; the tail needs one single
	assert.strictEqual(r.placed.filter(p => p.cells.length === 4).length >= 3, true);
});

test('retile never lets a piece cross a zone line', () => {
	const W = 6, H = 2;
	const cells = [];
	for (let y = 0; y < 2; y++) for (let x = 0; x < 6; x++) cells.push([x, y]);
	const allowed = blob(W, H, cells);
	const region = new Int32Array(W * H);
	for (let y = 0; y < 2; y++) for (let x = 3; x < 6; x++) region[y * W + x] = 1;
	const groups = sizeGroups(POOL);
	for (let seed = 1; seed < 20; seed++) {
		const r = retile({ W, H, allowed, region, groupsFor: () => groups, rng: xorshift(seed) });
		for (const p of r.placed) {
			const zs = new Set(p.cells.map(c => region[c]));
			assert.strictEqual(zs.size, 1, 'piece spans two zones');
		}
	}
});

test('retileLevel keeps functional blocking and the full blocked set', () => {
	const W = 10, H = 10, l = 0;
	const zone = new Int16Array(W * H);          // one zone
	const biomeTerrain = ['gr'];
	const objects = [];
	let n = 0;
	for (let y = 1; y < 9; y++) for (let x = 1; x < 9; x++)
		if ((x + y) % 5 !== 0)
			objects.push({ instanceName: `rock_${n++}`, l, x, y, type: 'rock', subtype: 'object',
				template: { animation: 'AVLr03r0', mask: ['B'] } });
	// a functional object sitting on the mass keeps its cells
	objects.push({ instanceName: 'mine', l, x: 5, y: 5, type: 'mine', subtype: 'sawmill',
		template: { animation: 'AVMsawd0', mask: ['VVV', 'BBA'] } });
	const before = new Set();
	for (const o of objects)
		for (const [x, y] of blockingCells(o.template, o.x, o.y)) before.add(y * W + x);
	const res = retileLevel({ objects, zone, biomeTerrain, W, H, l, rng: xorshift(3),
		isScenery: o => o.type === 'rock', blockingCells,
		entry: (type, x, y, lv, tpl) => ({ l: lv, x, y, type, subtype: 'object', template: tpl }) });
	const after = new Set();
	for (const o of res.objects)
		for (const [x, y] of blockingCells(o.template, o.x, o.y)) after.add(y * W + x);
	assert.deepStrictEqual([...after].sort((a, b) => a - b), [...before].sort((a, b) => a - b));
	assert.ok(res.objects.some(o => o.type === 'mine'), 'functional object lost');
	assert.ok(res.after < res.before, 'retile should consolidate singles into bigger pieces');
});

test('zone draw follows the engine: one mountain set per zone', () => {
	for (let seed = 1; seed < 40; seed++) {
		const t = zoneTemplates('gr', xorshift(seed));
		const mountainArt = new Set(t.filter(e => e.type === 'mountain')
			.map(e => e.animation.slice(0, 6).toLowerCase()));
		// greyMountains AVLmtgn* / brownMountains AVLmtgr*: never both in one zone
		assert.ok(mountainArt.size <= 1, `zone mixed mountain sets: ${[...mountainArt]}`);
	}
});
