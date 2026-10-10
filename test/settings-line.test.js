/**
 * settings-line.test.js - the .zones.json sidecar names the template, the base set (the preset) and the levers that differ from the base with their
 * values (K 2026-10-07, via the lead), and the mapsight card prints it: "Coldshadow's Fantasy; base: nostalgia; changed: waterContent 2, ...".
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');

test('the sidecar and the mapsight card carry the template, the base and the changed levers only', { timeout: 200000 }, () => {
	const out = path.join(testTmp(), 'vmapgen_settings_line.vmap');
	const a = [path.join(__dirname, '../src/main/generate-cli.js'), '--out', out, '--declaremods', '0', '--template', "Coldshadow's Fantasy",
		'--w', '36', '--h', '36', '--players', '2', '--seed', '3', '--factions', 'random,random',
		'--bio.waterContent', '2', '--bio.waterCoverage', '0.45', '--bio.mineDensity', '1', '--bio.mineGuardWeight', '2'];
	const r = spawnSync(process.execPath, a, { encoding: 'utf8', timeout: 180000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	const side = JSON.parse(fs.readFileSync(out + '.zones.json', 'utf8'));
	assert.strictEqual(side.settings, "Coldshadow's Fantasy; base: nostalgia; changed: waterContent 2, waterCoverage 0.45, mineGuardWeight 2");
	const card = spawnSync(process.execPath, [path.join(__dirname, '../tools/mapsight/mapsight.js'), 'card', out], { encoding: 'utf8', windowsHide: true, env: genEnv() });
	assert.ok(card.stdout.includes('SETTINGS ' + side.settings), card.stdout.slice(0, 400));
	for (const f of [out, out + '.zones.json', out.replace(/\.vmap$/, '.zonedump.json')]) fs.rmSync(f, { force: true });
});
