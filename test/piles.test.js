/**
 * piles.test.js - the engine's treasure piles as src/rmg/piles.js builds
 * them, rule by rule from VCMI's TreasurePlacer.cpp: the pool a zone draws
 * from (addAllPossibleObjects, ObjectDistributor for map limits), and
 * prepareTreasurePile (a desired value in the band, objects worth a quarter of
 * what is left up to all of it, at most one object not visited from the top,
 * each object's zone limit spent as piles take it).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const piles = require('../src/rmg/piles');

let seed = 7;
const rng = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };

// a small index: a chest, a resource, a bank (large), a water-only object, a static one, a map-limited one
const tpl = (visit, terrains) => ({ raw: { animation: 'x', mask: ['VA'], visitableFrom: visit }, allowedTerrains: terrains });
const objects = new Map([
	['core:treasureChest.treasureChest', { type: 'treasureChest', rmg: { value: 1500, rarity: 1000 } }],
	['core:resource.gold', { type: 'resource', rmg: { value: 750, rarity: 300 } }],
	['core:creatureBank.cyclopsStockpile', { type: 'creatureBank', rmg: { value: 3000, rarity: 100 } }],
	['core:flotsam.flotsam', { type: 'flotsam', rmg: { value: 750, rarity: 100 } }],
	['mod:lake.lake', { type: 'lake', handler: 'static', rmg: { value: 100, rarity: 100 }, templates: [tpl(['+++', '+-+', '+++'])] }],
	['mod:shrine.shrine', { type: 'shrine', rmg: { value: 2000, rarity: 100, zoneLimit: 1 }, templates: [tpl(['---', '+-+', '+++'])] }],
	['mod:relic.relic', { type: 'relic', rmg: { value: 900, rarity: 50, mapLimit: 2 }, templates: [tpl(['+++', '+-+', '+++'])] }],
	['core:prison.prison', { type: 'prison', rmg: { value: 5000, rarity: 30 } }],
]);

test('the common pool: rmg objects only, static ones and their own pools out, large and water marked', () => {
	const common = piles.commonPool(objects, true);
	const keys = common.map(e => e.key);
	assert.ok(!keys.includes('mod:lake.lake'), 'static objects are never treasure');
	assert.ok(!keys.includes('core:prison.prison'), 'prisons come from their own pool');
	const by = k => common.find(e => e.key === k);
	assert.strictEqual(by('core:treasureChest.treasureChest').large, false, 'H3 chests are visited from the top (class 5)');
	assert.strictEqual(by('core:creatureBank.cyclopsStockpile').large, true, 'a bank is visited from below');
	assert.strictEqual(by('core:flotsam.flotsam').water, 'only');
	assert.strictEqual(by('mod:shrine.shrine').large, true, 'a mod object follows its own templates');
	assert.ok(!piles.commonPool(objects, false).some(e => e.key.startsWith('mod:')), 'a map without mods takes core only');
});

test('a zone\'s pool: dearer than its richest band out, land zones without water objects, limits carried', () => {
	const common = piles.commonPool(objects, true);
	const pool = piles.zonePool(common, { maxValue: 2500, totalZones: 1, mapZones: 1 }, rng);
	const keys = pool.map(e => e.key);
	assert.ok(!keys.includes('core:creatureBank.cyclopsStockpile'), 'worth more than the zone\'s richest band');
	assert.ok(!keys.includes('core:flotsam.flotsam'), 'water-only on land');
	assert.strictEqual(pool.find(e => e.key === 'mod:shrine.shrine').left, 1, 'zone limit');
	assert.strictEqual(pool.find(e => e.key === 'mod:relic.relic').left, 2, 'a map limit over one zone: all of it');
	for (let i = 1; i < pool.length; i++) assert.ok(pool[i - 1].value <= pool[i].value, 'sorted by value, as the engine sorts');
	assert.ok(pool.some(e => e.key === 'spellScroll' && e.value === 500), 'scrolls from randomMap.json');
	assert.ok(!piles.zonePool(common, { maxValue: 2500, water: true }, rng).some(e => e.key === 'spellScroll'), 'no scrolls in water zones');
});

test('a pile: never more than the value drawn, over the band\'s minimum when the pool allows, one large object at most', () => {
	const common = piles.commonPool(objects, true);
	for (let i = 0; i < 400; i++) {
		const pool = piles.zonePool(common, { maxValue: 6000, totalZones: 1 }, rng);
		const band = { min: 3000, max: 6000 };
		const p = piles.preparePile(pool, band, rng);
		assert.ok(p.desired >= 3000 && p.desired <= 6000);
		assert.strictEqual(p.value, p.objects.reduce((a, o) => a + o.value, 0));
		assert.ok(p.value <= p.desired, `pile ${p.value} over its desired ${p.desired}`);
		assert.ok(p.objects.filter(o => o.large).length <= 1, 'one object not visited from the top a pile');
	}
});

test('zone limits are spent across the zone\'s piles', () => {
	// a water zone without prisons: nothing else in its pool (a land zone's
	// scrolls and seer huts would fill the piles after the object runs out)
	// worth 900: every pile of the band (desired 900-1000) can take it
	const only = [{ key: 'one', type: 'x', value: 900, probability: 1, zoneLimit: 3, large: false, water: 'only' }];
	const pool = piles.zonePool(only, { maxValue: 1000, water: true, prisons: 0 }, rng);
	assert.deepStrictEqual(pool.map(e => e.key), ['one']);
	const made = piles.zonePiles(pool, [{ min: 900, max: 1000, density: 400 }], 10, rng);
	assert.strictEqual(made[0].count, 10);
	assert.strictEqual(made[0].piles.length, 3, 'three piles, then the object is spent and the rest come up empty');
});

test('creature box counts round as the game\'s own Pandora\'s boxes', () => {
	assert.strictEqual(piles.creatureCount({ aiValue: 1000, level: 1 }), 5, '5000 / 1000');
	assert.strictEqual(piles.creatureCount({ aiValue: 700, level: 1 }), 8, '7 rounds up to an even 8');
	assert.strictEqual(piles.creatureCount({ aiValue: 250, level: 1 }), 20, '20 stays');
	assert.strictEqual(piles.creatureCount({ aiValue: 80, level: 1 }), 60, '62 rounds to 60');
	assert.strictEqual(piles.creatureCount({ aiValue: 0, level: 1 }), 0);
	assert.strictEqual(piles.creatureCount({ aiValue: 50000, level: 7 }), 0, 'less than one: no box');
});
