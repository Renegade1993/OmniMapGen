/**
 * approach-tiles.test.js - K's order of interdiction (2026-10-06: guard, loot, guard, wall) and the roads at objects, read on one Coldshadow's
 * Fantasy 108x108 two-level map:
 *  - a flying hero meets a guard at a dwelling or a dear pile: of the tiles an object is visited from, one that is open ground, holds no object
 *    and lies in no monster's 3x3 ring is left open on under 20% of dwellings and 15% of dear piles (before the closing pass 17.7% and 21.0% on
 *    the 80-map grid; the engine's 10 to 14% and 8 to 13%); the Opus Reviewer's flyerdw.js is the same test; every relic, major, artifact and
 *    Pandora's box has a monster beside it; under 5% of stacks have another within 2 tiles (the guard spacing of 2026-10-08);
 *  - a road passes a monolith, a gate or a mine and does not run through it (the engine's maps: none of 1,800 objects with a road);
 *  - every town has road on the tile in front of its entrance (the engine's maps: 186 of 186).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const sight = require('../tools/mapsight/lib/sight');

const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

test('approach tiles are guarded or closed, roads pass objects, towns have road at the door', { timeout: 290000 }, () => {
	const out = path.join(testTmp(), 'vmapgen_approach.vmap');
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--out', out, '--declaremods', '0',
		'--template', "Coldshadow's Fantasy", '--w', '108', '--h', '108', '--players', '2', '--seed', '3', '--underground', '1',
		'--factions', 'random,random', '--accommodate', 'size,players,humans,underground'],
	{ encoding: 'utf8', timeout: 260000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	assert.ok(/dwellings and dear piles with an open approach/.test(r.stderr), 'the closing pass ran');
	const M = sight.load(out);
	const ringed = new Uint8Array(M.NL * M.W * M.H), pick = new Uint8Array(M.NL * M.W * M.H);
	for (const m of M.monsters) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (M.inb(m.at[0] + dx, m.at[1] + dy)) ringed[M.idx(m.l, m.at[0] + dx, m.at[1] + dy)] = 1;
	for (const o of M.objs) if (o.pickup) for (const [x, y] of o.cells) pick[M.idx(o.l, x, y)] = 1;
	const count = cls => {
		let n = 0, open = 0;
		for (const o of M.objs) {
			if (o.cls !== cls || !o.visitable) continue;
			n++;
			if (M.approach(o).some(i => M.ground(i) && !M.blocked[i] && !pick[i] && !ringed[i])) open++;
		}
		return { n, open };
	};
	const dw = count('dwelling'), hi = count('high');
	assert.ok(hi.n > 100, `${hi.n} dear piles read`);
	// the map has no mods declared, so it may hold few creature dwellings. The limits are the engine's own (its Coldshadow maps leave 10 to 14%
	// of dwellings and 8 to 13% of dear piles with an open approach tile) and the lead's targets of 2026-10-08 (dwellings 20%, piles 15%); a
	// tile closed by a second guard beside the first is the crowding below, which the engine never shows
	if (dw.n >= 10) assert.ok(dw.open / dw.n < 0.20, `${dw.open} of ${dw.n} dwellings have an open approach tile a flyer can visit from`);
	assert.ok(hi.open / hi.n < 0.15, `${hi.open} of ${hi.n} dear piles have an open approach tile a flyer can visit from`);
	// a flyer that lands on a relic, a major, an artifact or a Pandora's box meets a monster beside it (K, 2026-10-05)
	const dear = M.objs.filter(o => o.cls === 'high' && o.type !== 'spellScroll');
	const bare = dear.filter(o => !M.monsters.some(m => m.l === o.l && Math.max(Math.abs(m.at[0] - o.at[0]), Math.abs(m.at[1] - o.at[1])) <= 1));
	assert.ok(bare.length / dear.length < 0.01, `${bare.length} of ${dear.length} dear piles have no monster beside them`);
	// stacks keep their distance (K, 2026-10-06 15:03, guard clusters; the engine's Coldshadow maps: 0.1% of stacks with another within 2 tiles)
	const crowded = M.monsters.filter(m => M.monsters.some(n => n !== m && n.l === m.l && Math.max(Math.abs(n.at[0] - m.at[0]), Math.abs(n.at[1] - m.at[1])) <= 2));
	assert.ok(crowded.length / M.monsters.length < 0.05, `${crowded.length} of ${M.monsters.length} stacks have another within 2 tiles`);
	// roads: through an object
	let through = 0, withRoad = 0;
	for (const o of M.objs) {
		if (!o.visitable || !/^(monolith|gate|mine)$/.test(o.cls)) continue;
		const own = new Set(o.cells.map(([x, y]) => M.idx(o.l, x, y))), app = new Set(M.approach(o));
		if (!o.entr.some(([ex, ey]) => M.road[M.idx(o.l, ex, ey)])) continue;
		withRoad++;
		if (o.entr.some(([ex, ey]) => N8.some(([dx, dy]) => { const x = ex + dx, y = ey + dy; if (!M.inb(x, y)) return false; const i = M.idx(o.l, x, y); return M.road[i] && !app.has(i) && !own.has(i); }))) through++;
	}
	assert.ok(withRoad > 30, `${withRoad} monoliths, gates and mines with a road read`);
	// 34% of monoliths, 18% of gates and 3% of mines had road through them before the pass (80-map grid); it cannot go round an object in a
	// one-tile passage, which is why this is not 0
	assert.ok(through / withRoad < 0.2, `${through} of ${withRoad} objects have road running through them`);
	// towns: road on the tile in front of the entrance
	let towns = 0, front = 0;
	for (const o of M.objs) {
		if (o.cls !== 'town') continue;
		towns++;
		const [ex, ey] = o.entr[0];
		if (M.inb(ex, ey + 1) && (M.road[M.idx(o.l, ex, ey + 1)] || M.road[M.idx(o.l, ex, ey)])) front++;
	}
	assert.ok(towns >= 4 && front / towns >= 0.95, `${front} of ${towns} towns have road at the door`);
	for (const f of [out, out + '.zones.json', out.replace(/\.vmap$/, '.zonedump.json')]) fs.rmSync(f, { force: true });
});
