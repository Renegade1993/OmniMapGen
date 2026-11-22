/**
 * guard-by-value.test.js - S253 (K 2026-11-15: "i'm rolling a lot of high-tier pandoras ... without much fight"; the lead 2026-11-16: match guards to targets
 * by value). A stack beside a dear pile (relic, major artifact, plain artifact, Pandora's box) guards it only when its strength (AI value x amount) is at
 * least 0.8 of the pile's value (content.js guardFitter): on Headquarters seed 1 a 24,000 experience box stood beside the 2,500 guard of a mine and was
 * counted guarded by it. Mechanism test on the fitter; the maps are counted by the proof run (treasure_bands --tiers).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { guardFitter, targetValue } = require('../src/biome/content');

const POOL = [{ id: 'scarab', aiValue: 90 }, { id: 'dragon', aiValue: 3000 }];
const pl = { objectPools: { guards: POOL } };
const box = xp => ({ type: 'pandoraBox', options: { rewardable: { info: [{ reward: { heroExperience: xp } }] } } });

test('a Pandora box is valued by its reward, others by the table', () => {
	assert.strictEqual(targetValue(box(20000)), 24000);
	assert.strictEqual(targetValue({ type: 'randomArtifactMajor' }), 20000);
	assert.strictEqual(targetValue({ type: 'pandoraBox', options: {} }), 8000);
});

test('a mine guard (45 scarabs, 4,050) does not guard a 24,000 box; a dragon stack does', () => {
	const fit = guardFitter(pl, box(20000));
	assert.ok(fit);
	assert.strictEqual(fit({ guardCreature: 'scarab', options: { amount: 45 } }), false);
	assert.strictEqual(fit({ guardCreature: 'dragon', options: { amount: 8 } }), true);   // 24,000 >= 24,000 (S432: the fit is the box's whole value)
	assert.strictEqual(fit({ guardCreature: 'dragon', options: { amount: 7 } }), false);  // 21,000 < 24,000
});

test('a stack with no creature written fits (strength unknown), and a cheap pile has no fitter', () => {
	assert.strictEqual(guardFitter(pl, box(20000))({ options: { amount: 3 } }), true);
	assert.strictEqual(guardFitter(pl, { type: 'treasureChest' }), null);
	assert.strictEqual(guardFitter({ objectPools: {} }, box(20000)), null);
});

test('S432: a Pandora box with a value is guarded by a stack worth at least that value, whatever the draw', () => {
	const { lootGuard } = require('../src/biome/content');
	const pool = [{ id: 'mid', level: 4, aiValue: 500, advMin: 10, advMax: 20 }, { id: 'big', level: 6, aiValue: 3000, advMin: 2, advMax: 5 }];
	const rng = (() => { let a = 11; return () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; }; })();
	for (const value of [6000, 12000, 18000, 24000]) for (let k = 0; k < 200; k++) {
		const g = lootGuard('pandoraBox', { monsterStrength: 0 }, rng, pool, value);
		if (!g) continue;
		const c = pool.find(q => q.id === g.creature);
		if (!c) continue;   // the engine's fallback creature when none of the pool fits the strength
		const ai = c.aiValue;
		assert.ok(ai * g.amount >= value,'value ' + value + ' guard ' + g.creature + ' x' + g.amount + ' = ' + ai * g.amount);
	}
});
