/**
 * stack-quality-levers.test.js - two levers the P3 sweep (2026-10-05) found dead where their label promises an effect.
 * Stack size reached only the roaming monsters of a free layout, so a template's guards kept the engine's counts at 0.25x and 3x
 * (mean stack 36.7 and 38.8 on 72x72 Coldshadow). Artifact quality moved the major and relic share by 2 points on a free layout.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const { readVmap } = require('../src/preview/render');

// S341 follow-up (2026-11-19): seed 1 moved to seed 4. Classic's size bands and feel draw (the defaults since 9877c4b) give a 72x72 map 2 to 26 random
// artifacts, and a share of 2 to 5 objects is no measure; checked on seeds 2 to 11 under the new defaults the lever moves the share both ways on 8 of the 10
// (the two that do not carry 3 to 14 artifacts), and seed 4 carries 19 to 26 (0.05, 0.35 and 0.63 at 0, default and 1)
const ART_SEED = 4;
function make(tag, extra, seed = 1) {
	const out = path.join(testTmp(), `vmapgen_levers_${tag}.vmap`);
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--out', out, '--declaremods', '0',
		'--w', '72', '--h', '72', '--players', '4', '--seed', String(seed), '--factions', 'random,random,random,random',
		'--accommodate', 'size,players,humans,underground', ...extra],
	{ encoding: 'utf8', timeout: 120000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	const { objects } = readVmap(out);
	for (const f of [out, out + '.zones.json', out.replace(/\.vmap$/, '.zonedump.json')]) fs.rmSync(f, { force: true });
	return Array.isArray(objects) ? objects : Object.values(objects);
}

test('Stack size scales a template map\'s guards, link guards included, and 1x leaves them alone', { timeout: 280000 }, () => {
	const mean = o => { const a = o.filter(x => x.options && x.options.amount).map(x => x.options.amount); return a.reduce((s, v) => s + v, 0) / a.length; };
	const tpl = ['--template', "Coldshadow's Fantasy"];
	const lo = mean(make('stack_lo', [...tpl, '--bio.stackScale', '0.25']));
	const one = mean(make('stack_one', [...tpl]));
	const hi = mean(make('stack_hi', [...tpl, '--bio.stackScale', '3']));
	assert.ok(lo < one / 2, `0.25x ${lo} against 1x ${one}`);
	assert.ok(hi > one * 1.8, `3x ${hi} against 1x ${one}`);
});

test('Artifact quality moves the major and relic share of a free layout both ways', { timeout: 200000 }, () => {
	const share = o => {
		const a = o.filter(x => /^randomArtifact(Minor|Major|Relic|Treasure)$/.test(x.type));
		return a.filter(x => /Major|Relic/.test(x.type)).length / a.length;
	};
	const lo = share(make('art_lo', ['--bio.artifactRichness', '0'], ART_SEED));
	const one = share(make('art_one', [], ART_SEED));
	const hi = share(make('art_hi', ['--bio.artifactRichness', '1'], ART_SEED));
	assert.ok(lo < one - 0.1, `0 ${lo} against default ${one}`);
	assert.ok(hi > one + 0.1, `1 ${hi} against default ${one}`);
});
