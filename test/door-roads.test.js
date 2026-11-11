/**
 * door-roads.test.js - a link doorway no road crossed gets its road (K, 2026-11-11, row S118: "Green didn't get a middle road").
 *
 * The roads are planned before the zone beyond a link's door is final. On K's Jebus Cross 108x108 four-player seed 1219140137 the door (36,92) opened on a lobe of the
 * middle zone that the wall band cut off at road time and that the later scenery passes leave walkable only by a one-tile diagonal arm; the door's road stub was taken back
 * as a road ending at nothing, and Green's road stayed in its own zone. roadplan.js joinDoorRoads joins such a doorway to the roads on both sides, last, on the final scenery.
 *  - unit: a doorway whose two zones are joined only by a diagonal arm gets a road across it; a doorway with no way at all is counted as left and logged;
 *  - K's seed: every pair of zones the template links has a road across its border, and the road net is one piece.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const { joinDoorRoads } = require('../src/biome/roadplan');
const sight = require('../tools/mapsight/lib/sight');

const W = 20, H = 8;
const at = (x, y) => y * W + x;

// two zones side by side (zone 0 left of x = 10, zone 1 right); the doorway is the pair (9,3) and (10,3); one road tile on each side
const level = (wall) => {
	const zone = new Int32Array(W * H);
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) zone[at(x, y)] = x < 10 ? 0 : 1;
	const blocked = new Uint8Array(W * H);
	for (const [x, y] of wall) blocked[at(x, y)] = 1;
	return { zone, blocked };
};

test('a doorway with a road on neither side is joined to the roads of both zones, through a diagonal arm', () => {
	// zone 1 beyond the door: open only along a diagonal staircase from (10,3) up to (15,0); the rest of the zone is wall
	const wall = [];
	for (let y = 0; y < H; y++) for (let x = 10; x < W; x++) if (!(x - 10 === 3 - y && y <= 3) && !(x === 10 && y === 3)) wall.push([x, y]);
	const { zone, blocked } = level(wall);
	const roads = new Set([at(2, 3), at(3, 3), at(13, 0)]);
	const r = joinDoorRoads([{ z: 1, cells: [at(9, 3), at(10, 3)] }], roads, zone, W, H, blocked, 0, null);
	assert.strictEqual(r.doors, 1);
	assert.strictEqual(r.joined, 1, 'the door is joined');
	assert.strictEqual(r.left, 0);
	assert.ok(roads.has(at(9, 3)) && roads.has(at(10, 3)), 'the road crosses the doorway');
});

test('a doorway no way reaches is counted as left and named, not hidden', () => {
	const wall = [];
	for (let y = 0; y < H; y++) for (let x = 11; x < W; x++) wall.push([x, y]);   // zone 1 beyond the door is shut except (10, y), no road in it
	const { zone, blocked } = level(wall);
	const roads = new Set([at(2, 3), at(3, 3)]);
	const r = joinDoorRoads([{ z: 1, cells: [at(9, 3), at(10, 3)] }], roads, zone, W, H, blocked, 0, null);
	assert.strictEqual(r.doors, 1);
	assert.strictEqual(r.joined, 0);
	assert.strictEqual(r.left, 1);
	assert.deepStrictEqual(r.leftAt, ['9,3 10,3']);
});

test('a doorway that already has a road is left alone', () => {
	const { zone, blocked } = level([]);
	const roads = new Set([at(9, 3), at(10, 3), at(2, 3), at(15, 3)]);
	const r = joinDoorRoads([{ z: 1, cells: [at(9, 3), at(10, 3)] }], roads, zone, W, H, blocked, 0, null);
	assert.strictEqual(r.doors, 0);
	assert.strictEqual(r.added, 0);
});

// K's options line of the map (his paths left out); the seed reproduces the lobe
const K = { w: '108', h: '108', players: '4', humans: '4', seed: '1219140137', factions: 'core:inferno,core:castle,core:tower,core:dungeon', 'bio.compOnly': '0',
	teams: 'red,tan;blue,green', humancolors: 'red,tan', heroes: 'red=core:zydar,tan=core:solmyr', declaremods: '0', template: 'Jebus Cross', preset: 'nostalgia',
	'bio.artifactDensity': '0.006', 'bio.artifactRichness': '0.5', 'bio.biomeWobble': '0.6', 'bio.bonusDensity': '1', 'bio.borderSolidity': '1', 'bio.chokeGuardRatio': '0.7', 'bio.decorDensity': '1',
	'bio.dragonIslandLayout': '0', 'bio.dwellingDensity': '1', 'bio.guardBottlenecks': '1', 'bio.guardDensity': '1', 'bio.guardDistance': '0', 'bio.guardDwellings': '1', 'bio.guardGradient': '0',
	'bio.guardMines': '1', 'bio.guardPortals': '2', 'bio.guardShare': '1', 'bio.guardTreasure': '1', 'bio.highLootRatio': '0.25', 'bio.interconnectPortal': '0.2', 'bio.interconnectivity': '0.6',
	'bio.islandShape': '1', 'bio.layoutFamily': '7', 'bio.lootGuardWeight': '1', 'bio.lowLootRatio': '0.25', 'bio.mineDensity': '1', 'bio.mineGuardWeight': '1', 'bio.monsterStrength': '0',
	'bio.objectGuardShare': '0.75', 'bio.openPathNoRoad': '0.55', 'bio.openPathRoad': '0.26', 'bio.pickupDensity': '1', 'bio.resourceDensity': '1', 'bio.richPlacement': '3', 'bio.riverAmount': '1',
	rivers: '1', 'bio.roadCobblestone': '1', 'bio.roadDirt': '1', 'bio.roadGravel': '1', 'bio.roadNetwork': '1', 'bio.roadType': '2', 'bio.stackScale': '1', 'bio.startZoneShare': '0.5',
	'bio.starterMines': '1', 'bio.subterraneanGateRatio': '1', 'bio.subterraneanNarrow': '0.6', 'bio.subterraneanOpen': '0.57', 'bio.teams': '1', 'bio.townRatio': '0.1', 'bio.undergroundStarts': '4',
	'bio.waterAccess': '2', 'bio.waterBuildings': '1', 'bio.waterContent': '0', 'bio.waterCoverage': '0', 'bio.waterShape': '8', 'bio.zoneCap': '300', 'bio.zoneCells': '400', 'bio.zoneSizeVariety': '0' };

test("K's seed 1219140137: Green's road crosses the link door to the middle, and the road net is one piece", { timeout: 290000 }, () => {
	const out = path.join(testTmp(), 'vmapgen_door_road.vmap');
	const args = [path.join(__dirname, '../src/main/generate-cli.js'), '--out', out];
	for (const [k, v] of Object.entries(K)) args.push('--' + k, v);
	const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 260000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	const m = /link doorways with no road across them: (\d+), joined (\d+).*?, left (\d+)/.exec(r.stderr);
	assert.ok(m, 'the pass logs its doorway counts every time it has a doorway to join');
	assert.strictEqual(Number(m[3]), 0, 'no doorway is left without a road');
	const M = sight.load(out);
	const { W: MW, H: MH, idx, inb, road } = M;
	const N8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
	const seen = new Uint8Array(MW * MH);
	let pieces = 0;
	for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
		const s = idx(0, x, y);
		if (!road[s] || seen[y * MW + x]) continue;
		pieces++;
		const q = [[x, y]]; seen[y * MW + x] = 1;
		while (q.length) {
			const [cx, cy] = q.pop();
			for (const [dx, dy] of N8) { const X = cx + dx, Y = cy + dy; if (inb(X, Y) && road[idx(0, X, Y)] && !seen[Y * MW + X]) { seen[Y * MW + X] = 1; q.push([X, Y]); } }
		}
	}
	assert.strictEqual(pieces, 1, `the road net is one piece (was 2: Green's zone alone), got ${pieces}`);
});
