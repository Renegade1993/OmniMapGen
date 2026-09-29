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
 *   - a template's crossroads on Mediterranean water is an island of its own while
 *     boats can sail there (Harbours above None) and bridged when they cannot; its
 *     zone keeps the shore ring; harbours stand on ground the players walk to, never
 *     on the island, and every player's hero gets there by boat (K, 2026-09-29: "I
 *     NEVER ASKED FOR A ROAD PATH OVER THE WATER")
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

// K, 2026-09-29, Jebus Cross with Mediterranean water: the template's crossroads is kept dry in the
// middle of the sea, and the "one land mass" rule bridged it to the shore with a land strip.
// "I NEVER ASKED FOR A ROAD PATH OVER THE WATER. IT'S MEDITERANEAN, AND THEY CAN GET THERE BY BOAT."
// With boats to sail there (Harbours above None) the crossroads is an island of its own.
const hubStarts = (W, H) => [[4, 4], [W - 5, H - 5], [4, H - 5], [W - 5, 4]].map(([x, y]) => ({ x, y }))
	.concat([{ x: W >> 1, y: H >> 1, hub: true }]);
const MED = WATER_SHAPES.findIndex(s => s.id === 'mediterranean');

// each dry cell's 4-connected piece (1-based, 0 on water) and how many pieces there are
function pieces4(water, W, H) {
	const label = new Int32Array(W * H);
	let n = 0;
	for (let c0 = 0; c0 < W * H; c0++) {
		if (water[c0] || label[c0]) continue;
		n++;
		const q = [c0];
		label[c0] = n;
		for (let h = 0; h < q.length; h++) {
			const c = q[h], x = c % W, y = (c / W) | 0;
			for (const [u, v] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]])
				if (u >= 0 && v >= 0 && u < W && v < H && !water[v * W + u] && !label[v * W + u]) { label[v * W + u] = n; q.push(v * W + u); }
		}
	}
	return { n, label };
}

test('the crossroads island is left apart while boats can sail there, and bridged when they cannot', () => {
	const W = 72, H = 72, hub = (H >> 1) * W + (W >> 1);
	for (const seed of [1, 2, 3]) {
		const at = extra => buildWaterPlan(W, H, { waterCoverage: 0.3, waterShape: MED, ...extra }, hubStarts(W, H), seed);
		const apart = at({ waterAccess: 2 });
		assert.deepStrictEqual(apart.hubCells, [hub], `seed ${seed}: the crossroads is left apart`);
		const { n, label } = pieces4(apart.mask, W, H);
		assert.strictEqual(n, 2, `seed ${seed}: the mainland and the island, nothing else`);
		assert.notStrictEqual(label[hub], label[4 * W + 4], `seed ${seed}: the island is a piece of its own`);
		// with no boats (None), or with the generator's own fallback, it is bridged as before
		for (const extra of [{ waterAccess: 0 }, { waterAccess: 2, waterHubBoats: 0 }]) {
			const bridged = at(extra);
			assert.deepStrictEqual(bridged.hubCells, [], `seed ${seed} ${JSON.stringify(extra)}: nothing left apart`);
			assert.strictEqual(pieces4(bridged.mask, W, H).n, 1, `seed ${seed} ${JSON.stringify(extra)}: one land mass`);
		}
	}
});

test('the crossroads zone keeps the shore ring round the sea with its island', () => {
	const W = 72, H = 72, N = W * H;
	const plan = buildWaterPlan(W, H, { waterCoverage: 0.3, waterShape: MED, waterAccess: 2 }, hubStarts(W, H), 1);
	const seeds = hubStarts(W, H).map(({ x, y }) => ({ x, y }));   // four corners, then the crossroads
	const raw = new Int16Array(N);
	for (let c = 0; c < N; c++) {
		let best = 0, bd = Infinity;
		seeds.forEach((s, i) => {
			// the crossroads' zone is the template's biggest, so its cell is drawn wider
			const d = Math.hypot(s.x - c % W, s.y - ((c / W) | 0)) / (i === 4 ? 1.5 : 1);
			if (d < bd) { bd = d; best = i; }
		});
		raw[c] = best;
	}
	const land = (zone, i) => { let n = 0; for (let c = 0; c < N; c++) if (!plan.mask[c] && zone[c] === i) n++; return n; };
	const wanted = land(raw, 4);
	const kept = raw.slice(), lost = raw.slice();
	settleZonesOnLand(kept, seeds, W, H, plan.mask, plan.hubCells);
	settleZonesOnLand(lost, seeds, W, H, plan.mask);
	// its seed stands on the island, so without the island held apart the whole ring goes to the
	// players' zones and the crossroads is a 15 by 15 square no template link reaches
	assert.ok(land(kept, 4) >= 0.9 * wanted, `held apart: ${land(kept, 4)} of ${wanted} cells kept`);
	assert.ok(land(lost, 4) <= 250, `not held apart: only the island is left, ${land(lost, 4)} cells`);
	// and it borders every player's zone
	const touches = new Set();
	for (let c = 0; c < N; c++) {
		if (plan.mask[c] || kept[c] !== 4) continue;
		for (const d of [c + 1, c + W]) if (d < N && !plan.mask[d] && kept[d] !== 4) touches.add(kept[d]);
		for (const d of [c - 1, c - W]) if (d >= 0 && !plan.mask[d] && kept[d] !== 4) touches.add(kept[d]);
	}
	assert.deepStrictEqual([...touches].sort(), [0, 1, 2, 3], 'the ring borders all four player zones');
});

// a lake with a dry island at its middle, zone 1 (the crossroads) holding both; the start in zone 0
function hubWorld(blockShores = false) {
	const W = 64, H = 48;
	const water = new Uint8Array(W * H), zone = new Int16Array(W * H), blocked = new Uint8Array(W * H);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			zone[y * W + x] = x < 16 ? 0 : x >= 48 ? 2 : 1;
			if ((x - 32) ** 2 / 196 + (y - 24) ** 2 / 100 <= 1 && !(Math.abs(x - 32) <= 4 && Math.abs(y - 24) <= 4))
				water[y * W + x] = 1;
		}
	for (let c = 0; c < W * H; c++) if (water[c]) blocked[c] |= OCCUPIED;
	const isle = c => Math.abs(c % W - 32) <= 4 && Math.abs(((c / W) | 0) - 24) <= 4;
	if (blockShores)
		for (let c = 0; c < W * H; c++) {
			if (water[c] || isle(c)) continue;
			const x = c % W, y = (c / W) | 0;
			for (let dy = -4; dy <= 4; dy++)
				for (let dx = -4; dx <= 4; dx++) {
					const u = x + dx, v = y + dy;
					if (u >= 0 && v >= 0 && u < W && v < H && water[v * W + u]) blocked[c] |= OCCUPIED;
				}
		}
	return { W, H, water, zone, blocked, isle, hub: 24 * W + 32 };
}

test('harbours stand where the players walk to, never on the crossroads island, and a boat sails to it', () => {
	const { W, H, water, zone, blocked, isle, hub } = hubWorld();
	const objects = [];
	const harbours = placeHarbours({ W, H, l: 0, water, zone, blocked, rng: xorshift(4),
		p: { waterAccess: 3 }, objects, towns: [{ x: 6, y: 24, l: 0 }], playerStarts: [{ x: 6, y: 24 }],
		objectEntry: entry, islands: true, hubCells: [hub] });
	assert.ok(harbours.length >= 1, 'a harbour');
	for (const h of harbours) assert.ok(!h.boarding.some(isle), `${h.kind} boards from the mainland`);
	for (const o of objects.filter(o => o.type === 'shipyard'))
		for (const [x, y] of blockingCells(o.template, o.x, o.y)) assert.ok(!isle(y * W + x), 'no shipyard on the island');
	// a boat from the mainland harbour lands on the island's own shore
	const links = sailLinksFor(harbours, water, W, H);
	assert.ok(links.some(([, shore]) => shore.some(isle)), 'the island is a landing for a boat');
});

test('an island no boat can sail from is refused, so the generator bridges it instead', () => {
	const { W, H, water, zone, blocked, hub } = hubWorld(true);
	assert.throws(() => placeHarbours({ W, H, l: 0, water, zone, blocked, rng: xorshift(4),
		p: { waterAccess: 2 }, objects: [], towns: [], playerStarts: [{ x: 6, y: 24 }],
		objectEntry: entry, hubCells: [hub] }), /crossroads island has no shore/);
});

for (const [access, apart] of [[2, true], [0, false]])
test(`Jebus Cross with Mediterranean water at Harbours ${access}: the crossroads ${apart ? 'is an island every player sails to' : 'is bridged to the land'}`,
{ timeout: 240000 }, () => {
	const { spawnSync } = require('child_process');
	const fs = require('fs');
	const out = path.join(testTmp(), `vmapgen_hubisland_${access}.vmap`);
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'),
		'--template', 'Jebus Cross', '--w', '72', '--h', '72', '--players', '4', '--seed', '3', '--out', out,
		'--bio.waterShape', String(MED), '--bio.waterCoverage', '0.2', '--bio.waterAccess', String(access)],
	{ encoding: 'utf8', timeout: 200000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	const { readVmap } = require('../src/preview/render');
	const { objects, levels } = readVmap(out);
	const rows = levels[0].rows, H = rows.length, W = rows[0].length;
	const wet = new Uint8Array(W * H);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) if (String(rows[y][x]).startsWith('wt')) wet[y * W + x] = 1;
	// the ground as a hero walks it, 8-way, on the terrain alone
	const piece = new Int32Array(W * H).fill(-1), size = [];
	for (let c0 = 0; c0 < W * H; c0++) {
		if (wet[c0] || piece[c0] >= 0) continue;
		const q = [c0];
		piece[c0] = size.length;
		for (let h = 0; h < q.length; h++) {
			const c = q[h], x = c % W, y = (c / W) | 0;
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					const u = x + dx, v = y + dy;
					if (u >= 0 && v >= 0 && u < W && v < H && !wet[v * W + u] && piece[v * W + u] < 0) { piece[v * W + u] = size.length; q.push(v * W + u); }
				}
		}
		size.push(q.length);
	}
	const centre = (H >> 1) * W + (W >> 1);
	if (!apart) {
		assert.strictEqual(size.length, 1, 'one land mass, the crossroads bridged in');
		assert.doesNotMatch(r.stderr, /left to boats/);
		fs.rmSync(out, { force: true });
		return;
	}
	assert.match(r.stderr, /the crossroads island is left to boats/);
	assert.strictEqual(size.length, 2, 'the mainland and the crossroads island');
	const isle = piece[centre];
	assert.ok(size[isle] >= 150 && size[isle] <= 400, `the island is ${size[isle]} cells`);
	// every player's hero gets there: walking, boarding a boat, buying one at a shipyard
	const { towns, reachFrom } = sailReach(out);
	assert.strictEqual(towns.length, 4);
	for (const t of towns) {
		const land = reachFrom(t);
		let onIsle = 0;
		for (let c = 0; c < W * H; c++) if (piece[c] === isle && land[c]) onIsle++;
		assert.ok(onIsle >= 0.5 * size[isle], `${t.options.owner} reaches the island (${onIsle} of ${size[isle]} cells)`);
	}
	// what stands on it is kept, and no harbour is on it
	assert.ok(objects.filter(o => (o.l || 0) === 0 && piece[o.y * W + o.x] === isle).length >= 5, 'the island has its treasure');
	const harbours = objects.filter(o => o.type === 'shipyard' || o.type === 'boat');
	assert.ok(harbours.length >= 2, 'harbours were placed');
	for (const o of harbours.filter(o => o.type === 'shipyard'))
		assert.notStrictEqual(piece[o.y * W + o.x], isle, 'no shipyard on the island');
	fs.rmSync(out, { force: true });
});
