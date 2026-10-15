'use strict';
/**
 * regression_pack.js - the failing maps of 2026-10-14 as named fixtures with expected results (lead's order 16:1x: "so no later change repeats them").
 *
 *   node tools/harness/regression_pack.js --tip DIR --out DIR [--only name,name] [--eval] [--lanes 3]
 *
 * regression_fixtures.json holds each fixture: name, why, opt (the generator options of the map, no paths), expect and an optional known (the failure it still shows, in words).
 *   expect.gate            'pass': the playable gate's hard checks pass on it (playable_gate.js, run on the fixtures as cases)
 *   expect.minStartWalk    every start walks at least this many tiles without entering a stack's ring (the gate's rule)
 *   expect.maxDrownedZones at most this many zones have fewer than 10 land tiles on level 0 (K 1583610596: 7bebab0 one such zone, 0.3.9's start +3 two, the Reviewer's "drowned two treasure zones")
 *   expect.startResourceMinesBad  at most this many start sawmills or ore pits are controlled by a guard above tier 1 (start-resource-guard)
 *   expect.craterHidden    at most this many stacks stand under a crater's picture (guard-blocked)
 * Result per fixture: OK (every expectation met), FAIL (one unmet, nothing known), XFAIL (unmet, and the fixture names that failure as known: still failing as written),
 * XPASS (a known failure that no longer shows: delete its "known" line). Exit 1 on a FAIL or an XPASS, so a fix and a regression both ask for a look.
 * judge(fixture, measures) is the pure part (test/regression-pack.test.js).
 */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');

function judge(fx, m) {
	const e = fx.expect || {}, unmet = [];
	if (e.gate === 'pass' && !m.gatePass) unmet.push(`gate: ${m.gateFails || 'fails'}`);
	if (e.minStartWalk !== undefined && !(m.minStartWalk >= e.minStartWalk)) unmet.push(`a start walks ${m.minStartWalk} tiles (floor ${e.minStartWalk})`);
	if (e.maxDrownedZones !== undefined && !(m.drownedZones <= e.maxDrownedZones)) unmet.push(`${m.drownedZones} zones with under 10 land tiles (at most ${e.maxDrownedZones})`);
	if (e.startResourceMinesBad !== undefined && !(m.startResourceMinesBad <= e.startResourceMinesBad)) unmet.push(`${m.startResourceMinesBad} start mines controlled above tier 1 (at most ${e.startResourceMinesBad})`);
	if (e.craterHidden !== undefined && !(m.craterHidden <= e.craterHidden)) unmet.push(`${m.craterHidden} stacks under a crater (at most ${e.craterHidden})`);
	if (!unmet.length) return { status: fx.known ? 'XPASS' : 'OK', unmet };
	return { status: fx.known ? 'XFAIL' : 'FAIL', unmet };
}

const N8 = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 0], [-1, 1]];
/** The tiles each owned start walks to from its town's door over open ground outside every stack's 3x3 ring; the least of them. */
function startWalks(M, sight) {
	const WET = new Set(['wa', 'wt']), st = sight.starts(M), ring = new Set();
	for (const m of M.monsters) for (const [dx, dy] of [[0, 0], ...N8]) if (M.inb(m.at[0] + dx, m.at[1] + dy)) ring.add(M.idx(m.l, m.at[0] + dx, m.at[1] + dy));
	const open = i => M.ground(i) && !WET.has(M.terr[i]) && !M.blocked[i] && !ring.has(i);
	const out = [];
	for (const t of M.objs.filter(o => o.cls === 'town' && st.some(s => s.l === o.l && Math.max(Math.abs(s.at[0] - o.at[0]), Math.abs(s.at[1] - o.at[1])) <= 1))) {
		const seen = new Set(), q = [];
		for (const i of M.approach(t)) if (open(i) && !seen.has(i)) { seen.add(i); q.push(i); }
		for (let h = 0; h < q.length; h++) { const c = q[h], x = c % M.W, y = Math.floor(c / M.W) % M.H; for (const [dx, dy] of N8) if (M.inb(x + dx, y + dy)) { const k = M.idx(t.l, x + dx, y + dy); if (open(k) && !seen.has(k)) { seen.add(k); q.push(k); } } }
		out.push(seen.size);
	}
	return out.length ? Math.min(...out) : NaN;
}

/** How many zones have fewer than 10 land tiles on level 0 (water excluded). */
function drownedZones(M) {
	const WET = new Set(['wa', 'wt']), n = new Map();
	for (let y = 0; y < M.H; y++) for (let x = 0; x < M.W; x++) { const z = M.zoneAt(0, x, y); if (z == null || z < 0) continue; const i = M.idx(0, x, y); n.set(z, (n.get(z) || 0) + (M.ground(i) && !WET.has(M.terr[i]) ? 1 : 0)); }
	return n.size ? [...n.values()].filter(c => c < 10).length : NaN;
}

function main() {
	const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
	const tip = path.resolve(arg('--tip', path.join(__dirname, '..', '..'))), out = path.resolve(arg('--out', path.join(tip, '.tmp', 'regression_pack')));
	const only = arg('--only') ? arg('--only').split(',') : null;
	const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'regression_fixtures.json'), 'utf8')).filter(f => !only || only.includes(f.name));
	fs.mkdirSync(out, { recursive: true });
	const casesFile = path.join(out, 'fixtures_as_cases.json');
	fs.writeFileSync(casesFile, JSON.stringify(fixtures.map(f => ({ name: f.name, opt: f.opt }))));
	if (!process.argv.includes('--eval')) {
		const g = spawnSync(process.execPath, [path.join(__dirname, 'playable_gate.js'), '--tip', tip, '--out', path.join(out, 'gate'), '--cases', casesFile, '--lanes', arg('--lanes', '3'), '--deadline-min', '30'], { stdio: 'inherit', cwd: tip, env: process.env });
		if (g.status !== 0 && g.status !== 1 && g.status !== null) { console.error('regression_pack: the gate did not run (exit ' + g.status + ')'); process.exit(2); }
	}
	const sight = require('../mapsight/lib/sight'), { CHECKS } = require('./grid_extra');
	const res = JSON.parse(fs.readFileSync(path.join(out, 'gate', 'gate_results.json'), 'utf8'));
	let bad = 0;
	console.log(`regression pack on ${path.basename(tip)}: ${fixtures.length} fixtures`);
	for (const fx of fixtures) {
		const r = res.find(x => x.name === fx.name), file = path.join(out, 'gate', 'maps', fx.name + '.vmap');
		if (!r || !fs.existsSync(file)) { console.log(`  FAIL  ${fx.name}: no map made`); bad++; continue; }
		const M = sight.load(file);
		const srg = CHECKS['start-resource-guard'](M), gb = CHECKS['guard-blocked'](M);
		const m = { gatePass: !(r.fails && r.fails.length), gateFails: (r.fails || []).map(f => f.slice(0, 90)).join('; '), minStartWalk: startWalks(M, sight), drownedZones: drownedZones(M),
			startResourceMinesBad: srg && srg.nums ? srg.nums.minesBad : 0, craterHidden: gb && gb.nums ? gb.nums.hidden : 0 };
		const j = judge(fx, m);
		if (j.status === 'FAIL' || j.status === 'XPASS') bad++;
		console.log(`  ${j.status.padEnd(5)} ${fx.name}: start walk ${m.minStartWalk}, zones under 10 land tiles ${m.drownedZones}, start mines bad ${m.startResourceMinesBad}, under a crater ${m.craterHidden}${j.unmet.length ? '; unmet: ' + j.unmet.join(' | ') : ''}${j.status === 'XPASS' ? '; known failure gone: ' + fx.known : ''}`);
	}
	process.exit(bad ? 1 : 0);
}
module.exports = { judge, startWalks, drownedZones };
if (require.main === module) main();
