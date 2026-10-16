/**
 * start-primary.test.js - a start's own wood and ore behind no stack of level 5 or more (K, 2026-10-14, his 144x144 six-player Coldshadow
 * map seed 2042393645, red: "my wood (being a primary resource) blocked behind high-tier creatures is not how the game should be (least of
 * all in a starting biome)"; the sawmill (32,139) reached only through the ring of 33 Earth Elementals, over the Pandora's box they guard).
 * startPrimaryGuards: a pile behind such a stack moves onto ground the start walks to with no fight, a mine moves the same way, and failing
 * that a stack that guards nothing else becomes weak (level 2 or lower, at most 2000); never a same-strength relabel (the lead's ruling).
 * The stack stands IN the way, as guards do (the Opus Reviewer, pass 56: with the stack beside a gap the first version passed and missed K's).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { startPrimaryGuards } = require('../src/biome/plan');
const { OCCUPIED, RESERVED, footprintBlock } = require('../src/biome/content');
const { pileTemplate, mineTemplate } = require('../src/biome/economy');
const { OBJECT_TEMPLATES } = require('../src/stitch/zones');

const POOL = [
	{ id: 'six', level: 6, aiValue: 1000, advMin: 4, advMax: 7, faction: 'neutral' },
	{ id: 'four', level: 4, aiValue: 500, advMin: 4, advMax: 7, faction: 'neutral' },
	{ id: 'two', level: 2, aiValue: 100, advMin: 4, advMax: 7, faction: 'neutral' },
];
const W = 24, H = 24;
// one zone, a wall down column 14 with one gap at (14,12) and the stack standing in it; the town west of the wall. opts.cramped: the west
// side reserved (no room for anything moved); opts.box: a Pandora's box beside the stack, east of the wall; opts.level: the stack's level
const run = (thing, opts = {}) => {
	const blocked = new Uint8Array(W * H), zone = new Int16Array(W * H);
	for (let y = 0; y < H; y++) if (y !== 12) blocked[y * W + 14] |= OCCUPIED;
	if (opts.cramped) for (let y = 0; y < H; y++) for (let x = 0; x < 14; x++) blocked[y * W + x] |= RESERVED;
	const pile = pileTemplate('randomResource');
	const lv = opts.level || 6, id = lv === 6 ? 'six' : 'four';
	const objects = [
		{ type: 'town', subtype: 'castle', x: 4, y: 12, l: 0, template: pile, options: { owner: 'red' } },
		{ type: `randomMonsterLevel${lv}`, subtype: 'object', x: 14, y: 12, l: 0, template: OBJECT_TEMPLATES.randomMonster, guardCreature: id, options: { character: 'hostile', amount: 10 } },
		thing === 'mine' ? { type: 'mine', subtype: 'sawmill', x: 20, y: 13, l: 0, template: mineTemplate('sawmill') }
			: { type: 'resource', subtype: 'wood', x: 19, y: 5, l: 0, template: pile },
	];
	if (opts.box) objects.push({ type: 'pandoraBox', subtype: 'object', x: 15, y: 11, l: 0, template: pile });
	for (const o of objects) footprintBlock(o.template, o.x, o.y, 0, W, H, blocked);
	const pl = { zone, objects, roadCells: new Set(), p: {}, objectPools: { guards: POOL }, zoneMeta: [{ spec: {} }] };
	const r = startPrimaryGuards(pl, 0, W, H, blocked, () => 0.5);
	return { r, objects: pl.objects };
};
const stackOf = objects => objects.find(o => /^randomMonster/.test(o.type));

test('a sawmill behind a level 6 stack standing in the way moves to the start\'s side; the stack stays', () => {
	const { r, objects } = run('mine');
	const m = objects.find(o => o.type === 'mine');
	assert.strictEqual(r.found, 1);
	assert.strictEqual(r.mines, 1);
	assert.ok(m.x < 14, `the sawmill at (${m.x},${m.y}) is west of the wall`);
	assert.strictEqual(stackOf(objects).type, 'randomMonsterLevel6');
});

test('a wood pile behind a level 6 stack standing in the way moves to the start\'s side, out of its ring', () => {
	const { r, objects } = run('pile');
	const w = objects.find(o => o.type === 'resource');
	assert.strictEqual(r.moved, 1);
	assert.ok(w.x < 14 && Math.max(Math.abs(w.x - 14), Math.abs(w.y - 12)) > 1, `the pile at (${w.x},${w.y})`);
});

test('with no room to move the sawmill, a stack that guards nothing else becomes weak: level 2 or lower, at most 2000', () => {
	const { r, objects } = run('mine', { cramped: true });
	const g = stackOf(objects);
	assert.strictEqual(r.mines, 0);
	assert.strictEqual(r.weakened, 1);
	assert.ok(/^randomMonsterLevel[12]$/.test(g.type), g.type);
	assert.ok(g.options.amount * 100 <= 2000, `strength ${g.options.amount * 100}`);
});

test('a stack that also guards a Pandora\'s box is not weakened; the sawmill is counted as left', () => {
	const { r, objects } = run('mine', { cramped: true, box: true });
	assert.ok(r.left >= 1, `left ${r.left}`);
	assert.strictEqual(stackOf(objects).type, 'randomMonsterLevel6');
	assert.strictEqual(stackOf(objects).options.amount, 10);
});

test("a level 4 stack on the way to the start's nearest sawmill: the sawmill moves (the engine leaves those to level 1 or nothing)", () => {
	const { r, objects } = run('mine', { level: 4 });
	assert.strictEqual(r.mines, 1);
	assert.ok(objects.find(o => o.type === 'mine').x < 14);
});

test('a level 4 stack on the way to a second, farther sawmill is left alone; a level 6 one is not', () => {
	for (const [lv, found] of [[4, 0], [6, 1]]) {
		const blocked = new Uint8Array(W * H), zone = new Int16Array(W * H);
		for (let y = 0; y < H; y++) if (y !== 12) blocked[y * W + 14] |= OCCUPIED;
		const pile = pileTemplate('randomResource');
		const objects = [
			{ type: 'town', subtype: 'castle', x: 4, y: 12, l: 0, template: pile, options: { owner: 'red' } },
			{ type: `randomMonsterLevel${lv}`, subtype: 'object', x: 14, y: 12, l: 0, template: OBJECT_TEMPLATES.randomMonster, guardCreature: lv === 6 ? 'six' : 'four', options: { character: 'hostile', amount: 10 } },
			{ type: 'mine', subtype: 'sawmill', x: 9, y: 5, l: 0, template: mineTemplate('sawmill') },
			{ type: 'mine', subtype: 'sawmill', x: 20, y: 13, l: 0, template: mineTemplate('sawmill') },
		];
		for (const o of objects) footprintBlock(o.template, o.x, o.y, 0, W, H, blocked);
		const r = startPrimaryGuards({ zone, objects, roadCells: new Set(), p: {}, objectPools: { guards: POOL }, zoneMeta: [{ spec: {} }] }, 0, W, H, blocked, () => 0.5);
		assert.strictEqual(r.found, found, `level ${lv}`);
	}
});

// the third round (MapGen Dev's caps, the engine's own rates): an open map, the town at (4,12), the object within 14 tiles of it
const open = (thing, lv, at) => {
	const blocked = new Uint8Array(W * H), zone = new Int16Array(W * H);
	const pile = pileTemplate('randomResource');
	const objects = [
		{ type: 'town', subtype: 'castle', x: 4, y: 12, l: 0, template: pile, options: { owner: 'red' } },
		thing === 'mine' ? { type: 'mine', subtype: 'sawmill', x: at[0], y: at[1], l: 0, template: mineTemplate('sawmill') }
			: { type: 'resource', subtype: 'wood', x: at[0], y: at[1], l: 0, template: pile },
	];
	// the stack on the tile below the object's way in, its ring over that way
	const vis = require('../src/biome/content').visitableCells(objects[1].template, at[0], at[1])[0];
	objects.push({ type: `randomMonsterLevel${lv}`, subtype: 'object', x: vis[0], y: vis[1] + 2, l: 0, template: OBJECT_TEMPLATES.randomMonster,
		guardCreature: { 1: 'one', 2: 'two', 4: 'four', 6: 'six' }[lv], options: { character: 'hostile', amount: 10 } });
	for (const o of objects) footprintBlock(o.template, o.x, o.y, 0, W, H, blocked);
	const pl = { zone, objects, roadCells: new Set(), p: {}, objectPools: { guards: POOL.concat([{ id: 'one', level: 1, aiValue: 50, advMin: 4, advMax: 7, faction: 'neutral' }]) }, zoneMeta: [{ spec: {} }] };
	const r = startPrimaryGuards(pl, 0, W, H, blocked, () => 0.5);
	const o = pl.objects.find(q => q.type === objects[1].type);
	const ways = [];
	for (const [vx, vy] of require('../src/biome/content').visitableCells(o.template, o.x, o.y)) for (const [dx, dy] of require('../src/biome/content').allowedDirs(o.template)) ways.push([vx + dx, vy + dy]);
	const ctl = pl.objects.filter(m => /^randomMonster/.test(m.type) && ways.some(([x, y]) => Math.max(Math.abs(x - m.x), Math.abs(y - m.y)) <= 1));
	return { r, ctl };
};
const lvOf = m => +/(\d)$/.exec(m.type)[1];

test('a sawmill 6 tiles from the town keeps no stack on its ways, even a level 2 one (the engine guards no start mine)', () => {
	const { r, ctl } = open('mine', 2, [12, 8]);
	assert.ok(r.capped + r.mines >= 1, JSON.stringify(r));
	assert.strictEqual(ctl.length, 0);
});

// 9 to 14 tiles: level 2 at most (the lead, 2026-10-15 08:36; it was level 4)
test('a wood pile 6 tiles out keeps at most a level 1 stack on its ways; one 11 tiles out at most level 2', () => {
	const a = open('pile', 6, [10, 9]);
	assert.ok(a.ctl.every(m => lvOf(m) <= 1), a.ctl.map(m => m.type).join());
	const b = open('pile', 4, [15, 6]);
	assert.ok(b.r.capped + (b.r.farFreed || 0) >= 1 && b.ctl.every(m => lvOf(m) <= 2), b.ctl.map(m => m.type).join());
	const c = open('pile', 2, [15, 6]);
	assert.strictEqual(c.r.capped, 0);
});
