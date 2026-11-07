/**
 * approx-entries.test.js - "Mini Nostalgia (approximate)" and "Nostalgia (approximate)" (the lead's order for K, 2026-10-20): list entries made only from the sliders
 * that exist today, set toward the numbers of the engine's Nostalgia maps (nostalgia-003-REACH levers_mini3 and levers_nostalgia). Each is an open-layout entry
 * the way the open layout is, says it is approximate, and every slider it sets is a real slider with the value inside its range and on its step.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv } = require('./_vcmi');

const ROOT = path.join(__dirname, '..');
const info = JSON.parse(fs.readFileSync(path.join(ROOT, 'mod', 'template-info.json'), 'utf8')).templates;
const approved = JSON.parse(fs.readFileSync(path.join(ROOT, 'mod', 'approved-templates.json'), 'utf8')).approved;
const NAMES = ['Mini Nostalgia (approximate)', 'Nostalgia (approximate)'];
const OPEN = JSON.parse(fs.readFileSync(path.join(ROOT, 'mod', 'open-template-name.json'), 'utf8')).name;

const r = spawnSync(process.execPath, [path.join(ROOT, 'src', 'main', 'generate-cli.js'), '--listknobs', '1'], { encoding: 'utf8', cwd: ROOT, env: genEnv(), windowsHide: true, timeout: 120000 });
const knobs = Object.fromEntries(JSON.parse(r.stdout).knobs.map(k => [k.key, k]));

test('the two approximate entries are approved open-layout entries that say they are approximate', () => {
	for (const n of NAMES) {
		assert.ok(approved[n], `${n} is approved`);
		const e = info[n];
		assert.ok(e, `${n} has an entry`);
		assert.strictEqual(e.openLayout, true, `${n} is an open layout: the generator drops --template for it`);
		// 2026-11-07 (the suite's debt): K, 2026-11-03: "focused general information provision, with a 'what makes it different' subtext": the text opens with what the map is
		// and says it is approximate in its second paragraph, after the label 'What makes it different:' (it opened with 'APPROXIMATE.' and a slider guide before)
		assert.match(e.description.split('\n\n')[1] || '', /^What makes it different: this entry is approximate\./, `${n}: the lobby text says so in its "what makes it different" paragraph`);
		assert.ok(!/^APPROXIMATE\./.test(e.description), `${n}: the text opens with what the map is`);
		assert.match(e.oneLine, /^Approximate:/);
		assert.strictEqual(e.originalPreferences.approximate, true);
	}
});

test('every slider an approximate entry sets exists, inside its range and on its step; the rest are the open layout\'s own', () => {
	for (const n of NAMES) {
		const lev = info[n].originalPreferences.levers, base = info[OPEN].originalPreferences.levers;
		assert.deepStrictEqual(Object.keys(lev), Object.keys(base), `${n}: the same sliders as the open layout's entry`);
		const tuned = info[n].originalPreferences.tunedSliders;
		assert.ok(tuned.length >= 5, `${n} sets ${tuned.length} sliders`);
		for (const k of Object.keys(lev)) {
			const kn = knobs[k];
			assert.ok(kn, `${n}: ${k} is a slider`);
			if (!tuned.includes(k)) { assert.strictEqual(lev[k], base[k], `${n}: ${k} stays at the open layout's value`); continue; }
			assert.ok(lev[k] >= kn.min && lev[k] <= kn.max, `${n}: ${k} ${lev[k]} is outside ${kn.min} to ${kn.max}`);
			if (kn.step) assert.ok(Math.abs(Math.round((lev[k] - kn.min) / kn.step) * kn.step + kn.min - lev[k]) < 1e-9, `${n}: ${k} ${lev[k]} is off its step ${kn.step}`);
			if (!tuned.includes(k)) assert.strictEqual(lev[k], base[k], `${n}: ${k} stays at the open layout's value`);
		}
		for (const k of tuned) assert.notStrictEqual(lev[k], base[k], `${n}: ${k} is tuned, so it differs from the open layout's`);
	}
});

test('Mini Nostalgia sets the start zones big and Nostalgia sets Biome size to 1500, with half of the slider\'s range left above it', () => {
	assert.strictEqual(info[NAMES[0]].originalPreferences.levers.startZoneShare, 0.65);
	assert.strictEqual(info[NAMES[1]].originalPreferences.levers.zoneCells, 1500);
	assert.ok(knobs.zoneCells.max >= 2 * 1500, `Biome size runs to ${knobs.zoneCells.max}`);
});

test('both entries set Layout family to Tree (Opus Map Vision, 2026-10-21: 0.68 and 0.75 land links a zone against Mixed 0.82 and 0.91), and say so', () => {
	const fam = require('../src/biome/knobs').KNOBS.find(k => k.key === 'layoutFamily');
	const tree = fam.stops.find(([, label]) => label === 'Tree')[0];
	for (const n of NAMES) {
		assert.strictEqual(info[n].originalPreferences.levers.layoutFamily, tree, `${n} sets Layout family to Tree`);
		assert.ok(info[n].originalPreferences.tunedSliders.includes('layoutFamily'), `${n} lists Layout family among its tuned sliders`);
		// the text says how the zones join in plain words, not by the slider's name (K's description rule; the slider is asserted above)
		assert.match(info[n].description, /joined as an? (tree|mesh)/, `${n}: the text says how the zones join`);
		assert.ok(!/Layout family/.test(info[n].description), `${n}: the text names no slider`);
	}
});
