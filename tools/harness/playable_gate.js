'use strict';
/**
 * playable_gate.js - the minimally playable gate over the configurations the options allow (K 2026-10-11 16:10: "they all lead to minimally playable outcomes at the
 * very least for all potential configurations").
 *
 *   node tools/harness/playable_gate.js --tip DIR --out DIR [--extremes 1] [--random N] [--seed 1] [--lanes 3] [--deadline-min 60] [--water 1] [--eval] [--cases FILE]
 *
 * A configuration passes when the map is written and loads, and
 *   - mapsight's hard checks pass (lib/check.js: road ends, a start shut at its gate, sealed objects, empty zones, split zones, own town behind a guard, teleport off road),
 *   - every start town has a road (grid_extra start-road) and every town has one on its front tile (playtest_checks town-road),
 *   - no start is boxed in: walking from the start town over open ground without entering a stack's 3x3 ring reaches at least 8 tiles on a map up to 48 wide, 50 above (the engine's own minimums on dry maps: 0, 57, 210),
 *   - no land zone of 40 walkable tiles or more is out of reach for a hero without a boat (guards are fights, not walls; monoliths and gates are taken), except on a
 *     map with water, where a zone reached only across water is reported as "by water" and not failed,
 *   - the number of start towns equals the number of players asked.
 * Per start, the tiles it walks to, the land zones it reaches and whether it can walk to a shipyard are listed in the notes; a start that misses a land zone and has no shipyard in reach
 * fails the map (the Mediterranean cases of the lead, 10-11 17:00). --water 1 adds the AoE water layouts (1 to 6) at 108 and 144 with seeds 1 and 7001 and K's 180x180 seed.
 * Configurations: with --extremes every lever alone at its minimum and its maximum on three configurations (open layout 72x72 four players, Coldshadow 108x108 four
 * players, open layout with an underground), then --random N combinations (size 36 to 144, players 2 to 8, one or two levels, open layout or the template, three to six levers
 * at an extreme or a random value), all fixed by --seed. Failing configurations are written to OUT/cases.json under a name with their full options, so they rerun.
 */
const fs = require('fs'), path = require('path');
const { execFile } = require('child_process');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const has = n => process.argv.includes(n);
// a VMAPGEN_* switch set in the shell would change what the generator makes (297 are read in src): the children run without them, and the run says which it found
const STRIPPED = Object.keys(process.env).filter(k => /^VMAPGEN_/.test(k) && k !== 'VMAPGEN_TEST_ROOT');
console.log('environment: ' + (STRIPPED.length ? 'VMAPGEN_* found and removed from the generator runs: ' + STRIPPED.join(', ') : 'no VMAPGEN_* switch set'));
const TIP = path.resolve(arg('--tip', path.join(__dirname, '..', '..')));
const OUT = path.resolve(arg('--out', path.join(TIP, '.tmp', 'playable_gate')));
const LANES = +arg('--lanes', 3), DEADLINE = Date.now() + 60000 * +arg('--deadline-min', 60), RANDOM = +arg('--random', 0), SEED = +arg('--seed', 1);
const ROOT = process.env.VMAPGEN_TEST_ROOT || 'C:/AI Projects/Heroes 3/VCMI/dmbtest';
const K_USER = process.env.DMB_USER_DIR || path.join(require('os').homedir(), 'Documents', 'My Games', "Dead Man's Boots");
const NODE_MODULES = process.env.NODE_PATH || 'C:/AI Projects/Heroes 3/VCMIMapGen/node_modules';
process.env.VCMI_ROOT = process.env.VCMI_ROOT || ROOT;
const sight = require('../mapsight/lib/sight');
const check = require('../mapsight/lib/check');
const { runChecks } = require('./playtest_checks');
const { KNOBS } = require(path.join(TIP, 'src/biome/knobs'));
const { BIOME_DEFAULTS } = require(path.join(TIP, 'src/biome/biomes'));
const cheb = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
const N8 = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 0], [-1, 1]];
const stopVal = s => (s && typeof s === 'object' ? (s.value !== undefined ? s.value : s[0]) : s);
const dflt = k => (k.default !== undefined ? k.default : BIOME_DEFAULTS[k.key]);
const ends = k => (k.stops && k.stops.length ? [stopVal(k.stops[0]), stopVal(k.stops[k.stops.length - 1])] : [k.min, k.max]);
const flag = (k, v) => [k.cli ? k.key : 'bio.' + k.key, v];
const TPL = "Coldshadow's Fantasy";

// ---------------------------------------------------------------------------------------------------------------- configurations
const cases = [];
if (has('--extremes') || (!RANDOM && !has('--water'))) {
	const bases = [{ id: 'free72', o: { w: 72, h: 72, players: 4, humans: 1 } }, { id: 'tpl108', o: { w: 108, h: 108, players: 4, humans: 1, template: TPL } }, { id: 'ug72', o: { w: 72, h: 72, players: 4, humans: 1, underground: 1 } }];
	for (const b of bases) for (const k of KNOBS) {
		if (b.id !== 'ug72' && k.page === 'underground') continue;
		for (const v of [...new Set(ends(k))]) {
			const [fk, fv] = flag(k, v);
			cases.push({ name: `x_${b.id}_${k.key}=${v}`, opt: { ...b.o, [fk]: fv, seed: '1' } });
		}
	}
}
// a small seeded generator so the same --seed gives the same configurations
let rs = SEED * 2654435761 % 4294967296;
const rnd = () => { rs = (rs * 1664525 + 1013904223) % 4294967296; return rs / 4294967296; };
const pick = a => a[Math.floor(rnd() * a.length)];
for (let i = 0; i < RANDOM; i++) {
	const size = pick([36, 36, 48, 72, 72, 108, 108, 144]), players = pick([2, 3, 4, 5, 6, 7, 8]), ug = rnd() < 0.4 ? 1 : 0, tpl = rnd() < 0.5;
	const o = { w: size, h: size, players, humans: Math.min(players, 1 + Math.floor(rnd() * 2)), seed: String(1 + Math.floor(rnd() * 99999)) };
	if (ug) o.underground = 1; if (tpl) o.template = TPL;
	const n = 3 + Math.floor(rnd() * 4), chosen = new Set();
	while (chosen.size < n) chosen.add(pick(KNOBS));
	for (const k of chosen) {
		if (k.page === 'underground' && !ug) continue;
		const r = rnd(); const v = r < 0.4 ? ends(k)[0] : r < 0.8 ? ends(k)[1] : +(k.min + rnd() * (k.max - k.min)).toFixed(2);
		const [fk, fv] = flag(k, v); o[fk] = fv;
	}
	if (o['bio.waterCoverage'] > 0 && o['bio.waterContent'] === undefined) o['bio.waterContent'] = 1;
	cases.push({ name: `r${SEED}_${i}_${size}p${players}${ug ? 'u' : ''}${tpl ? 't' : 'f'}`, opt: o });
}
if (has('--water')) {
	// the water layouts of the AoE library on 108 and 144, two seeds each, K's 180x180 and the cases the lead named (seed 7001), all four players
	let base = {};
	try { base = JSON.parse(fs.readFileSync(arg('--base', 'C:/AI Projects/Heroes 3/.tmp/opus-seeing/k1010/mapgen_180x180_p4_s669067840.vmap.zones.json'), 'utf8')).options; } catch (e) { base = {}; }
	for (const k of Object.keys(base)) if (/^(w|h|seed|out|vcmiroot|vcmiuserdir|bio.water.*)$/.test(k)) delete base[k];
	const SH = [[1, 'coastal', 0.35], [2, 'continental', 0.45], [3, 'mediterranean', 0.45], [4, 'highland', 0.35], [5, 'islands', 0.45], [6, 'archipelago', 0.45]];
	for (const size of [108, 144]) for (const seed of [1, 7001]) for (const [id, nm, cov] of SH) cases.push({ name: `w_${nm}_${size}_s${seed}`, opt: { ...base, w: size, h: size, players: 4, humans: 4, seed: String(seed), 'bio.waterShape': id, 'bio.waterCoverage': cov, 'bio.waterContent': id >= 5 ? 2 : 1, factions: 'random,random,random,random' } });
	cases.push({ name: 'w_mediterranean_180_k', opt: { ...base, w: 180, h: 180, players: 4, humans: 4, seed: '669067840', 'bio.waterShape': 3, 'bio.waterCoverage': 0.45, 'bio.waterContent': 1, factions: 'random,random,random,random' } });
}
if (arg('--cases')) { cases.length = 0; for (const c of JSON.parse(fs.readFileSync(arg('--cases'), 'utf8'))) cases.push(c); }

// ---------------------------------------------------------------------------------------------------------------- evaluation
function evaluate(file, c) {
	const fails = [], notes = [];
	let M;
	try { M = sight.load(file); } catch (e) { return { fails: [`does not load: ${String(e.message).slice(0, 120)}`], notes }; }
	try { const r = check.checkMap(file); for (const f of r.fails) fails.push('mapsight: ' + f); } catch (e) { fails.push(`mapsight check failed to run: ${String(e.message).slice(0, 100)}`); }
	let rc = null; try { rc = runChecks(file, ['start-road', 'town-road']).checks; } catch (e) { notes.push('harness checks did not run: ' + String(e.message).slice(0, 80)); }
	if (rc) for (const k of ['start-road', 'town-road']) { const r = rc[k]; if (r && !r.skipped && !r.error && !r.pass) fails.push(`${k}: ${r.value}`); }

	const players = +c.opt.players;
	const st = sight.starts(M);
	// with compOnly set the map's seats are humans + computer-only (stockChoices.js: players is ignored then); -1 is a roll, so only fewer starts than humans is wrong there
	const coRaw = c.opt['bio.compOnly'] !== undefined ? c.opt['bio.compOnly'] : c.opt.compOnly;
	const co = coRaw === undefined ? null : Number(coRaw), humans = c.opt.humans !== undefined ? Number(c.opt.humans) : players;
	const want = co === null ? players : (co > 0 ? Math.min(8, humans + co) : (co === 0 ? humans : null));
	if (want !== null ? st.length !== want : st.length < humans) fails.push(`${st.length} start towns for ${want !== null ? want : 'at least ' + humans} seats (players ${players}, humans ${humans}, compOnly ${co === null ? 'unset' : co})`);
	const WET = new Set(['wa', 'wt']);
	const N = M.W * M.H * M.NL, isWet = i => WET.has(M.terr[i]);
	let wet = 0; for (let i = 0; i < N; i++) if (isWet(i)) wet++;
	const ring = new Uint8Array(N), soft = new Uint8Array(N);
	for (const m of M.monsters) { soft[M.idx(m.l, m.at[0], m.at[1])] = 1; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (M.inb(m.at[0] + dx, m.at[1] + dy)) ring[M.idx(m.l, m.at[0] + dx, m.at[1] + dy)] = 1; }
	for (const o of M.objs) if (o.pickup) for (const [x, y] of (o.cells || [])) if (M.inb(x, y)) soft[M.idx(o.l, x, y)] = 1;
	const openHard = i => M.ground(i) && !isWet(i) && !M.blocked[i] && !ring[i];
	const openSoft = i => M.ground(i) && !isWet(i) && (!M.blocked[i] || soft[i]);
	const portals = M.objs.filter(o => o.cls === 'gate' || o.cls === 'monolith');
	const flood = (seeds, pass, usePortals) => {
		const seen = new Uint8Array(N), q = [], used = new Set();
		const seed = i => { if (pass(i) && !seen[i]) { seen[i] = 1; q.push(i); } };
		seeds.forEach(seed);
		for (;;) {
			for (let h = 0; h < q.length; h++) { const cc = q[h], l = Math.floor(cc / (M.W * M.H)), x = cc % M.W, y = Math.floor(cc / M.W) % M.H; for (const [dx, dy] of N8) if (M.inb(x + dx, y + dy)) seed(M.idx(l, x + dx, y + dy)); }
			q.length = 0;
			if (!usePortals) break;
			let grew = false;
			for (const p of portals) {
				if (used.has(p) || !M.approach(p).some(i => seen[i])) continue;
				used.add(p); grew = true;
				for (const o of portals) if (o.type === p.type && o.subtype === p.subtype) M.approach(o).forEach(seed);
				if (p.cls === 'gate') for (const o of portals) if (o.cls === 'gate') M.approach(o).forEach(seed);
			}
			if (!grew && !q.length) break;
		}
		return seen;
	};
	// starts: boxed in by guards. The engine itself leaves starts with 0 to 8 such tiles on 36x36 (p10 8, median 149), at least 57 on 72x72 (p10 117) and at least 210 on 108 and 144
	// (91 sample maps), so the limit is 8 up to 48 wide and 50 above (water maps hold less land than the dry engine maps, and 100 to 200 tiles is not boxed in)
	const boxMin = M.W <= 48 ? 8 : 50;
	const startTowns = M.objs.filter(o => o.cls === 'town' && st.some(s => s.l === o.l && cheb(s.at, o.at) <= 1));
	const perStart = [], reachHard = [];
	for (const t of startTowns) {
		const hard = flood(M.approach(t), openHard, false); let n = 0; for (let i = 0; i < N; i++) if (hard[i]) n++;
		reachHard.push(n); if (n < boxMin) fails.push(`start (${t.at}) boxed in by guards: ${n} tiles walkable without a fight (limit ${boxMin} for a ${M.W}x${M.H} map)`);
		perStart.push({ t, sf: flood(M.approach(t), openSoft, true) });
	}
	// every start against every land zone (lead 10-11 17:00): a zone of 40 walkable tiles or more is reached when half of it is walkable from the start (guards are fights,
	// monoliths and gates are taken, water is not crossed); a start that misses a zone must have a shipyard it can walk to, else the map fails for that start
	const reachRows = [];
	if (M.zones && M.zones.zoneOf && startTowns.length) {
		const byZone = new Map();
		for (let l = 0; l < M.NL; l++) for (let y = 0; y < M.H; y++) for (let x = 0; x < M.W; x++) {
			const z = M.zoneAt(l, x, y); if (z === undefined || z === null || z < 0) continue;
			const i = M.idx(l, x, y); if (!openSoft(i)) continue;
			const k = `${l}:${z}`; (byZone.get(k) || byZone.set(k, []).get(k)).push(i);
		}
		const zones = [...byZone].filter(([, a2]) => a2.length >= 40);
		const ships = M.objs.filter(o => /shipyard/i.test(o.type));
		for (const ps of perStart) {
			const missing = []; let reached = 0, tiles = 0;
			for (let i = 0; i < N; i++) if (ps.sf[i]) tiles++;
			for (const [k, arr] of zones) { let h = 0; for (const i of arr) if (ps.sf[i]) h++; if (h >= 0.5 * arr.length) reached++; else missing.push(`${k} ${h}/${arr.length}`); }
			const ship = ships.some(o => M.approach(o).some(i => ps.sf[i]));
			reachRows.push({ start: ps.t.at, tiles, zones: zones.length, reached, shipyard: ship });
			if (missing.length && !ship) fails.push(`start (${ps.t.at}) reaches ${reached} of ${zones.length} land zones on foot and has no shipyard in reach; not reached: ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ' ...' : ''}`);
			else if (missing.length) notes.push(`start (${ps.t.at}) reaches ${reached} of ${zones.length} land zones on foot, the rest by boat from a shipyard it can walk to`);
		}
	}
	notes.push(`reach per start (tiles, zones reached of all, shipyard): ${reachRows.map(r => `${r.tiles}, ${r.reached}/${r.zones}, ${r.shipyard ? 'yes' : 'no'}`).join(' | ')}`);
	notes.push(`starts walk ${reachHard.join('/')} tiles, water ${(100 * wet / N).toFixed(0)}%`);
	return { fails, notes };
}

function generate(c, file) {
	const o = { ...c.opt, out: file, vcmiroot: ROOT, vcmiuserdir: K_USER };
	const a = [path.join(TIP, 'src', 'main', 'generate-cli.js')];
	for (const [k, v] of Object.entries(o)) a.push('--' + k, String(v));
	const env = { ...process.env, VCMI_ROOT: ROOT, NODE_PATH: NODE_MODULES }; delete env.NODE_OPTIONS;
	for (const k of STRIPPED) delete env[k];
	return new Promise(r => execFile(process.execPath, a, { env, cwd: TIP, timeout: 600000, windowsHide: true, maxBuffer: 1 << 26 },
		(err, so, se) => { const txt = `${so || ''}${se || ''}`; fs.writeFileSync(file + '.log', txt); r(fs.existsSync(file) ? null : (err ? err.message.slice(0, 200) : 'no map written') + ' | ' + (txt.match(/error[^\n]*/i) || [''])[0].slice(0, 160)); }));
}

(async () => {
	fs.mkdirSync(OUT, { recursive: true });
	const results = [];
	const resultsFile = path.join(OUT, 'gate_results.json');
	const prior = fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile, 'utf8')) : [];
	const done = new Map(prior.map(r => [r.name, r]));
	const todo = cases.filter(c => !done.has(c.name));
	console.log(`gate: ${cases.length} configurations, ${done.size} done before, ${todo.length} to run, ${LANES} lanes`);
	let next = 0, ran = 0;
	const evalQueue = [];
	await Promise.all(Array.from({ length: LANES }, async () => {
		while (next < todo.length && Date.now() < DEADLINE && !fs.existsSync(path.join(OUT, 'STOP'))) {
			const c = todo[next++], file = path.join(OUT, 'maps', `${c.name.replace(/[^\w=.-]/g, '_')}.vmap`);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			let err = fs.existsSync(file) ? null : await generate(c, file);
			let r;
			if (err) r = { name: c.name, opt: c.opt, pass: false, fails: [`not generated: ${err}`], notes: [] };
			else { const e = evaluate(file, c); r = { name: c.name, opt: c.opt, pass: e.fails.length === 0, fails: e.fails, notes: e.notes }; }
			done.set(c.name, r); ran++;
			if (ran % 10 === 0) { console.log(`${ran} of ${todo.length} run, ${[...done.values()].filter(x => !x.pass).length} failing so far`); fs.writeFileSync(resultsFile, JSON.stringify([...done.values()], null, 1)); }
		}
	}));
	const all = cases.map(c => done.get(c.name)).filter(Boolean);
	fs.writeFileSync(resultsFile, JSON.stringify([...done.values()], null, 1));
	const failing = all.filter(r => !r.pass);
	fs.writeFileSync(path.join(OUT, 'cases.json'), JSON.stringify(failing.map(r => ({ name: r.name, opt: r.opt })), null, 1));
	// the tables
	const md = [`# Minimally playable gate (tip ${path.basename(TIP)}, ${new Date().toLocaleDateString('en-CA')})`, '',
		`${all.length} configurations run, ${all.length - failing.length} pass, ${failing.length} fail. Failing configurations are in cases.json (names and full options) and rerun with --cases.`, ''];
	const cause = {};
	for (const r of failing) for (const f of r.fails) { const k = f.replace(/\(\d[^)]*\)|\d+/g, 'N').slice(0, 70); (cause[k] = cause[k] || []).push(r.name); }
	md.push('## Failures by cause', '', '| cause | configurations |', '|---|---|');
	for (const [k, v] of Object.entries(cause).sort((a, b) => b[1].length - a[1].length)) md.push(`| ${k} | ${v.length}: ${v.slice(0, 6).join(', ')}${v.length > 6 ? ' ...' : ''} |`);
	// per lever extreme: pass or fail
	const x = all.filter(r => r.name.startsWith('x_'));
	if (x.length) {
		md.push('', '## Levers alone at their minimum and maximum', '', '| lever=value | free72 | tpl108 | ug72 |', '|---|---|---|---|');
		const rows = new Map();
		for (const r of x) { const m = r.name.match(/^x_(free72|tpl108|ug72)_(.+)$/); if (!m) continue; const e = rows.get(m[2]) || {}; e[m[1]] = r.pass ? 'pass' : 'FAIL'; rows.set(m[2], e); }
		for (const [k, e] of rows) md.push(`| ${k} | ${e.free72 || ''} | ${e.tpl108 || ''} | ${e.ug72 || ''} |`);
	}
	md.push('', '## Failing configurations', '');
	for (const r of failing) md.push(`- ${r.name}: ${r.fails.join('; ')}`);
	fs.writeFileSync(path.join(OUT, 'GATE.md'), md.join('\n') + '\n');
	console.log(`gate done: ${all.length} run, ${failing.length} failing -> ${path.join(OUT, 'GATE.md')}`);
})();
