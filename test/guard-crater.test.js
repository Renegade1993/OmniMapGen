/**
 * guard-crater.test.js - a guard whose creature draws three wide (HotA's style, mask ["VVV","VAV"], the anchor one right of the
 * placeholder's) is not written under a crater drawn after it (K, 2026-10-14, his 144x144 Coldshadow map seed 2042393645: "enchanter got
 * placed behind a crater (decorative blocker) again", the Enchanter (20,46) under the crater (21,46)). concretizeGuards writes another
 * creature of its level whose picture is clear, at the same strength; VMAPGEN_GUARD_CRATER=0 writes the one picked.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { concretizeGuards } = require('../src/biome/guardCreatures');
const { OBJECT_TEMPLATES } = require('../src/stitch/zones');

const reg = () => new Map([
	['wide', { id: 'wide', name: 'wide', scope: 'mod', level: 6, aiValue: 2000, advMin: 4, advMax: 7, faction: 'a', map: 'wide.def', mapMask: ['VVV', 'VAV'] }],
	['narrow', { id: 'narrow', name: 'narrow', scope: 'mod', level: 6, aiValue: 1000, advMin: 4, advMax: 7, faction: 'b', map: 'narrow.def', mapMask: ['VV', 'VA'] }],
	['low', { id: 'low', name: 'low', scope: 'mod', level: 2, aiValue: 100, advMin: 4, advMax: 7, faction: 'a', map: 'low.def', mapMask: ['VV', 'VA'] }],
]);
// a level-6 placeholder at (19,46) picked as the wide creature, a crater blocking (20,46) and (21,46), anchored at (21,46)
const run = (craterAt = 21) => {
	const g = { type: 'randomMonsterLevel6', subtype: 'object', x: 19, y: 46, l: 0, template: OBJECT_TEMPLATES.randomMonster, options: { character: 'hostile', amount: 10 } };
	const crater = { type: 'crater', subtype: 'object', x: craterAt, y: 46, l: 0, template: { mask: ['BB'] } };
	const objects = [g, crater];
	const r = concretizeGuards(objects, new Map([[g, 'wide']]), { registry: reg(), h3: null, useMods: true, W: 64, H: 64 });
	return { r, g };
};

test('a wide creature under a crater drawn after it is written as a narrow one of its level, at the same strength', () => {
	const { r, g } = run();
	assert.strictEqual(r.swapped, 1);
	assert.strictEqual(g.subtype, 'narrow');
	assert.strictEqual(g.x, 19, 'the narrow creature keeps the placeholder\'s anchor');
	assert.strictEqual(g.options.amount * 1000, 10 * 2000);
});

test('with no crater over the new column the creature picked stays', () => {
	const { r, g } = run(30);
	assert.strictEqual(r.swapped, 0);
	assert.strictEqual(g.subtype, 'wide');
	assert.strictEqual(g.x, 20);
});

test('VMAPGEN_GUARD_CRATER=0 writes the creature picked', () => {
	process.env.VMAPGEN_GUARD_CRATER = '0';
	try { const { g } = run(); assert.strictEqual(g.subtype, 'wide'); } finally { delete process.env.VMAPGEN_GUARD_CRATER; }
});

test('the swap draws only from the creatures the guard\'s zone allows (poolAt; the Opus Reviewer, pass 58)', () => {
	const g = { type: 'randomMonsterLevel6', subtype: 'object', x: 19, y: 46, l: 0, template: OBJECT_TEMPLATES.randomMonster, options: { character: 'hostile', amount: 10 } };
	const crater = { type: 'crater', subtype: 'object', x: 21, y: 46, l: 0, template: { mask: ['BB'] } };
	const r = concretizeGuards([g, crater], new Map([[g, 'wide']]), { registry: reg(), h3: null, useMods: true, W: 64, H: 64,
		poolAt: () => [{ id: 'wide' }, { id: 'low' }] });
	assert.strictEqual(r.swapped, 0);
	assert.strictEqual(r.coveredLeft, 1);
	assert.strictEqual(g.subtype, 'wide');
});
