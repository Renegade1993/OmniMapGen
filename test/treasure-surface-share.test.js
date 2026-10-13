/**
 * treasure-surface-share.test.js - a treasure zone on a dry surface lands its rich piles (bands from 10000 to under 50000) at 0.85, one
 * on a water map at 0.70 (K, 2026-10-12: "larger coldshadow templates are looking loot sparse in a lot of the middle biomes"; his
 * one-level 144x144 maps carried 55700 and 61100 loot value per 100 open tiles in their treasure zones against the engine's
 * 74000-77000; on his XL Mediterranean the higher share crowded the guards, 4.4% to 6.7%). The share each band uses is read from the
 * pile trace: a map's total of landed piles moves with every roll after the first zone and does not show it. 72x72 one level,
 * Coldshadow's Fantasy, seed 1, without water and with 30%.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');

const shares = water => {
	const out = path.join(testTmp(), `vmapgen_tshare_${process.pid}_${water}.vmap`);
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--w', '72', '--h', '72', '--players', '4',
		'--template', "Coldshadow's Fantasy", '--bio.waterCoverage', String(water), '--seed', '1', '--out', out],
	{ encoding: 'utf8', timeout: 300000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv({ VMAPGEN_PILE_TRACE: '1' }) });
	for (const f of [out, out + '.zones.json']) try { fs.unlinkSync(f); } catch (e) { /* gone already */ }
	assert.strictEqual(r.status, 0, (r.stderr || '').slice(-800));
	return [...(r.stderr || '').matchAll(/\[pileshare\] zone \d+ treasure level 0 band (\d+) rich share ([\d.]+)/g)]
		.filter(m => Number(m[1]) < 50000).map(m => Number(m[2]));
};

test("72x72 one level Coldshadow's Fantasy seed 1: a dry surface's treasure zones land rich piles at 0.85, a water map's at 0.70", () => {
	const dry = shares(0), wet = shares(0.3);
	assert.ok(dry.length > 0 && dry.every(v => v === 0.85), `dry ${dry.join(' ')}`);
	assert.ok(wet.length > 0 && wet.every(v => v === 0.7), `wet ${wet.join(' ')}`);
});
