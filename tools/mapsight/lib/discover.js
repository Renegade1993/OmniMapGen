'use strict';
/**
 * discover.js - discovery avenues that do not start from a named measure. K, 2026-10-01: "i feel like you still don't have
 * enough different discovery avenues". All compare ours with the engine's maps of the same template.
 *
 *   mapsight neighbours --ours FILE... --engine FILE... [--r 3]   what stands round each kind of object, ranked by difference
 *   mapsight motifs     --ours FILE... --engine FILE...           3x3 shapes of wall, open ground, road and objects
 *   mapsight outliers   --ours FILE... --engine FILE... [--n 30]  objects of ours least like any engine object of their kind
 *   mapsight walk       --ours FILE... --engine FILE... [--days 7] a hero walking from each start, day by day
 *   mapsight starts     --ours FILE --engine FILE --out DIR       what each player sees round his town at the start
 *
 * Each prints a ranked list with coordinates in ours, so the agent opens the places (near, render --crop, patches).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const sight = require('./sight');
const { walls } = require('./relations');

function list(args, name) {
	const out = [];
	args.forEach((a, i) => { if (a === name) for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) out.push(args[j]); });
	return out;
}
function opt(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }
const KIND = o => (o.cls === 'other' ? (o.visitable ? `small:${o.type}` : null) : o.cls === 'dwelling' ? 'dwelling' : o.cls === 'mine' ? `mine:${o.subtype}` : o.cls);
const load = f => { const A = sight.analyse(f); return { f, A, M: A.M, W: walls(A.M) }; };
const where = (X, o) => `${path.basename(X.f, '.vmap').slice(-6)} (${o.at[0]},${o.at[1]}${o.l ? ',L1' : ''})`;

// ---- neighbours: for each kind, the mix of kinds within r tiles ------------------------------------------------------
function neighbourRows(ours, engine, r) {
	const sig = maps => {
		const s = new Map(), n = new Map(), ex = new Map();
		for (const X of maps) {
			const objs = X.M.objs.filter(o => KIND(o));
			for (const o of objs) {
				const k = KIND(o);
				n.set(k, (n.get(k) || 0) + 1);
				const seen = new Set();
				for (const p of objs) if (p !== o && p.l === o.l && sight.cheb(p.at, o.at) <= r) seen.add(KIND(p));
				// walls and roads near it count as neighbours too
				let wall = false, road = false;
				for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
					const x = o.at[0] + dx, y = o.at[1] + dy;
					if (!X.M.inb(x, y)) continue;
					const i = X.M.idx(o.l, x, y);
					if (X.W.isWall(i)) wall = true;
					if (X.M.road[i]) road = true;
				}
				if (wall) seen.add('#wall'); if (road) seen.add('#road');
				for (const q of seen) {
					const key = `${k}|${q}`;
					s.set(key, (s.get(key) || 0) + 1);
					if (!ex.has(key)) ex.set(key, []);
					if (ex.get(key).length < 4) ex.get(key).push(where(X, o));
				}
			}
		}
		return { s, n, ex };
	};
	const A = sig(ours), B = sig(engine);
	const rows = [];
	for (const key of new Set([...A.s.keys(), ...B.s.keys()])) {
		const [k, q] = key.split('|');
		const na = A.n.get(k) || 0, nb = B.n.get(k) || 0;
		if (na < 8 || nb < 8) continue;
		const pa = (A.s.get(key) || 0) / na, pb = (B.s.get(key) || 0) / nb;
		const se = Math.sqrt(pa * (1 - pa) / na + pb * (1 - pb) / nb) || 0.01;
		rows.push({ k, q, pa, pb, z: (pa - pb) / Math.max(se, 0.02), ex: A.ex.get(key) || [] });
	}
	rows.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
	return rows;
}
function neighbours(ours, engine, r) {
	const rows = neighbourRows(ours, engine, r);
	console.log(`What stands within ${r} tiles of each kind of object: share of that kind with the neighbour, ours / engine (${ours.length} maps / ${engine.length} maps)`);
	for (const x of rows.slice(0, 40))
		console.log(`  ${x.k} next to ${x.q}: ${Math.round(100 * x.pa)}% / ${Math.round(100 * x.pb)}%${x.pa > x.pb && x.ex.length ? `   e.g. ${x.ex.join('  ')}` : ''}`);
}

// ---- motifs: 3x3 patterns of tile classes --------------------------------------------------------------------------------
function motifs(ours, engine, quiet) {
	const cls = (X, l, x, y) => {
		if (!X.M.inb(x, y)) return 'x';
		const i = X.M.idx(l, x, y);
		if (!X.M.ground(i)) return '~';
		if (X.M.road[i]) return '=';
		if (X.M.blocked[i]) return X.W.isWall(i) ? '#' : '%';
		return '.';
	};
	const count = maps => {
		const c = new Map(), ex = new Map(); let tot = 0;
		for (const X of maps) for (let l = 0; l < X.M.NL; l++) for (let y = 1; y < X.M.H - 1; y++) for (let x = 1; x < X.M.W - 1; x++) {
			let p = '';
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) p += cls(X, l, x + dx, y + dy);
			if (/^~+$|^#+$|^\.+$/.test(p)) continue;                 // plain water, wall or floor: not a shape
			c.set(p, (c.get(p) || 0) + 1); tot++;
			if (!ex.has(p)) ex.set(p, []);
			if (ex.get(p).length < 3) ex.get(p).push(`${path.basename(X.f, '.vmap').slice(-6)} (${x},${y}${l ? ',L1' : ''})`);
		}
		return { c, ex, tot };
	};
	const A = count(ours), B = count(engine);
	const rows = [];
	for (const p of new Set([...A.c.keys(), ...B.c.keys()])) {
		const fa = (A.c.get(p) || 0) / A.tot, fb = (B.c.get(p) || 0) / B.tot;
		if (fa + fb < 0.0015) continue;
		rows.push({ p, fa, fb, r: Math.log((fa + 1e-5) / (fb + 1e-5)), ex: A.ex.get(p) || B.ex.get(p) || [] });
	}
	rows.sort((a, b) => Math.abs(b.r) * (b.fa + b.fb) - Math.abs(a.r) * (a.fa + a.fb));
	if (quiet) return rows;
	console.log('3x3 shapes (rows top to bottom; # wall, % scattered obstacle, . floor, = road, ~ water or rock), share per 1000 shape tiles, ours / engine:');
	for (const x of rows.slice(0, 30)) {
		const g = x.p.match(/.../g).join(' ');
		console.log(`  [${g}]  ${(1000 * x.fa).toFixed(1)} / ${(1000 * x.fb).toFixed(1)}  ${x.fa > x.fb ? 'MORE in ours' : 'LESS in ours'}  e.g. ${x.ex.join('  ')}`);
	}
}

// ---- outliers: objects of ours whose surroundings look like no engine object of their kind -------------------------------
function features(X, o) {
	const M = X.M, i = M.idx(o.l, o.at[0], o.at[1]);
	let guard = 9, town = 30, road = 9, objs = 0;
	for (const m of M.monsters) if (m !== o && m.l === o.l) guard = Math.min(guard, sight.cheb(m.at, o.at));
	for (const t of M.objs) if (t.cls === 'town' && t.l === o.l) town = Math.min(town, sight.cheb(t.at, o.at));
	for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
		const x = o.at[0] + dx, y = o.at[1] + dy;
		if (M.inb(x, y) && M.road[M.idx(o.l, x, y)]) road = Math.min(road, Math.max(Math.abs(dx), Math.abs(dy)));
	}
	for (const p of M.objs) if (p !== o && p.l === o.l && (p.cls !== 'other' || p.visitable) && sight.cheb(p.at, o.at) <= 3) objs++;
	return [Math.min(X.W.dist[i], 6) / 2, guard / 3, sight.openAccess(M, o) ? 2 : 0, Math.min(town, 30) / 10, road / 3, Math.min(objs, 8) / 3];
}
const FEAT = ['wall distance', 'nearest guard', 'reachable past no guard', 'nearest town', 'nearest road', 'objects within 3'];
function outliers(ours, engine, n, quiet) {
	const bank = new Map();
	for (const X of engine) for (const o of X.M.objs) { const k = KIND(o); if (!k || k === 'monster') continue; if (!bank.has(k)) bank.set(k, []); bank.get(k).push(features(X, o)); }
	const rows = [];
	for (const X of ours) for (const o of X.M.objs) {
		const k = KIND(o); if (!k || k === 'monster' || !bank.has(k) || bank.get(k).length < 10) continue;
		const f = features(X, o);
		let best = 1e9, bf = null;
		for (const g of bank.get(k)) { const d = Math.hypot(...f.map((v, j) => v - g[j])); if (d < best) { best = d; bf = g; } }
		rows.push({ X, o, k, d: best, f, bf });
	}
	rows.sort((a, b) => b.d - a.d);
	const byKind = {};
	for (const r of rows.slice(0, Math.max(n * 4, 100))) byKind[r.k] = (byKind[r.k] || 0) + 1;
	if (quiet) return { rows, byKind };
	console.log(`Objects of ours least like any engine object of their kind (feature distance; features: ${FEAT.join(', ')}).`);
	console.log(`Kinds among the 100 most unusual: ${Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
	for (const r of rows.slice(0, n)) {
		const diff = FEAT.map((name, j) => ({ name, a: r.f[j], b: r.bf[j] })).sort((p, q) => Math.abs(q.a - q.b) - Math.abs(p.a - p.b)).slice(0, 2)
			.map(x => `${x.name} ${x.a.toFixed(1)} against the closest engine one's ${x.b.toFixed(1)}`).join('; ');
		console.log(`  ${r.k} ${where(r.X, r.o)}: distance ${r.d.toFixed(2)}; ${diff}`);
	}
}

// ---- walk: a hero from each start, day by day ---------------------------------------------------------------------------
const TERRAIN_COST = { dt: 100, gr: 100, sn: 150, sw: 175, sa: 150, rg: 125, sb: 100, lv: 100 };
const ROAD_COST = { pd: 75, pg: 65, pc: 50 };
function walk(X, days, mp) {
	const M = X.M, out = [];
	const monTile = new Map(M.monsters.map(m => [M.idx(m.l, m.at[0], m.at[1]), m]));
	const objAt = new Map();
	for (const o of M.objs) if (o.cls !== 'monster' && (o.cls !== 'other' || o.visitable)) for (const i of M.approach(o)) { if (!objAt.has(i)) objAt.set(i, []); objAt.get(i).push(o); }
	const cost = i => { const t = M.terr[i]; return TERRAIN_COST[t] || 125; };
	for (const s of sight.starts(M)) {
		const town = M.objs.find(o => o.cls === 'town' && o.l === s.l && o.at[0] === s.at[0] && o.at[1] === s.at[1]);
		if (!town) continue;
		const dist = new Float64Array(M.NL * M.W * M.H).fill(Infinity), pq = [];
		for (const i of M.approach(town)) if (M.ground(i) && !M.blocked[i]) { dist[i] = 0; pq.push([0, i]); }
		const met = [], seenO = new Set();
		while (pq.length) {
			pq.sort((a, b) => b[0] - a[0]);
			const [d, c] = pq.pop();
			if (d > dist[c] || d > days * mp) continue;
			for (const o of objAt.get(c) || []) if (!seenO.has(o)) { seenO.add(o); met.push({ day: Math.floor(d / mp) + 1, o }); }
			if (M.guardOf[c] >= 0) {                                   // stepping into a guard ring means a fight: note it, walk on
				const m = M.monsters.find(q => q.k === M.guardOf[c]) || null;
				if (m && !seenO.has(m)) { seenO.add(m); met.push({ day: Math.floor(d / mp) + 1, o: m }); }
			}
			const l = Math.floor(c / (M.W * M.H)), x = c % M.W, y = Math.floor(c / M.W) % M.H;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				if ((!dx && !dy) || !M.inb(x + dx, y + dy)) continue;
				const n = M.idx(l, x + dx, y + dy);
				if (!M.ground(n) || (M.blocked[n] && !monTile.has(n))) continue;
				const lay = M.road[n] ? 60 : cost(n);
				const nd = d + lay * (dx && dy ? 1.41 : 1);
				if (nd < dist[n]) { dist[n] = nd; pq.push([nd, n]); }
			}
		}
		out.push({ s, met });
	}
	return out;
}
function walkTally(maps, days, mp = 1500) {
	const per = [];
	for (const X of maps) for (const w of walk(X, days, mp)) {
		const row = { start: `${path.basename(X.f, '.vmap').slice(-6)} ${w.s.colour}` };
		for (let d = 1; d <= days; d++) {
			const m = w.met.filter(e => e.day <= d);
			row[d] = { guards: m.filter(e => e.o.cls === 'monster').length, prizes: m.filter(e => e.o.cls === 'high' || e.o.cls === 'dwelling').length,
				loot: m.filter(e => e.o.cls === 'low').length, mines: m.filter(e => e.o.cls === 'mine').length, towns: m.filter(e => e.o.cls === 'town').length,
				banks: m.filter(e => e.o.cls === 'bank').length };
		}
		const firstFight = w.met.find(e => e.o.cls === 'monster');
		row.firstFight = firstFight ? firstFight.day : null;
		const firstPrize = w.met.find(e => e.o.cls === 'high' || e.o.cls === 'dwelling');
		row.firstPrize = firstPrize ? `day ${firstPrize.day} ${firstPrize.o.type} (${firstPrize.o.at})` : 'none';
		per.push(row);
	}
	return per;
}
function walkReport(ours, engine, days) {
	const mp = 1500;
	const tally = maps => walkTally(maps, days, mp);
	const A = tally(ours), B = tally(engine);
	const med = a => { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1] : 0; };
	console.log(`A hero walking from each start (${mp} movement a day; roads 60, terrain 100 to 175; a guard ring is a fight and the walk goes on). Totals met by the end of each day, median over starts, ours / engine (${A.length} / ${B.length} starts):`);
	for (const key of ['guards', 'prizes', 'loot', 'banks', 'mines', 'towns'])
	console.log(`  ${key.padEnd(7)} ${[1, 2, 3, days].map(d => `day ${d}: ${med(A.map(r => r[d][key]))} / ${med(B.map(r => r[d][key]))}`).join('   ')}`);
	console.log(`  first fight on day (median): ${med(A.map(r => r.firstFight || 99))} / ${med(B.map(r => r.firstFight || 99))}`);
	const spread = (rows, key) => { const v = rows.map(r => r[3][key]); return `${Math.min(...v)} to ${Math.max(...v)}`; };
	console.log(`Fairness, spread between starts by day 3 (ours / engine): prizes ${spread(A, 'prizes')} / ${spread(B, 'prizes')}; mines ${spread(A, 'mines')} / ${spread(B, 'mines')}; guards ${spread(A, 'guards')} / ${spread(B, 'guards')}`);
	console.log('Ours, each start: first prize reached:');
	for (const r of A) console.log(`  ${r.start}: ${r.firstPrize}; by day 3 prizes ${r[3].prizes}, mines ${r[3].mines}, guards ${r[3].guards}`);
}

// ---- starts: the first screen round each player's town -------------------------------------------------------------------
function startsPictures(oursF, engF, out) {
	fs.mkdirSync(out, { recursive: true });
	const X = load(oursF), Y = load(engF);
	const sa = sight.starts(X.M), sb = sight.starts(Y.M);
	const n = Math.min(sa.length, sb.length);
	for (let k = 0; k < n; k++) {
	const a = sa[k], b = sb[k], s = 30;
	const side = (Z, st) => {
		const x0 = Math.max(0, Math.min(Z.M.W - s, st.at[0] - (s >> 1))), y0 = Math.max(0, Math.min(Z.M.H - s, st.at[1] - (s >> 1)));
		const rows = [];
		for (let y = y0; y < y0 + s; y++) { let r = ''; for (let x = x0; x < x0 + s; x++) { const i = Z.M.idx(st.l, x, y); r += !Z.M.ground(i) ? 'r' : Z.M.road[i] ? '=' : Z.M.blocked[i] ? 'b' : Z.M.guardOf[i] >= 0 ? 'g' : '.'; } rows.push(r); }
		const objects = Z.M.objs.filter(o => o.l === st.l && o.at[0] >= x0 && o.at[0] < x0 + s && o.at[1] >= y0 && o.at[1] < y0 + s && (o.cls !== 'other' || o.visitable)).map(o => ({ cls: o.cls, at: o.at }));
		return { x0, y0, rows, objects, title: `${path.basename(Z.f, '.vmap')} ${st.colour} start L${st.l}` };
	};
	const dump = path.join(out, `start${k + 1}.json`);
	fs.writeFileSync(dump, JSON.stringify({ s, left: side(X, a), right: side(Y, b) }));
	spawnSync('py', [path.join(__dirname, '..', 'pair.py'), dump, path.join(out, `start${k + 1}.png`)], { timeout: 60000, windowsHide: true });
	fs.unlinkSync(dump);
	}
	console.log(`${n} start pictures (30x30 round each player's town, ours left) in ${out}`);
}

function main(cmd, args) {
	const ours = list(args, '--ours').map(load), engine = list(args, '--engine').map(load);
	if (!ours.length || !engine.length) { console.log(`${cmd} needs --ours FILE... and --engine FILE...`); process.exitCode = 2; return; }
	if (cmd === 'neighbours') return neighbours(ours, engine, +(opt(args, '--r') || 3));
	if (cmd === 'motifs') return motifs(ours, engine);
	if (cmd === 'outliers') return outliers(ours, engine, +(opt(args, '--n') || 30));
	if (cmd === 'walk') return walkReport(ours, engine, +(opt(args, '--days') || 7));
	if (cmd === 'starts') return startsPictures(list(args, '--ours')[0], list(args, '--engine')[0], opt(args, '--out') || '.');
}

module.exports = { main, neighbourRows, motifs, outliers, walkTally, load, KIND };
