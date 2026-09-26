'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { BitSet } = require('../src/wfc/bitset');
const { buildCompat, solve, ac3 } = require('../src/wfc/solver');
const { computeTaccl } = require('../src/stitch/taccl');
const { mergeChunks } = require('../src/stitch/poms');
const { writeZip } = require('../src/exporter/zipWriter');
const zlib = require('zlib');

test('BitSet basics', () => {
	const b = new BitSet(70);
	b.set(5); b.set(69);
	assert.strictEqual(b.popcount(), 2);
	assert.strictEqual(b.get(5), 1);
	assert.strictEqual(b.get(6), 0);
	b.clear(5);
	assert.strictEqual(b.popcount(), 1);
	assert.strictEqual(b.firstSet(), 69);
	const c = b.clone(); c.set(0);
	assert.notDeepStrictEqual([...c.indices()], [...b.indices()]);
});

test('AC-3 enforces adjacency', () => {
	// 3 tiles: tile0 only neighbors tile1; tile1 neighbors all; tile2 neighbors tile1
	const numTiles = 3;
	const pairs = [];
	for (let d = 0; d < 4; d++) {
		pairs.push([0, d, 1]); pairs.push([1, d, 0]); pairs.push([1, d, 1]);
		pairs.push([1, d, 2]); pairs.push([2, d, 1]);
	}
	const compat = buildCompat(numTiles, pairs);
	const W = 3, H = 1;
	const domains = [BitSet.full(numTiles), BitSet.full(numTiles), BitSet.full(numTiles)];
	// Force leftmost to 0 => middle must be 1 => right must be 1
	domains[0].words.fill(0); domains[0].set(0);
	assert.ok(ac3(domains, W, H, compat));
	// middle is forced to 1 (the only tile 0 supports); rightmost keeps all
	// three candidates because tile 1 neighbors everything.
	assert.strictEqual(domains[1].popcount(), 1);
	assert.strictEqual(domains[1].firstSet(), 1);
	assert.strictEqual(domains[2].popcount(), 3);
});

test('WFC solves a uniform grid', () => {
	const numTiles = 4;
	const pairs = [];
	for (let a = 0; a < numTiles; a++) for (let b = 0; b < numTiles; b++)
		for (let d = 0; d < 4; d++) pairs.push([a, d, b]); // all-compatible
	const compat = buildCompat(numTiles, pairs);
	const tiles = solve({ width: 8, height: 8, numTiles, weights: [1,1,1,1], compat, seed: 7 });
	assert.ok(tiles);
	assert.strictEqual(tiles.length, 64);
	assert.ok(tiles.every(t => t >= 0 && t < numTiles));
});

test('WFC respects forced cells', () => {
	const numTiles = 2;
	const pairs = [];
	for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++)
		for (let d = 0; d < 4; d++) pairs.push([a, d, b]);
	const compat = buildCompat(numTiles, pairs);
	const tiles = solve({ width: 4, height: 4, numTiles, weights: [1,1], compat,
		seed: 3, forced: new Map([[0, 1], [15, 0]]) });
	assert.strictEqual(tiles[0], 1);
	assert.strictEqual(tiles[15], 0);
});

test('TACCL returns sane stitch width', () => {
	const numTiles = 4;
	const pairs = [];
	for (let a = 0; a < numTiles; a++) for (let b = 0; b < numTiles; b++)
		for (let d = 0; d < 4; d++) pairs.push([a, d, b]);
	const compat = buildCompat(numTiles, pairs);
	const { L, stitchWidth } = computeTaccl(numTiles, compat, 3);
	assert.ok(L >= 0);
	assert.strictEqual(stitchWidth, 2 * L + 3);
});

test('POMS merge writes every cell', () => {
	const numTiles = 3;
	const pairs = [];
	for (let a = 0; a < numTiles; a++) for (let b = 0; b < numTiles; b++)
		for (let d = 0; d < 4; d++) pairs.push([a, d, b]);
	const compat = buildCompat(numTiles, pairs);
	const chunk = { ox: 0, oy: 0, w: 8, h: 8, tiles: new Int32Array(64).fill(1) };
	const grid = mergeChunks([chunk], 8, 8, numTiles, [1,1,1], compat, 4, 0.3, 5);
	assert.strictEqual(grid.length, 64);
	assert.ok(grid.every(v => v >= 0));
});

test('zip round-trip', () => {
	const zip = writeZip([{ name: 'a.json', data: '{"x":1}' }, { name: 'b.json', data: 'hello' }]);
	assert.strictEqual(zip.readUInt32LE(0), 0x04034b50);
	// find central directory, locate b.json, inflate
	let eocd = -1;
	for (let i = zip.length - 22; i >= 0; i--) if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
	assert.ok(eocd > 0);
	let off = zip.readUInt32LE(eocd + 16);
	const entries = {};
	for (let i = 0; i < 2; i++) {
		const nl = zip.readUInt16LE(off + 28), xl = zip.readUInt16LE(off + 30), cl = zip.readUInt16LE(off + 32);
		const name = zip.slice(off + 46, off + 46 + nl).toString();
		entries[name] = { csize: zip.readUInt32LE(off + 18), lhoff: zip.readUInt32LE(off + 42) };
		off += 46 + nl + xl + cl;
	}
	const e = entries['b.json'];
	const nl = zip.readUInt16LE(e.lhoff + 26), xl = zip.readUInt16LE(e.lhoff + 28);
	const raw = zip.slice(e.lhoff + 30 + nl + xl, e.lhoff + 30 + nl + xl + e.csize);
	assert.strictEqual(zlib.inflateRawSync(raw).toString(), 'hello');
});
