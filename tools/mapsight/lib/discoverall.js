'use strict';
/**
 * discoverall.js - every discovery avenue over every template, calibrated, and what is wrong on most templates.
 * K, 2026-10-01: "do it, i'll take anything and everything".
 *
 *   mapsight discover-all --engine DIR --ours DIR --out DIR [--match REGEX]
 *
 * Avenues: neighbours (what stands round each kind of object), motifs (3x3 shapes), outliers (objects unlike any engine
 * object of their kind), walk (a hero from each start, day by day), terrains (which terrains border which, and the
 * obstacles each terrain carries). Calibration: each avenue is also run between two halves of the engine's own seeds of
 * every template; the 99th percentile of those engine-against-engine scores is the line, so a finding is a difference
 * the engine shows against itself less than 1 time in 100. Per template: <id>.md. Across templates: index.md.
 */
const fs = require('fs');
const path = require('path');
const sight = require('./sight');
const D = require('./discover');

function opt(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }
const groupOf = f => path.basename(f).replace(/\.vmap$/i, '').replace(/_s\d+$/, '');
const pc = (a, p) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(p * b.length))] : 0; };
const med = a => pc(a, 0.5);

// ---- terrains: borders between terrains, and obstacle kinds per terrain -------------------------------------------------
function terrainRows(ours, engine) {
	const sig = maps => {
		const pairs = new Map(), obst = new Map(); let np = 0, no = 0;
		for (const X of maps) {
			const M = X.M;
			for (let l = 0; l < M.NL; l++) for (let y = 0; y < M.H; y++) for (let x = 0; x < M.W; x++) {
				const a = M.terr[M.idx(l, x, y)];
				for (const [dx, dy] of [[1, 0], [0, 1]]) {
					if (!M.inb(x + dx, y + dy)) continue;
					const b = M.terr[M.idx(l, x + dx, y + dy)];
					if (a === b) continue;
					const k = [a, b].sort().join('/'); pairs.set(k, (pairs.get(k) || 0) + 1); np++;
				}
			}
			for (const o of M.objs) {
				if (o.visitable || o.cls !== 'other') continue;
				const t = M.terr[M.idx(o.l, o.x, o.y)];
				const k = `${t}: ${o.type}`; obst.set(k, (obst.get(k) || 0) + 1); no++;
			}
		}
		return { pairs, obst, np, no };
	};
	const A = sig(ours), B = sig(engine), rows = [];
	for (const [kind, ma, mb, na, nb] of [['border', A.pairs, B.pairs, A.np, B.np], ['obstacle', A.obst, B.obst, A.no, B.no]])
		for (const k of new Set([...ma.keys(), ...mb.keys()])) {
			const fa = (ma.get(k) || 0) / Math.max(1, na), fb = (mb.get(k) || 0) / Math.max(1, nb);
			if (fa + fb < 0.01) continue;
			rows.push({ kind, k, fa, fb, score: Math.abs(Math.log((fa + 0.002) / (fb + 0.002))) * Math.sqrt(fa + fb) });
		}
	rows.sort((a, b) => b.score - a.score);
	return rows;
}
// border length per tile of each terrain: how ragged the terrain patches are
function roughness(maps) {
	let border = 0, tiles = 0;
	for (const X of maps) {
		const M = X.M;
		for (let l = 0; l < M.NL; l++) for (let y = 0; y < M.H; y++) for (let x = 0; x < M.W; x++) {
			const i = M.idx(l, x, y), a = M.terr[i];
			if (a === 'rc' || a === 'wa') continue;
			tiles++;
			for (const [dx, dy] of [[1, 0], [0, 1]]) if (M.inb(x + dx, y + dy) && M.terr[M.idx(l, x + dx, y + dy)] !== a) border++;
		}
	}
	return border / Math.max(1, tiles);
}

function scoresOf(ours, engine) {
	const nb = D.neighbourRows(ours, engine, 3);
	const mo = D.motifs(ours, engine, true);
	const te = terrainRows(ours, engine);
	return { nb, mo, te };
}

function main(args) {
	const out = opt(args, '--out'), match = opt(args, '--match') ? new RegExp(opt(args, '--match'), 'i') : null;
	if (!out) { console.log('discover-all needs --out DIR'); process.exitCode = 2; return; }
	const groups = new Map();
	for (const [side, dir] of [['engine', opt(args, '--engine')], ['ours', opt(args, '--ours')]])
		for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.vmap'))) {
			const g = groupOf(f); if (match && !match.test(g)) continue;
			if (!groups.has(g)) groups.set(g, { engine: [], ours: [] });
			groups.get(g)[side].push(path.join(dir, f));
		}
	fs.mkdirSync(out, { recursive: true });
	// calibration: engine halves of every template
	const calNb = [], calMo = [], calTe = [], calWalk = {}, calOut = [];
	const results = [];
	for (const [id, g] of [...groups].sort()) {
		if (g.engine.length < 4 || !g.ours.length) continue;
		const E = g.engine.map(D.load), O = g.ours.map(D.load);
		const h = Math.floor(E.length / 2), E1 = E.slice(0, h), E2 = E.slice(h);
		const cal = scoresOf(E1, E2);
		calNb.push(...cal.nb.map(r => Math.abs(r.z))); calMo.push(...cal.mo.map(r => Math.abs(r.r) * (r.fa + r.fb) * 1000)); calTe.push(...cal.te.map(r => r.score));
		const outE = D.outliers(E1, E2, 0, true).rows.map(r => r.d);
		calOut.push(pc(outE, 0.99));
		const res = scoresOf(O, E);
		const outO = D.outliers(O, E, 0, true);
		const W = { ours: D.walkTally(O, 7), eng: D.walkTally(E, 7), e1: D.walkTally(E1, 7), e2: D.walkTally(E2, 7) };
		for (const k of ['guards', 'prizes', 'loot', 'banks', 'mines', 'towns']) {
			const a = med(W.e1.map(r => r[7][k])), b = med(W.e2.map(r => r[7][k]));
			(calWalk[k] = calWalk[k] || []).push(Math.abs(Math.log((a + 1) / (b + 1))));
		}
		results.push({ id, E, O, res, outO, outLine: pc(outE, 0.99), W, rough: { ours: roughness(O), eng: roughness(E) } });
		console.log(`${id}: measured`);
	}
	const L = { nb: pc(calNb, 0.99), mo: pc(calMo, 0.99), te: pc(calTe, 0.99), walk: Object.fromEntries(Object.entries(calWalk).map(([k, v]) => [k, pc(v, 0.95)])) };
	const agg = { nb: new Map(), mo: new Map(), te: new Map(), walk: new Map(), out: new Map(), rough: [] };
	for (const r of results) {
		const md = [`# ${r.id}: discovery avenues`, '', `Ours ${r.O.length} maps, engine ${r.E.length}. Lines (engine half against engine half, 99th percentile): neighbours |z| ${L.nb.toFixed(1)}, motifs ${L.mo.toFixed(2)}, terrains ${L.te.toFixed(3)}.`, ''];
		const nb = r.res.nb.filter(x => Math.abs(x.z) > L.nb);
		md.push(`## Neighbours (${nb.length} beyond the line)`, '');
		for (const x of nb.slice(0, 30)) {
			md.push(`- ${x.k} next to ${x.q}: ours ${Math.round(100 * x.pa)}%, engine ${Math.round(100 * x.pb)}%${x.pa > x.pb && x.ex.length ? `; e.g. ${x.ex.join('  ')}` : ''}`);
			const k = `${x.k} next to ${x.q}: ${x.pa > x.pb ? 'more' : 'less'} in ours`; const e = agg.nb.get(k) || { n: 0, a: [], b: [] }; e.n++; e.a.push(x.pa); e.b.push(x.pb); agg.nb.set(k, e);
		}
		const mo = r.res.mo.filter(x => Math.abs(x.r) * (x.fa + x.fb) * 1000 > L.mo);
		md.push('', `## Motifs, 3x3 shapes (${mo.length} beyond the line; # wall, % scattered obstacle, . floor, = road, ~ water or rock)`, '');
		for (const x of mo.slice(0, 15)) {
			md.push(`- [${x.p.match(/.../g).join(' ')}] ours ${(1000 * x.fa).toFixed(1)}, engine ${(1000 * x.fb).toFixed(1)} per 1000; e.g. ${x.ex.join('  ')}`);
			const k = `[${x.p.match(/.../g).join(' ')}] ${x.fa > x.fb ? 'more' : 'less'} in ours`; agg.mo.set(k, (agg.mo.get(k) || 0) + 1);
		}
		const te = r.res.te.filter(x => x.score > L.te);
		md.push('', `## Terrains: borders and obstacles (${te.length} beyond the line); terrain raggedness (border per tile) ours ${r.rough.ours.toFixed(3)}, engine ${r.rough.eng.toFixed(3)}`, '');
		for (const x of te.slice(0, 15)) {
			md.push(`- ${x.kind} ${x.k}: ours ${(100 * x.fa).toFixed(1)}%, engine ${(100 * x.fb).toFixed(1)}%`);
			const k = `${x.kind} ${x.k}: ${x.fa > x.fb ? 'more' : 'less'} in ours`; agg.te.set(k, (agg.te.get(k) || 0) + 1);
		}
		agg.rough.push({ id: r.id, o: r.rough.ours, e: r.rough.eng });
		const odd = r.outO.rows.filter(x => x.d > r.outLine);
		md.push('', `## Outliers: objects of ours beyond the line an engine object crosses 1 time in 100 (${odd.length} of ${r.outO.rows.length})`, '');
		const kinds = {};
		for (const x of odd) kinds[x.k] = (kinds[x.k] || 0) + 1;
		md.push(`- by kind: ${Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${k} ${v}`).join(', ')}`);
		for (const x of odd.slice(0, 12)) md.push(`- ${x.k} ${path.basename(x.X.f, '.vmap').slice(-6)} (${x.o.at}${x.o.l ? ',L1' : ''}): distance ${x.d.toFixed(2)}`);
		for (const [k, v] of Object.entries(kinds)) { const e = agg.out.get(k) || { t: 0, n: 0 }; e.t++; e.n += v; agg.out.set(k, e); }
		md.push('', '## Walk: a hero from each start, totals met by day 7 (median over starts), ours / engine', '');
		for (const k of ['guards', 'prizes', 'loot', 'banks', 'mines', 'towns']) {
			const a = med(r.W.ours.map(x => x[7][k])), b = med(r.W.eng.map(x => x[7][k]));
			const beyond = Math.abs(Math.log((a + 1) / (b + 1))) > L.walk[k];
			md.push(`- ${k}: ${a} / ${b}${beyond ? (a > b ? ' MORE' : ' LESS') : ''}`);
			if (beyond) { const key = `${k} met in a week: ${a > b ? 'more' : 'less'} in ours`; agg.walk.set(key, (agg.walk.get(key) || 0) + 1); }
		}
		fs.writeFileSync(path.join(out, `${r.id}.md`), md.join('\n') + '\n');
	}
	const n = results.length, I = [`# Discovery across ${n} templates`, '', 'Each line: how many templates show it beyond the engine-against-engine line. Per template: <id>.md.', ''];
	I.push('## Neighbours (what stands round what)', '');
	for (const [k, e] of [...agg.nb].sort((a, b) => b[1].n - a[1].n).slice(0, 45)) I.push(`- ${k}: ${e.n} templates (median ours ${Math.round(100 * med(e.a))}%, engine ${Math.round(100 * med(e.b))}%)`);
	I.push('', '## Outliers by kind (templates with any, objects in all)', '');
	for (const [k, e] of [...agg.out].sort((a, b) => b[1].t - a[1].t).slice(0, 25)) I.push(`- ${k}: ${e.t} templates, ${e.n} objects`);
	I.push('', '## Walk, a week from each start', '');
	for (const [k, v] of [...agg.walk].sort((a, b) => b[1] - a[1])) I.push(`- ${k}: ${v} templates`);
	I.push('', '## Terrains', '', `- terrain raggedness (border per tile), median ours ${med(agg.rough.map(x => x.o)).toFixed(3)}, engine ${med(agg.rough.map(x => x.e)).toFixed(3)}; ours smoother on ${agg.rough.filter(x => x.o < x.e).length} of ${n} templates`);
	for (const [k, v] of [...agg.te].sort((a, b) => b[1] - a[1]).slice(0, 25)) I.push(`- ${k}: ${v} templates`);
	I.push('', '## Motifs', '');
	for (const [k, v] of [...agg.mo].sort((a, b) => b[1] - a[1]).slice(0, 20)) I.push(`- ${k}: ${v} templates`);
	fs.writeFileSync(path.join(out, 'index.md'), I.join('\n') + '\n');
	console.log(`written ${out}\\index.md and ${n} template files; lines: neighbours ${L.nb.toFixed(1)}, motifs ${L.mo.toFixed(2)}, terrains ${L.te.toFixed(3)}`);
}

module.exports = { main, terrainRows, roughness };
