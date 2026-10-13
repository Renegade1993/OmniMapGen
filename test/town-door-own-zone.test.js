/**
 * town-door-own-zone.test.js - a free layout's neutral town has its door and the tiles before it in its own zone, so no start zone gains a
 * second town through a neighbour's door. The spot search walks a zone's cells by the town's anchor (the footprint's bottom right); at 144x144
 * eight players seed 3 the town of zone 27 at (107,5) opened its door at (105,5) into green's start zone 3, which then held two towns against
 * one for every other start (MapGen Dev's size matrix, towns-per-start), and two more neutral towns had their doors across a zone line.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const sight = require('../tools/mapsight/lib/sight');
const { runChecks } = require('../tools/harness/playtest_checks');

test('144x144 eight players seed 3: neutral town doors in their own zones, every start zone the same number of towns', () => {
	const out = path.join(testTmp(), `vmapgen_town_door_${process.pid}.vmap`);
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--w', '144', '--h', '144', '--players', '8',
		'--seed', '3', '--out', out], { encoding: 'utf8', timeout: 300000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	try {
		assert.strictEqual(r.status, 0, (r.stderr || '').slice(-800));
		const M = sight.load(out), across = [];
		for (const t of M.objs.filter(o => o.cls === 'town' && !(o.options && o.options.owner))) {
			const ax = Math.max(...t.cells.map(c => c[0])), ay = Math.max(...t.cells.map(c => c[1]));
			if (M.zoneAt(t.l, t.at[0], t.at[1]) !== M.zoneAt(t.l, ax, ay)) across.push(`town door (${t.at}) L${t.l}`);
		}
		assert.deepStrictEqual(across, []);
		const tp = runChecks(out, ['towns-per-start']).checks['towns-per-start'];
		assert.ok(tp.pass, JSON.stringify(tp));
	} finally {
		for (const f of [out, out + '.zones.json']) try { fs.unlinkSync(f); } catch (e) { /* gone already */ }
	}
});
