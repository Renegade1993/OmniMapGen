'use strict';
/**
 * sweep.js - go over a map one area at a time and compare each with the engine's areas of the same kind.
 * K, 2026-10-01: "do an open-ended sweep of the map and pick a zone at a time and compare".
 *
 *   mapsight sweep --run DIR|--engine DIR [--match REGEX] (--ours DIR | --maps FILE ...) [--top 6] [--pictures DIR] [--json out]
 *
 * An area is a guard-free region of AREA_MIN+ tiles: the open ground a zone is made of, found the same way on every map
 * (maps from K's game carry no zone file, and ours numbers its zones unlike the template). Kind: "start" (a player's
 * main town is visited from it), "town" (another town), "dragon cache" (neutral dragon dwellings, no town), "wild".
 * Each area of ours is measured with every relational measure (relations.js) limited to the area, plus its size and
 * contents per 100 tiles, and compared with the engine's areas of the same kind and level over all its seeds (10th to
 * 90th percentile). The measures furthest outside come first, with coordinates inside the area.
 * --pictures writes, for each area of ours, a crop of it and of the engine area of the same kind closest in size, at
 * the same scale, for the agent to open when the numbers say something is off.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const sight = require('./sight');
const { describe, AREA_MIN } = require('./relations');

function opt(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }
function list(args, name) {
	const out = [];
	args.forEach((a, i) => { if (a === name) for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) out.push(args[j]); });
	return out;
}
const vmaps = dir => (dir && fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.vmap$/i.test(f)).map(f => path.join(dir, f)) : []);
const q = (a, p) => { const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.max(0, Math.round(p * (b.length - 1))))]; };
const fmt = (v, share) => (share ? `${Math.round(100 * v)}%` : (Math.round(v * 10) / 10).toString());

/** Every area of one map with its kind, place, contents and measures. */
function areasOf(file) {
	const A = sight.analyse(file), M = A.M;
	describe(A);                                     // builds A._areaOf
	const areaOf = A._areaOf;
	const out = [];
	const startAreas = new Set(A.starts.map(s => areaOf({ type: 'start', at: s.at, l: s.l })));
	for (const r of M.regions.filter(x => x.tiles >= AREA_MIN)) {
		const objs = M.objs.filter(o => o.cls !== 'other' && areaOf(o) === r.id);
		const has = c => objs.filter(o => o.cls === c).length;
		const dragons = A.census.filter(d => d.dragon && areaOf(d.o) === r.id).length;
		let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
		for (let y = 0; y < M.H; y++) for (let x = 0; x < M.W; x++) if (M.region[M.idx(r.l, x, y)] === r.id) {
			x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
		}
		const kind = startAreas.has(r.id) ? 'start' : has('town') ? 'town' : dragons ? 'dragon cache' : 'wild';
		const d = describe(A, { area: r.id });
		const per100 = n => (100 * n) / r.tiles;
		const dens = {
			'per 100 tiles: guards': per100(M.monsters.filter(m => A._areaOf(m) === r.id).length),
			'per 100 tiles: high loot': per100(has('high')), 'per 100 tiles: low loot': per100(has('low')),
			'per 100 tiles: dwellings': per100(has('dwelling')), 'per 100 tiles: creature banks': per100(has('bank')),
			'per 100 tiles: mines': per100(has('mine')), 'area size (tiles)': r.tiles,
		};
		out.push({ file, A, r, kind, l: r.l, tiles: r.tiles, box: [x0, y0, x1, y1], contents: { towns: has('town'), high: has('high'), low: has('low'), dwellings: has('dwelling'), dragons, banks: has('bank'), mines: has('mine'), guards: M.monsters.filter(m => A._areaOf(m) === r.id).length, gates: has('gate'), monoliths: has('monolith') },
			measures: d.measures, counts: d.counts, examples: d.examples, counter: d.counter, dens });
	}
	return out;
}

function render(file, out, a, pad = 3) {
	const [x0, y0, x1, y1] = a.box;
	const cx = Math.max(0, x0 - pad), cy = Math.max(0, y0 - pad), w = x1 - x0 + 1 + 2 * pad, h = y1 - y0 + 1 + 2 * pad;
	const px = Math.max(6, Math.min(16, Math.floor(900 / Math.max(w, h))));
	spawnSync('node', [path.join(__dirname, '..', 'mapsight.js'), 'render', file, out, '--level', String(a.l), '--crop', `${cx},${cy},${w},${h}`, '--px', String(px), '--pitch', String(px >= 12 ? 6 : 12)],
		{ encoding: 'utf8', timeout: 120000, windowsHide: true });
	return px;
}

function main(args) {
	const run = opt(args, '--run');
	const match = opt(args, '--match') ? new RegExp(opt(args, '--match'), 'i') : null;
	const pick = fs_ => fs_.filter(f => !match || match.test(path.basename(f)));
	const engine = pick([...vmaps(opt(args, '--engine') || (run && path.join(run, 'engine'))), ...list(args, '--engine-maps')]);
	const ours = [...pick(vmaps(opt(args, '--ours') || (run && !list(args, '--maps').length ? path.join(run, 'ours') : null))), ...list(args, '--maps')];
	if (engine.length < 2 || !ours.length) { console.log(`sweep needs 2+ engine maps and 1+ of ours (engine ${engine.length}, ours ${ours.length})`); process.exitCode = 2; return; }
	const top = +(opt(args, '--top') || 6), pics = opt(args, '--pictures');
	if (pics) fs.mkdirSync(pics, { recursive: true });
	const E = engine.flatMap(areasOf);
	const report = [];
	for (const f of ours) {
		const O = areasOf(f);
		console.log(`\n######## ${path.basename(f)}: ${O.length} areas (engine: ${E.length} areas over ${engine.length} maps)`);
		const byKind = {};
		for (const a of O) byKind[a.kind] = (byKind[a.kind] || 0) + 1;
		const eKind = {};
		for (const a of E) eKind[a.kind] = (eKind[a.kind] || 0) + 1;
		console.log(`kinds, ours: ${JSON.stringify(byKind)}; engine per map: ${JSON.stringify(Object.fromEntries(Object.entries(eKind).map(([k, v]) => [k, Math.round(10 * v / engine.length) / 10])))}`);
		O.sort((a, b) => a.l - b.l || a.box[1] - b.box[1] || a.box[0] - b.box[0]).forEach((a, k) => {
			let pool = E.filter(e => e.kind === a.kind && e.l === a.l);
			if (pool.length < 4) pool = E.filter(e => e.kind === a.kind);
			const rows = [];
			const consider = (name, v, share, n, evs) => {
				if (evs.length < 4) return;
				const lo = q(evs, 0.1), hi = q(evs, 0.9), spread = Math.max(hi - lo, share ? 0.05 : Math.max(0.2, 0.1 * Math.abs(hi)));
				const out = v < lo ? lo - v : v > hi ? v - hi : 0;
				if (out > 0) rows.push({ name, v, lo, hi, share, n, score: out / spread });
			};
			for (const [name, v] of Object.entries(a.measures)) {
				if ((a.counts[name] || 0) < 3) continue;
				consider(name, v, true, a.counts[name], pool.filter(e => e.measures[name] !== undefined && (e.counts[name] || 0) >= 3).map(e => e.measures[name]));
			}
			for (const [name, v] of Object.entries(a.dens)) consider(name, v, false, null, pool.map(e => e.dens[name]));
			rows.sort((x, y) => y.score - x.score);
			const c = a.contents;
			console.log(`\n== area ${k + 1}: ${a.kind}, ${a.l ? 'underground' : 'surface'}, ${a.tiles} tiles, x ${a.box[0]}-${a.box[2]} y ${a.box[1]}-${a.box[3]}` +
				` | towns ${c.towns}, guards ${c.guards}, high loot ${c.high}, low ${c.low}, dwellings ${c.dwellings}${c.dragons ? ` (neutral dragon ${c.dragons})` : ''}, banks ${c.banks}, mines ${c.mines}${c.gates ? `, gates ${c.gates}` : ''}${c.monoliths ? `, monoliths ${c.monoliths}` : ''}` +
				` | compared with ${pool.length} engine areas`);
			if (!rows.length) console.log('   nothing outside the engine\'s 10th to 90th percentile');
			for (const r of rows.slice(0, top)) {
				const exs = r.share ? ((r.v < (r.lo + r.hi) / 2 ? a.counter : a.examples)[r.name] || []) : [];
				console.log(`   ${r.name}: ours ${fmt(r.v, r.share)}${r.n ? ` of ${r.n}` : ''}, engine ${fmt(r.lo, r.share)} to ${fmt(r.hi, r.share)}` +
					(exs.length ? `\n      ${r.v < (r.lo + r.hi) / 2 ? 'without it' : 'with it'}: ${exs.slice(0, 4).join('  ')}` : ''));
			}
			if (pics) {
				const base = `${path.basename(f, '.vmap')}_area${k + 1}_${a.kind.replace(/ /g, '-')}`;
				const pxo = render(f, path.join(pics, `${base}_ours.png`), a);
				const twin = pool.slice().sort((x, y) => Math.abs(x.tiles - a.tiles) - Math.abs(y.tiles - a.tiles))[0];
				if (twin) render(twin.file, path.join(pics, `${base}_engine.png`), twin);
				console.log(`   pictures: ${base}_ours.png and _engine.png (${pxo} px a tile; engine area from ${path.basename(twin ? twin.file : '')})`);
			}
			report.push({ map: path.basename(f), area: k + 1, kind: a.kind, level: a.l, tiles: a.tiles, box: a.box, contents: c, differences: rows.slice(0, top) });
		});
	}
	if (opt(args, '--json')) fs.writeFileSync(opt(args, '--json'), JSON.stringify(report, null, 1));
}

module.exports = { main, areasOf };
