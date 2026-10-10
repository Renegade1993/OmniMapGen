/**
 * prison-spacing.test.js - no prison stacking (K, 2026-10-04: "the fuck is this prison stacking": two pairs of prisons side by side
 * on a 108x108 one-level map, 13 of them, 1.11 a 1000 tiles against the engine's 0.6 to 0.77). A prison keeps eight tiles from every
 * other prison on its level, and a level holds at most 0.77 of them to a 1000 tiles.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const { readVmap } = require('../src/preview/render');

test('108x108 Coldshadow, seed 5: no two prisons within eight tiles, no more than the engine\'s density', { timeout: 280000 }, () => {
	const out = path.join(testTmp(), 'vmapgen_prison_spacing.vmap');
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--out', out, '--declaremods', '0',
		'--template', "Coldshadow's Fantasy", '--w', '108', '--h', '108', '--players', '2', '--seed', '5', '--factions', 'random,random',
		'--accommodate', 'size,players,humans,underground'],
	{ encoding: 'utf8', timeout: 270000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	const { objects } = readVmap(out);
	fs.rmSync(out, { force: true });
	const prisons = (Array.isArray(objects) ? objects : Object.values(objects)).filter(o => o && o.type === 'prison');
	assert.ok(prisons.length > 0, 'the map has prisons');
	for (let i = 0; i < prisons.length; i++) for (let j = i + 1; j < prisons.length; j++) {
		if ((prisons[i].l || 0) !== (prisons[j].l || 0)) continue;
		assert.ok(Math.max(Math.abs(prisons[i].x - prisons[j].x), Math.abs(prisons[i].y - prisons[j].y)) >= 8,
			`prisons at (${prisons[i].x},${prisons[i].y}) and (${prisons[j].x},${prisons[j].y})`);
	}
	assert.ok(prisons.length <= Math.ceil(0.77 * 108 * 108 / 1000), `${prisons.length} prisons`);
});
