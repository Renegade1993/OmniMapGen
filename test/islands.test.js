/**
 * islands.test.js
 *
 * Pins the island layouts (water W3): Islands and Archipelago put every start
 * on an island of its own, and a boat is the only way off it.
 *   - every island gets a zone of its own, so no zone spans the water
 *   - every start island gets a harbour even with Harbours set to None, and
 *     a boat waiting on its shore (an AI that cannot buy one still sails)
 *   - the stranded sweep counts a boat landing as a way in: content on an
 *     island with no start survives, and would not without the links
 *   - the whole generator makes Islands maps where every start island has a
 *     free boat (two players on 72x72 seed 4 once had a shipyard only), and one (108x108, four players, seed 1) where
 *     each player can walk to a harbour and sail to every other player: two
 *     players there sat behind their own island's zone walls while the seal
 *     passes, following boat links both ways, called them connected
 *   - every player walks to a boat of its own (72x72 seed 7, Harbours Every
 *     zone, no portals: blue could reach only its shipyard, because the seal
 *     passes counted any harbour as a way off)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { genEnv, testTmp } = require('./_vcmi');
const { placeHarbours, sailLinksFor } = require('../src/biome/waterfill');
const { buildWaterPlan, settleZonesOnLand, WATER_SHAPES } = require('../src/biome/water');
const { partitionBiomes } = require('../src/biome/biomes');
const { sweepStranded } = require('../src/biome/plan');
const { OCCUPIED, footprintBlock, blockingCells, visitableCells, REMOVABLE_TYPES } = require('../src/biome/content');
const { OBJECT_TEMPLATES } = require('../src/stitch/zones');
const { xorshift } = require('../src/wfc/solver');

const entry = (type, x, y, l, tpl, subtype = 'object', options) =>
	({ instanceName: `${type}_${x}_${y}_${l}`, l, x, y, type, subtype, options,
		template: { animation: tpl.animation, mask: tpl.mask, visitableFrom: tpl.visitableFrom } });

// two islands and a strait: west x 0-15 (zone 0, the start), east x 24-47 (zone 1)
function twoIslands() {
	const W = 48, H = 24;
	const water = new Uint8Array(W * H), zone = new Int16Array(W * H), blocked = new Uint8Array(W * H);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const c = y * W + x;
			zone[c] = x < 20 ? 0 : 1;
			if (x >= 16 && x < 24) { water[c] = 1; blocked[c] |= OCCUPIED; }
		}
	return { W, H, water, zone, blocked };
}

const islandIds = WATER_SHAPES.map((s, i) => (s.islands ? i : -1)).filter(i => i >= 0);

test('the island layouts are offered', () => {
	assert.deepStrictEqual(islandIds.map(i => WATER_SHAPES[i].id), ['islands', 'archipelago']);
});

test('every island gets a zone of its own', () => {
	const W = 72, H = 72;
	const starts = [[4, 4], [67, 67], [4, 67], [67, 4]].map(([x, y]) => ({ x, y }));
	for (const sh of islandIds)
		for (const seed of [1, 2, 3]) {
			const plan = buildWaterPlan(W, H, { waterCoverage: 0.4, waterShape: sh }, starts, seed);
			const water = plan.mask;
			const { zone, seeds } = partitionBiomes(W, H, plan.starts, 6, xorshift(seed),
				{ waterIslands: true }, water);
			settleZonesOnLand(zone, seeds, W, H, water);
			// label the islands, then check no zone owns land on two of them
			const island = new Int32Array(W * H).fill(-1);
			let k = 0;
			for (let c0 = 0; c0 < W * H; c0++) {
				if (water[c0] || island[c0] >= 0) continue;
				const q = [c0];
				island[c0] = k;
				for (let h = 0; h < q.length; h++) {
					const c = q[h], x = c % W, y = (c / W) | 0;
					for (const [u, v] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]])
						if (u >= 0 && v >= 0 && u < W && v < H && !water[v * W + u] && island[v * W + u] < 0) { island[v * W + u] = k; q.push(v * W + u); }
				}
				k++;
			}
			const home = new Map();
			const withZone = new Set();
			for (let c = 0; c < W * H; c++) {
				if (water[c]) continue;
				if (!home.has(zone[c])) home.set(zone[c], island[c]);
				assert.strictEqual(home.get(zone[c]), island[c],
					`${WATER_SHAPES[sh].id} s${seed}: zone ${zone[c]} on one island`);
				withZone.add(island[c]);
			}
			assert.strictEqual(withZone.size, k, `${WATER_SHAPES[sh].id} s${seed}: ${k} islands, each zoned`);
		}
});

test('a start island gets a harbour and a boat even with Harbours set to None', () => {
	const { W, H, water, zone, blocked } = twoIslands();
	const objects = [];
	const town = OBJECT_TEMPLATES.randomTown;
	footprintBlock(town, 8, 12, 0, W, H, blocked);
	const harbours = placeHarbours({ W, H, l: 0, water, zone, blocked, rng: xorshift(4),
		p: { waterAccess: 0 }, objects, towns: [{ x: 8, y: 12, l: 0 }],
		playerStarts: [{ x: 8, y: 12 }], objectEntry: entry, islands: true });
	const onHome = h => h.boarding.some(c => c % W < 16);
	assert.ok(harbours.some(h => h.kind === 'shipyard' && onHome(h)), 'a shipyard on the start island');
	assert.ok(harbours.some(h => h.kind === 'boat' && onHome(h)), 'and a boat waiting beside it');
	assert.ok(objects.some(o => o.type === 'boat'));
});

test('a start whose zone misses the shore still gets a boat on its island', () => {
	const { W, H, water, zone, blocked } = twoIslands();
	// the start's zone is an inland pocket; the west shore belongs to zone 2
	for (let y = 0; y < H; y++)
		for (let x = 0; x < 16; x++) zone[y * W + x] = x < 8 ? 0 : 2;
	const objects = [];
	const harbours = placeHarbours({ W, H, l: 0, water, zone, blocked, rng: xorshift(6),
		p: { waterAccess: 1 }, objects, towns: [], playerStarts: [{ x: 3, y: 12 }],
		objectEntry: entry, islands: true });
	assert.ok(harbours.some(h => h.kind === 'boat' && h.boarding.some(c => c % W < 16)),
		'a boat on the start island');
});

test('the stranded sweep lands on other islands by boat, and only by boat', () => {
	const build = withLinks => {
		const { W, H, water, zone, blocked } = twoIslands();
		const objects = [];
		const town = OBJECT_TEMPLATES.randomTown;
		objects.push(entry('randomTown', 8, 12, 0, town, 'object', { owner: 'red' }));
		footprintBlock(town, 8, 12, 0, W, H, blocked);
		const harbours = placeHarbours({ W, H, l: 0, water, zone, blocked, rng: xorshift(4),
			p: { waterAccess: 1 }, objects, towns: [{ x: 8, y: 12, l: 0 }],
			playerStarts: [{ x: 8, y: 12 }], objectEntry: entry, islands: true });
		// a prize on the far island
		objects.push(entry('randomArtifact', 36, 12, 0, OBJECT_TEMPLATES.randomArtifact));
		const plan = { objects, p: { water }, sailLinks: withLinks ? sailLinksFor(harbours, water, W, H) : [] };
		sweepStranded(plan, W, H, 0, [{ x: 8, y: 12 }], null);
		return plan.objects.some(o => o.type === 'randomArtifact');
	};
	assert.strictEqual(build(true), true, 'reached by boat');
	assert.strictEqual(build(false), false, 'unreachable without the boat');
});

for (const [size, seed, cover] of [[48, 3, '0.4'], [72, 4, '0.25']])
test(`an Islands map (${size}x${size}, 2 players, seed ${seed}): every start island has a free boat`, { timeout: 240000 }, () => {
	const { spawnSync } = require('child_process');
	const fs = require('fs');
	const out = path.join(testTmp(), `vmapgen_islands_test_${size}.vmap`);
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'),
		'--w', String(size), '--h', String(size), '--players', '2', '--seed', String(seed), '--out', out,
		'--bio.waterCoverage', cover, '--bio.waterShape', String(islandIds[0])],
	{ encoding: 'utf8', timeout: 200000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	const { readVmap } = require('../src/preview/render');
	const { objects, levels } = readVmap(out);
	const rows = levels[0].rows, H = rows.length, W = rows[0].length;
	const wet = c => String(rows[(c / W) | 0][c % W]).startsWith('wt');
	const island = new Int32Array(W * H).fill(-1);
	let k = 0;
	for (let c0 = 0; c0 < W * H; c0++) {
		if (wet(c0) || island[c0] >= 0) continue;
		const q = [c0];
		island[c0] = k;
		for (let h = 0; h < q.length; h++) {
			const c = q[h], x = c % W, y = (c / W) | 0;
			for (const [u, v] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]])
				if (u >= 0 && v >= 0 && u < W && v < H && !wet(v * W + u) && island[v * W + u] < 0) { island[v * W + u] = k; q.push(v * W + u); }
		}
		k++;
	}
	const near = (o, pred) => {
		for (let dy = -3; dy <= 3; dy++)
			for (let dx = -3; dx <= 3; dx++) {
				const x = o.x + dx, y = o.y + dy;
				if (x >= 0 && y >= 0 && x < W && y < H && pred(y * W + x)) return true;
			}
		return false;
	};
	const starts = objects.filter(o => o.type === 'randomTown' && o.options && o.options.owner && (o.l || 0) === 0);
	assert.strictEqual(starts.length, 2);
	const homes = starts.map(s => island[s.y * W + s.x - 2]);
	assert.strictEqual(new Set(homes).size, 2, 'the two starts are on different islands');
	for (const [i, s] of starts.entries()) {
		const ok = objects.some(o => o.type === 'boat' && (o.l || 0) === 0
			&& near(o, c => island[c] === homes[i]));
		assert.ok(ok, `${s.options.owner}'s island has a boat`);
	}
	fs.rmSync(out, { force: true });
});

// Where each player's hero gets to, on foot and by boat, in a saved map. Walks
// 8-way over land no fixed object blocks (monsters and pickups step aside),
// boards a boat beside reached ground or buys one at a reached shipyard (on
// its first water tile in the engine's order), sails the open water and goes
// ashore anywhere, and takes monolith pairs. A small cousin of check_reach.py.
function sailReach(file) {
	const { readVmap } = require('../src/preview/render');
	const { objects, levels } = readVmap(file);
	const rows = levels[0].rows, H = rows.length, W = rows[0].length;
	const wet = new Uint8Array(W * H), hard = new Uint8Array(W * H);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const tt = String(rows[y][x]).slice(0, 2);
			if (tt === 'wt') wet[y * W + x] = 1;
			if (tt === 'rc') hard[y * W + x] = 1;
		}
	const on0 = objects.filter(o => (o.l || 0) === 0 && o.template && o.template.mask);
	const cellsOf = (o, f) => f(o.template, o.x, o.y).filter(([x, y]) => x >= 0 && y >= 0 && x < W && y < H).map(([x, y]) => y * W + x);
	for (const o of on0)
		if (!REMOVABLE_TYPES.has(o.type)) for (const c of cellsOf(o, blockingCells)) hard[c] = 1;
	const ring = c => {
		const out = [], x = c % W, y = (c / W) | 0;
		for (let dy = -1; dy <= 1; dy++)
			for (let dx = -1; dx <= 1; dx++) {
				const u = x + dx, v = y + dy;
				if ((dx || dy) && u >= 0 && v >= 0 && u < W && v < H) out.push(v * W + u);
			}
		return out;
	};
	const LAUNCH = [[-2, 0], [2, 0], [-2, 1], [2, 1], [-1, 1], [1, 1], [0, 1], [-2, -1], [2, -1], [-1, -1], [1, -1], [0, -1]];
	const boats = on0.filter(o => o.type === 'boat').map(o => cellsOf(o, visitableCells)[0]);
	const yards = on0.filter(o => o.type === 'shipyard').map(o => {
		const v = cellsOf(o, visitableCells)[0], vx = v % W, vy = (v / W) | 0;
		const launch = LAUNCH.map(([dx, dy]) => (vy + dy) * W + vx + dx).find(c => c >= 0 && c < W * H && wet[c]);
		return { from: [v + W, v + W - 1, v + W + 1], launch };
	});
	const monos = on0.filter(o => o.type === 'monolithTwoWay').map(o => ({ sub: o.subtype, v: cellsOf(o, visitableCells)[0] }));
	const towns = on0.filter(o => o.type === 'randomTown' && o.options && o.options.owner);
	const gateOf = t => cellsOf(t, visitableCells).map(c => c + W).filter(c => c < W * H && !hard[c]);
	const reachFrom = t => {
		const land = new Uint8Array(W * H), sea = new Uint8Array(W * H);
		const stack = gateOf(t);
		for (const c of stack) land[c] = 1;
		const sail = w => {
			if (sea[w]) return;
			const q = [w];
			sea[w] = 1;
			for (let i = 0; i < q.length; i++)
				for (const n of ring(q[i])) {
					if (wet[n] && !hard[n] && !sea[n]) { sea[n] = 1; q.push(n); }
					else if (!wet[n] && !hard[n] && !land[n]) { land[n] = 1; stack.push(n); }
				}
		};
		const used = new Set();
		for (let grew = true; grew;) {
			grew = false;
			while (stack.length) {
				const c = stack.pop();
				for (const n of ring(c)) if (!wet[n] && !hard[n] && !land[n]) { land[n] = 1; stack.push(n); }
			}
			boats.forEach((b, i) => { if (!used.has('b' + i) && ring(b).some(c => land[c])) { used.add('b' + i); sail(b); grew = true; } });
			yards.forEach((y, i) => { if (!used.has('y' + i) && y.launch !== undefined && y.from.some(c => land[c])) { used.add('y' + i); sail(y.launch); grew = true; } });
			for (const m of monos)
				if (!used.has('m' + m.sub) && ring(m.v).some(c => land[c])) {
					used.add('m' + m.sub);
					for (const e of monos) if (e.sub === m.sub)
						for (const n of ring(e.v)) if (!wet[n] && !hard[n] && !land[n]) { land[n] = 1; stack.push(n); }
					grew = true;
				}
		}
		return land;
	};
	return { towns, gateOf, reachFrom };
}

test('Islands 108x108, 4 players, seed 1: every player walks to a harbour and sails to the rest', { timeout: 240000 }, () => {
	const { spawnSync } = require('child_process');
	const fs = require('fs');
	const out = path.join(testTmp(), 'vmapgen_islands_108.vmap');
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'),
		'--w', '108', '--h', '108', '--players', '4', '--seed', '1', '--out', out,
		'--bio.waterCoverage', '0.35', '--bio.waterShape', String(islandIds[0])],
	{ encoding: 'utf8', timeout: 200000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	const { towns, gateOf, reachFrom } = sailReach(out);
	assert.strictEqual(towns.length, 4);
	for (const a of towns) {
		const land = reachFrom(a);
		for (const b of towns)
			assert.ok(gateOf(b).some(c => land[c]), `${a.options.owner} reaches ${b.options.owner}`);
	}
	fs.rmSync(out, { force: true });
});

test('Islands 72x72, 2 players, seed 7, Every zone, no portals: every player walks to a boat', { timeout: 240000 }, () => {
	const { spawnSync } = require('child_process');
	const fs = require('fs');
	const out = path.join(testTmp(), 'vmapgen_islands_boatwalk.vmap');
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'),
		'--w', '72', '--h', '72', '--players', '2', '--seed', '7', '--out', out,
		'--bio.waterCoverage', '0.3', '--bio.waterShape', String(islandIds[0]),
		'--bio.waterAccess', '3', '--bio.interconnectPortal', '0'],
	{ encoding: 'utf8', timeout: 200000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	const { readVmap } = require('../src/preview/render');
	const { objects, levels } = readVmap(out);
	const rows = levels[0].rows, H = rows.length, W = rows[0].length;
	const wet = new Uint8Array(W * H), hard = new Uint8Array(W * H);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const tt = String(rows[y][x]).slice(0, 2);
			if (tt === 'wt') wet[y * W + x] = 1;
			if (tt === 'rc') hard[y * W + x] = 1;
		}
	const on0 = objects.filter(o => (o.l || 0) === 0 && o.template && o.template.mask);
	const cellsOf = (o, f) => f(o.template, o.x, o.y).filter(([x, y]) => x >= 0 && y >= 0 && x < W && y < H).map(([x, y]) => y * W + x);
	for (const o of on0) if (!REMOVABLE_TYPES.has(o.type)) for (const c of cellsOf(o, blockingCells)) hard[c] = 1;
	const ring = c => {
		const res = [], x = c % W, y = (c / W) | 0;
		for (let dy = -1; dy <= 1; dy++)
			for (let dx = -1; dx <= 1; dx++) {
				const u = x + dx, v = y + dy;
				if ((dx || dy) && u >= 0 && v >= 0 && u < W && v < H) res.push(v * W + u);
			}
		return res;
	};
	const boats = on0.filter(o => o.type === 'boat').map(o => cellsOf(o, visitableCells)[0]);
	const towns = on0.filter(o => o.type === 'randomTown' && o.options && o.options.owner);
	assert.strictEqual(towns.length, 2);
	for (const t of towns) {
		// on foot only: no boat, no shipyard, no portal
		const seen = new Uint8Array(W * H);
		const stack = cellsOf(t, visitableCells).map(c => c + W).filter(c => c < W * H && !hard[c] && !wet[c]);
		for (const c of stack) seen[c] = 1;
		while (stack.length) {
			const c = stack.pop();
			for (const n of ring(c)) if (!seen[n] && !wet[n] && !hard[n]) { seen[n] = 1; stack.push(n); }
		}
		assert.ok(boats.some(b => ring(b).some(c => seen[c])), `${t.options.owner} walks to a boat`);
	}
	fs.rmSync(out, { force: true });
});
