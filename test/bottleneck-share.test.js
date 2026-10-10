/**
 * bottleneck-share.test.js - Bottleneck guard share acts on a template (K, 2026-10-05 14:52: every setting acts on every template; the tooltip
 * said "Free layout only"). The template's own guarded links are 1x (the default share); below it some lose their guard, none keep one at 0
 * but a start's, and the default is exactly as it was.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');

function doorways(share) {
	const out = path.join(testTmp(), `vmapgen_choke_${share}.vmap`);
	const a = [path.join(__dirname, '../src/main/generate-cli.js'), '--out', out, '--declaremods', '0', '--template', "Coldshadow's Fantasy",
		'--w', '108', '--h', '108', '--underground', '1', '--players', '4', '--seed', '2', '--factions', 'random,random,random,random',
		'--accommodate', 'size,players,humans,underground', '--bio.chokeGuardRatio', String(share)];
	const r = spawnSync(process.execPath, a, { encoding: 'utf8', timeout: 200000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	let guarded = 0, links = 0;
	for (const m of r.stderr.matchAll(/doorway guards (\d+) of (\d+) doorway link/g)) { guarded += +m[1]; links += +m[2]; }
	for (const f of [out, out + '.zones.json', out.replace(/\.vmap$/, '.zonedump.json')]) fs.rmSync(f, { force: true });
	return { guarded, links };
}

test('Coldshadow 108x108 two levels: doorway guards fall with the share, every link at the default, only the starts at 0', { timeout: 700000 }, () => {
	const zero = doorways(0), mid = doorways(0.35), dflt = doorways(0.7), top = doorways(1);
	assert.ok(zero.links > 8, `${zero.links} doorway links`);
	assert.strictEqual(dflt.guarded, dflt.links, 'the template guards every one of its links at the default share');
	assert.strictEqual(top.guarded, dflt.guarded, 'above the default nothing more to guard when the template guards every link');
	assert.ok(zero.guarded < mid.guarded && mid.guarded < dflt.guarded, `guards ${zero.guarded}, ${mid.guarded}, ${dflt.guarded} at 0, 0.35, 0.7`);
	assert.ok(zero.guarded <= zero.links / 2, `at 0 only the starts' links keep a guard: ${zero.guarded} of ${zero.links}`);
});
