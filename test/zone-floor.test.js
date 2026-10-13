/**
 * zone-floor.test.js - every zone of 50 tiles or more holds at least one visited object, pile or guard a 100 of its tiles (mapsight's
 * empty-zone rule), where it has free ground a hero walks to. fillBareWindows filled 8x8 windows of 32 open tiles only, so a narrow zone
 * got nothing: 108x108 four players seed 3, zone 6, 1 object in 116 tiles (and K's road map seed 2090106454 zone 12, 1 of 107). Thin
 * slivers with no free tile (a corridor one tile wide, a strip of wall) are not reached by this and stay a layout matter.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const sight = require('../tools/mapsight/lib/sight');
const { emptyZones } = require('../tools/mapsight/lib/check');

test('108x108 four players seed 3: no zone under one object a 100 tiles', () => {
	const out = path.join(testTmp(), `vmapgen_zone_floor_${process.pid}.vmap`);
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--w', '108', '--h', '108', '--players', '4',
		'--underground', '0', '--seed', '3', '--out', out], { encoding: 'utf8', timeout: 300000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	try {
		assert.strictEqual(r.status, 0, (r.stderr || '').slice(-800));
		assert.deepStrictEqual(emptyZones(sight.load(out)), []);
	} finally {
		for (const f of [out, out + '.zones.json']) try { fs.unlinkSync(f); } catch (e) { /* gone already */ }
	}
});
