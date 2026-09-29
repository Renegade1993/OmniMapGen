/**
 * waterfill.test.js
 *
 * Pins boats, shipyards and water objects (src/biome/waterfill.js, water W2)
 * on a small lake: a town zone on the shore gets a shipyard whose launch tile
 * is this lake's water with a free boarding cell beside it; water objects sit
 * on the lake only, and every one can be reached by boat from that launch.
 * At Every biome a zone that touches no water sails from the nearest shore of the
 * zone beside it (K, 2026-09-29: "THERE'S NO FUCKING HARBORS ANYWHERE").
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { placeHarbours, fillWater } = require('../src/biome/waterfill');
const { OCCUPIED, blockingCells, visitableCells, allowedDirs } = require('../src/biome/content');
const { xorshift } = require('../src/wfc/solver');

const entry = (type, x, y, l, tpl, subtype = 'object') =>
	({ instanceName: `${type}_${x}_${y}_${l}`, l, x, y, type, subtype,
		template: { animation: tpl.animation, mask: tpl.mask, visitableFrom: tpl.visitableFrom } });

function world() {
	const W = 48, H = 40;
	const water = new Uint8Array(W * H), zone = new Int16Array(W * H), blocked = new Uint8Array(W * H);
	// a lake in the middle, zone 0 west of x = 24, zone 1 east
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			zone[y * W + x] = x < 24 ? 0 : 1;
			if ((x - 24) ** 2 / 144 + (y - 20) ** 2 / 64 <= 1) water[y * W + x] = 1;
		}
	for (let c = 0; c < W * H; c++) if (water[c]) blocked[c] |= OCCUPIED;
	return { W, H, water, zone, blocked };
}

test('a town zone on the shore gets a shipyard that launches onto the lake', () => {
	const { W, H, water, zone, blocked } = world();
	const objects = [];
	const towns = [{ x: 6, y: 20, l: 0 }];                 // a town in zone 0
	const harbours = placeHarbours({ W, H, l: 0, water, zone, blocked, rng: xorshift(3),
		p: { waterAccess: 2 }, objects, towns, playerStarts: [], objectEntry: entry });
	const yards = objects.filter(o => o.type === 'shipyard');
	assert.strictEqual(yards.length, 1, 'one shipyard, for the one town zone');
	assert.strictEqual(harbours.length, 1);
	const h = harbours[0];
	assert.ok(water[h.cell], 'launch tile is water');
	// the shipyard stands on zone 0's land
	for (const [x, y] of blockingCells(yards[0].template, yards[0].x, yards[0].y)) {
		assert.ok(!water[y * W + x], 'shipyard on land');
		assert.strictEqual(zone[y * W + x], 0);
	}
	// its launch tile is the first free water tile in the engine's order
	const [vx, vy] = visitableCells(yards[0].template, yards[0].x, yards[0].y)[0];
	const LAUNCH = [[-2, 0], [2, 0], [-2, 1], [2, 1], [-1, 1], [1, 1], [0, 1], [-2, -1], [2, -1], [-1, -1], [1, -1], [0, -1]];
	const first = LAUNCH.map(([dx, dy]) => (vy + dy) * W + vx + dx).find(c => water[c]);
	assert.strictEqual(first, h.cell);
});

test('water objects sit on the lake and a boat from the harbour reaches every one', () => {
	const { W, H, water, zone, blocked } = world();
	const objects = [];
	const harbours = placeHarbours({ W, H, l: 0, water, zone, blocked, rng: xorshift(5),
		p: { waterAccess: 3 }, objects, towns: [{ x: 6, y: 20, l: 0 }], playerStarts: [], objectEntry: entry });
	assert.ok(harbours.length >= 1);
	const before = objects.length;
	const placed = fillWater({ W, H, l: 0, water, harbours, rng: xorshift(7),
		p: { waterTreasure: 3 }, objects, objectEntry: entry });
	assert.ok(placed > 0, 'something was placed');
	const added = objects.slice(before);
	// the water layer after placement: land and blocking cells taken
	const taken = new Uint8Array(W * H);
	for (let c = 0; c < W * H; c++) if (!water[c]) taken[c] = 1;
	for (const o of added)
		for (const [x, y] of blockingCells(o.template, o.x, o.y)) {
			assert.ok(water[y * W + x], `${o.type} blocks only water`);
			taken[y * W + x] = 1;
		}
	// sail 8-way from the first harbour over untaken water
	const seen = new Uint8Array(W * H);
	const q = [harbours[0].cell];
	seen[q[0]] = 1;
	for (let i = 0; i < q.length; i++) {
		const c = q[i], x = c % W, y = (c / W) | 0;
		for (let dy = -1; dy <= 1; dy++)
			for (let dx = -1; dx <= 1; dx++) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const d = ny * W + nx;
				if (!seen[d] && water[d] && !taken[d]) { seen[d] = 1; q.push(d); }
			}
	}
	for (const o of added) {
		const vis = visitableCells(o.template, o.x, o.y);
		if (!vis.length) continue;                                   // scenery
		const ok = vis.some(([vx, vy]) => allowedDirs(o.template)
			.some(([dx, dy]) => seen[(vy + dy) * W + vx + dx]));
		assert.ok(ok, `${o.type} at ${o.x},${o.y} reachable by boat`);
	}
});

test('Buildings on the water: mermaids, buoys, sirens and whirlpools, the whirlpools in pairs', () => {
	const { W, H, water, zone, blocked } = world();
	const base = [];
	const harbours = placeHarbours({ W, H, l: 0, water, zone, blocked, rng: xorshift(5),
		p: { waterAccess: 3 }, objects: base, towns: [{ x: 6, y: 20, l: 0 }], playerStarts: [], objectEntry: entry });
	const BUILDINGS = ['mermaids', 'buoy', 'sirens', 'whirlpool'];
	for (const [mult, seed] of [[0, 11], [30, 11], [30, 12], [30, 13]]) {
		const objects = base.slice();
		fillWater({ W, H, l: 0, water, harbours, rng: xorshift(seed),
			p: { waterTreasure: 0, waterBuildings: mult }, objects, objectEntry: entry });
		const added = objects.slice(base.length);
		const count = t => added.filter(o => o.type === t).length;
		if (!mult) {
			assert.strictEqual(BUILDINGS.reduce((s, t) => s + count(t), 0), 0, 'the lever at 0 places none');
			continue;
		}
		assert.ok(count('sirens') >= 1 && count('buoy') >= 1, `seed ${seed}: sirens and buoys`);
		assert.strictEqual(count('whirlpool') % 2, 0, `seed ${seed}: whirlpools in pairs`);
		// the engine's names: sirens and whirlpool are one object each, subtype "object"
		for (const o of added.filter(o => o.type === 'sirens' || o.type === 'whirlpool'))
			assert.strictEqual(o.subtype, 'object');
		assert.ok(!added.some(o => /flotsam|seaChest|shipwreck|derelictShip/.test(o.type)), 'treasure follows its own lever');
	}
});

test('no harbours with waterAccess 0, and nothing on the water without one', () => {
	const { W, H, water, zone, blocked } = world();
	const objects = [];
	const harbours = placeHarbours({ W, H, l: 0, water, zone, blocked, rng: xorshift(3),
		p: { waterAccess: 0 }, objects, towns: [{ x: 6, y: 20, l: 0 }], playerStarts: [], objectEntry: entry });
	assert.strictEqual(harbours.length, 0);
	assert.strictEqual(fillWater({ W, H, l: 0, water, harbours, rng: xorshift(7), p: {}, objects, objectEntry: entry }), 0);
	assert.strictEqual(objects.length, 0);
});

// K, 2026-09-29, Jebus Cross with a Mediterranean sea held inside the crossroads zone: none of the
// four player zones touched the water, so "Every biome" put one shipyard on a shore of hundreds of
// cells, and the map read as "no harbours anywhere". A zone off the shore now sails from the
// nearest shore of the zone beside it.
function ringWorld() {
	const W = 64, H = 48;
	const water = new Uint8Array(W * H), zone = new Int16Array(W * H), blocked = new Uint8Array(W * H);
	// zone 0 west, zone 2 east, zone 1 between them holding the whole lake
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			zone[y * W + x] = x < 16 ? 0 : x >= 48 ? 2 : 1;
			if ((x - 32) ** 2 / 144 + (y - 24) ** 2 / 64 <= 1) water[y * W + x] = 1;
		}
	for (let c = 0; c < W * H; c++) if (water[c]) blocked[c] |= OCCUPIED;
	return { W, H, water, zone, blocked };
}

test('Every biome: a zone that touches no water sails from the nearest shore beside it', () => {
	const { W, H, water, zone, blocked } = ringWorld();
	const objects = [];
	const harbours = placeHarbours({ W, H, l: 0, water, zone, blocked, rng: xorshift(3),
		p: { waterAccess: 3 }, objects, towns: [], playerStarts: [{ x: 6, y: 24 }, { x: 57, y: 24 }],
		objectEntry: entry });
	const west = harbours.find(h => h.serves === 0), east = harbours.find(h => h.serves === 2);
	assert.ok(west && east, 'a harbour for each start zone off the shore');
	assert.strictEqual(west.kind, 'shipyard');
	assert.strictEqual(east.kind, 'shipyard');
	// on the side its zone lies, launching onto this lake, standing on the zone between
	assert.ok(west.cell % W < 32, `the west start's shipyard launches on the west shore (x ${west.cell % W})`);
	assert.ok(east.cell % W > 32, `the east start's shipyard launches on the east shore (x ${east.cell % W})`);
	assert.ok(water[west.cell] && water[east.cell]);
	const yards = objects.filter(o => o.type === 'shipyard');
	assert.strictEqual(yards.length, 2);
	for (const o of yards)
		for (const [x, y] of blockingCells(o.template, o.x, o.y)) {
			assert.ok(!water[y * W + x], 'on land');
			assert.strictEqual(zone[y * W + x], 1, 'in the zone that owns the shore');
		}
	// the zone that owns the shore keeps its own boat, as before
	assert.ok(harbours.some(h => h.serves === undefined && h.kind === 'boat' && h.zone === 1));
});

test('Every biome serves a town zone with a shipyard and a plain zone with a boat', () => {
	const { W, H, water, zone, blocked } = ringWorld();
	const harbours = placeHarbours({ W, H, l: 0, water, zone, blocked, rng: xorshift(5),
		p: { waterAccess: 3 }, objects: [], towns: [{ x: 6, y: 24, l: 0 }], playerStarts: [], objectEntry: entry });
	assert.strictEqual(harbours.find(h => h.serves === 0).kind, 'shipyard', 'the town zone');
	assert.strictEqual(harbours.find(h => h.serves === 2).kind, 'boat', 'the plain zone');
});

test('below Every biome a zone off the shore gets nothing, as the engine\'s own rule has it', () => {
	const { W, H, water, zone, blocked } = ringWorld();
	for (const access of [1, 2]) {
		const objects = [];
		const harbours = placeHarbours({ W, H, l: 0, water, zone, blocked: blocked.slice(), rng: xorshift(3),
			p: { waterAccess: access }, objects, towns: [], playerStarts: [{ x: 6, y: 24 }, { x: 57, y: 24 }],
			objectEntry: entry });
		assert.strictEqual(harbours.length, 0, `access ${access}: no start or town zone has a shore`);
		assert.strictEqual(objects.length, 0);
	}
});
