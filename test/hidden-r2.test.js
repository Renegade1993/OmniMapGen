// Hidden by the south-first order (R2b), spec scope N (roster SPEC-MapGenDev-hidden-by-r2-1107.md; the Opus Reviewer 2026-11-07; K item 39: "still have some incorrect layering
// of creatures, buildings, and blocker decorations"; K: "The further down/toward the player's view, the higher the display priority"). The engine is to draw the object anchored
// further south over the one north of it. A pickup or a stack stands where a building south of it covers a quarter or more of its picture only if the stock order already hid it.
// Mechanism tests: the order itself (no sprites), and the registry in content.js with the sprites of the suite's install (skipped where it has none, as declip-art.test.js).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { genEnv } = require('./_vcmi');
const pics = require('../src/biome/pictures');
const content = require('../src/biome/content');
const { declipPictures } = require('../src/biome/declip');

test('R2b: priority first, then the lower anchor row first, then decoration, object, hero, then file order', () => {
	const o = (x, y, k, cls = 1, z = 0) => ({ x, y, k, cls, z });
	assert.ok(pics.drawnBeforeR2b(o(5, 4, 9), o(5, 5, 1)), 'the object anchored further south is drawn later');
	assert.ok(!pics.drawnBeforeR2b(o(5, 5, 1), o(5, 4, 9)));
	assert.ok(pics.drawnBeforeR2b(o(5, 5, 9, 0), o(5, 5, 1, 1)), 'on one row a decoration goes before an object whatever the file order');
	assert.ok(pics.drawnBeforeR2b(o(5, 5, 9, 1), o(5, 5, 1, 3)), 'a hero goes last');
	assert.ok(pics.drawnBeforeR2b(o(5, 5, 1, 1), o(6, 5, 2, 1)) && !pics.drawnBeforeR2b(o(6, 5, 2, 1), o(5, 5, 1, 1)), 'an object and a stack tie by file order, as stock');
	assert.ok(pics.drawnBeforeR2b(o(5, 9, 1, 1, 3), o(5, 1, 0, 1, 0)), 'a draw priority goes under every object without one, whatever the row');
	// the blocked-tile rule of the stock comparator is not part of R2b
	const stockUnder = { x: 4, y: 4, z: 0, k: 1, hero: false, cells: new Set(['4,4']) }, stockOver = { x: 4, y: 5, z: 0, k: 2, hero: false, cells: new Set(['4,5']) };
	assert.strictEqual(pics.drawnBefore(stockUnder, stockOver), pics.drawnBeforeR2b({ ...stockUnder, cls: 1 }, { ...stockOver, cls: 1 }));
});

const W = 20, H = 20;
const ROOTS = [genEnv().VCMI_ROOT, process.env.VMAPGEN_SPRITE_ROOT].filter(Boolean);
const UTOPIA = { animation: 'AVSutop0', mask: ['VVVVVVV', 'VVVVVVV', 'VVVBBBB', 'VBBBBBV', 'VVVBBAV'], visitableFrom: ['---', '+-+', '+++'] };
const SCROLL = { animation: 'AVA0001', mask: ['VA'], visitableFrom: ['+++', '+-+', '+++'] };
const CHEST = { animation: 'AVTchst0', mask: ['VA'], visitableFrom: ['+++', '+-+', '+++'] };
const readable = !!(pics.spriteOf(UTOPIA.animation, ROOTS) && pics.spriteOf(CHEST.animation, ROOTS));

function withEnv(env, fn) {
	const was = {};
	for (const k of Object.keys(env)) { was[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
	try { return fn(); } finally { for (const k of Object.keys(env)) { if (was[k] === undefined) delete process.env[k]; else process.env[k] = was[k]; } }
}

test('a pickup is refused where a Dragon Utopia south of it covers a quarter of its picture, and stands where it is clear', { skip: !readable && 'sprites not in the suite install' }, () => {
	process.env.VCMI_ROOT = process.env.VCMI_ROOT || genEnv().VCMI_ROOT;
	const blocked = new Uint8Array(W * H);
	content.setTallArt(true);
	assert.ok(content.footprintBlock(UTOPIA, 10, 12, 0, W, H, blocked));
	const refused = [], seen = [];
	for (let y = 4; y <= 12; y++) for (let x = 3; x <= 16; x++) {
		if (blocked[y * W + x]) continue;
		(content.footprintFits(CHEST, x, y, 0, W, H, blocked) ? seen : refused).push([x, y]);
	}
	assert.ok(refused.length >= 1, 'a tile under the Utopia\'s picture is refused');
	assert.ok(content.tallStat().loot >= refused.length, 'the refusals are counted');
	assert.ok(refused.every(([, y]) => y < 12), 'only tiles north of its anchor row');
	assert.ok(seen.some(([x, y]) => y <= 5), 'ground well north of it is free');
	// off: every tile fits as before
	withEnv({ VMAPGEN_TALL_ART: '0' }, () => { for (const [x, y] of refused) assert.ok(content.footprintFits(CHEST, x, y, 0, W, H, blocked), `(${x},${y}) fits with the rule off`); });
	content.setTallArt(false);
	for (const [x, y] of refused) assert.ok(content.footprintFits(CHEST, x, y, 0, W, H, blocked), `(${x},${y}) fits for a template that keeps its pickups where they landed`);
	content.setTallArt(true);
});

test('a Dragon Utopia is refused where its picture would cover a placed pickup, and goes where it is clear', { skip: !readable && 'sprites not in the suite install' }, () => {
	content.setTallArt(true);
	// find a tile above where the Utopia at (10,12) would be refused for a pickup, then put the pickup there first
	const probe = new Uint8Array(W * H);
	content.footprintBlock(UTOPIA, 10, 12, 0, W, H, probe);
	let tile = null;
	for (let y = 4; y < 12 && !tile; y++) for (let x = 3; x <= 16 && !tile; x++) if (!probe[y * W + x] && !content.footprintFits(CHEST, x, y, 0, W, H, probe)) tile = [x, y];
	assert.ok(tile, 'a pickup tile the Utopia refuses');
	const blocked = new Uint8Array(W * H);
	assert.ok(content.footprintBlock(CHEST, tile[0], tile[1], 0, W, H, blocked));
	assert.ok(!content.footprintFits(UTOPIA, 10, 12, 0, W, H, blocked), 'the Utopia does not go over the pickup');
	assert.ok(content.footprintFits(UTOPIA, 10, 17, 0, W, H, blocked) || content.footprintFits(UTOPIA, 15, 18, 0, W, H, blocked), 'it goes where no pickup lies under its picture');
	withEnv({ VMAPGEN_TALL_ART: '0' }, () => assert.ok(content.footprintFits(UTOPIA, 10, 12, 0, W, H, blocked), 'with the rule off it goes there as before'));
	assert.ok(content.tallStat().building >= 1);
});

test('declipPictures moves a pickup the south-first order hides and stock shows, inside the pickup\'s ring, and VMAPGEN_DECLIP_R2=0 leaves it', { skip: !readable && 'sprites not in the suite install' }, () => {
	const { blockingCells, footprintCells } = content;
	const entry = (type, x, y, template) => ({ instanceName: `${type}_${x}_${y}_0`, l: 0, x, y, type, subtype: 'object', template });
	const blockedOf = plan => { const b = new Uint8Array(W * H); for (const o of plan.objects) for (const [x, y] of blockingCells(o.template, o.x, o.y)) b[y * W + x] |= 1; return b; };
	// scan for a tile above the Utopia whose pickup R2b hides and stock shows: the one the placement test refuses
	content.setTallArt(true);
	const probe = new Uint8Array(W * H);
	content.footprintBlock(UTOPIA, 10, 12, 0, W, H, probe);
	let tile = null;
	for (let y = 4; y < 12 && !tile; y++) for (let x = 3; x <= 16 && !tile; x++) if (!probe[y * W + x] && !content.footprintFits(CHEST, x, y, 0, W, H, probe)) tile = [x, y];
	assert.ok(tile, 'a tile where R2b hides and stock shows');
	const make = () => { const u = entry('dragonUtopia', 10, 12, UTOPIA), c = entry('treasureChest', tile[0], tile[1], CHEST); return { u, c, plan: { objects: [u, c], openMask: new Uint8Array(W * H).fill(1) } }; };
	const on = make();
	const r = declipPictures(on.plan, W, H, 0, blockedOf(on.plan), blockingCells, footprintCells, ROOTS);
	assert.strictEqual(r.moved, 1, 'the pickup moved');
	assert.strictEqual(r.r2bMoved, 1, 'and it was one the south-first order newly hides');
	assert.ok(Math.max(Math.abs(on.c.x - tile[0]), Math.abs(on.c.y - tile[1])) <= 2, 'within two tiles');
	const off = make();
	withEnv({ VMAPGEN_DECLIP_R2: '0' }, () => assert.deepStrictEqual(declipPictures(off.plan, W, H, 0, blockedOf(off.plan), blockingCells, footprintCells, ROOTS), { moved: 0, left: 0 }));
	assert.deepStrictEqual([off.c.x, off.c.y], tile, 'with the order off it stays where it stood');
});
