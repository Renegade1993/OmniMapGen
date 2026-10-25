/**
 * template-footprint.test.js - templateFootprint reads a mask with VCMI's
 * alphabet (ObjectTemplate::readJson): 'B', 'H', 'A' and 'T' block, 'A' and
 * 'T' are visited, 'V' is picture only.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { templateFootprint } = require('../src/parser/assetIndex');

const sorted = a => a.map(String).sort();

test('templateFootprint: V is picture only, A blocks and is visited', () => {
	const f = templateFootprint({ mask: ['VVV', 'BBA'] });
	assert.deepStrictEqual(sorted(f.blocked), sorted([[0, 0], [1, 0], [2, 0]]));
	assert.deepStrictEqual(f.visitable, [[2, 0]]);
});

test('templateFootprint: H blocks, T blocks and is visited', () => {
	const f = templateFootprint({ mask: ['0H', 'HT'] });
	assert.deepStrictEqual(sorted(f.blocked), sorted([[1, 1], [0, 0], [1, 0]]));
	assert.deepStrictEqual(f.visitable, [[1, 0]]);
});
