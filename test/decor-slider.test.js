/**
 * decor-slider.test.js - the Scenery slider reaches the mass inside a template's zones (P3 lever sweep, 2026-10-04: on
 * Coldshadow 72x72 and 108x108 the scenery read the same at 0x, 1x and 2x). The blocking distance from a corridor is 8 at 1x, nearer
 * at more and never at 0: the share of blocked tiles in a zone's interior rises with the slider, and 1x is as it was.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const sight = require('../tools/mapsight/lib/sight');

function innerBlocked(out) {
	const M = sight.load(out);
	let n = 0, b = 0;
	for (let y = 5; y < M.H - 5; y++) for (let x = 5; x < M.W - 5; x++) {
		const i = M.idx(0, x, y);
		if (!M.ground(i)) continue;
		const z = M.zoneAt(0, x, y);
		let near = false;
		for (let dy = -5; dy <= 5 && !near; dy += 5) for (let dx = -5; dx <= 5; dx += 5) if (M.zoneAt(0, x + dx, y + dy) !== z) { near = true; break; }
		if (near) continue;
		n++;
		if (M.blocked[i]) b++;
	}
	return b / Math.max(1, n);
}

// two seeds, the margins added: one seed's margin is a few tenths of a point wide (seed 1: 0.028 before the road and guard fixes of 2026-10-10,
// 0.013 after, with the other seed at 0.15), and a single seed's reading fails a change that does not touch the scenery
test('Coldshadow 108x108: interior blocked share grows with the Scenery slider', { timeout: 590000 }, () => {
	let low = 0, high = 0;
	for (const seed of ['1', '2']) {
		const share = {};
		for (const d of [0, 1, 2]) {
			const out = path.join(testTmp(), `vmapgen_decor_slider_${d}_${seed}.vmap`);
			const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--out', out, '--declaremods', '0',
				'--template', "Coldshadow's Fantasy", '--w', '108', '--h', '108', '--players', '4', '--seed', seed, '--bio.decorDensity', String(d),
				'--factions', 'random,random,random,random', '--accommodate', 'size,players,humans,underground'],
			{ encoding: 'utf8', timeout: 90000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
			assert.strictEqual(r.status, 0, r.stderr.slice(-600));
			share[d] = innerBlocked(out);
			for (const f of [out, out + '.zones.json', out.replace(/\.vmap$/, '.zonedump.json')]) fs.rmSync(f, { force: true });
		}
		low += share[1] - share[0];
		high += share[2] - share[1];
		assert.ok(share[2] > share[1], `seed ${seed}: 2x ${share[2]} against 1x ${share[1]}`);
	}
	assert.ok(low > 0.10, `1x over 0x, two seeds added: ${low}`);
	assert.ok(high > 0.04, `2x over 1x, two seeds added: ${high}`);
});
