/**
 * regression-pack.test.js - the judging rule of tools/harness/regression_pack.js on hand-made measures, and the fixtures file (MapGen Dev, 2026-10-14).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { judge } = require('../tools/harness/regression_pack');

const good = { gatePass: true, gateFails: '', minStartWalk: 80, drownedZones: 0, startResourceMinesBad: 0, craterHidden: 0 };

test('judge: every expectation met is OK; one unmet with nothing known is FAIL; the same with a known line is XFAIL; a known line that no longer shows is XPASS', () => {
	const fx = { name: 'a', expect: { gate: 'pass', minStartWalk: 50, maxDrownedZones: 0, startResourceMinesBad: 0, craterHidden: 0 } };
	assert.strictEqual(judge(fx, good).status, 'OK');
	const walk = { ...good, minStartWalk: 30 };
	assert.strictEqual(judge(fx, walk).status, 'FAIL');
	assert.match(judge(fx, walk).unmet[0], /start walks 30 tiles/);
	assert.strictEqual(judge({ ...fx, known: 'start (100,74) walks 30 tiles' }, walk).status, 'XFAIL');
	assert.strictEqual(judge({ ...fx, known: 'start (100,74) walks 30 tiles' }, good).status, 'XPASS');
	assert.strictEqual(judge(fx, { ...good, gatePass: false, gateFails: 'road ends 1' }).status, 'FAIL');
	assert.strictEqual(judge(fx, { ...good, drownedZones: 2 }).status, 'FAIL');
	assert.strictEqual(judge(fx, { ...good, startResourceMinesBad: 2 }).status, 'FAIL');
	assert.strictEqual(judge(fx, { ...good, craterHidden: 1 }).status, 'FAIL');
});

test('judge: a missing measure (NaN walk) counts as unmet, not as passing', () => {
	const fx = { name: 'b', expect: { minStartWalk: 50, maxDrownedZones: 0 } };
	assert.strictEqual(judge(fx, { ...good, minStartWalk: NaN }).status, 'FAIL');
	assert.strictEqual(judge(fx, { ...good, drownedZones: NaN }).status, 'FAIL');
});

test('the fixtures file names the seven maps of 2026-10-14, each with options and an expectation, and holds no personal path', () => {
	const file = path.join(__dirname, '..', 'tools', 'harness', 'regression_fixtures.json');
	const raw = fs.readFileSync(file, 'utf8'), fx = JSON.parse(raw);
	for (const n of ['k1583610596_xl_mediterranean', 'w_mediterranean_108_s7001', 'w_mediterranean_144_s7001', 'w_mediterranean_144_s1', 'r1_16_72p8uf', 'wood_case_grid_p4_72_s2', 'crater_case_grid_p2_144_s2'])
		assert.ok(fx.some(f => f.name === n && f.opt && f.expect), n);
	assert.ok(!new RegExp('Users|' + ['K', 'money'].join('') + '|C:\\\\|C:/', 'i').test(raw), 'a personal or absolute path in the fixtures');
});
