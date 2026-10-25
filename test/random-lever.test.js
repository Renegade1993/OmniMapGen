/**
 * random-lever.test.js - a lever left to chance (K, 2026-10-03: "each setting should have a random setting (sliders: a checkbox?)"): --bio.<key> random
 * rolls a value in the lever's own range, on its step, the same for the same seed, from its own stream; the map reports it.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { isRandomLever, randomLever } = require('../src/main/stockChoices');
const { KNOBS } = require('../src/biome/knobs');
const { genEnv, testTmp } = require('./_vcmi');

test('every lever rolls inside its range and on its step', () => {
	for (const k of KNOBS.filter(q => !q.cli && Number.isFinite(q.min) && Number.isFinite(q.max))) {
		for (let seed = 1; seed <= 60; seed++) {
			const v = randomLever(k, seed);
			assert.ok(v >= k.min - 1e-9 && v <= k.max + 1e-9, `${k.key} seed ${seed}: ${v} outside ${k.min}..${k.max}`);
			if (k.step > 0) {
				const n = (v - k.min) / k.step;
				assert.ok(Math.abs(n - Math.round(n)) < 1e-6, `${k.key} seed ${seed}: ${v} off the step ${k.step}`);
			}
		}
	}
});

test('the same seed rolls the same value; seeds spread over the range', () => {
	const k = KNOBS.find(q => q.key === 'decorDensity');
	assert.strictEqual(randomLever(k, 42), randomLever(k, 42));
	const vals = new Set();
	for (let seed = 1; seed <= 40; seed++) vals.add(randomLever(k, seed));
	assert.ok(vals.size >= 10, `only ${vals.size} values over 40 seeds`);
});

test('the word is read as random, a number is not', () => {
	assert.ok(isRandomLever('random') && isRandomLever(' Random '));
	assert.ok(!isRandomLever('0.5') && !isRandomLever(0.5));
});

test('a map made with --bio.decorDensity random reports the value it rolled', { timeout: 600000 }, () => {
	const dir = fs.mkdtempSync(path.join(testTmp(), 'rlever-'));
	const out = path.join(dir, 'm.vmap');
	const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'main', 'generate-cli.js'), '--out', out, '--w', '36', '--h', '36', '--players', '2', '--seed', '7',
		'--declaremods', '0', '--bio.decorDensity', 'random'], { encoding: 'utf8', timeout: 540000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, (r.stderr || '').slice(-1500));
	const want = randomLever(KNOBS.find(q => q.key === 'decorDensity'), 7);
	assert.ok(r.stdout.includes(`lever decorDensity ${want}`), `the random line names the roll: ${r.stdout.slice(0, 400)}`);
	const side = JSON.parse(fs.readFileSync(out + '.zones.json', 'utf8'));
	assert.ok(side.rolled.includes(`lever decorDensity ${want}`));
	if (Math.abs(want - 1) > 1e-9) assert.ok(side.settings.includes(`decorDensity ${want}`), side.settings);
	fs.rmSync(dir, { recursive: true, force: true });
});
