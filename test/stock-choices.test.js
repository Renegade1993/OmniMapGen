/**
 * stock-choices.test.js - the game's own Random Map Setup choices, as the
 * generator takes them (src/main/stockChoices.js). K, 2026-09-27: DMB and its
 * mods never do less than stock VCMI, so each choice that screen offers is
 * pinned here: the player split, Random for counts, water, monsters and the
 * template, and the three road types by the engine's own fallback.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const stock = require('../src/main/stockChoices');

test('road types: the best one left on, as RoadPlacer falls back from cobblestone', () => {
	assert.strictEqual(stock.roadFromToggles({}), undefined, 'no toggles given: the Road type lever decides');
	const r = (d, g, c) => stock.roadFromToggles({ roadDirt: d, roadGravel: g, roadCobblestone: c });
	assert.strictEqual(r(1, 1, 1), 'pc');
	assert.strictEqual(r(1, 1, 0), 'pg', 'cobblestone off: gravel');
	assert.strictEqual(r(1, 0, 0), 'pd', 'cobblestone and gravel off: dirt');
	assert.strictEqual(r(0, 1, 0), 'pg');
	assert.strictEqual(r(0, 0, 0), 'none', 'all off: no roads');
	assert.strictEqual(stock.roadFromToggles({ roadCobblestone: 0 }), 'pg', 'a toggle never set counts as on, stock\'s default');
});

test('the player split: human or computer players plus computer only players', () => {
	const roll = stock.roller(1);
	assert.deepStrictEqual(stock.playerCounts({ players: 4, humans: 2, compOnly: 4 }, roll), { nPlayers: 6, humans: 2 },
		'the map has their sum, whatever the total says');
	assert.deepStrictEqual(stock.playerCounts({ players: 5, humans: 1 }, roll), { nPlayers: 5, humans: 1 },
		'without computer only players, the total as before');
	assert.deepStrictEqual(roll.rolled, [], 'nothing rolled');
});

test('Random counts roll within 2-8 players and the template\'s range, the same on the same seed', () => {
	for (let seed = 1; seed <= 40; seed++) {
		const a = stock.playerCounts({ humans: -1, compOnly: -1, templatePlayers: '2-4' }, stock.roller(seed));
		assert.ok(a.nPlayers >= 2 && a.nPlayers <= 4 && a.humans >= 1 && a.humans <= a.nPlayers, `seed ${seed}: ${JSON.stringify(a)}`);
		assert.deepStrictEqual(stock.playerCounts({ humans: -1, compOnly: -1, templatePlayers: '2-4' }, stock.roller(seed)), a,
			'the same seed rolls the same');
		const b = stock.playerCounts({ humans: 3, compOnly: -1 }, stock.roller(seed));
		assert.ok(b.humans === 3 && b.nPlayers >= 3 && b.nPlayers <= 8, `seed ${seed}: ${JSON.stringify(b)}`);
		const c = stock.playerCounts({ players: -1, humans: 2, templatePlayers: '2,6-7' }, stock.roller(seed));
		assert.ok([2, 6, 7].includes(c.nPlayers), `seed ${seed}: players ${c.nPlayers} in the template's range`);
	}
	const roll = stock.roller(9);
	stock.playerCounts({ humans: -1, compOnly: 2 }, roll);
	assert.match(roll.rolled[0], /^human or computer players \d, computer only 2$/, 'every roll reported');
});

test('counts that fit no map are kept for the template check to refuse', () => {
	assert.deepStrictEqual(stock.playerCounts({ humans: 5, compOnly: 5, templatePlayers: '2-4' }, stock.roller(1)),
		{ nPlayers: 8, humans: 5 });
});

test('water content: none dries the map, islands takes the islands layout, Random picks one', () => {
	const opts = { islandsShape: 5, defaultCoverage: 0.2 };
	const none = { waterContent: 0, waterCoverage: 0.3 };
	stock.applyWaterContent(none, stock.roller(1), opts);
	assert.strictEqual(none.waterCoverage, 0);
	const islands = { waterContent: 2, waterCoverage: 0 };
	stock.applyWaterContent(islands, stock.roller(1), opts);
	assert.deepStrictEqual([islands.waterShape, islands.waterCoverage], [5, 0.2], 'a dry map takes the default amount');
	const normal = { waterContent: 1, waterCoverage: 0.3, waterShape: 2 };
	stock.applyWaterContent(normal, stock.roller(1), opts);
	assert.deepStrictEqual([normal.waterShape, normal.waterCoverage], [2, 0.3], 'normal leaves the Water page as set');
	const normalDry = { waterContent: 1, waterCoverage: 0, waterShape: 2 };
	stock.applyWaterContent(normalDry, stock.roller(1), opts);
	assert.deepStrictEqual([normalDry.waterShape, normalDry.waterCoverage], [2, 0.2], 'normal at 0% brings the default amount');
	const seen = new Set();
	for (let seed = 1; seed <= 60; seed++) {
		const b = { waterContent: -1, waterCoverage: 0.3, waterShape: 1 };
		stock.applyWaterContent(b, stock.roller(seed), opts);
		seen.add(b.waterCoverage === 0 ? 'none' : b.waterShape === 5 ? 'islands' : 'normal');
	}
	assert.deepStrictEqual([...seen].sort(), ['islands', 'none', 'normal']);
});

test('nearby seeds roll apart from the first draw', () => {
	// xorshift straight from the seed drew nearly one first number for seeds 1-60
	const firsts = new Set();
	for (let seed = 1; seed <= 60; seed++) firsts.add(stock.roller(seed).pick([0, 1, 2]));
	assert.strictEqual(firsts.size, 3);
	let low = 0;
	for (let seed = 1; seed <= 300; seed++) if (stock.roller(seed).next() < 1 / 3) low++;
	assert.ok(low > 60 && low < 140, `a third of first draws below 1/3, got ${low} of 300`);
});

test('monster strength Random rolls weak, normal or strong; a set strength stays', () => {
	for (let seed = 1; seed <= 30; seed++) {
		const b = { monsterStrength: stock.RANDOM_STRENGTH };
		stock.applyMonsterStrength(b, stock.roller(seed));
		assert.ok([-1, 0, 1].includes(b.monsterStrength));
	}
	const set = { monsterStrength: -2 };
	stock.applyMonsterStrength(set, stock.roller(1));
	assert.strictEqual(set.monsterStrength, -2);
});

test('the Random template is one the map fits, or free layout when none does', () => {
	assert.ok(stock.isRandomTemplate('random') && stock.isRandomTemplate('(Random)') && !stock.isRandomTemplate('Jebus Cross'));
	const roll = stock.roller(3);
	const fits = name => name !== 'Too Big' && (name === 'Jebus Cross' || name === 'Nostalgia');
	for (let i = 0; i < 20; i++) assert.ok(['Jebus Cross', 'Nostalgia'].includes(stock.randomTemplate(['Too Big', 'Jebus Cross', 'Nostalgia'], fits, roll)));
	assert.strictEqual(stock.randomTemplate(['Too Big'], () => false, roll), undefined);
	assert.match(roll.rolled[roll.rolled.length - 1], /free layout/);
	assert.strictEqual(stock.randomTemplate(['Broken'], () => { throw new Error('bad file'); }, roll), undefined, 'a template that fails to load is skipped');
});
