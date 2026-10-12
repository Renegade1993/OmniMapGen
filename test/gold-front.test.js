/**
 * gold-front.test.js - a gold mine is guarded on every way in (K, 2026-10-08: "found a completely unguarded gold mine in my start biome"; the
 * engine guards 100% of its gold mines). MapGen Dev's gold-front check found 39 of 766 gold mines open to a walker on the 80-map grid of 62564c7:
 * mines entered only from the map's rim (nothing can stand there), a guard moved off a doorstep that covered the mine's door, a mine whose door
 * is on a start zone's road far from any town. The grid map 72x72 two levels four players seed 1 had one (a mine whose door is on a start zone's road, the road leading away from every town).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const sight = require('../tools/mapsight/lib/sight');

function openGoldMines(file) {
	const M = sight.load(file);
	const ring = new Set();
	for (const m of M.objs) if (m.cls === 'monster') for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (M.inb(m.at[0] + dx, m.at[1] + dy)) ring.add(M.idx(m.l, m.at[0] + dx, m.at[1] + dy));
	const open = [];
	let all = 0;
	for (const q of M.objs) {
		if (q.cls !== 'mine' || !/gold/i.test(String(q.subtype || q.type))) continue;
		all++;
		const free = M.approach(q).filter(i => M.ground(i) && !M.blocked[i]);
		if (free.some(i => !ring.has(i))) open.push(q.at.join(','));
	}
	return { all, open };
}

test('72x72 two levels four players seed 1 (a grid map): every gold mine has a guard on each free way in', { timeout: 240000 }, () => {
	const opts = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'gold_front_p4_72_s1.json'), 'utf8'));
	const out = path.join(testTmp(), `vmapgen_gold_front_${process.pid}.vmap`);
	const args = [path.join(__dirname, '../src/main/generate-cli.js'), '--out', out];
	for (const [k, v] of Object.entries(opts)) { if (k === 'declaremods') continue; args.push('--' + k, String(v)); }
	const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 200000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	const { all, open } = openGoldMines(out);
	assert.ok(all >= 3, `${all} gold mines on the map`);
	assert.deepStrictEqual(open, [], `gold mines open to a walker: ${open.join(' ')}`);
	for (const f of [out, out + '.zones.json', out.replace(/\.vmap$/, '.zonedump.json')]) fs.rmSync(f, { force: true });
});
