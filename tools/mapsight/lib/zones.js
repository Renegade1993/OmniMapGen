'use strict';
/**
 * zones.js - the template's zones one by one, and the graph that joins them, ours beside the engine's.
 * K, 2026-10-01: "well you better engineer these gaps away" (the zone graph and zone-by-zone matching were missing).
 *
 *   mapsight zones --ours FILE... --engine FILE...
 *
 * Needs a zone tile map on both sides: the engine's sidecar from rmgdump built 2026-10-01 or later (zoneTiles; e.g.
 * VCMI_rmgconv.exe), ours from generate.js with templateIds (branch opus-coldshadow). Per template zone: its level,
 * size and contents on each side; per pair of zones: how they are joined (passages through open ground, the guard in
 * each, gates and monoliths between them), across all seeds.
 */
const path = require('path');
const sight = require('./sight');

function list(args, name) {
	const out = [];
	args.forEach((a, i) => { if (a === name) for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) out.push(args[j]); });
	return out;
}
const N8 = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];

/** One map's zones and links. */
function read(file) {
	const A = sight.analyse(file), M = A.M;
	if (!M.zones || !M.zones.zoneOf) return null;
	const zoneOf = (l, x, y) => { const z = M.zoneAt(l, x, y); return z === undefined || z === null || z < 0 ? null : z; };
	const Z = new Map();
	const zget = id => { if (!Z.has(id)) Z.set(id, { id, type: (M.zones.zones.get(id) || {}).type || '?', levels: {}, tiles: 0, c: {} }); return Z.get(id); };
	for (let l = 0; l < M.NL; l++) for (let y = 0; y < M.H; y++) for (let x = 0; x < M.W; x++) {
		const z = zoneOf(l, x, y); if (z === null) continue;
		const e = zget(z); e.tiles++; e.levels[l] = (e.levels[l] || 0) + 1;
	}
	const count = (e, k) => { e.c[k] = (e.c[k] || 0) + 1; };
	for (const o of M.objs) {
		const z = zoneOf(o.l, o.at[0], o.at[1]); if (z === null) continue;
		const e = zget(z);
		if (o.cls === 'town') count(e, o.options && o.options.owner ? 'player town' : 'town');
		else if (['high', 'low', 'dwelling', 'bank', 'mine', 'gate', 'monolith'].includes(o.cls)) count(e, o.cls === 'high' ? 'high loot' : o.cls === 'low' ? 'low loot' : o.cls);
		else if (o.cls === 'monster') count(e, 'guard');
	}
	for (const d of A.census) if (d.dragon) { const z = zoneOf(d.o.l, d.o.at[0], d.o.at[1]); if (z !== null) count(zget(z), 'neutral dragon'); }
	for (const s of A.starts) { const z = zoneOf(s.l, s.at[0], s.at[1]); if (z !== null) count(zget(z), 'start'); }
	// links: walkable tiles of zone a next to walkable tiles of zone b form crossings; crossings that touch each other
	// are one passage; a passage's guard is a monster whose ring covers one of its tiles
	const walk = i => M.ground(i) && (!M.blocked[i] || M.guardOf[i] >= 0);
	const cross = new Map();
	for (let l = 0; l < M.NL; l++) for (let y = 0; y < M.H; y++) for (let x = 0; x < M.W; x++) {
		const i = M.idx(l, x, y); if (!walk(i)) continue;
		const a = zoneOf(l, x, y); if (a === null) continue;
		for (const [dx, dy] of N8) {
			if (!M.inb(x + dx, y + dy)) continue;
			const j = M.idx(l, x + dx, y + dy); if (!walk(j)) continue;
			const b = zoneOf(l, x + dx, y + dy); if (b === null || b <= a) continue;
			const key = `${a}-${b}`;
			if (!cross.has(key)) cross.set(key, []);
			cross.get(key).push(i, j);
		}
	}
	const links = new Map();
	for (const [key, tiles] of cross) {
		const set = new Set(tiles), seen = new Set(), passages = [];
		for (const t of set) {
			if (seen.has(t)) continue;
			const st = [t]; seen.add(t); const comp = [];
			while (st.length) {
				const c = st.pop(); comp.push(c);
				const l = Math.floor(c / (M.W * M.H)), x = c % M.W, y = Math.floor(c / M.W) % M.H;
				for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
					if (!M.inb(x + dx, y + dy)) continue;
					const n = M.idx(l, x + dx, y + dy);
					if (set.has(n) && !seen.has(n)) { seen.add(n); st.push(n); }
				}
			}
			const guards = new Set();
			for (const c of comp) if (M.guardOf[c] >= 0) guards.add(M.guardOf[c]);
			const g = [...guards].map(k => M.objs[k]).filter(Boolean);
			const I = sight.index();
			const lvl = m => { const c = I && I.creature(m.subtype); return c ? c.level : '?'; };
			const c0 = comp[0];
			passages.push({ width: new Set(comp).size, guards: g.map(m => `${(m.options && m.options.amount) || '?'} ${m.subtype} (L${lvl(m)})`),
				at: [c0 % M.W, Math.floor(c0 / M.W) % M.H, Math.floor(c0 / (M.W * M.H))] });
		}
		links.set(key, { passages, teleports: 0 });
	}
	// gates and monoliths between zones
	const tp = M.objs.filter(o => o.cls === 'gate' || o.cls === 'monolith');
	const gates = tp.filter(o => o.cls === 'gate'), used = new Set();
	const pairs = [];
	for (const g of gates.filter(g => g.l === 0)) {
		let best = null, bd = 1e9;
		for (const h of gates) if (h.l === 1 && !used.has(h)) { const d = Math.hypot(g.x - h.x, g.y - h.y); if (d < bd) { bd = d; best = h; } }
		if (best) { used.add(best); pairs.push([g, best, 'gate']); }
	}
	const mono = new Map();
	for (const o of tp.filter(o => o.cls === 'monolith')) { const k = `${o.type}|${o.subtype}`; if (!mono.has(k)) mono.set(k, []); mono.get(k).push(o); }
	for (const [, ls] of mono) for (let i = 1; i < ls.length; i++) pairs.push([ls[0], ls[i], 'monolith']);
	for (const [p, q, kind] of pairs) {
		const a = zoneOf(p.l, p.at[0], p.at[1]), b = zoneOf(q.l, q.at[0], q.at[1]);
		if (a === null || b === null || a === b) continue;
		const key = a < b ? `${a}-${b}` : `${b}-${a}`;
		if (!links.has(key)) links.set(key, { passages: [], teleports: 0 });
		links.get(key).teleports++;
		links.get(key)[kind] = (links.get(key)[kind] || 0) + 1;
		// the two ends' visiting tiles (x, y, level), for measures on what reaches them (roads)
		(links.get(key).ends = links.get(key).ends || []).push([p.at[0], p.at[1], p.l], [q.at[0], q.at[1], q.l]);
	}
	return { file, Z, links };
}

function main(args) {
	const O = list(args, '--ours').map(read).filter(Boolean), E = list(args, '--engine').map(read).filter(Boolean);
	if (!O.length || !E.length) { console.log('zones needs maps with a zone tile map on both sides (--ours, --engine)'); process.exitCode = 2; return; }
	const med = a => { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1] : 0; };
	const ids = [...new Set([...E, ...O].flatMap(m => [...m.Z.keys()]))].sort((a, b) => a - b);
	console.log(`Zones one by one: median over ${O.length} maps of ours / ${E.length} of the engine's. Level: share of seeds with the zone mostly underground.`);
	const keys = ['start', 'player town', 'town', 'neutral dragon', 'dwelling', 'high loot', 'low loot', 'bank', 'mine', 'guard', 'gate', 'monolith'];
	for (const id of ids) {
		const eo = O.map(m => m.Z.get(id)).filter(Boolean), ee = E.map(m => m.Z.get(id)).filter(Boolean);
		const ug = zs => zs.filter(z => (z.levels[1] || 0) > (z.levels[0] || 0)).length;
		const t = (ee[0] || eo[0] || {}).type;
		const flag = [];
		if (ug(eo) * 2 > eo.length !== ug(ee) * 2 > ee.length) flag.push('LEVEL DIFFERS');
		const row = keys.map(k => { const a = med(eo.map(z => z.c[k] || 0)), b = med(ee.map(z => z.c[k] || 0)); if (Math.abs(a - b) > Math.max(1, 0.5 * b)) flag.push(k); return a || b ? `${k} ${a}/${b}` : null; }).filter(Boolean);
		const ta = med(eo.map(z => z.tiles)), tb = med(ee.map(z => z.tiles));
		if (tb && (ta / tb > 1.5 || ta / tb < 0.67)) flag.push('size');
		console.log(`\nzone ${id} (${t}): underground ${ug(eo)}/${eo.length} of ours, ${ug(ee)}/${ee.length} of the engine's; tiles ${ta}/${tb}${flag.length ? '   <<< ' + flag.join(', ') : ''}`);
		console.log(`  ${row.join('; ')}`);
	}
	console.log('\nLinks between zones (share of seeds with the link; passages through open ground, median count and widths; guards; gates and monoliths):');
	const lk = [...new Set([...E, ...O].flatMap(m => [...m.links.keys()]))].sort((a, b) => { const [a1, a2] = a.split('-').map(Number), [b1, b2] = b.split('-').map(Number); return a1 - b1 || a2 - b2; });
	for (const k of lk) {
		const lo = O.map(m => m.links.get(k)), le = E.map(m => m.links.get(k));
		const share = ls => ls.filter(Boolean).length;
		const pas = ls => med(ls.map(x => (x ? x.passages.length : 0)));
		const tele = ls => med(ls.map(x => (x ? x.teleports : 0)));
		const gl = ls => { const all = ls.filter(Boolean).flatMap(x => x.passages.flatMap(p => p.guards)); return all.slice(0, 3).join(', '); };
		const so = share(lo) / O.length, se = share(le) / E.length;
		const flag = (so >= 0.5) !== (se >= 0.5) ? '   <<< ' + (se >= 0.5 ? 'MISSING in ours' : 'EXTRA in ours') : pas(lo) !== pas(le) || tele(lo) !== tele(le) ? '   <<< differs' : '';
		console.log(`  ${k}: ours ${share(lo)}/${O.length} seeds, ${pas(lo)} passages, ${tele(lo)} teleports [${gl(lo)}]; engine ${share(le)}/${E.length}, ${pas(le)} passages, ${tele(le)} teleports [${gl(le)}]${flag}`);
	}
}

module.exports = { main, read };
