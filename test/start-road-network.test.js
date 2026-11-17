/**
 * start-road-network.test.js - every start town lies on the one road network (K, 2026-11-16, S277, his 108x108 four players seed 125077493:
 * "path out routing completely failed, and that player has an extremely unfair disadvantage"; green's town sat on an 11-tile piece of road of its
 * own, the other three starts on one of 698 tiles, and the generator wrote the map).
 *
 * Cause: guardZoneJoins closed a zone step with scenery on a ROAD tile and cut the road (plan.js; a guard stands on the road tile now).
 * Backstop: startroads.js joins any start on a piece of its own, and a start with a walk to the others and no road is an error.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const sight = require('../tools/mapsight/lib/sight');
const { joinStartRoads, roadPieces } = require('../src/biome/startroads');

// road pieces of a map and the pieces each start town touches (the lead's reading, .tmp\lead\kmap1116\pieces.js: a road tile within two of the town)
function startPieces(file) {
	const M = sight.load(file), { W, H, idx } = M;
	const R = new Set();
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (M.road[idx(0, x, y)]) R.add(y * W + x);
	const P = roadPieces(R, W, H);
	return sight.starts(M).filter(s => (s.l || 0) === 0).map(s => {
		const hit = new Set();
		for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const c = (s.at[1] + dy) * W + s.at[0] + dx; if (R.has(c)) hit.add(P.of.get(c)); }
		return { colour: s.colour, pieces: [...hit] };
	});
}

const gen = (seed, extra = []) => {
	const out = path.join(testTmp(), `vmapgen_startroad_${seed}.vmap`);
	const a = [path.join(__dirname, '../src/main/generate-cli.js'), '--out', out, '--w', '108', '--h', '108', '--players', '4', '--humans', '1',
		'--declaremods', '0', '--seed', String(seed), ...extra];
	const r = spawnSync(process.execPath, a, { encoding: 'utf8', timeout: 380000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, (r.stderr || '').slice(-800));
	return out;
};

test('a start on a road piece of its own is joined to the network (a plan with two pieces)', () => {
	const W = 40, H = 20;
	const R = new Set();
	for (let x = 2; x <= 8; x++) R.add(5 * W + x);        // piece of the first town
	for (let x = 20; x <= 30; x++) R.add(5 * W + x);      // piece of the second town
	const town = (x, y, owner) => ({ type: 'town', l: 0, x, y, template: { mask: ['x'] }, options: { owner } });
	const plan = { roadCells: R, objects: [town(3, 5, 'red'), town(28, 5, 'blue')], p: {}, openMask: null };
	const d = { blockingCells: (t, x, y) => [[x, y]], visitableCells: (t, x, y) => [[x, y]], isDecor: () => false, clearScenery: () => 0, blocked: new Uint8Array(W * H) };
	const r = joinStartRoads(plan, W, H, 0, d);
	assert.strictEqual(r.joined, 1);
	assert.deepStrictEqual(r.left, []);
	assert.strictEqual(roadPieces(plan.roadCells, W, H).list.length, 1, 'one piece after the join');
});

test('a start walled off from the network by an object no road may cross is reported, not joined', () => {
	const W = 40, H = 10;
	const R = new Set();
	for (let x = 2; x <= 8; x++) R.add(5 * W + x);
	for (let x = 30; x <= 36; x++) R.add(5 * W + x);
	const town = (x, y, owner) => ({ type: 'town', l: 0, x, y, template: { mask: ['x'] }, options: { owner } });
	const wall = [];
	for (let y = 0; y < H; y++) wall.push({ type: 'mine', l: 0, x: 15, y, template: { mask: ['x'] }, options: {} });
	const plan = { roadCells: R, objects: [town(3, 5, 'red'), town(33, 5, 'blue'), ...wall], p: {}, openMask: null };
	const d = { blockingCells: (t, x, y) => [[x, y]], visitableCells: (t, x, y) => (t.mask && /town/.test(String(t.name || '')) ? [[x, y]] : []), isDecor: () => false, clearScenery: () => 0, blocked: new Uint8Array(W * H) };
	const r = joinStartRoads(plan, W, H, 0, d);
	assert.strictEqual(r.joined, 0);
	assert.deepStrictEqual(r.noWalk.concat(r.left).length, 1, 'the cut-off start is named');
});

for (const seed of [125077493, 7]) {
	test(`108x108 four players free layout, seed ${seed}: every start town touches one and the same road piece`, { timeout: 400000 }, () => {
		const out = gen(seed);
		const st = startPieces(out);
		for (const f of [out, out + '.zones.json', out.replace(/\.vmap$/, '.zonedump.json'), out + '.log']) fs.rmSync(f, { force: true });
		assert.ok(st.length >= 4, 'the starts are read: ' + JSON.stringify(st));
		const first = new Set(st[0].pieces);
		assert.ok(st.every(s => s.pieces.some(p => first.has(p))), 'one network: ' + JSON.stringify(st));
	});
}
