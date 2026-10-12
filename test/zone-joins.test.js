/**
 * zone-joins.test.js - no walk between two zones meets no guard unless a doorway left free by design makes it (the Opus Reviewer's R37 and R41,
 * 2026-10-11: such joins came and went with every fill change; guardZoneJoins in plan.js guards each one, or closes it with a piece of scenery where
 * no guard fits). A step it leaves is a failure. It fails today where a town's door lies across a zone line (72x72 two levels seed 2: the conflux (26,5) in
 * zone 9 with a doorstep tile in zone 4; 36x36 eight players start towns): no guard or blocker may stand on a doorstep, so the door must be its own zone's.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');

const generate = args => {
	const out = path.join(testTmp(), `vmapgen_joins_${process.pid}_${args.join('_').replace(/[^a-z0-9_.]/gi, '')}.vmap`);
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), ...args, '--out', out],
		{ encoding: 'utf8', timeout: 300000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	return { r, out };
};

for (const [name, args] of [
	['36x36 four players seed 3 (zone 4 into zone 5 at (8,19))', ['--w', '36', '--h', '36', '--players', '4', '--seed', '3', '--underground', '0']],
	['72x72 two levels four players seed 2', ['--w', '72', '--h', '72', '--players', '4', '--seed', '2', '--underground', '1']],
]) {
	test(`${name}: every walk between zones with no fight is a free doorway (no step left)`, () => {
		const { r } = generate(args);
		assert.strictEqual(r.status, 0, (r.stderr || '').slice(-800));
		const lines = (r.stdout + r.stderr).split('\n').filter(s => /zone joins with no fight/.test(s));
		for (const s of lines) {
			const m = /(\d+) step\(s\) left/.exec(s);
			assert.ok(m && Number(m[1]) === 0, s);
		}
	});
}
