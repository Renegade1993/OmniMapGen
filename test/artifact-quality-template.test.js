/**
 * artifact-quality-template.test.js - Artifact quality acts on a template (K, 2026-10-05 14:52: every setting acts on every template; the tooltip
 * said "Free layout only"). The piles' own tiers are 1x (the default slider); away from it the major and relic share is leaned and the number of
 * artifacts stays the piles' own.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const sight = require('../tools/mapsight/lib/sight');

function artifacts(quality, seed = 2) {
	const out = path.join(testTmp(), `vmapgen_art_quality_${quality}_${seed}.vmap`);
	const a = [path.join(__dirname, '../src/main/generate-cli.js'), '--out', out, '--declaremods', '0', '--template', "Coldshadow's Fantasy",
		'--w', '108', '--h', '108', '--underground', '1', '--players', '4', '--seed', String(seed), '--factions', 'random,random,random,random',
		'--accommodate', 'size,players,humans,underground', '--bio.artifactRichness', String(quality)];
	const r = spawnSync(process.execPath, a, { encoding: 'utf8', timeout: 200000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	let all = 0, high = 0;
	for (const o of sight.load(out).objs) if (/^(randomArtifact|artifact$)/.test(o.type)) { all++; if (/Major|Relic/.test(o.type)) high++; }
	for (const f of [out, out + '.zones.json', out.replace(/\.vmap$/, '.zonedump.json')]) fs.rmSync(f, { force: true });
	return { all, high, share: high / all };
}

test('Coldshadow 108x108 two levels: the major and relic share rises with Artifact quality, the number stays (0.50, 0.69, 0.90 over 3 seeds)', { timeout: 1500000 }, () => {
	// four seeds summed: one seed's count moves 10 to 15% between settings with the pile draw alone (seed 2 at 6a8e76f: 226 and 239 at 0.5 and
	// 1; on the guard unit 2026-10-08, seeds 2 and 3: 529, 475, 498; seeds 2 to 5: 1011, 938, 948)
	const sum = q => { const r = [2, 3, 4, 5].map(seed => artifacts(q, seed)); const all = r.reduce((t, x) => t + x.all, 0); return { all, share: r.reduce((t, x) => t + x.high, 0) / all }; };
	const lo = sum(0), mid = sum(0.5), hi = sum(1);
	assert.ok(lo.share + 0.1 < mid.share && mid.share + 0.1 < hi.share, `shares ${lo.share.toFixed(2)}, ${mid.share.toFixed(2)}, ${hi.share.toFixed(2)} at 0, 0.5, 1`);
	assert.ok(Math.abs(lo.all - mid.all) <= 0.1 * mid.all && Math.abs(hi.all - mid.all) <= 0.1 * mid.all, `artifacts ${lo.all}, ${mid.all}, ${hi.all}`);
});
