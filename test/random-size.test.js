/**
 * random-size.test.js - the map-size row's Random (K, 2026-10-04: "we need a random map size button"). --w random (or -1) picks a size
 * from the row, the same one for the same seed, and not one too small for the players.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { isRandomSize, randomSize, roller } = require('../src/main/stockChoices');

const ROW = [36, 72, 108, 144, 180, 216, 252];

test('random, -1 and 0 mean Random; a size does not', () => {
	for (const v of ['random', 'Random', '-1', 0, '0']) assert.ok(isRandomSize(v), String(v));
	for (const v of [undefined, '72', 108]) assert.ok(!isRandomSize(v), String(v));
});

test('the pick comes from the row, is the same for a seed, and is reported', () => {
	const a = roller(7), b = roller(7);
	const s = randomSize(4, a);
	assert.ok(ROW.includes(s));
	assert.strictEqual(randomSize(4, b), s);
	assert.match(a.rolled[0], /^size \d+x\d+ \(of \d+ that take 4 players\)$/);
});

test('twelve seeds reach several sizes, and never one below what the players need', () => {
	for (const [players, floor] of [[2, 36], [4, 72], [6, 108], [8, 144]]) {
		const seen = new Set();
		for (let seed = 1; seed <= 40; seed++) seen.add(randomSize(players, roller(seed)));
		assert.ok([...seen].every(v => v >= floor), `${players} players: ${[...seen]}`);
		assert.ok(seen.size >= 3, `${players} players reach ${seen.size} sizes`);
	}
});
