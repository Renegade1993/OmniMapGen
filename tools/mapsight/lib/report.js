'use strict';
/**
 * report.js - one report per template, written for the agent who tunes the generator: everything ours does that the
 * engine does not, with numbers, ranges and coordinates.
 *
 *   mapsight report --engine DIR --ours DIR [--match REGEX] --out DIR [--maps K-route maps --as <template id>]
 *
 * Calibrated flags. For each measure the engine's seeds give a median and a spread (median absolute deviation, with a
 * floor). Every engine seed is scored against the other seeds the same way (leave one out) over all templates; the 99th
 * percentile of those scores is the "definite" line and the 95th the "lean" line, so a definite flag is a difference no
 * more than 1 in 100 real engine maps shows. Calibration is cached beside the profiles (calibration.json).
 *
 * Sections: settings; fixed checks (road ends, dragons, starts); relational measures; content (object types per 1000
 * tiles: missing, extra, off); every improper road end of ours.
 */
const fs = require('fs');
const path = require('path');
const { profile, version, CACHE } = require('./profile');
const { CHECKS } = require('./compare');

function opt(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }
function list(args, name) {
	const out = [];
	args.forEach((a, i) => { if (a === name) for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) out.push(args[j]); });
	return out;
}
const vmaps = dir => (dir && fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.vmap$/i.test(f)).map(f => path.join(dir, f)) : []);
const groupOf = f => path.basename(f).replace(/\.vmap$/i, '').replace(/_s\d+$/, '');
const med = a => { const b = [...a].sort((x, y) => x - y); const n = b.length; return n % 2 ? b[n >> 1] : (b[n / 2 - 1] + b[n / 2]) / 2; };
const pc = (a, p) => { const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * b.length))]; };

/** Robust score of v against engine values: distance from their median in units of their spread. */
function score(v, ev, floor) {
	const m = med(ev);
	const mad = med(ev.map(x => Math.abs(x - m))) * 1.4826;
	return (v - m) / Math.max(mad, floor);
}
const FLOOR_SHARE = 0.03;
const floorCensus = ev => Math.max(0.05, 0.25 * med(ev));        // per-1000-tile counts: a quarter of the median, at least 0.05

/** Leave-one-out over the engine seeds of every template: the score lines a real engine map crosses 1 and 5 times in 100. */
function calibrate(groups) {
	const cf = path.join(CACHE, `calibration-${version()}.json`);
	if (fs.existsSync(cf)) return JSON.parse(fs.readFileSync(cf, 'utf8'));
	const sm = [], sc = [];
	for (const [, g] of groups) {
		const E = g.engine.map(profile);
		if (E.length < 5) continue;
		for (let k = 0; k < E.length; k++) {
			const rest = E.filter((_, j) => j !== k);
			for (const [n, v] of Object.entries(E[k].measures)) {
				if ((E[k].counts[n] || 0) < 5) continue;
				const ev = rest.filter(e => e.measures[n] !== undefined && (e.counts[n] || 0) >= 5).map(e => e.measures[n]);
				if (ev.length >= 4) sm.push(Math.abs(score(v, ev, FLOOR_SHARE)));
			}
			const types = new Set(rest.flatMap(e => Object.keys(e.census)));
			for (const t of types) {
				const ev = rest.map(e => e.census[t] || 0);
				if (med(ev) <= 0) continue;
				sc.push(Math.abs(score(E[k].census[t] || 0, ev, floorCensus(ev))));
			}
		}
	}
	const cal = { measures: { definite: pc(sm, 0.99), lean: pc(sm, 0.95), n: sm.length }, census: { definite: pc(sc, 0.99), lean: pc(sc, 0.95), n: sc.length } };
	fs.mkdirSync(CACHE, { recursive: true });
	fs.writeFileSync(cf, JSON.stringify(cal));
	return cal;
}

function pct(v) { return `${Math.round(100 * v)}%`; }
function num(v) { return (Math.round(v * 100) / 100).toString(); }

function reportGroup(id, E, O, cal, kinds, noBase) {
	// the target: what a real engine map of this template scores, each seed in turn against the others
	let base = null;
	if (!noBase && E.length >= 5) {
		const b = E.map((e, k) => reportGroup(id, E.filter((_, j) => j !== k), [e], cal, new Map(), true));
		const d = b.map(x => x.definite).sort((x, y) => x - y), f = b.map(x => x.data.fixedFails.length).sort((x, y) => x - y);
		base = { definite: d, fixed: f };
	}
	const L = [];
	L.push(`# ${id}`);
	L.push('');
	L.push(`Engine: ${E.length} seeds. Ours: ${O.map(o => `${path.basename(o.file)}${kinds.get(o.file) ? ' (' + kinds.get(o.file) + ')' : ''}`).join(', ')}. Tool version ${version()}.`);
	if (base) L.push(`TARGET: a real engine map of this template, scored against the other engine seeds the same way, gets ${base.definite[0]} to ${base.definite[base.definite.length - 1]} definite flags (median ${base.definite[base.definite.length >> 1]}) and ${base.fixed[0]} to ${base.fixed[base.fixed.length - 1]} fixed-check failures. Ours is dialled in when it scores inside that.`);
	L.push(`Flags are calibrated: "definite" means a score a real engine map reaches less than 1 time in 100 (|score| over ${num(cal.measures.definite)} for measures, ${num(cal.census.definite)} for content), "lean" less than 5 in 100. Score = distance from the engine's median in units of its spread.`);
	let definite = 0, lean = 0;
	// ---- settings
	L.push('', '## Settings');
	const es = E[0].settings;
	for (const o of O) {
		const s = o.settings, diffs = [];
		for (const k of ['w', 'h', 'levels']) if (s[k] !== es[k]) diffs.push(`${k} ${s[k]} against the engine's ${es[k]}`);
		const ep = [...new Set(E.map(e => e.settings.players))];
		if (!ep.includes(s.players)) diffs.push(`start slots ${s.players} against the engine's ${ep.join('/')} (the engine fills every start zone of the template; check the player count setting)`);
		L.push(`- ${path.basename(o.file)}: ${diffs.length ? diffs.join('; ') : 'same size, levels and start slots as the engine'}`);
	}
	// ---- fixed checks
	L.push('', '## Fixed checks (fail when ours is beyond the engine\'s worst seed)');
	const range = m => { const v = E.map(e => e.metrics[m]).filter(x => x !== null && x !== undefined); return v.length ? { min: Math.min(...v), max: Math.max(...v) } : null; };
	for (const c of CHECKS) {
		const r = range(c.m);
		if (!r) continue;
		const cells = O.map(o => { const v = o.metrics[c.m]; if (v === null || v === undefined) return 'n/a'; const f = c.fail(v, r); if (f) definite++; return `${c.pct ? pct(v) : num(v)}${f ? ' FAIL' : ''}`; });
		L.push(`- ${c.name}: engine ${c.pct ? pct(r.min) : num(r.min)} to ${c.pct ? pct(r.max) : num(r.max)}; ours ${cells.join(', ')}${c.why ? ` (${c.why})` : ''}`);
	}
	// ---- relational measures
	const rows = [];
	const names = new Set([...E, ...O].flatMap(p => Object.keys(p.measures)));
	for (const n of names) {
		const ev = E.filter(e => e.measures[n] !== undefined && (e.counts[n] || 0) >= 5).map(e => e.measures[n]);
		if (ev.length < 4) continue;
		const ov = O.filter(o => o.measures[n] !== undefined && (o.counts[n] || 0) >= 5);
		if (!ov.length) continue;
		const zs = ov.map(o => score(o.measures[n], ev, FLOOR_SHARE));
		const z = med(zs);
		const level = Math.abs(z) > cal.measures.definite ? 'definite' : Math.abs(z) > cal.measures.lean ? 'lean' : null;
		if (!level) continue;
		const o0 = ov[0], more = z > 0;
		const ex = (more ? o0.examples[n] : o0.counter[n]) || [];
		rows.push({ n, z, level, ev, ov: ov.map(o => o.measures[n]), ex, map: path.basename(o0.file), more, evx: (E.find(e => (e.examples[n] || []).length) || { examples: {} }).examples[n] || [] });
	}
	rows.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
	definite += rows.filter(r => r.level === 'definite').length; lean += rows.filter(r => r.level === 'lean').length;
	L.push('', `## Spatial relationships (${rows.filter(r => r.level === 'definite').length} definite, ${rows.filter(r => r.level === 'lean').length} lean)`);
	for (const r of rows) {
		L.push(`- ${r.level.toUpperCase()} ${r.n}: ours ${r.ov.map(pct).join(', ')}; engine ${pct(Math.min(...r.ev))} to ${pct(Math.max(...r.ev))}, median ${pct(med(r.ev))} (score ${num(r.z)}, ours has ${r.more ? 'more' : 'less'})`);
		if (r.ex.length) L.push(`  - ${r.more ? 'in ours' : 'in ours, without it'} (${r.map}): ${r.ex.slice(0, 6).join('; ')}`);
		if (!r.more && r.evx.length) L.push(`  - in the engine's, with it: ${r.evx.slice(0, 3).join('; ')}`);
	}
	// ---- content
	const types = new Set([...E, ...O].flatMap(p => Object.keys(p.census)));
	const missing = [], extra = [], off = [];
	for (const t of types) {
		const ev = E.map(e => e.census[t] || 0), present = ev.filter(x => x > 0).length;
		const ov = O.map(o => o.census[t] || 0);
		const om = med(ov);
		if (present >= Math.ceil(0.75 * E.length) && om === 0) { missing.push({ t, em: med(ev) }); continue; }
		if (present === 0 && om > 0) { extra.push({ t, om }); continue; }
		if (med(ev) <= 0) continue;
		const z = score(om, ev, floorCensus(ev));
		if (Math.abs(z) > cal.census.lean) off.push({ t, z, om, em: med(ev), lo: Math.min(...ev), hi: Math.max(...ev), level: Math.abs(z) > cal.census.definite ? 'definite' : 'lean' });
	}
	missing.sort((a, b) => b.em - a.em); extra.sort((a, b) => b.om - a.om); off.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
	definite += missing.length + off.filter(o => o.level === 'definite').length; lean += off.filter(o => o.level === 'lean').length;
	L.push('', `## Content per 1000 tiles (${missing.length} missing, ${extra.length} extra, ${off.length} off)`);
	if (missing.length) L.push(`- MISSING in ours, present on ${'3 of 4'.replace('3 of 4', 'at least three quarters of')} the engine's seeds: ${missing.slice(0, 30).map(m => `${m.t} (${num(m.em)})`).join(', ')}`);
	if (extra.length) L.push(`- EXTRA in ours, on no engine seed: ${extra.slice(0, 30).map(m => `${m.t} (${num(m.om)})`).join(', ')}`);
	for (const o of off.slice(0, 40)) L.push(`- ${o.level.toUpperCase()} ${o.t}: ours ${num(o.om)}, engine ${num(o.lo)} to ${num(o.hi)}, median ${num(o.em)} (score ${num(o.z)})`);
	const cls = new Set([...E, ...O].flatMap(p => Object.keys(p.classes)));
	L.push(`- by class (engine median / ours): ${[...cls].sort().map(c => `${c} ${num(med(E.map(e => e.classes[c] || 0)))}/${num(med(O.map(o => o.classes[c] || 0)))}`).join(', ')}`);
	// ---- road ends
	L.push('', '## Improper road ends in ours');
	for (const o of O) {
		const b = o.roadBad;
		L.push(`- ${path.basename(o.file)}: ${b.length ? b.slice(0, 15).map(e => `${e.kind} at (${e.at}${e.l ? ',L1' : ''})${e.kind === 'gap' ? ` near road (${e.gapTo})` : `, ${e.arm} tiles from ${e.to}`}${e.touch && e.touch.length ? ` [${e.touch.join(' ')}]` : ''}`).join('; ') : 'none'}${b.length > 15 ? ` ... (${b.length})` : ''}`);
	}
	const fixedFails = CHECKS.filter(c => { const r = range(c.m); return r && O.some(o => o.metrics[c.m] !== null && o.metrics[c.m] !== undefined && c.fail(o.metrics[c.m], r)); }).map(c => c.name);
	const data = { id, fixedFails, measures: rows.map(r => ({ n: r.n, level: r.level, z: r.z, more: r.more, engine: med(r.ev), ours: med(r.ov) })),
		missing: missing.map(m => m.t), extra: extra.map(m => m.t), off: off.map(o => ({ t: o.t, level: o.level, z: o.z, ours: o.om, engine: o.em })) };
	if (base) data.base = base;
	return { text: L.join('\n') + '\n', data, base, definite, lean, missing: missing.length, extra: extra.length, roadBad: med(O.map(o => o.roadBad.length)) };
}

function main(args) {
	const match = opt(args, '--match') ? new RegExp(opt(args, '--match'), 'i') : null;
	const out = opt(args, '--out');
	if (!out) { console.log('report needs --out DIR'); process.exitCode = 2; return; }
	const groups = new Map();
	const add = (side, f, g) => { g = g || groupOf(f); if (!groups.has(g)) groups.set(g, { engine: [], ours: [] }); groups.get(g)[side].push(f); };
	vmaps(opt(args, '--engine')).forEach(f => add('engine', f));
	vmaps(opt(args, '--ours')).forEach(f => add('ours', f));
	const kinds = new Map();
	if (opt(args, '--as')) for (const f of list(args, '--maps')) { add('ours', f, opt(args, '--as')); kinds.set(f, 'K route'); }
	const cal = calibrate(groups);
	console.log(`calibration (leave one out over the engine seeds): measures definite ${num(cal.measures.definite)}, lean ${num(cal.measures.lean)} (${cal.measures.n} scores); content definite ${num(cal.census.definite)}, lean ${num(cal.census.lean)} (${cal.census.n})`);
	fs.mkdirSync(out, { recursive: true });
	const index = [];
	for (const [id, g] of [...groups].sort()) {
		if (match && !match.test(id)) continue;
		if (g.engine.length < 4 || !g.ours.length) continue;
		const r = reportGroup(id, g.engine.map(profile), g.ours.map(profile), cal, kinds);
		fs.writeFileSync(path.join(out, `${id}.md`), r.text);
		fs.writeFileSync(path.join(out, `${id}.json`), JSON.stringify(r.data));
		index.push({ id, ...r });
		console.log(`${id}: ${r.definite} definite, ${r.lean} lean, missing ${r.missing}, extra ${r.extra}, improper road ends ${r.roadBad}`);
	}
	index.sort((a, b) => b.definite - a.definite);
	const I = ['# mapsight report index', '', `Tool version ${version()}. Calibration: measures definite ${num(cal.measures.definite)}, lean ${num(cal.measures.lean)}; content definite ${num(cal.census.definite)}, lean ${num(cal.census.lean)}.`, '',
		'Target: an engine map scored against the other engine seeds; ours is dialled in when its definite flags fall inside the target range.', '',
		'| template | definite | target (engine) | lean | content missing | content extra | improper road ends (median) |', '|---|---|---|---|---|---|---|',
		...index.map(r => `| [${r.id}](${r.id}.md) | ${r.definite} | ${r.base ? `${r.base.definite[0]} to ${r.base.definite[r.base.definite.length - 1]}` : 'n/a'} | ${r.lean} | ${r.missing} | ${r.extra} | ${r.roadBad} |`)];
	// what is wrong on most templates: fix these first
	const n = index.length, by = new Map(), cont = new Map(), fx = new Map();
	for (const r of index) {
		for (const m of r.data.measures) if (m.level === 'definite') {
			const e = by.get(m.n) || { n: m.n, k: 0, more: 0, eng: [], ours: [] };
			e.k++; if (m.more) e.more++; e.eng.push(m.engine); e.ours.push(m.ours); by.set(m.n, e);
		}
		for (const t of r.data.missing) cont.set(`missing ${t}`, (cont.get(`missing ${t}`) || 0) + 1);
		for (const t of r.data.extra) cont.set(`extra ${t}`, (cont.get(`extra ${t}`) || 0) + 1);
		for (const o of r.data.off) if (o.level === 'definite') { const k = `${o.z > 0 ? 'too many' : 'too few'} ${o.t}`; cont.set(k, (cont.get(k) || 0) + 1); }
		for (const f of r.data.fixedFails) fx.set(f, (fx.get(f) || 0) + 1);
	}
	I.push('', `## Fix first: what is wrong on most of the ${n} templates`, '', '### Fixed checks failing', '');
	for (const [k, v] of [...fx].sort((a, b) => b[1] - a[1])) I.push(`- ${k}: ${v} of ${n} templates`);
	I.push('', '### Spatial relationships flagged definite', '');
	for (const e of [...by.values()].sort((a, b) => b.k - a.k))
		I.push(`- ${e.n}: ${e.k} of ${n} templates, ours ${e.more * 2 > e.k ? 'more' : 'less'}; engine median ${Math.round(100 * med(e.eng))}%, ours ${Math.round(100 * med(e.ours))}%`);
	I.push('', '### Content (definite on 3+ templates)', '');
	for (const [k, v] of [...cont].filter(([, v]) => v >= 3).sort((a, b) => b[1] - a[1]).slice(0, 60)) I.push(`- ${k}: ${v} templates`);
	fs.writeFileSync(path.join(out, 'index.md'), I.join('\n') + '\n');
}

module.exports = { main, calibrate, score };
