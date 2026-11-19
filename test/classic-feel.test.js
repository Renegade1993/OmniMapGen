/**
 * classic-feel.test.js - Classic draws each map's feel (S340, K 2026-11-19: "some should feel exactly like old school heroes, some should feel like VCMI/HOTA
 * nostalgia, but not all"). The draw comes from the seed, one in five maps lands at each end, a lever the player named is never touched, feel 1 is the
 * Nostalgia band as it is, feel 0 moves the levers to the originals' side, and the draw goes in the map's random line.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv } = require('./_vcmi');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'src', 'main', 'generate-cli.js');
const feel = require(path.join(ROOT, 'src', 'biome', 'classicFeel'));
const layout = (args, env) => spawnSync(process.execPath, [CLI, '--layout', '1', '--w', '108', '--h', '108', '--players', '8', '--seed', '5', ...args],
	{ encoding: 'utf8', cwd: ROOT, env: { ...genEnv(), ...env }, windowsHide: true, timeout: 240000 });
const zonesOf = out => JSON.parse(out.trim().split('\n').find(l => l.startsWith('{"plan"'))).plan.reduce((n, p) => n + p.zoneLand.length, 0);

test('the draw is the seed\'s own and one map in five lands at each end', () => {
	assert.deepStrictEqual(feel.draw(77), feel.draw(77));
	let lo = 0, hi = 0;
	const N = 2000;
	for (let s = 1; s <= N; s++) { const f = feel.draw(s).f; if (f < 0.15) lo++; if (f > 0.85) hi++; }
	assert.ok(lo / N > 0.17 && lo / N < 0.27, `old school end ${lo / N}`);
	assert.ok(hi / N > 0.17 && hi / N < 0.27, `Nostalgia end ${hi / N}`);
});

test('feel 1 is the Nostalgia band as it is and feel 0 moves levers to the originals\' side', () => {
	const cur = { startZoneShare: 0.69, zoneCells: 517, mineDensity: 0.05, resourceDensity: 1, pickupDensity: 1, artifactDensity: 0.0105, guardDensity: 1.3, decorDensity: 1 };
	const ranges = { zoneCells: { min: 150, max: 3000 }, startZoneShare: { min: 0.2, max: 0.8 } };
	const ctx = { W: 108, H: 108, levels: 1, players: 8 };
	const one = feel.apply(feel.draw(3, 1), cur, ranges, ctx), zero = feel.apply(feel.draw(3, 0), cur, ranges, ctx);
	assert.strictEqual(one.mineDensity, 0.05);
	assert.strictEqual(one.guardDensity, 1.3);
	assert.ok(zero.mineDensity >= 0.7, `mines at feel 0: ${zero.mineDensity}`);
	assert.ok(zero.guardDensity >= 0.8 && zero.guardDensity <= 2.2);
	assert.ok(zero.zoneCells !== one.zoneCells, 'the zone count follows the feel');
});

test('a lever the player named is never touched, and --feel is in the settings of the map', () => {
	const a = layout(['--feel', '0', '--bio.zoneCells', '400']);
	assert.strictEqual(a.status, 0, a.stderr);
	assert.ok(zonesOf(a.stdout) > 20, 'zoneCells 400 by hand keeps its own zone count');
	const b = layout(['--feel', '0']);
	assert.ok(/feel 0\.00/.test(b.stdout), 'the draw is in the random line');
	assert.notStrictEqual(zonesOf(b.stdout), 15, 'at feel 0 the zone count is not the Nostalgia band\'s 15');
	assert.strictEqual(zonesOf(layout(['--feel', '1']).stdout), 15, 'at feel 1 it is');
});

test('VMAPGEN_CLASSIC_FEEL=0 is the Nostalgia band alone: 15 zones at 108', () => {
	const r = layout([], { VMAPGEN_CLASSIC_FEEL: '0' });
	assert.strictEqual(zonesOf(r.stdout), 15);
});
