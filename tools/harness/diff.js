/**
 * diff.js - the engine's maps against ours, per template and setting, over the seeds of a grid run.
 *
 * node tools/harness/diff.js --run <grid out dir> [--min-seeds 3] [--only <regex on group id>]
 * Reads <run>/engine/*.vmap and <run>/ours/*.vmap (run_grid.py), measures each once (cached under
 * <run>/measures), groups by job id (the run name without its _s<seed>), and writes
 *   <run>/report.txt     per group: map-level measures, zone sizes, zone objects (the intent), gaps flagged
 *   <run>/findings.json  every flagged gap as data, and the gaps that repeat across groups
 * A map-level gap is flagged only when the means differ by more than twice the spread of either side
 * (the seed noise) and by a tenth of the engine's value, so a difference that a reroll would erase is not
 * reported. A zone object is "missing" when the engine puts one in the zone on average and ours at a
 * fifth of that or less, and "extra" when ours holds four times the engine's and at least two.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { measureRun } = require('./measure');
const { lookups, loadIndex, FIELDS } = require('../map_metrics');

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : null; };
const RUN = path.resolve(opt('run') || '.');
const MINSEEDS = +(opt('min-seeds') || 3);
const ONLY = opt('only') ? new RegExp(opt('only')) : null;
const L = lookups(loadIndex());

const mean = a => a.reduce((s, v) => s + v, 0) / (a.length || 1);
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const fmt = v => v === null || v === undefined || !Number.isFinite(v) ? '-' : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);

function load(side, name) {
	const base = path.join(RUN, side, name);
	const cache = path.join(RUN, 'measures', side + '_' + name + '.json');
	if (fs.existsSync(cache) && fs.statSync(cache).mtimeMs > fs.statSync(base + '.vmap').mtimeMs) return JSON.parse(fs.readFileSync(cache, 'utf8'));
	const have = side === 'engine' ? fs.existsSync(base + '.zones.json') : fs.existsSync(base + '.zonedump.json');
	if (!have) return null;
	let m;
	try { m = measureRun(side, base, L); } catch (e) { console.error(`${side} ${name}: ${e.message}`); return null; }
	fs.mkdirSync(path.dirname(cache), { recursive: true });
	fs.writeFileSync(cache, JSON.stringify(m));
	return m;
}

const names = side => fs.existsSync(path.join(RUN, side)) ? fs.readdirSync(path.join(RUN, side)).filter(f => f.endsWith('.vmap')).map(f => f.slice(0, -5)) : [];
const groups = new Map();
for (const side of ['engine', 'ours'])
	for (const n of names(side)) {
		const g = n.replace(/_s\d+$/, '');
		if (ONLY && !ONLY.test(g)) continue;
		if (!groups.has(g)) groups.set(g, { engine: [], ours: [] });
		const m = load(side, n);
		if (m) groups.get(g)[side].push(m);
	}

const MAP_KEYS = FIELDS.map(([k]) => k).filter(k => !/^(water|land_mirror)/.test(k));
const out = [], findings = [];
const flag = (e, o, floor) => {
	if (e.length < MINSEEDS || o.length < MINSEEDS) return null;
	const me = mean(e), mo = mean(o), noise = Math.max(sd(e), sd(o));
	const d = mo - me;
	if (Math.abs(d) > Math.max(2 * noise, 0.1 * Math.abs(me), floor)) return d > 0 ? 'ours higher' : 'ours lower';
	return null;
};

for (const [g, s] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
	if (s.engine.length < MINSEEDS || s.ours.length < MINSEEDS) continue;
	out.push(`\n=== ${g}   (${s.engine.length} engine maps, ${s.ours.length} of ours)`);
	// A. the map as a whole
	out.push('  map-level                                         engine (sd)        ours (sd)   gap');
	const rows = [];
	const classes = new Set(); for (const m of [...s.engine, ...s.ours]) for (const c of Object.keys(m.classes)) classes.add(c);
	for (const c of [...classes].sort()) rows.push([`class ${c} per 1000 tiles`, s.engine.map(m => m.classes[c] || 0), s.ours.map(m => m.classes[c] || 0), 0.3]);
	for (const k of MAP_KEYS) rows.push([k, s.engine.map(m => m.map[k]).filter(Number.isFinite), s.ours.map(m => m.map[k]).filter(Number.isFinite), 0.03]);
	for (const [name, e, o, floor] of rows) {
		if (!e.length || !o.length) continue;
		const f = flag(e, o, floor);
		out.push(`  ${name.padEnd(44)} ${fmt(mean(e)).padStart(8)} (${fmt(sd(e))})  ${fmt(mean(o)).padStart(8)} (${fmt(sd(o))})  ${f || ''}`);
		if (f) findings.push({ group: g, kind: 'map', measure: name, engine: mean(e), ours: mean(o), dir: f });
	}
	// B. zones: size and what stands in each
	const ids = new Set(); for (const m of [...s.engine, ...s.ours]) for (const id of Object.keys(m.zones)) ids.add(id);
	out.push('  zones: share of land tiles, engine against ours; objects the engine has and ours lacks (or the reverse)');
	for (const id of [...ids].sort((a, b) => +a - +b)) {
		const share = m => { const z = m.zones[id]; if (!z) return 0; const tot = Object.values(m.zones).reduce((t, q) => t + q.tiles, 0); return tot ? z.tiles / tot : 0; };
		const es = s.engine.map(share), os = s.ours.map(share);
		const meta = s.engine.map(m => m.zones[id]).find(Boolean);
		const zf = flag(es, os, 0.02);
		const keys = new Set(); for (const m of [...s.engine, ...s.ours]) if (m.zones[id]) for (const k of Object.keys(m.zones[id].objects)) keys.add(k);
		const miss = [], extra = [];
		for (const k of keys) {
			if (classOfKey(k) === 'decor') continue;
			const e = s.engine.map(m => (m.zones[id] && m.zones[id].objects[k]) || 0), o = s.ours.map(m => (m.zones[id] && m.zones[id].objects[k]) || 0);
			const me = mean(e), mo = mean(o);
			const inE = e.filter(v => v > 0).length / e.length;
			if (me >= 0.5 && mo <= 0.2 * me && inE >= 0.5) miss.push([k, me, mo]);
			else if (mo >= 2 && mo >= 4 * me) extra.push([k, me, mo]);
		}
		miss.sort((a, b) => b[1] - a[1]);
		extra.sort((a, b) => b[2] - a[2]);
		const line = `  zone ${String(id).padEnd(3)} ${meta ? (meta.type + ' ' + String(meta.town || '').replace(/^core:/, '')).padEnd(26) : ''.padEnd(26)} share ${fmt(mean(es))} / ${fmt(mean(os))}${zf ? '  [' + zf + ']' : ''}`;
		out.push(line);
		if (zf) findings.push({ group: g, kind: 'zoneSize', zone: id, engine: mean(es), ours: mean(os), dir: zf });
		for (const [k, me, mo] of miss.slice(0, 8)) { out.push(`      MISSING in ours: ${k}  engine ${fmt(me)}  ours ${fmt(mo)}`); findings.push({ group: g, kind: 'missing', zone: id, key: k, engine: me, ours: mo }); }
		for (const [k, me, mo] of extra.slice(0, 5)) { out.push(`      EXTRA in ours:   ${k}  engine ${fmt(me)}  ours ${fmt(mo)}`); findings.push({ group: g, kind: 'extra', zone: id, key: k, engine: me, ours: mo }); }
	}
}

function classOfKey(k) { return require('./measure').classOf(k); }

// the gaps that repeat: the same measure or the same missing object in several groups
const rep = new Map();
for (const f of findings) {
	const k = f.kind === 'map' ? `map ${f.measure} (${f.dir})` : f.kind === 'zoneSize' ? `zone size (${f.dir})` : `${f.kind} ${f.key}`;
	if (!rep.has(k)) rep.set(k, { n: 0, groups: new Set(), sumE: 0, sumO: 0 });
	const r = rep.get(k); r.n++; r.groups.add(f.group); r.sumE += f.engine; r.sumO += f.ours;
}
out.push('\n=== gaps that repeat across groups (the consistent ones)');
for (const [k, r] of [...rep].sort((a, b) => b[1].groups.size - a[1].groups.size).slice(0, 60))
	if (r.groups.size >= 2) out.push(`  ${String(r.groups.size).padStart(3)} groups  ${k}   engine ${fmt(r.sumE / r.n)} ours ${fmt(r.sumO / r.n)}`);

fs.writeFileSync(path.join(RUN, 'report.txt'), out.join('\n') + '\n');
fs.writeFileSync(path.join(RUN, 'findings.json'), JSON.stringify(findings, null, 1));
console.log(`${groups.size} groups, ${findings.length} flagged gaps -> ${path.join(RUN, 'report.txt')}`);
