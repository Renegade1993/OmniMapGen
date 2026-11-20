/**
 * special-buildings.test.js - the special buildings of the open layout (S350, K 2026-11-19: "Special buildings (slider on the Treasure page)"): trading posts, universities,
 * sanctuaries, hill forts, cartographers, signs and one-way portals at the original scenarios' rate (special.js RATES: 127 scenarios, per 1,000 ground tiles), times the slider.
 * 0x writes none; 1x lands near the originals' rate; 3x about three times as many; every building stands where a hero can walk to its door; a named template gets none.
 * The 80-map count behind the rates is in the lane log (.tmp\m1118\sample80_*.jsonl on the day); this is the sample the suite can afford.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv } = require('./_vcmi');
const sight = require('../tools/mapsight/lib/sight');
const { RATES } = require('../src/biome/special');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'src', 'main', 'generate-cli.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'special-buildings-'));
const KIND = o => (/^tradingPost/.test(o.type) ? 'tradingPost' : /^(university|sanctuary|hillFort|sign)$/.test(o.type) ? o.type
	: o.type === 'cartographer' ? 'cartographer' : /^monolithOneWay/.test(o.type) ? 'oneWay' : null);
const N8 = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 0], [-1, 1]];

function make(tag, seed, args, env) {
	const out = path.join(dir, tag + '.vmap');
	const r = spawnSync(process.execPath, [CLI, '--w', '108', '--h', '108', '--players', '4', '--seed', String(seed), ...args, '--out', out],
		{ encoding: 'utf8', cwd: ROOT, env: { ...genEnv(), ...env }, windowsHide: true, timeout: 280000 });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	return out;
}
function count(file) {
	const M = sight.load(file);
	let ground = 0;
	for (let i = 0; i < M.W * M.H * M.NL; i++) if (M.ground(i)) ground++;
	const by = {};
	const objs = M.objs.filter(o => KIND(o));
	for (const o of objs) by[KIND(o)] = (by[KIND(o)] || 0) + 1;
	return { M, ground, by, objs, total: objs.length };
}

test('0x writes none, on the slider and on the proof switch', () => {
	const off = count(make('x0', 1, ['--bio.specialDensity', '0']));
	assert.strictEqual(off.total, 0, JSON.stringify(off.by));
	const sw = count(make('sw', 1, [], { VMAPGEN_SPECIAL_BUILDINGS: '0' }));
	assert.strictEqual(sw.total, 0, JSON.stringify(sw.by));
});

test('1x lands near the originals\' rate and 3x about three times as many', { timeout: 2400000 }, () => {
	// a map has a kind or not, drawn from its seed (the originals bunch their buildings), so the rate is read over ten maps; 3x is the same seeds, so the same kinds
	const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], seeds3 = [3, 4, 6, 8];
	let g1 = 0, n1 = 0, g3 = 0, n3 = 0, g1s = 0, n1s = 0;
	const seen = {};
	for (const s of seeds) {
		const c = count(make('x1_' + s, s, ['--bio.specialDensity', '1']));   // 1x is set by hand: left out is Template, which the lean draws (S365)
		g1 += c.ground; n1 += c.total;
		if (seeds3.includes(s)) { g1s += c.ground; n1s += c.total; }
		for (const k of Object.keys(c.by)) seen[k] = (seen[k] || 0) + c.by[k];
	}
	for (const s of seeds3) { const c = count(make('x3_' + s, s, ['--bio.specialDensity', '3'])); g3 += c.ground; n3 += c.total; }
	// objects per 1,000 ground tiles at the originals' overworld rate: every kind, a one-way pair being two objects
	const want = RATES.tradingPost[0] + RATES.university[0] + RATES.sanctuary[0] + RATES.hillFort[0] + RATES.cartographer[0] + RATES.sign[0] + 2 * RATES.oneWay[0];
	const got = n1 / g1 * 1000, got1s = n1s / g1s * 1000, got3 = n3 / g3 * 1000;
	assert.ok(got > want * 0.5 && got < want * 1.8, `1x ${got.toFixed(2)} objects per 1,000 ground tiles against the originals' ${want.toFixed(2)} (${JSON.stringify(seen)})`);
	assert.ok(got3 > got1s * 2.2 && got3 < got1s * 3.6, `3x ${got3.toFixed(2)} against 1x ${got1s.toFixed(2)} on the same four maps`);
	for (const k of ['tradingPost', 'university', 'sanctuary', 'hillFort', 'sign', 'oneWay']) assert.ok(seen[k] > 0, `${k} never appears in ten maps: ${JSON.stringify(seen)}`);
});

test('every special building has a door a hero can walk to from a start town, and a one-way portal has both ends', { timeout: 600000 }, () => {
	for (const s of [3, 4, 6]) {
		const c = count(make('reach' + s, s, ['--bio.specialDensity', '2']));
		const M = c.M;
		const starts = sight.starts(M);
		const seen = new Set(), q = [];
		// a stack on the way is a fight and no wall: its tile is walked through (the reach the generator keeps is the same, with the guards as the cost)
		const guardAt = new Set(M.monsters.map(m => M.idx(m.l, m.at[0], m.at[1])));
		const open = i => M.ground(i) && (!M.blocked[i] || guardAt.has(i));
		for (const t of M.objs.filter(o => o.cls === 'town' && starts.some(a => a.l === o.l && Math.max(Math.abs(a.at[0] - o.at[0]), Math.abs(a.at[1] - o.at[1])) <= 1)))
			for (const i of M.approach(t)) if (open(i) && !seen.has(i)) { seen.add(i); q.push(i); }
		assert.ok(q.length, 'a start door');
		let h = 0;
		const spread = () => {
			for (; h < q.length; h++) {
				const cc = q[h], x = cc % M.W, y = Math.floor(cc / M.W) % M.H, l = Math.floor(cc / (M.W * M.H));
				for (const [dx, dy] of N8) if (M.inb(x + dx, y + dy)) { const k = M.idx(l, x + dx, y + dy); if (open(k) && !seen.has(k)) { seen.add(k); q.push(k); } }
			}
		};
		spread();
		// the map's two-way monolith pairs carry a hero from one end's door to the other's (the generator keeps its reach through them)
		const mono = M.objs.filter(o => o.type === 'monolithTwoWay');
		for (let grew = true; grew;) {
			grew = false;
			for (const o of mono) if ([...M.approach(o)].some(i => seen.has(i)))
				for (const p2 of mono) if (p2 !== o && p2.subtype === o.subtype) for (const i of M.approach(p2)) if (open(i) && !seen.has(i)) { seen.add(i); q.push(i); grew = true; }
			spread();
		}
		for (const o of c.objs) {
			assert.ok([...M.approach(o)].some(i => seen.has(i)), `seed ${s}: ${o.type} at (${o.at}) has no door a hero reaches`);
		}
		const ent = c.objs.filter(o => o.type === 'monolithOneWayEntrance'), ex = c.objs.filter(o => o.type === 'monolithOneWayExit');
		for (const e of ent) assert.ok(ex.some(x => x.subtype === e.subtype), `seed ${s}: entrance ${e.subtype} has no exit`);
		for (const e of ex) assert.ok(ent.some(x => x.subtype === e.subtype), `seed ${s}: exit ${e.subtype} has no entrance`);
	}
});

test('a named template has no special buildings of the slider\'s: Coldshadow\'s Fantasy is the same map at 0x and 3x', { timeout: 600000 }, () => {
	const at = (tag, v) => {
		const out = path.join(dir, tag + '.vmap');
		const r = spawnSync(process.execPath, [CLI, '--w', '72', '--h', '72', '--players', '4', '--seed', '2', '--template', "Coldshadow's Fantasy", '--bio.specialDensity', v, '--out', out],
			{ encoding: 'utf8', cwd: ROOT, env: genEnv(), windowsHide: true, timeout: 280000 });
		assert.strictEqual(r.status, 0, r.stderr.slice(-600));
		return count(out).objs.map(o => `${o.type}:${o.subtype}@${o.l},${o.at[0]},${o.at[1]}`).sort();
	};
	assert.deepStrictEqual(at('cs3', '3'), at('cs0', '0'));
});

test('a special building that asks for a guard has its guard tile held at placement: 12 maps, at least 75 percent of the asks stand guarded', { timeout: 2400000 }, () => {
	// the ask is drawn with the building and the guard's tile is held when it is placed, as stock lays a pile (S350); drawn at the guard pass 32 to 41 percent of
	// the asks found no tile under the stock spacing rules. VMAPGEN_TRACE_SPECIAL=1 prints one line a building: asked, posted, shared.
	let asked = 0, posted = 0, shared = 0;
	for (let seed = 1; seed <= 12; seed++) {
		const out = path.join(dir, 'ask' + seed + '.vmap');
		const r = spawnSync(process.execPath, [CLI, '--w', '108', '--h', '108', '--players', '4', '--seed', String(seed), '--bio.specialDensity', '1', '--out', out],
			{ encoding: 'utf8', cwd: ROOT, env: { ...genEnv(), VMAPGEN_TRACE_SPECIAL: '1' }, windowsHide: true, timeout: 280000 });
		assert.strictEqual(r.status, 0, r.stderr.slice(-600));
		for (const l of r.stderr.split('\n')) {
			const m = /^\[special guard\] \w+ asked (\d) posted (\d) shared (\d)/.exec(l);
			if (m) { asked += +m[1]; posted += +m[2]; shared += +m[3]; }
		}
	}
	assert.ok(asked >= 8, `too few asks to judge: ${asked}`);
	assert.ok((posted + shared) / asked >= 0.75, `${posted} posted and ${shared} shared of ${asked} asks`);
});
