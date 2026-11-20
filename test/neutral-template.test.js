/**
 * neutral-template.test.js - the Template number of Biome size and Start biome size on a named template is what the template gives at that map size (S386, K: "template for the
 * numerical sliders should be a numerical setting that represents what the template defaults to at that given size, so the player can easily adjust it up or down from there").
 * A number set to the neutral gives the template's own map; above it the biomes grow, below it they shrink. mod/template-info.json holds the measured table (tools/neutral_measure.js).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv } = require('./_vcmi');
const { neutralFor } = require('../src/biome/neutral');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'src', 'main', 'generate-cli.js');
const layout = (template, size, players, args) => {
	const r = spawnSync(process.execPath, [CLI, '--layout', '1', '--w', String(size), '--h', String(size), '--players', String(players), '--seed', '1', '--template', template,
		'--accommodate', 'size,players,humans,underground', ...args], { encoding: 'utf8', cwd: ROOT, env: genEnv(), windowsHide: true, timeout: 280000, maxBuffer: 1 << 28 });
	assert.strictEqual(r.status, 0, (r.stderr || '').slice(-600));
	const line = r.stdout.split('\n').find(l => l.startsWith('{"plan"'));
	assert.ok(line, 'no plan: ' + r.stdout.slice(0, 300));
	return JSON.parse(line).plan[0].zoneLand;
};

test('the neutral is interpolated by the map side and the players, and there is none outside the measured sides or for a template with no table', () => {
	const table = { 72: { 4: { zoneCells: 200, startZoneShare: 0.6, zoneCap: 10 }, 8: { zoneCells: 100, startZoneShare: 0.8, zoneCap: 20 } }, 144: { 4: { zoneCells: 800, startZoneShare: 0.4, zoneCap: 10 }, 8: { zoneCells: 400, startZoneShare: 0.6, zoneCap: 20 } } };
	assert.deepStrictEqual(neutralFor('x', 72, 72, 4, table), { zoneCells: 200, startZoneShare: 0.6, zoneCap: 10 });
	assert.deepStrictEqual(neutralFor('x', 108, 108, 4, table), { zoneCells: 500, startZoneShare: 0.5, zoneCap: 10 }, 'halfway by side');
	assert.deepStrictEqual(neutralFor('x', 72, 72, 6, table), { zoneCells: 150, startZoneShare: 0.7, zoneCap: 15 }, 'halfway by players');
	assert.strictEqual(neutralFor('x', 36, 36, 4, table), null, 'under the measured sides');
	assert.strictEqual(neutralFor('x', 252, 252, 4, table), null, 'over the measured sides');
	assert.strictEqual(neutralFor('No Such Template', 108, 108, 4), null);
});

test('named templates have a measured neutral at the sizes the lobby offers', () => {
	for (const name of ["Coldshadow's Fantasy", 'Jebus Cross', 'Golems Aplenty', 'Headquarters']) {
		for (const size of [72, 108, 144]) {
			const nv = neutralFor(name, size, size, 4);
			assert.ok(nv && nv.zoneCells > 0 && nv.startZoneShare > 0 && nv.zoneCap > 0, `${name} at ${size}: ${JSON.stringify(nv)}`);
		}
	}
});

test('a named template with Biome size and Start biome size set to the neutral at that size is the template\'s own layout, and away from it the layout moves', { timeout: 1800000 }, () => {
	for (const name of ["Coldshadow's Fantasy", 'Jebus Cross', 'Golems Aplenty']) {
		for (const size of [72, 108]) {
			const nv = neutralFor(name, size, size, 4);
			const own = layout(name, size, 4, []);
			const same = layout(name, size, 4, ['--bio.zoneCells', String(nv.zoneCells), '--bio.startZoneShare', String(nv.startZoneShare)]);
			assert.deepStrictEqual(same, own, `${name} at ${size}: the neutral gives the template's own zones`);
			const big = layout(name, size, 4, ['--bio.zoneCells', String(Math.min(3000 * nv.zoneCells / 400, nv.zoneCells * 3)), '--bio.startZoneShare', String(nv.startZoneShare)]);
			const small = layout(name, size, 4, ['--bio.zoneCells', String(Math.max(1, Math.round(nv.zoneCells / 3))), '--bio.startZoneShare', String(nv.startZoneShare)]);
			if (name !== 'Jebus Cross') assert.notDeepStrictEqual(big, small, `${name} at ${size}: bigger and smaller biomes are different layouts`);
		}
	}
});

test('an older lobby\'s stored 400 on Jebus Cross is now a ratio to its neutral, so it is not the template\'s own map any more', { timeout: 600000 }, () => {
	const nv = neutralFor('Jebus Cross', 108, 108, 4);
	assert.ok(nv.zoneCells > 1000, `Jebus Cross's own zone is large: ${nv.zoneCells}`);
	const own = layout('Jebus Cross', 108, 4, []);
	const old = layout('Jebus Cross', 108, 4, ['--bio.zoneCells', '400']);
	assert.notDeepStrictEqual(old, own, 'a stored 400 reads as a small fraction of the neutral');
});
