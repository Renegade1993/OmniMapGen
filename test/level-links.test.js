/**
 * level-links.test.js - what keeps a template's links what the template says
 * once starts can lie underground: the template's own cheapest way between
 * two zones (a forced border is never cheaper), the mods' monolith channels,
 * a guard's reach kept off free paths and other entrances, zones drawn toward
 * a start pinned below, and the paths held clear between a zone's links.
 * [HotA] Nostalgia seeds 5001 and 5002 (2026-09-27) broke each of these.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { templateBottleneck, crossLevelAnchors, pinnedStartSeed, holdFreePaths } = require('../src/biome/plan');
const { modChannels, linkBook, CHANNELS } = require('../src/biome/portals');
const { reachOnReserved, markApproach, footprintBlock, OCCUPIED, RESERVED } = require('../src/biome/content');

const link = (a, b, guard, type) => ({ aRef: { l: 0, i: a }, bRef: { l: 0, i: b }, guard, ...(type ? { type } : {}) });

test("a forced border costs what the template's own cheapest way costs", () => {
	// Nostalgia in small: starts 1 and 10 share free ground through zone 4,
	// starts 2 and 15 through 7; the groups meet only through 17 (12,500) and
	// the centre 3 (45,000); a fictive link joins nothing
	const plan = { connections: [link(1, 4, 3000), link(4, 10, 3000), link(2, 7, 3000), link(7, 15, 3000),
		link(10, 17, 12500), link(17, 15, 12500), link(1, 3, 45000), link(2, 3, 45000), link(4, 7, 0, 'fictive')] };
	const way = templateBottleneck(plan);
	assert.strictEqual(way(0, 4, 0, 7), 12500, 'the two groups apart by their 12,500 links');
	assert.strictEqual(way(0, 4, 0, 10), 3000, 'one group: free all the way');
	assert.strictEqual(way(0, 1, 0, 1), 0);
	assert.strictEqual(way(0, 4, 0, 99), Infinity, 'no path at all');
	const wide = templateBottleneck({ connections: [link(1, 2, 9000, 'wide')] });
	assert.strictEqual(wide(0, 1, 0, 2), 0, 'a wide link costs nothing');
});

test("a mod's land monoliths are channels after the core's eight", () => {
	const tpl = (animation, extra = {}) => ({ templates: [{ raw: { animation, mask: ['VV', 'VA'], ...extra } }] });
	const objects = new Map([
		['core:monolithTwoWay.monolith1', { subtype: 'monolith1', templates: [] }],
		['hota.x:core:monolithTwoWay.hotaRed', { subtype: 'hotaRed', ...tpl('hota/red') }],
		['hota.x:core:monolithTwoWay.hotaSea', { subtype: 'hotaSea', ...tpl('hota/sea', { allowedTerrains: ['water'] }) }],
		['hota.x:core:monolithTwoWay.noMask', { subtype: 'noMask', templates: [{ raw: { animation: 'x' } }] }],
		['hota.x:core:treasureChest.chest', { subtype: 'chest', ...tpl('chest') }],
	]);
	const extra = modChannels(objects);
	assert.deepStrictEqual(extra.map(ch => [ch.subtype, ch.mod, ch.tpl.animation]), [['hotaRed', 'hota.x', 'hota/red']],
		'the sea portal, the maskless one and the chest are no channels');
	const book = linkBook(extra);
	assert.strictEqual(book.left(), CHANNELS.length + 1);
	for (let i = 0; i < CHANNELS.length; i++) book.take(book.next());
	assert.strictEqual(book.next().subtype, 'hotaRed', 'handed out once the core ones are taken');
	book.take(book.next());
	assert.strictEqual(book.next(), null);
});

test("a template zone's guard never stands over a road or another entrance", () => {
	const W = 10, H = 10, blocked = new Uint8Array(W * H);
	const monster = { animation: 'm', mask: ['VVV', 'VAV'] };  // stands on (x - 1, y)
	assert.strictEqual(reachOnReserved(monster, 5, 5, 0, W, H, blocked), false, 'open ground');
	blocked[6 * W + 5] |= RESERVED;  // a road cell below its tile (4, 5)
	assert.strictEqual(reachOnReserved(monster, 5, 5, 0, W, H, blocked), true);
	assert.strictEqual(reachOnReserved(monster, 5, 5, 0, W, H, blocked, new Set([6 * W + 5])), false,
		'unless it is the approach of the object it guards');
	const other = new Uint8Array(W * H);
	const chest = { animation: 'c', mask: ['A'], visitableFrom: ['+++', '+-+', '+++'] };
	footprintBlock(chest, 3, 4, 0, W, H, other);
	markApproach(chest, 3, 4, 0, W, H, other);
	assert.strictEqual(reachOnReserved(monster, 5, 5, 0, W, H, other), true, "beside another object's entrance");
	assert.strictEqual(reachOnReserved(monster, 8, 8, 0, W, H, other), false);
});

test('a zone linked to a start pinned below is drawn to that start', () => {
	const zones = [[{ id: 1, type: 'treasure', size: 20 }, { id: 2, type: 'treasure', size: 20 }],
		[{ id: 3, type: 'playerStart', owner: 1, size: 20 }, { id: 4, type: 'treasure', size: 20 }]];
	const plan = { perLevel: zones, connections: [
		{ aRef: { l: 0, i: 0 }, bRef: { l: 1, i: 0 }, guard: 3000 },
		{ aRef: { l: 0, i: 1 }, bRef: { l: 1, i: 1 }, guard: 3000 }] };
	const starts = [{ owner: 1, l: 1, x: 4, y: 4 }];
	const seed = pinnedStartSeed(plan, { l: 1, i: 0 }, starts, 64, 64);
	assert.ok(seed.x > 4 && seed.y > 4 && seed.x < 32, `the town's cell moved in toward the middle: ${seed.x},${seed.y}`);
	assert.strictEqual(pinnedStartSeed(plan, { l: 1, i: 1 }, starts, 64, 64), null, 'not a start');
	const anchors = crossLevelAnchors(plan, [], 0, starts, 64, 64);
	assert.deepStrictEqual([anchors[0].x, anchors[0].y, anchors[0].k], [seed.x, seed.y, 1]);
	assert.strictEqual(anchors[1], null, 'its partner below is not laid out yet');
	assert.ok(crossLevelAnchors(plan, [], 0).every(a => a === null), 'without the starts, as before');
});

test("the ground between a zone's links is held clear, around its guards", () => {
	// a corridor three cells high between two monoliths
	const W = 12, H = 5;
	const mono = { animation: 'm', mask: ['VV', 'VA'], visitableFrom: ['---', '+-+', '+++'] };
	const lay = monster => {
		const blocked = new Uint8Array(W * H);
		for (let x = 0; x < W; x++) { blocked[x] |= OCCUPIED; blocked[(H - 1) * W + x] |= OCCUPIED; }
		const objects = [{ type: 'monolithTwoWay', l: 0, x: 2, y: 2, template: mono },
			{ type: 'monolithTwoWay', l: 0, x: 9, y: 2, template: mono }];
		for (const o of objects) footprintBlock(mono, o.x, o.y, 0, W, H, blocked);
		if (monster) objects.push({ type: 'randomMonsterLevel1', l: 0, x: 7, y: 2, template: { mask: ['VVV', 'VAV'] } });
		const plan = { zone: new Int32Array(W * H), objects, openings: [], roadCells: new Set() };
		return { held: holdFreePaths(plan, 0, W, H, blocked), blocked };
	};
	const open = lay(false);
	assert.ok(open.held > 0);
	assert.ok([1, 2, 3].some(y => open.blocked[y * W + 6] & RESERVED), 'the corridor between them is held');
	assert.strictEqual(lay(true).held, 0, 'a guard across the whole corridor: no free way to hold');
});
