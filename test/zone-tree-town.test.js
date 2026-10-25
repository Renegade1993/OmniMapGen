/**
 * zone-tree-town.test.js - a zone's road tree joins the town when the tile
 * nearest its aim is walled in (findings-oe.md, roadsplines.js zoneTree).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { zoneTree } = require('../src/biome/roadsplines');

test('zoneTree: the junction is a tile the town reaches', () => {
	const W = 30, H = 12;
	const wall = new Set();
	// a closed box of rock round (8,5), the tile 7 steps from the gate toward the link end
	for (let y = 3; y <= 7; y++) for (let x = 6; x <= 10; x++) if (x === 6 || x === 10 || y === 3 || y === 7) wall.add(y * W + x);
	const open = c => !wall.has(c);
	const zoneCells = [];
	for (let c = 0; c < W * H; c++) zoneCells.push(c);
	const town = 5 * W + 1, end = 5 * W + 28;
	let r = 1;
	const rng = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 4294967296);
	const missed = [];
	const roads = zoneTree({ W, H, open, zoneCells, town, ends: [end], rng, missed, stub: 7 });
	assert.deepStrictEqual(missed, []);
	// the town's tile and the end are joined by the roads, four steps at a time
	const seen = new Set([town]), q = [town];
	for (let i = 0; i < q.length; i++) {
		const c = q[i], x = c % W, y = (c / W) | 0;
		for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
			const m = (y + dy) * W + x + dx;
			if (x + dx >= 0 && x + dx < W && y + dy >= 0 && y + dy < H && roads.has(m) && !seen.has(m)) { seen.add(m); q.push(m); }
		}
	}
	assert.ok(seen.has(end), 'the town reaches the link end over the roads');
});
