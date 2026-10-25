/**
 * biome-size-range.test.js - the Biome size slider runs 150 to 3000 (the lead, 2026-10-20: the engine's Nostalgia, 24 zones on 144x144 with two levels,
 * needs Biome size 1500, which was the top of the slider, so there was no margin). The values of the old range make the maps they made before: the
 * differential check is tools\harness-free and run by hand (.tmp\deadends\size_range_diff.txt); here the range itself and what a value above 1500 does.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const { KNOBS } = require('../src/biome/knobs');

const knob = KNOBS.find(k => k.key === 'zoneCells');

test('Biome size runs 150 to 3000 in steps of 50 and still defaults to 400', () => {
	assert.strictEqual(knob.min, 150);
	assert.strictEqual(knob.max, 3000);
	assert.strictEqual(knob.step, 50);
	assert.strictEqual(knob.default, 400);
});

test('a Biome size above the old top makes a map, with no more zones than at the old top', { timeout: 280000 }, () => {
	const zones = value => {
		const out = path.join(testTmp(), `vmapgen_zonecells_${process.pid}_${value}.vmap`);
		const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--out', out, '--declaremods', '0', '--w', '72', '--h', '72', '--players', '4',
			'--seed', '7', '--bio.zoneCells', String(value)], { encoding: 'utf8', cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv(), timeout: 250000 });
		assert.strictEqual(r.status, 0, `${value}: ${(r.stderr || '').slice(-400)}`);
		const side = JSON.parse(fs.readFileSync(out + '.zones.json', 'utf8'));
		for (const f of [out, out + '.zones.json']) try { fs.unlinkSync(f); } catch (e) { /* gone */ }
		const ids = new Set();
		for (const lv of side.levels) for (const z of lv.zone) if (z >= 0) ids.add(z);
		return ids.size;
	};
	const top = zones(1500), above = zones(3000);
	assert.ok(above >= 6, `${above} zones at 3000: at least the four starts and two more`);
	assert.ok(above <= top, `${above} zones at 3000 against ${top} at 1500`);
});
