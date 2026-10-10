/**
 * zones-options.test.js - the .zones.json beside every map carries the command line it was made with (K's playtest of 2026-10-04: his
 * extmapgen_log.txt keeps only the last run, so the islands map he reported could not be made again). Same options, same map.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');

test('the zones sidecar holds the options and the choices left to chance', { timeout: 200000 }, () => {
	const out = path.join(testTmp(), 'vmapgen_zones_options.vmap');
	const env = { ...genEnv() };
	delete env.VMAPGEN_ZONE_DUMP;
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--out', out, '--declaremods', '0',
		'--w', '36', '--h', '36', '--players', '2', '--seed', '11', '--factions', 'random,random',
		'--accommodate', 'size,players,humans,underground', '--bio.waterContent', '0'],
	{ encoding: 'utf8', timeout: 190000, cwd: path.join(__dirname, '..'), windowsHide: true, env });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	const side = JSON.parse(fs.readFileSync(out + '.zones.json', 'utf8'));
	fs.rmSync(out, { force: true });
	fs.rmSync(out + '.zones.json', { force: true });
	assert.strictEqual(side.options.seed, '11');
	assert.strictEqual(side.options['bio.waterContent'], '0');
	assert.strictEqual(side.options.w, '36');
	assert.ok(Array.isArray(side.rolled), 'what chance decided is listed');
	assert.ok(Array.isArray(side.levels));
});
