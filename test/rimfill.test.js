/**
 * rimfill.test.js
 *
 * Pins the rim-lobe pass (src/biome/rimfill.js): it only ever adds blocking,
 * never on a doorway, keeps the open ground in one piece, turns no roomy cell
 * into a one-cell sliver, and leaves every object a way in.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { fillRimRows } = require('../src/biome/rimfill');
const { OCCUPIED, blockingCells, visitableCells, allowedDirs } = require('../src/biome/content');
const { xorshift } = require('../src/wfc/solver');

const W = 30, H = 20;
const entry = (type, x, y, l, tpl, subtype = 'object') =>
	({ instanceName: `${type}_${x}_${y}_${l}`, l, x, y, type, subtype,
		template: { animation: tpl.animation, mask: tpl.mask, visitableFrom: tpl.visitableFrom } });

function world() {
	const zone = new Int16Array(W * H);
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) zone[y * W + x] = x < W / 2 ? 0 : 1;
	const blocked = new Uint8Array(W * H);
	const objects = [];
	const rock = { animation: 'AVLrk1gr.def', mask: ['B'] };
	// the rim band: two cells deep on each side of the zone line, with a
	// one-cell doorway through it at y = 10
	for (let y = 0; y < H; y++)
		for (const x of [W / 2 - 2, W / 2 - 1, W / 2, W / 2 + 1]) {
			if (y === 10) continue;
			blocked[y * W + x] |= OCCUPIED;
			objects.push(entry('rock', x, y, 0, rock));
		}
	// a pickup against the band, so its ways in run along the rim rows
	const pile = { animation: 'AVTwood0.def', mask: ['A'], visitableFrom: ['+++', '+-+', '+++'] };
	blocked[5 * W + 12] |= OCCUPIED;
	objects.push(entry('resource', 12, 5, 0, pile, 'wood'));
	const hole = [10 * W + 14, 10 * W + 15];
	const plan = { zone, biomeTerrain: ['gr', 'gr'], objects, roadCells: new Set(),
		openings: [{ a: 0, b: 1, kind: 'openNoRoad', hole, inner: [10 * W + 13, 10 * W + 16] }],
		towns: [] };
	return { plan, blocked, hole };
}

const free = (b, c) => !(b[c] & OCCUPIED);
function roomy(b, c) {
	const x = c % W, y = (c / W) | 0;
	const f = (a, d) => a >= 0 && d >= 0 && a < W && d < H && free(b, d * W + a);
	for (const [ox, oy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]])
		if (f(x + ox, y + oy) && f(x + ox + 1, y + oy) && f(x + ox, y + oy + 1) && f(x + ox + 1, y + oy + 1)) return true;
	return false;
}
function components(b) {
	const seen = new Uint8Array(W * H);
	let n = 0;
	for (let s = 0; s < W * H; s++) {
		if (!free(b, s) || seen[s]) continue;
		n++;
		const st = [s]; seen[s] = 1;
		while (st.length) {
			const c = st.pop(), x = c % W, y = (c / W) | 0;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const k = ny * W + nx;
				if (!seen[k] && free(b, k)) { seen[k] = 1; st.push(k); }
			}
		}
	}
	return n;
}

test('rim lobes: blocking only grows, doorway stays open, ground stays one piece', () => {
	const { plan, blocked, hole } = world();
	const before = Uint8Array.from(blocked);
	const n = fillRimRows(plan, W, H, 0, blocked, xorshift(7), entry, o => o.type !== 'resource');
	assert.ok(n > 0, 'the pass should add some blocking');
	for (let c = 0; c < W * H; c++)
		if (before[c] & OCCUPIED) assert.ok(blocked[c] & OCCUPIED, `cell ${c} was unblocked`);
	for (const c of hole) assert.ok(free(blocked, c), 'a doorway cell was blocked');
	assert.strictEqual(components(blocked), components(before));
});

test('rim lobes: no roomy cell becomes a sliver, every object keeps a way in', () => {
	const { plan, blocked } = world();
	const before = Uint8Array.from(blocked);
	fillRimRows(plan, W, H, 0, blocked, xorshift(11), entry, o => o.type !== 'resource');
	for (let c = 0; c < W * H; c++)
		if (free(blocked, c) && roomy(before, c)) assert.ok(roomy(blocked, c), `cell ${c} became a sliver`);
	const pile = plan.objects.find(o => o.type === 'resource');
	const own = new Set(blockingCells(pile.template, pile.x, pile.y).map(([a, b]) => b * W + a));
	let ways = 0;
	for (const [vx, vy] of visitableCells(pile.template, pile.x, pile.y))
		for (const [dx, dy] of allowedDirs(pile.template)) {
			const c = (vy + dy) * W + (vx + dx);
			if (!own.has(c) && free(blocked, c)) ways++;
		}
	assert.ok(ways >= 1, 'the pickup lost every way in');
});

test('VMAPGEN_RIMFILL=off leaves the level untouched', () => {
	const { plan, blocked } = world();
	const before = Uint8Array.from(blocked);
	process.env.VMAPGEN_RIMFILL = 'off';
	try {
		assert.strictEqual(fillRimRows(plan, W, H, 0, blocked, xorshift(7), entry, () => true), 0);
	} finally { delete process.env.VMAPGEN_RIMFILL; }
	assert.deepStrictEqual(blocked, before);
});
