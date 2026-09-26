/**
 * start-order.test.js - a template's start zones get the start cells its links
 * arrange them in (startOrder.js). Golem Foundry rings four starts through
 * quarries (1-5-2-6-3-7-4-8-1); pinned in the CLI's order, players 1 and 2 sat
 * on opposite corners and 2 to 5 of the 12 links fell back to portal pairs on
 * each of five seeds (2026-09-26).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { orderStarts } = require('../src/rmg/startOrder');

// the CLI's first four start cells on a 72x72 map, in player order
const CORNERS = [{ x: 4, y: 4 }, { x: 67, y: 67 }, { x: 4, y: 67 }, { x: 67, y: 4 }];
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

test('a ring of four starts puts ring neighbours on neighbouring corners', () => {
	const ring = { connections: [[1, 5], [2, 5], [2, 6], [3, 6], [3, 7], [4, 7], [4, 8], [1, 8],
		[5, 9], [6, 9], [7, 9], [8, 9]].map(([a, b]) => ({ a: String(a), b: String(b), guard: 5000 })) };
	const order = orderStarts(ring, [1, 2, 3, 4], CORNERS);
	const at = k => CORNERS[order[k]];
	assert.deepStrictEqual(at(0), CORNERS[0], 'player 1 keeps the first cell when that costs nothing');
	for (const [a, b] of [[0, 1], [1, 2], [2, 3], [3, 0]])
		assert.ok(dist(at(a), at(b)) < 70, `ring neighbours ${a + 1} and ${b + 1} sit on neighbouring corners`);
	for (const [a, b] of [[0, 2], [1, 3]])
		assert.ok(dist(at(a), at(b)) > 80, `${a + 1} and ${b + 1} face each other across the map`);
});

test('starts the template treats alike keep the CLI order', () => {
	const star = { connections: [1, 2, 3, 4].map(s => ({ a: String(s), b: '5', guard: 3000 })) };
	assert.deepStrictEqual(orderStarts(star, [1, 2, 3, 4], CORNERS), [0, 1, 2, 3]);
	// two starts: nothing to arrange
	assert.deepStrictEqual(orderStarts(star, [1, 2], CORNERS.slice(0, 2)), [0, 1]);
});

test('Golem Foundry at 72x72 for four realizes every link as land', { timeout: 300000 }, () => {
	const { spawnSync } = require('child_process');
	const path = require('path');
	const { genEnv, testTmp } = require('./_vcmi');
	for (const seed of ['1', '2']) {
		const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'),
			'--w', '72', '--h', '72', '--players', '4', '--seed', seed, '--declaremods', '0',
			'--template', 'Golem Foundry', '--out', path.join(testTmp(), 'golem_foundry_plan.vmap')],
		{ encoding: 'utf8', timeout: 240000, cwd: path.join(__dirname, '..'), windowsHide: true,
			env: genEnv({ VMAPGEN_PLAN_ONLY: '1' }) });
		assert.strictEqual(r.status, 0, r.stderr.slice(-600));
		const plan = JSON.parse(r.stdout.split('\n').find(l => l.startsWith('{"plan"'))).plan[0];
		assert.strictEqual(plan.links, 12);
		assert.strictEqual(plan.unfulfilled, 0, `seed ${seed}: ${plan.unfulfilled} links fell back to portals`);
	}
});

test('a start the links never reach counts as far from the rest', () => {
	const t = { connections: [{ a: '1', b: '2' }, { a: '2', b: '3' }] };
	const order = orderStarts(t, [1, 2, 3, 4], CORNERS);
	assert.deepStrictEqual([...order].sort(), [0, 1, 2, 3]);
	const at = k => CORNERS[order[k]];
	assert.ok(dist(at(0), at(1)) < 70 && dist(at(1), at(2)) < 70, 'the chain 1-2-3 runs along neighbouring corners');
});
