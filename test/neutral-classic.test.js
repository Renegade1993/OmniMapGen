/**
 * neutral-classic.test.js - Classic's neutral value (S401, S402): the middle of the lean at each size and player count, as data the lobby reads
 * (mod/template-info.json, templates.Classic.neutral). It is the lean's own middle (feel 0.5, each lever halfway between its old-school ends), inside every lever's range.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { KNOBS } = require('../src/biome/knobs');
const feel = require('../src/biome/classicFeel');
const { middle, SIDES, PLAYERS } = require('../tools/neutral_classic');

const info = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mod', 'template-info.json'), 'utf8')).templates.Classic;

test('Classic has a neutral at every size and player count the lobby offers, equal to the lean\'s middle', () => {
	assert.ok(info.neutral, 'a neutral block');
	for (const s of SIDES) for (const p of PLAYERS) {
		const row = info.neutral[String(s)] && info.neutral[String(s)][String(p)];
		assert.ok(row, `${s} wide, ${p} players`);
		assert.deepStrictEqual(row, middle(s, p), `${s} wide, ${p} players: the table is the lean's middle (run node tools/neutral_classic.js)`);
	}
});

test('the neutral covers every lever the lean draws, each inside its slider range, and Monster tier is a whole number', () => {
	const row = info.neutral['108']['4'];
	for (const k of feel.leaning()) {
		assert.ok(row[k] !== undefined, `${k} has a neutral`);
		const knob = KNOBS.find(q => q.key === k);
		if (knob && knob.min !== undefined) assert.ok(row[k] >= knob.min - 1e-9 && row[k] <= knob.max + 1e-9, `${k} ${row[k]} is inside ${knob.min} to ${knob.max}`);
	}
	assert.ok(Number.isInteger(row.monsterStrength), `Monster tier ${row.monsterStrength}`);
	assert.strictEqual(row.specialDensity, 0.5, 'Special buildings 0.5x at the lean\'s middle');
});

test('the neutral follows the map: Start biome size scales with the players, Biome size with the size', () => {
	const a = info.neutral['108']['2'], b = info.neutral['108']['8'];
	assert.ok(a.startZoneShare < b.startZoneShare, `${a.startZoneShare} against ${b.startZoneShare}`);
	assert.ok(info.neutral['72']['4'].zoneCells !== info.neutral['180']['4'].zoneCells, 'Biome size differs between 72 and 180 wide');
});
