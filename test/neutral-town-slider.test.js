/**
 * neutral-town-slider.test.js - the Neutral town biomes slider moves the town count of the open layout (S351, the lead 2026-11-19: S340 measured that it did not). The per-acre
 * count of neutral towns (plan.js, "extra neutral towns for map area") followed the map's size alone and was the floor under every setting; it now follows the slider against its
 * default: 0 gives no neutral town (a town for each player only), 0.05 about half the usual number, the default the usual number (the same map as with VMAPGEN_TOWN_SLIDER=0).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv } = require('./_vcmi');
const sight = require('../tools/mapsight/lib/sight');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'src', 'main', 'generate-cli.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neutral-town-'));

function towns(tag, args, env) {
	const out = path.join(dir, tag + '.vmap');
	const r = spawnSync(process.execPath, [CLI, '--w', '108', '--h', '108', '--players', '4', '--seed', '1', ...args, '--out', out],
		{ encoding: 'utf8', cwd: ROOT, env: { ...genEnv(), ...env }, windowsHide: true, timeout: 280000 });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	const M = sight.load(out);
	return { n: M.objs.filter(o => /^(town|randomTown)$/.test(o.type)).length, objs: M.objs.map(o => `${o.type}@${o.l},${o.x},${o.y}`).sort() };
}

test('Neutral town biomes: 0 is a town for each player, 0.05 fewer than the default, and the default is the usual map', { timeout: 600000 }, () => {
	const none = towns('t0', ['--bio.townRatio', '0']);
	const few = towns('t5', ['--bio.townRatio', '0.05']);
	const usual = towns('t10', ['--bio.townRatio', '0.1']);
	const before = towns('t10off', ['--bio.townRatio', '0.1'], { VMAPGEN_TOWN_SLIDER: '0' });
	assert.strictEqual(none.n, 4, `0: ${none.n} towns`);
	assert.ok(few.n > none.n && few.n < usual.n, `0.05: ${few.n} towns between ${none.n} and ${usual.n}`);
	assert.deepStrictEqual(usual.objs, before.objs, 'at the default the map is the earlier one, object for object');
});
