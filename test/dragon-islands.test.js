/**
 * dragon-islands.test.js - every dragon island holds a dragon dwelling (K, 2026-10-04, islands Coldshadow: "each dragon island should
 * have at least one generation structure"). A dragon zone is a rich zone with no town of its own (Coldshadow's junction zones 17 to
 * 20): each one that has room gets one of the signature dwellings, the kinds going round, with a guard on its way in.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ensureSignatureDwelling } = require('../src/biome/plan');

const W = 40, H = 40;
const tpl = { animation: 'AVXtest', mask: ['VBB', 'VBA'], visitableFrom: ['+++', '+-+', '+++'] };
const cand = subtype => ({ type: 'creatureGeneratorSpecial', subtype, tpl, value: 50000 });
const level = () => {
	const zone = new Int16Array(W * H).fill(-1);
	// zone index 0 = template zone 17 (x 2..18), 1 = zone 18 (x 21..37), 2 = zone 21 with a castle (rows 30..38)
	for (let y = 2; y < 28; y++) for (let x = 2; x < 19; x++) zone[y * W + x] = 0;
	for (let y = 2; y < 28; y++) for (let x = 21; x < 38; x++) zone[y * W + x] = 1;
	for (let y = 30; y < 39; y++) for (let x = 2; x < 38; x++) zone[y * W + x] = 2;
	return { zone, objects: [], roadCells: new Set(), openMask: null, p: {} };
};
const pools = () => ({ __sigCands: [cand('frozenCliffs'), cand('sulfurousLair')], __richZones: new Set([17, 18, 21]) });
const p = { zonePlan: { perLevel: [[{ id: 17 }, { id: 18 }, { id: 21, neutralTowns: { castles: 1 } }]] } };
const dwellings = pl => pl.objects.filter(o => o.type === 'creatureGeneratorSpecial');
let seed = 1;
const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

test('each rich zone without a town gets a dwelling and a guard; the zone with the castle does not', () => {
	const pl = level(), blocked = new Uint8Array(W * H);
	const line = ensureSignatureDwelling([pl], W, H, blocked, pools(), p, rng);
	const d = dwellings(pl);
	assert.strictEqual(d.length, 2, line);
	assert.deepStrictEqual(d.map(o => pl.zone[o.y * W + o.x]).sort(), [0, 1]);
	assert.strictEqual(new Set(d.map(o => o.subtype)).size, 2, 'the kinds go round');
	assert.strictEqual(pl.objects.filter(o => /^randomMonster/.test(o.type)).length, 2, 'a guard each');
});

test('a zone that already has one is left alone', () => {
	const pl = level(), blocked = new Uint8Array(W * H);
	pl.objects.push({ type: 'creatureGeneratorSpecial', subtype: 'frozenCliffs', x: 10, y: 10, l: 0, template: tpl });
	ensureSignatureDwelling([pl], W, H, blocked, pools(), p, rng);
	const d = dwellings(pl);
	assert.strictEqual(d.length, 2, 'zone 18 got its own, zone 17 kept its one');
	assert.strictEqual(d.filter(o => pl.zone[o.y * W + o.x] === 0).length, 1);
});
