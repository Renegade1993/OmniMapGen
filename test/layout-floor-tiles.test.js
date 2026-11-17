/**
 * layout-floor-tiles.test.js - the layout-only output carries the underground floor (S299, DMB Dev's lobby preview; K 2026-11-17: "underground still looks
 * wrong ... we need to remove the areas that are abyssal in the underground"): "floorTiles", one flat array of 0 and 1 per level, index y * w + x, 1 the carve left
 * open floor and 0 solid rock; null for the surface. It comes from the carve the full map makes.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');

const layout = (extraArgs, env = {}) => {
	const dir = fs.mkdtempSync(path.join(testTmp(), 'lft-'));
	const file = path.join(dir, 'layout.json');
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--w', '72', '--h', '72', '--players', '4', '--seed', '3',
		'--layout', file, ...extraArgs], { encoding: 'utf8', timeout: 300000, windowsHide: true, env: genEnv(env) });
	assert.strictEqual(r.status, 0, (r.stderr || '').slice(-600));
	const out = JSON.parse(fs.readFileSync(file, 'utf8'));
	fs.rmSync(dir, { recursive: true, force: true });
	return out;
};

test('two levels: floorTiles is null for the surface and a w * h array of 0 and 1 for the underground, about half of it open', { timeout: 600000 }, () => {
	const out = layout(['--underground', '1']);
	assert.ok(Array.isArray(out.floorTiles) && out.floorTiles.length === 2, 'one entry per level');
	assert.strictEqual(out.floorTiles[0], null);
	const f = out.floorTiles[1];
	assert.strictEqual(f.length, out.size.w * out.size.h);
	assert.ok(f.every(v => v === 0 || v === 1));
	const share = f.reduce((a, b) => a + b, 0) / f.length;
	assert.ok(share > 0.3 && share < 0.7, `open share ${share.toFixed(3)}`);
	for (const lv of out.layout) assert.strictEqual(lv.floor, undefined, 'no copy inside the level objects');
	// every zone of the level has floor: the carve opens each of them
	const zoneOpen = new Set();
	out.layout[1].zone.forEach((z, i) => { if (f[i] && z >= 0) zoneOpen.add(z); });
	assert.strictEqual(zoneOpen.size, out.layout[1].classes.length, 'each zone has open floor');
});

test('one level: no floorTiles; VMAPGEN_LAYOUT_FLOOR_TILES=0 leaves it out of a two-level run', { timeout: 600000 }, () => {
	assert.strictEqual(layout(['--underground', '0']).floorTiles, undefined);
	assert.strictEqual(layout(['--underground', '1'], { VMAPGEN_LAYOUT_FLOOR_TILES: '0' }).floorTiles, undefined);
});
