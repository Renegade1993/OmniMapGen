/**
 * portal-share.test.js - Portal share acts on a template (K, 2026-10-05 14:52: every setting acts on every template; the tooltip said
 * "Free layout only"). The template's own portals are 1x (the default share); above it a share of its other passages, a start's never,
 * become portal pairs, and the default is exactly as it was.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const sight = require('../tools/mapsight/lib/sight');

function monoliths(share) {
	const out = path.join(testTmp(), `vmapgen_portal_share_${share}.vmap`);
	const a = [path.join(__dirname, '../src/main/generate-cli.js'), '--out', out, '--declaremods', '0', '--template', "Coldshadow's Fantasy",
		'--w', '108', '--h', '108', '--underground', '1', '--players', '4', '--seed', '2', '--factions', 'random,random,random,random',
		'--accommodate', 'size,players,humans,underground', '--bio.interconnectPortal', String(share)];
	const r = spawnSync(process.execPath, a, { encoding: 'utf8', timeout: 200000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	const n = sight.load(out).objs.filter(o => /^monolithTwoWay/.test(o.type)).length;
	for (const f of [out, out + '.zones.json', out.replace(/\.vmap$/, '.zonedump.json')]) fs.rmSync(f, { force: true });
	return n;
}

test('Coldshadow 108x108 two levels: portal ends rise with the share above the default (8, 17, 20 a map at 0.2, 0.6, 1 over 3 seeds)', { timeout: 500000 }, () => {
	const base = monoliths(0.2), mid = monoliths(0.6), top = monoliths(1);
	assert.ok(mid >= base + 6, `${base} portal ends at the default, ${mid} at 0.6`);
	assert.ok(top >= base + 6, `${base} at the default, ${top} at 1`);
});
