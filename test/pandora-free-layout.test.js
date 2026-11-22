/**
 * pandora-free-layout.test.js - S432 (K 2026-11-21: "lot of high xp pandoras....we already solved so many of these issues in the other map templates...make sure they carry over"). The fixes made on the template maps
 * (S253) reach the free layout: a start zone's box is worth under 20,000, a stack with no count written is judged by the middle of its creature's range, and the count follows the originals.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { pandoraOptions } = require('../src/biome/economy');
const { guardFitter } = require('../src/biome/content');

const mulberry = a => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const reward = o => o.rewardable.info[0].reward;

test('a capped draw never holds more than the cap: experience 15,000 and gold 15,000 under 18,000, and the uncapped draw does go higher', () => {
	const rng = mulberry(7);
	let top = 0, capTop = 0;
	for (let i = 0; i < 600; i++) {
		const r = reward(pandoraOptions(rng, undefined, 18000)), u = reward(pandoraOptions(rng, undefined));
		capTop = Math.max(capTop, (r.heroExperience || 0) * 1.2, (r.resources && r.resources.gold) || 0);
		top = Math.max(top, (u.heroExperience || 0) * 1.2, (u.resources && u.resources.gold) || 0);
	}
	assert.ok(capTop <= 18000, 'capped top ' + capTop);
	assert.ok(top > 18000, 'the corpus draw reaches ' + top);
});

test('a stack with a creature and no count is judged by the middle of the creature\'s range', () => {
	const pl = { objectPools: { guards: [{ id: 'scarab', aiValue: 90, advMin: 20, advMax: 50 }, { id: 'titan', aiValue: 5000, advMin: 5, advMax: 9 }] } };
	const box = { type: 'pandoraBox', options: { rewardable: { info: [{ reward: { heroExperience: 20000 } }] } } };
	const fit = guardFitter(pl, box);
	assert.strictEqual(fit({ guardCreature: 'scarab', options: {} }), false);     // 90 x 35 = 3,150 of 24,000
	assert.strictEqual(fit({ guardCreature: 'titan', options: {} }), true);       // 5,000 x 7 = 35,000
	assert.strictEqual(fit({ guardCreature: 'scarab', options: { amount: 45 } }), false);
});
