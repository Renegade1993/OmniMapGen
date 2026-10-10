/**
 * playtest-checks.test.js - the grid checks of tools/harness/playtest_checks.js on hand-built maps, so each check is shown to
 * fail on the thing K showed (2026-10-06) and pass on its absence without a generation run.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { CHECKS } = require('../tools/harness/playtest_checks');

/** A W x H one-level map: land everywhere, `water(x, y)` true where it is water. */
function fake(W, H, water, extra = {}) {
	const terr = new Array(W * H);
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) terr[y * W + x] = water(x, y) ? 'wt' : 'gr';
	return { NL: 1, W, H, terr, idx: (l, x, y) => (l * H + y) * W + x, inb: (x, y) => x >= 0 && y >= 0 && x < W && y < H, objs: [], monsters: [], zones: null, regionsOf: () => [], ...extra };
}
const sea = (x, y) => y >= 30;                       // a sea along the bottom, so there is water to measure

test('coast-slots: a ruler-straight slot of 2 by 14 fails, a slot of 2 by 6 passes, a ragged channel passes', () => {
	const slot = len => (x, y) => sea(x, y) || ((x === 20 || x === 21) && y >= 4 && y < 4 + len);
	const r = CHECKS['coast-slots'](fake(40, 40, slot(14)));
	assert.strictEqual(r.pass, false, r.value);
	assert.ok(/2 wide, 14 long/.test(r.items[0]), r.items[0]);
	assert.strictEqual(CHECKS['coast-slots'](fake(40, 40, slot(6))).pass, true);
	// the same 14 rows with the channel wandering by two tiles every few rows is not a slot
	const ragged = (x, y) => sea(x, y) || (y >= 4 && y < 18 && x >= 20 + 2 * Math.floor((y - 4) / 3) % 4 && x <= 21 + 2 * Math.floor((y - 4) / 3) % 4);
	assert.strictEqual(CHECKS['coast-slots'](fake(40, 40, ragged)).pass, true);
});

test('coast-slots: skipped on a map with no water', () => {
	assert.ok(CHECKS['coast-slots'](fake(40, 40, () => false)).skipped);
});

test('guard-clusters: four stacks within two tiles of each other fail; stacks spread across the map pass', () => {
	const mon = (x, y) => ({ l: 0, at: [x, y], cls: 'monster' });
	const crowd = [mon(10, 10), mon(11, 11), mon(12, 10), mon(11, 9)];
	for (let i = 0; i < 40; i++) crowd.push(mon(3 + (i % 8) * 4, 20 + ((i / 8) | 0) * 4));
	const bad = CHECKS['guard-clusters'](fake(40, 40, () => false, { monsters: crowd }));
	assert.strictEqual(bad.pass, false, bad.value);
	const spread = [];
	for (let i = 0; i < 40; i++) spread.push(mon(3 + (i % 8) * 4, 4 + ((i / 8) | 0) * 4));
	assert.strictEqual(CHECKS['guard-clusters'](fake(40, 40, () => false, { monsters: spread })).pass, true);
});

test('towns-per-start: a start zone with two towns against one with one fails (K 36x36 seed 1750425233: red 2, blue 1)', () => {
	const town = (x, y, zone) => ({ l: 0, cls: 'town', type: 'town', at: [x, y], x, y, zone });
	const objs = [town(5, 5, 1), town(8, 5, 1), town(30, 30, 2)];
	const M = fake(40, 40, () => false, {
		objs,
		header: { players: { red: { mainTown: { l: 0, x: 5, y: 5 } }, blue: { mainTown: { l: 0, x: 30, y: 30 } } } },
		zones: { zoneOf: () => undefined },
	});
	M.zoneAt = (l, x, y) => objs.find(o => o.at[0] === x && o.at[1] === y).zone;
	const r = CHECKS['towns-per-start'](M);
	assert.strictEqual(r.pass, false, r.value);
	objs.push(town(33, 30, 2));
	assert.strictEqual(CHECKS['towns-per-start'](M).pass, true);
});
