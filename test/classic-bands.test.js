/**
 * classic-bands.test.js - Classic follows the map size (S320, K 2026-11-17: Nostalgia and Mini Nostalgia "are all supposed to merge and combine in the classic template").
 * The lever values come from mod/template-info.json (Classic, originalPreferences.bands) through src/biome/classicBands.js: the anchors at 108, 144 and 180,
 * a straight line between them, no cliff at any size, the fade under 108, and a lever the player moved is left alone.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv } = require('./_vcmi');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'src', 'main', 'generate-cli.js');
const bands = JSON.parse(fs.readFileSync(path.join(ROOT, 'mod', 'template-info.json'), 'utf8')).templates.Classic.originalPreferences.bands;

const cli = (args, extraEnv) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: ROOT, env: { ...genEnv(), VMAPGEN_CLASSIC_FEEL: '0', ...extraEnv }, windowsHide: true, timeout: 240000 });
const listBands = (side, levels) => JSON.parse(cli(['--listbands', '1', '--w', String(side), '--h', String(side), '--underground', levels === 2 ? '1' : '0']).stdout).levers;
const zonesOf = out => JSON.parse(out.trim().split('\n').find(l => l.startsWith('{"plan"'))).plan.reduce((n, p) => n + p.zoneLand.length, 0);

test('the anchors are the table: the lever values at 108, 144 and 180 are the anchors\' own', () => {
	for (const a of bands.anchors) {
		const v = listBands(a.side, a.side >= 144 ? 2 : 1);
		for (const [k, want] of Object.entries(a.levers)) assert.strictEqual(v[k], want, `${k} at ${a.side}`);
	}
});

test('no size has a cliff: from 36 to 252 a lever never moves by more than a quarter of its whole range between sides six tiles apart', () => {
	const rows = [];
	for (let side = 36; side <= 252; side += 6) rows.push(listBands(side, 1));
	for (const k of Object.keys(rows[0])) {
		if (k === 'undergroundStarts') continue; // a choice: it switches once
		const vals = rows.map(r => r[k]), span = Math.max(...vals) - Math.min(...vals);
		for (let i = 1; i < vals.length; i++) assert.ok(Math.abs(vals[i] - vals[i - 1]) <= 0.25 * span + 1e-9, `${k} jumps from ${vals[i - 1]} to ${vals[i]} at side ${36 + 6 * i}`);
	}
});

test('under the fade the lever defaults are Classic\'s own, and above 180 the Nostalgia values hold', () => {
	const small = listBands(36, 1);
	assert.strictEqual(small.zoneCells, 400);
	assert.strictEqual(small.startZoneShare, 0.5);
	assert.strictEqual(small.mineDensity, 1);
	const big = listBands(216, 2), top = bands.anchors[bands.anchors.length - 1].levers;
	for (const k of Object.keys(top)) assert.strictEqual(big[k], top[k], `${k} at 216`);
});

test('the zone count is the stock count: 15 on a 108 map, 24 on a 180 map on two levels, and VMAPGEN_CLASSIC_BANDS=0 gives the earlier layout', () => {
	const a = cli(['--layout', '1', '--w', '108', '--h', '108', '--players', '8', '--seed', '1']);
	assert.strictEqual(zonesOf(a.stdout), 15);
	const b = cli(['--layout', '1', '--w', '108', '--h', '108', '--players', '8', '--seed', '1'], { VMAPGEN_CLASSIC_BANDS: '0' });
	assert.ok(zonesOf(b.stdout) > 15, 'the earlier layout has more zones');
	const c = cli(['--layout', '1', '--w', '180', '--h', '180', '--players', '8', '--underground', '1', '--seed', '1']);
	assert.strictEqual(zonesOf(c.stdout), 24);
});

test('a start zone keeps the stock size when fewer play: the share scales with the players over eight, and the zone count stays the stock count', () => {
	const at = n => JSON.parse(cli(['--listbands', '1', '--w', '108', '--h', '108', '--players', String(n)]).stdout).levers;
	assert.strictEqual(at(8).startZoneShare, 0.69);
	assert.ok(Math.abs(at(4).startZoneShare - 0.345) < 1e-9, 'four players take half the share of eight');
	assert.strictEqual(at(2).startZoneShare, 0.2, 'not below the slider\'s own minimum');
	const four = zonesOf(cli(['--layout', '1', '--w', '108', '--h', '108', '--players', '4', '--seed', '1']).stdout);
	assert.strictEqual(four, 15, 'the stock zone count, starts included');
});

test('a lever the player moved is never overwritten', () => {
	const r = cli(['--layout', '1', '--w', '108', '--h', '108', '--players', '8', '--seed', '1', '--bio.zoneCells', '400']);
	assert.ok(zonesOf(r.stdout) > 15, 'zoneCells 400 by hand keeps the earlier zone count');
});
