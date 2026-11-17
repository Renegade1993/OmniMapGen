/**
 * layout-terrains.test.js - the layout-only output names each zone's terrain per level (S273, DMB Dev's lobby preview and the template
 * pictures colour each zone by it): level.terrains is parallel to classes (index = zone id), the engine's terrain identifier.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');

const layout = (extraArgs) => {
	const dir = fs.mkdtempSync(path.join(testTmp(), 'lt-'));
	const file = path.join(dir, 'layout.json');
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--w', '72', '--h', '72', '--players', '4', '--seed', '3',
		'--layout', file, ...extraArgs], { encoding: 'utf8', timeout: 300000, windowsHide: true, env: genEnv({}) });
	assert.strictEqual(r.status, 0, (r.stderr || '').slice(-600));
	const out = JSON.parse(fs.readFileSync(file, 'utf8'));
	fs.rmSync(dir, { recursive: true, force: true });
	return out;
};

test('72x72 four players, two levels: every level has terrains, one name per zone, and the underground names a terrain the surface may not', { timeout: 600000 }, () => {
	const out = layout(['--underground', '1']);
	assert.strictEqual(out.layout.length, 2);
	for (const lv of out.layout) {
		assert.ok(Array.isArray(lv.terrains), 'terrains is there');
		assert.strictEqual(lv.terrains.length, lv.classes.length, 'parallel to classes');
		assert.ok(lv.terrains.every(t => typeof t === 'string' && /^[a-z0-9_]+$/.test(t)), 'each a lower-case identifier: ' + JSON.stringify(lv.terrains));
	}
	const under = new Set(out.layout[1].terrains);
	assert.ok(under.has('subterra') || [...under].some(t => t !== 'grass'), 'the underground is not drawn in surface terrain only: ' + [...under].join(','));
});
