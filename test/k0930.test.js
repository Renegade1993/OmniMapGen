/**
 * k0930.test.js
 *
 * Pins what K's playtest of 2026-09-30 found (his words in the log, SID-20261001-m5q216), each
 * measured the way tools/map_metrics.js measures it against the 71 real maps:
 *   - roads run onto the entrance tile of a town (the real maps do for 1076 of 1078) and are
 *     one tile wide (none of the real maps has a 2x2 block of road)
 *   - a building's art is the one real maps put on that ground: no lean-to or frost well on dirt
 *   - a prison keeps two tiles from every building placed before it
 *   (a town biome's dwellings and the tiers are measured by tools/map_metrics.js, dwelling_on_native, not pinned here)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const { artFor, violates } = require('../src/biome/terrainArt');
const { readVmap, parseTileCode } = require('../src/preview/render');
const { visitableCells } = require('../src/biome/content');

function generate(name, args) {
	const out = path.join(testTmp(), `vmapgen_k0930_${name}.vmap`);
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'),
		'--out', out, '--declaremods', '0', ...args],
	{ encoding: 'utf8', timeout: 200000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	const map = readVmap(out);
	fs.rmSync(out, { force: true });
	return map;
}

const isRoad = (lv, x, y) => {
	const c = lv.rows[y] && lv.rows[y][x];
	return !!c && /^p[dgc]$/.test(parseTileCode(c).road || '');
};

test('the art a building has follows the ground: the lean-to is snow only, the well has art for each ground', () => {
	const rng = () => 0.5;
	const well = { animation: 'AVXwlsn0' }, lean = { animation: 'AVMlean0' };
	assert.strictEqual(artFor('leanTo', 'leanTo', lean, 'sn', rng), lean, 'a lean-to stands on snow');
	for (const g of ['gr', 'dt', 'lv', 'sb', 'rg', 'sa', 'sw'])
		assert.strictEqual(artFor('leanTo', 'leanTo', lean, g, rng), null, `no lean-to on ${g}`);
	assert.strictEqual(artFor('magicWell', 'magicWell', well, 'sn', rng), well, 'the frost well stays on snow');
	for (const g of ['gr', 'dt', 'lv', 'sb'])
		assert.notStrictEqual(artFor('magicWell', 'magicWell', well, g, rng).animation.toLowerCase(), 'avxwlsn0', `no frost well on ${g}`);
	assert.strictEqual(artFor('magicWell', 'magicWell', well, 'zz', rng), well, 'a mod terrain keeps the art asked for');
	assert.ok(violates('magicWell', 'magicWell', 'AVXwlsn0', 'gr'));
	assert.ok(!violates('magicWell', 'magicWell', 'AVXwlsn0', 'sn'));
});

for (const seed of [5, 6])
test(`72x72 free layout seed ${seed}: roads reach the town gates, one tile wide; prisons clear of buildings`,
{ timeout: 240000 }, () => {
	const { objects, levels } = generate(`free_${seed}`, ['--w', '72', '--h', '72', '--players', '4',
		'--seed', String(seed), '--factions', 'random,random,random,random']);
	const lv = levels[0], H = lv.rows.length, W = lv.rows[0].length;

	// every town whose gate has road within three tiles has it on the gate tile itself
	let towns = 0, onGate = 0;
	for (const o of objects) {
		if (!/^(town|randomTown)$/.test(o.type) || !o.template || (o.l || 0) !== 0) continue;
		towns++;
		const [gx, gy] = visitableCells(o.template, o.x, o.y)[0];
		if (isRoad(lv, gx, gy)) onGate++;
		else for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++)
			assert.ok(!isRoad(lv, gx + dx, gy + dy), `town (${o.x},${o.y}) has road beside its gate but not on it`);
	}
	assert.ok(towns >= 4 && onGate >= 0.8 * towns, `${onGate} of ${towns} towns have road on the gate`);

	// roads one tile wide
	for (let y = 0; y < H - 1; y++)
		for (let x = 0; x < W - 1; x++)
			assert.ok(!(isRoad(lv, x, y) && isRoad(lv, x + 1, y) && isRoad(lv, x, y + 1) && isRoad(lv, x + 1, y + 1)),
				`a 2x2 block of road at (${x},${y})`);

	// a prison keeps off the buildings: within one tile of another building for no more than a quarter
	const buildings = objects.filter(o => o.template && o.template.mask
		&& /^(town|randomTown|mine|creatureBank|creatureGenerator|shrine|witchHut|windmill|waterWheel|marlettoTower|arena|mercenaryCamp|tavern|stables|library|schoolOf|learningStone|redwoodObservatory|temple|treeOfKnowledge|oasis|fountain|wateringHole|faerieRing|mysticalGarden)/i.test(o.type));
	const prisons = objects.filter(o => o.type === 'prison' && o.template && o.template.mask);
	let near = 0;
	for (const p of prisons) {
		const pv = visitableCells(p.template, p.x, p.y);
		if (buildings.some(b => visitableCells(b.template, b.x, b.y).some(([bx, by]) => pv.some(([px, py]) => Math.max(Math.abs(bx - px), Math.abs(by - py)) <= 1)))) near++;
	}
	assert.ok(prisons.length < 4 || near <= 0.25 * prisons.length, `${near} of ${prisons.length} prisons stand against a building`);
});

test('tools/map_metrics.js measures a generated map the way the log says', { timeout: 240000 }, () => {
	const { useTestRoots } = require('./_vcmi');
	useTestRoots();
	const { analyse, lookups, loadIndex, FIELDS } = require('../tools/map_metrics');
	const out = path.join(testTmp(), 'vmapgen_k0930_metrics.vmap');
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--out', out,
		'--declaremods', '0', '--w', '72', '--h', '72', '--players', '4', '--seed', '5',
		'--factions', 'random,random,random,random'],
	{ encoding: 'utf8', timeout: 200000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	const m = analyse(out, lookups(loadIndex()));
	fs.rmSync(out, { force: true });
	for (const [k] of FIELDS)
		assert.ok(k in m, `the measure ${k} is reported`);
	assert.ok(m.road_town_at >= 0.8, `towns with a road on the entrance: ${m.road_town_at}`);
	assert.strictEqual(m.road_thick_share, 0, 'no road is two tiles wide');
	assert.ok(m.dwellings > 0 && m.prisons >= 0 && m.region_count > 0);
});
