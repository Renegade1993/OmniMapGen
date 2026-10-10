/**
 * underground-sliders.test.js - Narrow tunnels and Open cave floor reach the tunnel network (P3 lever sweep, 2026-10-05: the
 * default splines carve read neither, so the underground came out the same at both ends of each). The share of the level that is
 * floor falls as tunnels narrow and rises as the open share does.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const sight = require('../tools/mapsight/lib/sight');

function floor(tag, extra) {
	const out = path.join(testTmp(), `vmapgen_ug_${tag}.vmap`);
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--out', out, '--declaremods', '0',
		'--template', "Coldshadow's Fantasy", '--w', '72', '--h', '72', '--underground', '1', '--players', '4', '--seed', '1',
		'--factions', 'random,random,random,random', '--accommodate', 'size,players,humans,underground', ...extra],
	{ encoding: 'utf8', timeout: 120000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	const M = sight.load(out);
	let g = 0;
	for (let y = 0; y < M.H; y++) for (let x = 0; x < M.W; x++) if (M.ground(M.idx(1, x, y))) g++;
	for (const f of [out, out + '.zones.json', out.replace(/\.vmap$/, '.zonedump.json')]) fs.rmSync(f, { force: true });
	return g / (M.W * M.H);
}

test('Narrow tunnels: wide caverns hold more floor than narrow tunnels', { timeout: 250000 }, () => {
	const wide = floor('n0', ['--bio.subterraneanNarrow', '0']), narrow = floor('n1', ['--bio.subterraneanNarrow', '1']);
	assert.ok(wide > narrow + 0.08, `0 ${wide} against 1 ${narrow}`);
});

test('Open cave floor: more open leaves more floor', { timeout: 250000 }, () => {
	const lo = floor('o2', ['--bio.subterraneanOpen', '0.2']), hi = floor('o9', ['--bio.subterraneanOpen', '0.9']);
	assert.ok(hi > lo + 0.08, `0.9 ${hi} against 0.2 ${lo}`);
});
