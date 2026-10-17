/**
 * connectivity-template.test.js - Biome connections acts on a template (K, 2026-10-15: "all levers should measurably affect the map output with
 * any given combination of levers and settings"; the tooltip said "Free layout only"). plan.js planLevel: the default is the template's own
 * links; above it zones that touch gain passages, below it some of its doorway links close, a start's never, the level always in one piece.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const check = require('../tools/mapsight/lib/check');

function links(conn, seed = 2) {
	const out = path.join(testTmp(), `vmapgen_tpl_conn_${conn}_${seed}.vmap`);
	const a = [path.join(__dirname, '../src/main/generate-cli.js'), '--out', out, '--declaremods', '0', '--template', "Coldshadow's Fantasy",
		'--w', '108', '--h', '108', '--players', '4', '--seed', String(seed), '--factions', 'random,random,random,random',
		'--accommodate', 'size,players,humans,underground', '--bio.interconnectivity', String(conn)];
	const r = spawnSync(process.execPath, a, { encoding: 'utf8', timeout: 300000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	const m = r.stderr.match(/level 0: doorway guards \d+ of (\d+) doorway link/);
	assert.ok(m, 'the doorway count line');
	const fails = check.checkMap(out).fails;
	for (const f of [out, out + '.zones.json', out.replace(/\.vmap$/, '.zonedump.json')]) fs.rmSync(f, { force: true });
	return { doors: Number(m[1]), fails };
}

test('Coldshadow 108x108 one level: doorway links fall at Biome connections 0 and rise at 1, and every map passes mapsight', { timeout: 1200000 }, () => {
	const lo = links(0), mid = links(0.6), hi = links(1);
	assert.ok(lo.doors < mid.doors && mid.doors < hi.doors, `doorway links ${lo.doors}, ${mid.doors}, ${hi.doors} at 0, 0.6, 1`);
	for (const [k, r] of [['0', lo], ['0.6', mid], ['1', hi]]) assert.deepStrictEqual(r.fails, [], `mapsight at ${k}`);
});
