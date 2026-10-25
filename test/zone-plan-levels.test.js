/**
 * zone-plan-levels.test.js - on two levels with every start on the surface,
 * a start zone the template forces underground is laid once, on the surface
 * (findings-oe.md, rmg/template.js buildZonePlan).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildZonePlan } = require('../src/rmg/template');

test('buildZonePlan: undergroundStarts 0 puts a forced-underground start on one level', () => {
	const raw = { minSize: 's', maxSize: 'xl+u', players: '2', zones: {}, connections: [] };
	const zones = [
		{ id: 1, type: 'playerStart', owner: 1, size: 20, forcedLevel: 'underground' },
		{ id: 2, type: 'playerStart', owner: 2, size: 20 },
		{ id: 3, type: 'treasure', size: 20 }];
	const plan = buildZonePlan(raw, zones, { w: 72, h: 72, levels: 2, players: 2, undergroundStarts: 0 }, new Set());
	const on = plan.perLevel.map(l => l.filter(z => z.id === 1).length);
	assert.deepStrictEqual(on, [1, 0]);
});
