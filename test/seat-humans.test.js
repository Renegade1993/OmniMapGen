/**
 * seat-humans.test.js - seatHumansOnPlayerStarts takes no hole in the
 * players list for a computer to trade with (findings-oe.md, colorStarts.js).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { seatHumansOnPlayerStarts } = require('../src/rmg/colorStarts');

test('seatHumansOnPlayerStarts: a hole in the players list is no partner', () => {
	const t = i => (i === 0 ? 'cpuStart' : 'playerStart');
	for (const teams of [undefined, [['red']]]) {
		const players = [{ color: 'red', canPlay: 'PlayerOrAI' }, null];
		assert.deepStrictEqual(seatHumansOnPlayerStarts(players, t, teams, -1), []);
		assert.strictEqual(players[0].color, 'red');
	}
});
