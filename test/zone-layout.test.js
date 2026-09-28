/**
 * zone-layout.test.js - template zone layout (biomes.js layoutZoneSeeds and
 * its helpers, plan.js chooseTemplateLayout, generate.js's start cells).
 *
 * On 2026-09-26 our template maps fell back to portal pairs far more than the
 * engine's: 2 to 6 of Golem Foundry's 12 links on every seed, 7 of 2SM4d's 15.
 * Starts were pinned in player order onto fixed corners and free zones started
 * anywhere. Now the start cells follow the template's links, free zones start
 * from the link graph's own drawing, and the best of several layouts is kept.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { symmetricEigen, spectralCoords, fitSimilarity, wobbleWaves } = require('../src/biome/biomes');

const laplacian = (n, edges) => {
	const L = Array.from({ length: n }, () => new Array(n).fill(0));
	for (const [i, j] of edges) { L[i][j] -= 1; L[j][i] -= 1; L[i][i] += 1; L[j][j] += 1; }
	return L;
};

test('the eigen solver finds a path\'s and a ring\'s known spectra', () => {
	const near = (got, want) => got.every((v, i) => Math.abs(v - want[i]) < 1e-9);
	assert.ok(near(symmetricEigen(laplacian(3, [[0, 1], [1, 2]])).values, [0, 1, 3]));
	assert.ok(near(symmetricEigen(laplacian(4, [[0, 1], [1, 2], [2, 3], [3, 0]])).values, [0, 2, 2, 4]));
	const A = [[4, 1, 2], [1, 3, 0], [2, 0, 5]];
	const { values, vectors } = symmetricEigen(A);
	for (let k = 0; k < 3; k++) {
		const v = vectors[k];
		const Av = A.map(r => r.reduce((s, x, i) => s + x * v[i], 0));
		assert.ok(Av.every((x, i) => Math.abs(x - values[k] * v[i]) < 1e-9), `eigenpair ${k}`);
	}
});

test('a 3x3 grid\'s spectral drawing keeps grid neighbours closest', () => {
	const adj = Array.from({ length: 9 }, () => []);
	for (let r = 0; r < 3; r++)
		for (let c = 0; c < 3; c++) {
			const i = r * 3 + c;
			if (c < 2) { adj[i].push(i + 1); adj[i + 1].push(i); }
			if (r < 2) { adj[i].push(i + 3); adj[i + 3].push(i); }
		}
	const sc = spectralCoords(adj);
	const d = (i, j) => Math.hypot(sc[i].x - sc[j].x, sc[i].y - sc[j].y);
	// the centre sits nearer its four neighbours than any corner does
	for (const nb of [1, 3, 5, 7]) for (const corner of [0, 2, 6, 8]) assert.ok(d(4, nb) < d(4, corner));
	assert.strictEqual(spectralCoords([[1], [0], []]), null, 'a graph in pieces has no drawing');
});

test('a similarity fit carries two points exactly and a mirrored set too', () => {
	const f = fitSimilarity([{ x: 0, y: 0 }, { x: 1, y: 0 }], [{ x: 10, y: 10 }, { x: 10, y: 20 }]);
	const q = f({ x: 0.5, y: 0 });
	assert.ok(Math.abs(q.x - 10) < 1e-9 && Math.abs(q.y - 15) < 1e-9);
	const from = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }];
	const to = from.map(p => ({ x: 5 - 2 * p.x, y: 7 + 2 * p.y }));   // mirrored and doubled
	const g = fitSimilarity(from, to);
	for (let i = 0; i < 3; i++) {
		const r = g(from[i]);
		assert.ok(Math.hypot(r.x - to[i].x, r.y - to[i].y) < 1e-9, `point ${i}`);
	}
});

test('2SM4d for two at 72x72 realizes every link as land', { timeout: 300000 }, () => {
	// its two starts sit side by side in the middle, which no corner gives
	const { spawnSync } = require('child_process');
	const { genEnv, testTmp } = require('./_vcmi');
	for (const seed of ['1', '2']) {
		const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'),
			'--w', '72', '--h', '72', '--players', '2', '--seed', seed, '--declaremods', '0',
			'--template', '2SM4d', '--out', path.join(testTmp(), '2sm4d_plan.vmap')],
		{ encoding: 'utf8', timeout: 240000, cwd: path.join(__dirname, '..'), windowsHide: true,
			env: genEnv({ VMAPGEN_PLAN_ONLY: '1' }) });
		assert.strictEqual(r.status, 0, r.stderr.slice(-600));
		const plan = JSON.parse(r.stdout.split('\n').find(l => l.startsWith('{"plan"'))).plan[0];
		assert.strictEqual(plan.links, 15);
		assert.strictEqual(plan.unfulfilled, 0, `seed ${seed}: ${plan.unfulfilled} links fell back to portals`);
	}
});

test('link types follow the engine: forcePortal is a portal, fictive and repulsive carry nothing', { timeout: 300000 }, () => {
	const fs = require('fs');
	const { spawnSync } = require('child_process');
	const { genEnv, testTmp } = require('./_vcmi');
	const tplFile = path.join(testTmp(), 'link_types_template.json');
	const zone = (type, owner) => ({ type, size: 10, monsters: 'normal', ...(owner ? { owner, playerTowns: { castles: 1 } } : {}),
		treasure: [{ min: 500, max: 3000, density: 8 }] });
	fs.writeFileSync(tplFile, JSON.stringify({ 'Link Types': { minSize: 's', maxSize: 'l', players: '2',
		zones: { 1: zone('playerStart', 1), 2: zone('playerStart', 2), 3: zone('treasure'), 4: zone('treasure') },
		connections: [{ a: '1', b: '3', guard: 3000 }, { a: '2', b: '3', guard: 3000 }, { a: '1', b: '4', guard: 3000 },
			{ a: '2', b: '4', type: 'fictive' }, { a: '3', b: '4', type: 'repulsive' },
			{ a: '1', b: '2', type: 'forcePortal', guard: 12000 }] } }));
	const out = path.join(testTmp(), 'link_types.vmap');
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'),
		'--w', '36', '--h', '36', '--players', '2', '--seed', '5', '--declaremods', '0',
		'--template', tplFile, '--out', out],
	{ encoding: 'utf8', timeout: 240000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	assert.match(r.stderr, /template link 1-2 is a portal pair by the template/);
	assert.doesNotMatch(r.stderr, /template link (2-4|3-4)/, 'fictive and repulsive links get no passage');
	assert.match(r.stderr, /of 3 template links without a shared border/, 'three land links counted');
	// each end of the portal pair is guarded with the link's strength, as the engine does
	const objs = require('../src/preview/render').readVmap(out).objects;
	const monos = objs.filter(o => o.type === 'monolithTwoWay');
	assert.strictEqual(monos.length, 2);
	for (const m of monos)
		assert.ok(objs.some(o => /^randomMonster|^monster$/.test(o.type) && Math.abs(o.x - m.x) <= 2 && Math.abs(o.y - m.y) <= 2),
			`a guard beside the monolith at (${m.x},${m.y})`);
	fs.rmSync(out, { force: true });
	fs.rmSync(tplFile, { force: true });
});

test('a start zone keeps its share beside a big centre (Jebus Cross 108 for two)', { timeout: 300000 }, () => {
	// starts of size 30 around a size-40 centre; seeded on the town's corner
	// cell, a start kept 300-1900 of 11664 cells and the centre took 7000
	const { spawnSync } = require('child_process');
	const { genEnv, testTmp } = require('./_vcmi');
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'),
		'--w', '108', '--h', '108', '--players', '2', '--seed', '1001', '--declaremods', '0',
		'--template', 'Jebus Cross', '--out', path.join(testTmp(), 'jebus_plan.vmap')],
	{ encoding: 'utf8', timeout: 240000, cwd: path.join(__dirname, '..'), windowsHide: true,
		env: genEnv({ VMAPGEN_PLAN_ONLY: '1' }) });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	const plan = JSON.parse(r.stdout.split('\n').find(l => l.startsWith('{"plan"'))).plan[0];
	assert.strictEqual(plan.unfulfilled, 0);
	plan.types.forEach((t, i) => {
		if (t === 'playerStart') assert.ok(plan.zoneLand[i] >= 1000, `start zone ${i + 1}: ${plan.zoneLand[i]} cells`);
	});
	assert.ok(plan.zoneLand[4] < 0.5 * plan.landCells, `the centre holds ${plan.zoneLand[4]} of ${plan.landCells}`);
});

test('border wobble bends at the zones\' own scale: nothing changes up to 108x108, a giant free layout keeps its bends', () => {
	// the old waves, (W + H) / 10 and / 28, at every size a free layout runs at
	// the default Biome size (400 cells a zone) up to 108x108
	for (const [n, zones] of [[36, 4], [72, 13], [108, 29]])
		assert.deepStrictEqual(wobbleWaves(n, n, zones), { coarse: Math.max(4, Math.round(n / 5)), fine: Math.max(3, Math.round(n / 14)) });
	// 252x252 free: 159 zones about 20 cells apart keep waves of 22 and 8, where
	// the map's own size gave 50 and 18 (a border saw half a wave: facets)
	assert.deepStrictEqual(wobbleWaves(252, 252, 159), { coarse: 22, fine: 8 });
	// a template's few big zones on the same map keep the map-sized waves
	assert.deepStrictEqual(wobbleWaves(252, 252, 5), { coarse: 50, fine: 18 });
});

test('free layout starts share half the land, each within a fifth of the others', () => {
	// K, 2026-09-27: one start's biome was "about 3 times bigger than the
	// castle"; the smallest start ran a twelfth of the largest on bad seeds
	const { partitionBiomes, BIOME_DEFAULTS, MAX_START_SHARE } = require('../src/biome/biomes');
	const { xorshift } = require('../src/wfc/solver');
	for (const [W, n] of [[72, 4], [108, 4], [144, 8]]) {
		const corners = [[4, 4], [W - 5, W - 5], [4, W - 5], [W - 5, 4], [4, W >> 1], [W - 5, W >> 1], [W >> 1, 4], [W >> 1, W - 5]];
		const starts = corners.slice(0, n).map(([x, y]) => ({ x, y }));
		const startCells = Math.min(BIOME_DEFAULTS.startZoneShare / n, MAX_START_SHARE) * W * W;
		const count = n + Math.round((W * W - n * startCells) / BIOME_DEFAULTS.zoneCells);
		for (const seed of [1, 2, 3]) {
			const { zone, seeds } = partitionBiomes(W, W, starts, count, xorshift(seed * 7919), {}, null, startCells);
			const area = new Array(seeds.length).fill(0);
			for (const z of zone) area[z]++;
			const own = area.slice(0, n);
			const share = own.reduce((a, b) => a + b, 0) / (W * W);
			assert.ok(share > 0.4 && share < 0.56, `${W}x${W} ${n}p seed ${seed}: starts hold ${share.toFixed(2)} of the land`);
			assert.ok(Math.min(...own) / Math.max(...own) > 0.8,
				`${W}x${W} ${n}p seed ${seed}: start areas ${own.join(', ')}`);
		}
	}
});
