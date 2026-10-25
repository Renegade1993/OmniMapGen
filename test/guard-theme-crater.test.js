/**
 * guard-theme-crater.test.js - a themed guard (--guardtheme) is not drawn
 * under a crater drawn after it either: applyGuardTheme prefers a creature
 * whose picture is clear, as concretizeGuards and rollPlaceholders do
 * (findings-oe.md, guardCreatures.js applyGuardTheme).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { applyGuardTheme, creatureLook } = require('../src/biome/guardCreatures');
const { OBJECT_TEMPLATES } = require('../src/stitch/zones');

const entry = (id, mask) => {
	const c = { id, name: id, scope: 'mod', level: 6, aiValue: 1000, advMin: 4, advMax: 7, faction: 'a', map: `${id}.def`, mapMask: mask };
	return { ...c, ...creatureLook(c, { h3: null, useMods: true }), mods: [] };
};

test('applyGuardTheme: the wide creature is not drawn under the crater', () => {
	const pool = [entry('wide', ['VVV', 'VAV']), entry('narrow', ['VV', 'VA'])];
	assert.ok(pool[0].shift.dx === 1 && pool[1].shift.dx === 0, 'the wide look moves its anchor one right');
	for (let seed = 1; seed <= 20; seed++) {
		const g = { type: 'randomMonsterLevel6', subtype: 'object', x: 19, y: 46, l: 0, template: OBJECT_TEMPLATES.randomMonster, options: { character: 'hostile', amount: 10 } };
		const crater = { type: 'crater', subtype: 'object', x: 21, y: 46, l: 0, template: { mask: ['BB'] } };
		let r = seed;
		const rng = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 4294967296);
		applyGuardTheme([g, crater], { pool, share: 1, rng, W: 64, H: 64 });
		assert.strictEqual(g.subtype, 'narrow', `seed ${seed}`);
	}
});
