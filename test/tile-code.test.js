/**
 * tile-code.test.js - parseTileCode tells a tile's road from its river when
 * the tile has only one of them (findings-oe.md, preview/palette.js).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseTileCode } = require('../src/preview/palette');

test('parseTileCode: road, river, both, neither', () => {
	assert.deepStrictEqual(parseTileCode('gr5_rw3_'), { terr: 'gr', road: null, river: 'rw' });
	assert.deepStrictEqual(parseTileCode('gr5_pc2_'), { terr: 'gr', road: 'pc', river: null });
	assert.deepStrictEqual(parseTileCode('gr5_pg2_rw3_'), { terr: 'gr', road: 'pg', river: 'rw' });
	assert.deepStrictEqual(parseTileCode('sn12|'), { terr: 'sn', road: null, river: null });
});
