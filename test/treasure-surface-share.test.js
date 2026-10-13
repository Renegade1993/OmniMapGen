/**
 * treasure-surface-share.test.js - a surface treasure zone lands more of its rich piles than an underground one (K, 2026-10-12: "larger
 * coldshadow templates are looking loot sparse in a lot of the middle biomes"; his one-level 144x144 maps carried 55700 and 61100 loot
 * value per 100 open tiles in their treasure zones against the engine's 74000-77000). The same map, seed and rolls with the surface
 * share at the underground's 0.70 lands fewer piles. 72x72 one level, Coldshadow's Fantasy, seed 1, the pile trace.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');

const landed = extra => {
	const out = path.join(testTmp(), `vmapgen_tshare_${process.pid}_${Object.keys(extra).length}.vmap`);
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--w', '72', '--h', '72', '--players', '4',
		'--template', "Coldshadow's Fantasy", '--seed', '1', '--out', out],
	{ encoding: 'utf8', timeout: 300000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv({ VMAPGEN_PILE_TRACE: '1', ...extra }) });
	for (const f of [out, out + '.zones.json']) try { fs.unlinkSync(f); } catch (e) { /* gone already */ }
	assert.strictEqual(r.status, 0, (r.stderr || '').slice(-800));
	return [...(r.stderr || '').matchAll(/\[pile\] zone \d+ engine piles: (\d+) landed/g)].reduce((a, m) => a + Number(m[1]), 0);
};

test("72x72 one level Coldshadow's Fantasy seed 1: surface treasure zones land more rich piles than at the underground's share", () => {
	const now = landed({}), before = landed({ VMAPGEN_TPL_PILE_LAND_RICH_TREASURE_SURFACE: '0.70' });
	assert.ok(now > before, `landed ${now} against ${before} at 0.70`);
});
