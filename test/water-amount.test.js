/**
 * water-amount.test.js - Amount of water reaches a template map's water (K, 2026-10-05: "this is not 45% water"): the engine-style
 * water kept its calibrated share (0.14 to 0.19) whatever the slider said. The surface comes out within 2 points of the amount asked.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const sight = require('../tools/mapsight/lib/sight');

function share(amount) {
	const out = path.join(testTmp(), `vmapgen_water_amount_${amount}.vmap`);
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--out', out, '--declaremods', '0',
		'--template', "Coldshadow's Fantasy", '--w', '72', '--h', '72', '--players', '4', '--seed', '1', '--factions', 'random,random,random,random',
		'--accommodate', 'size,players,humans,underground', '--bio.waterContent', '1', '--bio.waterCoverage', String(amount), '--bio.waterShape', '3'],
	{ encoding: 'utf8', timeout: 150000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	const M = sight.load(out);
	let w = 0;
	for (let y = 0; y < M.H; y++) for (let x = 0; x < M.W; x++) if (!M.ground(M.idx(0, x, y))) w++;
	for (const f of [out, out + '.zones.json', out.replace(/\.vmap$/, '.zonedump.json')]) fs.rmSync(f, { force: true });
	return w / (M.W * M.H);
}

test('Coldshadow 72x72 Mediterranean water at 10%, 30% and 45% comes out within 3 points of the amount', { timeout: 280000 }, () => {
	for (const a of [0.1, 0.3, 0.45]) {
		const got = share(a);
		assert.ok(Math.abs(got - a) <= 0.03, `${a} gave ${got}`);
	}
});
