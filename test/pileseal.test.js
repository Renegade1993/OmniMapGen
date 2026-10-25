/**
 * pileseal.test.js - a pile moved into a dead end is closed once it has
 * moved: the cell it leaves does not open a second way into the dead end
 * (findings-oe.md, pileseal.js).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { sealPiles } = require('../src/biome/pileseal');

const OCCUPIED = 1, RESERVED = 2, APPROACH = 4;
const tpl = { mask: ['A'] };
const deps = W => ({
	OCCUPIED, RESERVED, APPROACH,
	blockingCells: (t, x, y) => [[x, y]],
	visitableCells: (t, x, y) => [[x, y]],
	footprintFits: (t, x, y, l, W2, H2, blocked) => !(blocked[y * W + x] & OCCUPIED),
	footprintBlock: (t, x, y, l, W2, H2, blocked) => { blocked[y * W + x] |= OCCUPIED; return true; },
	markApproach: () => {},
	objectEntry: (type, x, y, l, template) => ({ type, x, y, l, template, instanceName: `${type}_${x}_${y}` }),
	monsterTpl: tpl, monsterOptions: () => ({}), rng: () => 0.5,
});

test('sealPiles: no dead end whose second way in is the cell the pile leaves', () => {
	const W = 12, H = 12;
	const blocked = new Uint8Array(W * H);
	// the dead end (6,5): walled above and below, its one free neighbour (5,5), the pile at (7,5) beside it
	for (const [x, y] of [[5, 4], [6, 4], [7, 4], [5, 6], [6, 6], [7, 6]]) blocked[y * W + x] |= OCCUPIED;
	// a second dead end that stays closed when the pile leaves: (10,10), its free neighbour (9,10)
	for (const [x, y] of [[9, 9], [10, 9], [11, 9], [11, 10], [9, 11], [10, 11], [11, 11]]) blocked[y * W + x] |= OCCUPIED;
	const pile = { type: 'randomArtifactRelic', x: 7, y: 5, l: 0, template: tpl };
	blocked[5 * W + 7] |= OCCUPIED;
	const plan = { zone: new Int32Array(W * H), objects: [pile], roadCells: new Set(), p: {} };
	sealPiles(plan, W, H, 0, blocked, deps(W));
	const free = c => !(blocked[c] & OCCUPIED);
	const guards = plan.objects.filter(o => /Monster/.test(o.type)).map(m => m.y * W + m.x);
	const ways = [];
	for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
		const u = pile.x + dx, v = pile.y + dy;
		if ((dx || dy) && u >= 0 && v >= 0 && u < W && v < H && free(v * W + u)) ways.push(v * W + u);
	}
	assert.deepStrictEqual([pile.x, pile.y], [10, 10]);
	assert.deepStrictEqual(ways, [], `pile at (${pile.x},${pile.y}) has free neighbours ${ways.map(c => `(${c % W},${(c / W) | 0})`).join(' ')}; guard ${guards}`);
});
