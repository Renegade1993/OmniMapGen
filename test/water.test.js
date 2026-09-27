/**
 * water.test.js
 *
 * Pins surface water (src/biome/water.js, queue item 25d) and the terrain
 * view flips it exposed (src/exporter/terrainView.js):
 *   - no water at coverage 0, so a dry map is untouched
 *   - the coverage asked for is the coverage delivered
 *   - the land stays in one piece and every start stands on dry ground;
 *     on the island layouts every start has an island of its own instead
 *   - every shore tile has a sprite in the engine's own pattern table
 *   - the pattern table's four flips are the four orientations
 *   - zones partitioned over the land keep each zone in one piece
 *   - smoothing draws a shore corner where two land terrains meet the water
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { genEnv, useTestRoots, testTmp } = require('./_vcmi');
const { buildWaterPlan, settleZonesOnLand, WATER_SHAPES, START_CLEAR } = require('../src/biome/water');
const { buildPatterns, assignTerrainViews, smoothForPatterns } = require('../src/exporter/terrainView');
const { partitionBiomes } = require('../src/biome/biomes');
const { xorshift } = require('../src/wfc/solver');

const patterns = buildPatterns(JSON.parse(fs.readFileSync(
	path.join(__dirname, '../src/exporter/terrainViewPatterns.json'), 'utf8')
	.replace(/^\s*\/\/.*$/gm, '')));
const WATER = { id: 'core:water', group: 'water', transitionRequired: true, passable: true, isDirt: false, isSand: false };
const GRASS = { id: 'core:grass', group: 'normal', transitionRequired: false, passable: true, isDirt: false, isSand: false };
const DIRT = { id: 'core:dirt', group: 'dirt', transitionRequired: false, passable: true, isDirt: true, isSand: false };
const SNOW = { id: 'core:snow', group: 'normal', transitionRequired: false, passable: true, isDirt: false, isSand: false };
const SAND = { id: 'core:sand', group: 'sand', transitionRequired: true, passable: true, isDirt: false, isSand: true };

const unmatched = (m, W, H, land = GRASS) =>
	assignTerrainViews(W, H, (x, y) => (m[y * W + x] ? WATER : land), patterns, () => 0.5).unmatched;
const shoreCheck = (W, H) => m => {
	const out = new Uint8Array(W * H);
	for (const land of [GRASS, DIRT]) {
		const r = assignTerrainViews(W, H, (x, y) => (m[y * W + x] ? WATER : land), patterns, () => 0.5);
		for (let c = 0; c < W * H; c++) if (r.unmatchedCells[c]) out[c] = 1;
	}
	return out;
};
const corners = (W, H) => [[4, 4], [W - 5, H - 5], [4, H - 5], [W - 5, 4]].map(([x, y]) => ({ x, y }));

// each dry cell's piece of land (1-based; 0 is water) and the piece count
function landLabels(m, W, H) {
	const label = new Int32Array(W * H);
	let pieces = 0;
	for (let c0 = 0; c0 < W * H; c0++) {
		if (m[c0] || label[c0]) continue;
		pieces++;
		const q = [c0];
		label[c0] = pieces;
		for (let h = 0; h < q.length; h++) {
			const c = q[h], x = c % W, y = (c / W) | 0;
			for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const d = ny * W + nx;
				if (!m[d] && !label[d]) { label[d] = pieces; q.push(d); }
			}
		}
	}
	return { pieces, label };
}
const landPieces = (m, W, H) => landLabels(m, W, H).pieces;

test('the four pattern flips are the four orientations', () => {
	// a lake with a corner facing every way, and coasts running both diagonals
	const W = 24, H = 24;
	const shapes = {
		square: (x, y) => x >= 6 && x < 18 && y >= 6 && y < 18,
		circle: (x, y) => (x - 11.5) ** 2 + (y - 11.5) ** 2 <= 49,
		diagonalA: (x, y) => x + y >= 24,
		diagonalB: (x, y) => x - y >= 0,
	};
	for (const [name, f] of Object.entries(shapes)) {
		const m = new Uint8Array(W * H);
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) m[y * W + x] = f(x, y) ? 1 : 0;
		assert.strictEqual(unmatched(m, W, H), 0, `${name}: every tile draws`);
	}
});

test('no water at coverage 0', () => {
	assert.strictEqual(buildWaterPlan(72, 72, { waterCoverage: 0 }, corners(72, 72), 1), null);
	assert.strictEqual(buildWaterPlan(72, 72, {}, corners(72, 72), 1), null);
});

test('every shape: coverage delivered, one land mass (an island per start), dry starts, drawable shore', () => {
	for (const W of [48, 108])
		for (let sh = 0; sh < WATER_SHAPES.length; sh++)
			for (const cov of [0.15, 0.35])
				for (const seed of [1, 7]) {
					const H = W, label = `${W} ${WATER_SHAPES[sh].id} ${cov} s${seed}`;
					const plan = buildWaterPlan(W, H, { waterCoverage: cov, waterShape: sh },
						corners(W, H), seed, shoreCheck(W, H));
					// island straits are water whatever the amount, so a low amount
					// comes out higher on those layouts (never over 30% for it)
					if (WATER_SHAPES[sh].islands)
						assert.ok(plan.coverage > cov - 0.05 && plan.coverage < Math.max(cov + 0.05, 0.3),
							`${label}: coverage ${plan.coverage}`);
					else
						assert.ok(Math.abs(plan.coverage - cov) < 0.05, `${label}: coverage ${plan.coverage}`);
					if (WATER_SHAPES[sh].islands) {
						const { label: piece } = landLabels(plan.mask, W, H);
						const homes = plan.starts.map(s => piece[s.y * W + s.x]);
						assert.strictEqual(new Set(homes).size, plan.starts.length, `${label}: an island per start`);
						assert.ok(plan.islands, `${label}: the plan says islands`);
					} else
						assert.strictEqual(landPieces(plan.mask, W, H), 1, `${label}: land in one piece`);
					for (const s of plan.starts)
						for (let dy = -START_CLEAR; dy <= START_CLEAR; dy++)
							for (let dx = -START_CLEAR; dx <= START_CLEAR; dx++) {
								const x = s.x + dx, y = s.y + dy;
								if (x < 0 || y < 0 || x >= W || y >= H) continue;
								assert.strictEqual(plan.mask[y * W + x], 0, `${label}: start (${s.x},${s.y}) dry`);
							}
					assert.strictEqual(unmatched(plan.mask, W, H, GRASS) + unmatched(plan.mask, W, H, DIRT), 0,
						`${label}: shore drawable`);
				}
});

test('deterministic in its inputs', () => {
	const a = buildWaterPlan(72, 72, { waterCoverage: 0.3, waterShape: 3 }, corners(72, 72), 5);
	const b = buildWaterPlan(72, 72, { waterCoverage: 0.3, waterShape: 3 }, corners(72, 72), 5);
	assert.deepStrictEqual(Array.from(a.mask), Array.from(b.mask));
});

test('zones on land: each zone one dry piece, water labelled by the nearest land', () => {
	const W = 72, H = 72;
	for (let sh = 0; sh < WATER_SHAPES.length; sh++) {
		const plan = buildWaterPlan(W, H, { waterCoverage: 0.3, waterShape: sh }, corners(W, H), 3);
		const water = plan.mask;
		const { zone, seeds } = partitionBiomes(W, H, plan.starts, 10, xorshift(9),
			{ waterIslands: !!WATER_SHAPES[sh].islands }, water);
		for (const s of seeds) assert.strictEqual(water[s.y * W + s.x], 0, 'seeds on land');
		settleZonesOnLand(zone, seeds, W, H, water);
		for (let i = 0; i < seeds.length; i++) {
			// flood zone i's land from its seed; every dry cell of zone i is reached
			const seen = new Uint8Array(W * H);
			const q = [seeds[i].y * W + seeds[i].x];
			seen[q[0]] = 1;
			for (let h = 0; h < q.length; h++) {
				const c = q[h], x = c % W, y = (c / W) | 0;
				for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const d = ny * W + nx;
					if (!seen[d] && !water[d] && zone[d] === i) { seen[d] = 1; q.push(d); }
				}
			}
			for (let c = 0; c < W * H; c++)
				if (!water[c] && zone[c] === i) assert.ok(seen[c], `zone ${i} in one piece (shape ${sh})`);
		}
		for (let c = 0; c < W * H; c++) assert.ok(zone[c] >= 0 && zone[c] < seeds.length);
	}
});

// K's own example (2026-09-24): a Mediterranean sea does not fit Coldshadow's
// Fantasy without the underground, because the template's junction and
// treasure zones then share the surface with its 8 starts and the sea takes
// their ground. With the underground on, those zones go below and it fits.
// Runs the real CLI in layout-only mode against the installed template.
test('template check: Mediterranean on Coldshadow\'s Fantasy needs the underground', { timeout: 360000 }, t => {
	const { spawnSync } = require('child_process');
	const { listTemplates } = require('../src/rmg/template');
	useTestRoots();
	if (!listTemplates().includes('Coldshadow\'s Fantasy')) { t.skip('template not installed'); return; }
	const run = (under, strict) => spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'),
		'--template', 'Coldshadow\'s Fantasy', '--accommodate', 'size,players,humans,underground',
		'--w', '144', '--h', '144', '--players', '8', '--seed', '7',
		'--bio.waterCoverage', '0.3', '--bio.waterShape', '3', '--underground', under,
		...(strict ? ['--strict', '1'] : []),
		'--out', path.join(testTmp(), 'vmapgen_water_check.vmap')],
	{ env: genEnv({ VMAPGEN_PLAN_ONLY: '1' }), encoding: 'utf8', timeout: 200000,
		cwd: path.join(__dirname, '..'), windowsHide: true });
	// --strict 1: the old verdict, refused with what would fit
	const strict = run('0', true);
	assert.notStrictEqual(strict.status, 0, 'strict: refused without the underground');
	assert.match(strict.stderr, /Water does not fit this template: Mediterranean/);
	assert.match(strict.stderr, /turn the underground on/);
	// never refused (K, 2026-09-27): made with the most of that water that fits
	const dry = run('0', false);
	assert.strictEqual(dry.status, 0, `made without the underground: ${dry.stderr.slice(-400)}`);
	assert.match(dry.stderr, /water accommodation: Mediterranean water at 30% does not fit .*; made with/);
	const under = run('1', false);
	assert.strictEqual(under.status, 0, `accepted with the underground: ${under.stderr.slice(-400)}`);
	assert.match(under.stderr, /water fits the template/);
});

// Queue 28: where water, snow and grass meet at one corner the first two
// smoothing passes change nothing and two tiles have no sprite (a water
// neighbour reads as sand to a land tile, the other land terrain as dirt).
// The third pass tries the transition terrains and fixes it, water untouched.
test('smoothing draws a shore corner where two land terrains meet the water', () => {
	const rows = [
		'wwwwwwnnnnnn',
		'wwwwwwnnnnnn',
		'wwwwwnnnnnnn',
		'wwwwnnnnnnnn',
		'wwwwnnnnnnnn',
		'wwwnnnnnnnnn',
		'wgggnnnnnnnn',
		'ggggggnnnnng',
		'ggggggggnngg',
		'gggggggggggg',
		'gggggggggggg',
		'gggggggggggg',
	];
	const W = 12, H = 12;
	const T = { w: WATER, g: GRASS, n: SNOW, d: DIRT, s: SAND };
	const cells = rows.join('').split('');
	const water = cells.map(k => k === 'w');
	const bad = cs => assignTerrainViews(W, H, (x, y) => T[cs[y * W + x]], patterns, () => 0).unmatched;
	const old = cells.slice();
	smoothForPatterns(W, H, old, k => T[k], patterns, 6, c => water[c]);
	assert.ok(bad(old) > 0, 'the vote leaves the corner undrawn');
	const now = cells.slice();
	smoothForPatterns(W, H, now, k => T[k], patterns, 6, c => water[c], ['d', 's']);
	assert.strictEqual(bad(now), 0, 'every tile draws');
	for (let c = 0; c < W * H; c++) if (water[c]) assert.strictEqual(now[c], 'w', 'the water is structure');
	assert.ok(now.filter((k, c) => k !== cells[c]).length <= 2, 'a tile or two changes');
});
