/**
 * underground-starts.test.js - the "Split Spawns Between Overworld and Underground" control (K, 2026-10-03): five choices,
 * 0 All Overworld, 1 Mixed, 2 All Underground, 3 Random, 4 Template preference (the default).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { resolveUndergroundStarts: pick } = require('../src/main/stockChoices');
const tpl = require('../src/rmg/template');

const T = tpl.loadTemplate("Coldshadow's Fantasy");
const zones = tpl.resolveZones(T.raw);
const startsOn = (mode, seed) => {
	const plan = tpl.buildZonePlan(T.raw, zones, { w: 144, h: 144, levels: 2, players: 4, humans: 1, seed,
		starts: [null, null, null, null], undergroundStarts: mode }, new Set(['size', 'players', 'humans', 'underground']));
	const count = level => plan.perLevel[level].filter(z => /start/i.test(z.type) && z.owner <= 4).length;
	return { over: count(0), under: count(1) };
};

test('Coldshadow two levels: All Overworld keeps every start up, All Underground puts every start below', () => {
	for (let seed = 1; seed <= 12; seed++) {
		assert.deepStrictEqual(startsOn(pick(0, { hasTemplate: true, seed }).mode, seed), { over: 4, under: 0 }, `seed ${seed}`);
		assert.deepStrictEqual(startsOn(pick(2, { hasTemplate: true, seed }).mode, seed), { over: 0, under: 4 }, `seed ${seed}`);
	}
});

test('Coldshadow two levels: Mixed puts some starts on each level (the game\'s split)', () => {
	let both = 0;
	for (let seed = 1; seed <= 12; seed++) {
		const s = startsOn(pick(1, { hasTemplate: true, seed }).mode, seed);
		assert.strictEqual(s.over + s.under, 4);
		if (s.over && s.under) both++;
	}
	assert.ok(both >= 6, `some of each on ${both} of 12 seeds`);
});

test('Random shows all three over 12 seeds, and the same seed always picks the same', () => {
	const seen = new Set();
	for (let seed = 1; seed <= 12; seed++) {
		const a = pick(3, { hasTemplate: true, seed }), b = pick(3, { hasTemplate: true, seed });
		assert.strictEqual(a.mode, b.mode);
		assert.ok(/random/.test(a.note), 'the log line says what random picked');
		seen.add(a.mode);
	}
	assert.deepStrictEqual([...seen].sort(), [0, 1, 2]);
});

test('Template preference: a template with no start-level rule keeps every start up; the open layout means Random; the default is Template preference', () => {
	assert.strictEqual(pick(4, { hasTemplate: true }).mode, 0);
	assert.strictEqual(pick(undefined, { hasTemplate: true }).mode, 0);
	assert.strictEqual(pick(4, { hasTemplate: true, templateForcesStarts: true }).mode, 1);
	const open = new Set();
	for (let seed = 1; seed <= 12; seed++) open.add(pick(4, { hasTemplate: false, seed }).mode);
	assert.deepStrictEqual([...open].sort(), [0, 1, 2], 'the open layout under Template preference is Random');
	// Coldshadow's own start zones carry no forced level, so its preference is All Overworld
	assert.ok(!zones.some(z => /start/i.test(z.type) && z.forcedLevel));
});

test('a map with one level has no underground whatever is chosen, and says so; the retired Automatic (-1) reads as All Overworld', () => {
	for (const v of [1, 2, 3, 4]) {
		const r = pick(v, { hasTemplate: true, levels: 1, seed: 5 });
		assert.strictEqual(r.mode, 0);
		if (v === 1 || v === 2) assert.ok(/one level/.test(r.note), `choice ${v}: the log line says the map has one level`);
	}
	assert.strictEqual(pick(-1, { hasTemplate: true }).mode, 0);
	assert.strictEqual(pick(-1, { hasTemplate: false, seed: 3 }).mode, 0);
});
