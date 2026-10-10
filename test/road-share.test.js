/**
 * road-share.test.js - Passages with road acts on a template (K, 2026-10-05 14:52: every setting acts on every template; the tooltip said
 * "Free layout only"). The template's own road flags are 1x (the default weights); with less road weight some of its roaded passages
 * lose their road, and the default is exactly as it was.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const sight = require('../tools/mapsight/lib/sight');

function roadTiles(weight) {
	const out = path.join(testTmp(), `vmapgen_road_share_${weight}.vmap`);
	const a = [path.join(__dirname, '../src/main/generate-cli.js'), '--out', out, '--declaremods', '0', '--template', "Coldshadow's Fantasy",
		'--w', '108', '--h', '108', '--underground', '1', '--players', '4', '--seed', '2', '--factions', 'random,random,random,random',
		'--accommodate', 'size,players,humans,underground', '--bio.openPathRoad', String(weight)];
	const r = spawnSync(process.execPath, a, { encoding: 'utf8', timeout: 200000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	const M = sight.load(out);
	let n = 0;
	for (let i = 0; i < M.road.length; i++) n += M.road[i];
	for (const f of [out, out + '.zones.json', out.replace(/\.vmap$/, '.zonedump.json')]) fs.rmSync(f, { force: true });
	return n;
}

test('Coldshadow 108x108 two levels: road tiles fall with the road weight (1105, 799 a map at 0.26, 0.02 over 3 seeds)', { timeout: 400000 }, () => {
	const dflt = roadTiles(0.26), low = roadTiles(0.02);
	assert.ok(low <= 0.9 * dflt, `${dflt} road tiles at the default weight, ${low} at 0.02`);
});
