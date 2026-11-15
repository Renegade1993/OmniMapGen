/**
 * layout-water-tiles.test.js - the layout-only output carries the water tile by tile (S035, DMB Dev's lobby preview; K's rows 35.1 "changes with ...
 * water" and 35.3 "matches it in ... water"): "waterTiles", one flat array of 0 and 1 per level, index y * w + x as the dump's "water" is read.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');

const layout = (extraArgs, env = {}) => {
	const dir = fs.mkdtempSync(path.join(testTmp(), 'lwt-'));
	const file = path.join(dir, 'layout.json');
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--w', '48', '--h', '48', '--players', '4', '--seed', '1',
		'--underground', '0', '--layout', file, ...extraArgs], { encoding: 'utf8', timeout: 300000, windowsHide: true, env: genEnv(env) });
	assert.strictEqual(r.status, 0, (r.stderr || '').slice(-600));
	const out = JSON.parse(fs.readFileSync(file, 'utf8'));
	fs.rmSync(dir, { recursive: true, force: true });
	return out;
};

test('48x48 four players, Water content Islands: waterTiles is one 0/1 array of w * h per level and its share is the summary\'s coverage', { timeout: 600000 }, () => {
	const out = layout(['--bio.waterContent', '2']);
	assert.ok(out.water, 'the summary stays');
	assert.ok(Array.isArray(out.waterTiles) && out.waterTiles.length === out.size.levels, 'one array per level');
	for (const lv of out.waterTiles) {
		assert.strictEqual(lv.length, out.size.w * out.size.h);
		assert.ok(lv.every(v => v === 0 || v === 1));
	}
	const share = out.waterTiles[0].reduce((a, b) => a + b, 0) / out.waterTiles[0].length;
	assert.ok(Math.abs(share - out.water.coverage) < 0.02, `water share ${share.toFixed(3)} against coverage ${out.water.coverage.toFixed(3)}`);
});

test('no water: no waterTiles; VMAPGEN_LAYOUT_WATER_TILES=0: the field is left out and nothing else changes', { timeout: 600000 }, () => {
	assert.strictEqual(layout([]).waterTiles, undefined);
	const on = layout(['--bio.waterContent', '2']), off = layout(['--bio.waterContent', '2'], { VMAPGEN_LAYOUT_WATER_TILES: '0' });
	assert.strictEqual(off.waterTiles, undefined);
	const rest = { ...on }; delete rest.waterTiles;
	assert.deepStrictEqual(off, rest);
});
