/**
 * neutral-blocks.test.js - S434 (K, the fourth time: "\"Template\" setting should be in the middle so the players can adjust up or down"). mod/template-info.json carries, for each template
 * with a neutral block, a neutral value for every slider with a Template notch that does something on that template, and the bar range round it (the same room up and down).
 * The blocks are written by tools/neutral_blocks.js; a lever or default that changes without a rerun makes this red.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { NOTCHED, classicNeutral, rangeOf } = require('../tools/neutral_blocks');
const INERT = require('../src/biome/inert.json');

const info = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mod', 'template-info.json'), 'utf8')).templates;
const SIDES = [36, 72, 108, 144, 180, 216, 252], PLAYERS = [2, 4, 6, 8];
const near = (a, b) => Math.abs(a - b) < 1e-6;

test('Classic: every slider with a Template notch has a neutral value in its range at every size and player count, equal to what the generator gives it', () => {
	for (const s of SIDES) for (const p of PLAYERS) {
		const n = info.Classic.neutral[s][p], want = classicNeutral(s, p);
		for (const k of NOTCHED) {
			assert.ok(Number.isFinite(n[k.key]), `Classic ${s} wide ${p} players: no neutral for ${k.key}`);
			assert.ok(n[k.key] >= k.min - 1e-9 && n[k.key] <= k.max + 1e-9, `Classic ${s}/${p}: ${k.key} ${n[k.key]} outside ${k.min}..${k.max}`);
			assert.ok(near(n[k.key], want[k.key]), `Classic ${s}/${p}: ${k.key} stored ${n[k.key]}, generator ${want[k.key]}`);
		}
	}
});

test('every range is the same room up and down round its neutral, inside the lever, or null only where the neutral stands at an end of the lever', () => {
	for (const [name, t] of Object.entries(info)) {
		if (!t.neutral) continue;
		for (const s of SIDES) for (const p of PLAYERS) for (const [key, n] of Object.entries(t.neutral[s][p])) {
			const k = NOTCHED.find(q => q.key === key);
			if (!k) continue;
			const r = t.range[s][p][key], want = rangeOf(k, n);
			assert.deepStrictEqual(r, want, `${name} ${s}/${p} ${key}`);
			if (r) {
				assert.ok(near(n - r[0], r[1] - n), `${name} ${s}/${p} ${key}: not centred ${r} round ${n}`);
				assert.ok(r[0] >= k.min - 1e-9 && r[1] <= k.max + 1e-9, `${name} ${s}/${p} ${key}: ${r} outside ${k.min}..${k.max}`);
			}
		}
	}
});

test('a named template has a neutral for each live slider and none for one that does nothing on it', () => {
	for (const name of ["Coldshadow's Fantasy", 'Jebus Cross', 'Headquarters', 'Golems Aplenty']) {
		const n = info[name].neutral['108']['4'];
		for (const k of NOTCHED) {
			const inert = INERT[k.key] || {};
			const dead = !!(inert[name] || inert['*named']);
			if (dead && ['zoneCells', 'startZoneShare', 'zoneCap'].includes(k.key)) continue;   // measured on the template's own maps (tools/neutral_measure.js); the Biome size conversion reads them
			if (dead) assert.strictEqual(n[k.key], undefined, `${name}: ${k.key} does nothing here and has a neutral`);
			else assert.ok(Number.isFinite(n[k.key]), `${name}: no neutral for ${k.key}`);
		}
	}
});
