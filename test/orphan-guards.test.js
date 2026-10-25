// No guard a hero cannot reach, re-checked last (plan.js, the guards-only sweep after the late passes; K, 2026-10-18 via the lead: "there were
// still guards there like it was a choke point"). A mechanism test on a built plan, and a rate over seeds that fails without the last sweep.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const { sweepStranded } = require('../src/biome/plan');
const { FILL_TYPES } = require('../src/biome/content');

const W = 12, H = 12;
const cell = (x, y) => y * W + x;
const entry = (type, x, y, template, options) => ({ instanceName: `${type}_${x}_${y}_0`, l: 0, x, y, type, subtype: 'object', template, options });

test('the last sweep takes a guard shut in a rock pocket and leaves everything else as placed', () => {
	// open floor everywhere but a rock ring round (8..10, 8..10): the guard at (9,9) and a resource at (9,8) stand inside it
	const openMask = new Uint8Array(W * H).fill(1);
	for (let y = 7; y <= 11; y++) for (let x = 7; x <= 11; x++) if (x === 7 || y === 7 || x === 11 || y === 11) openMask[cell(x, y)] = 0;
	const town = { animation: 'town', mask: ['BBB', 'BBA'], visitableFrom: ['+++', '+-+', '+++'] };
	const monster = FILL_TYPES.creeps[0].tpl;
	const resource = { animation: 'res', mask: ['A'], visitableFrom: ['+++', '+-+', '+++'] };
	const shut = entry('randomMonsterLevel1', 9, 9, monster, { character: 'hostile' });
	const free = entry('randomMonsterLevel1', 3, 6, monster, { character: 'hostile' });
	const loot = entry('resource', 9, 8, resource);
	const plan = { objects: [entry('randomTown', 4, 3, town, { owner: 'red' }), shut, free, loot], openMask, p: {} };
	sweepStranded(plan, W, H, 0, [{ x: 3, y: 3 }], null, null, { only: o => /^(monster|randomMonster)/.test(o.type), label: 'guard(s) no hero reaches taken off' });
	assert.ok(!plan.objects.includes(shut), 'the guard in the pocket goes');
	assert.ok(plan.objects.includes(free), 'a guard a hero reaches stays');
	assert.ok(plan.objects.includes(loot), 'the last sweep takes guards only: the pocket\'s resource stays as placed');
});

// A rate since the lead's rule (2026-10-18): 36x36 six players two levels, seeds 1 to 24, on the suite's install. Without the last sweep one
// seed keeps a guard no hero reaches (seed 4 on 1f9b7ed, seed 22 with the portal ends placed far apart); with it there are none. Bar: 0.
test('36x36 six players two levels, seeds 1 to 24: no guard a hero cannot reach', { timeout: 900000 }, t => {
	const { CHECKS } = require('../tools/harness/k1018_checks');
	const sight = require('../tools/mapsight/lib/sight');
	let orphans = 0, guards = 0;
	const where = [];
	for (let seed = 1; seed <= 24; seed++) {
		const out = path.join(testTmp(), `vmapgen_orphan_${process.pid}_${seed}.vmap`);
		const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--w', '36', '--h', '36', '--players', '6',
			'--underground', '1', '--seed', String(seed), '--out', out], { encoding: 'utf8', timeout: 300000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
		try {
			assert.strictEqual(r.status, 0, (r.stderr || '').slice(-800));
			const c = CHECKS['orphan-guards'](sight.load(out));
			orphans += c.nums.orphans; guards += c.nums.guards;
			if (c.nums.orphans) where.push(`seed ${seed}: ${c.items.join(' ')}`);
		} finally {
			for (const f of [out, out + '.zones.json']) try { fs.unlinkSync(f); } catch (e) { /* gone already */ }
		}
	}
	t.diagnostic(`guards no hero reaches ${orphans} of ${guards}`);
	assert.strictEqual(orphans, 0, where.join('; '));
});
