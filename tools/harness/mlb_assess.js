'use strict';
/**
 * mlb_assess.js - monsters, blockers and loot: how each kind of loot relates to its guard and to the blockers round it,
 * ours against the engine's. Written for the assessment of 2026-10-08 (K: "assessing and fixing/closing the gap on monsters,
 * blockers, and loot relationships").
 *
 *   node tools/harness/mlb_assess.js --ours MAP|DIR... --engine MAP|DIR... [--json OUT]
 *
 * Per loot kind (relic, major, pandora, artifact, scroll, prison, dwelling, bank, mine) over all the maps of a set:
 *   per 1000 land tiles   how many there are
 *   unguarded %           no monster within 2 tiles of the visit tile and none whose 3x3 covers an approach tile
 *   flyer-open %          no monster within 1 tile of the visit tile
 *   guards beside         monsters within 2 tiles of the visit tile, median
 *   guard distance        nearest monster to the visit tile, median
 *   blocked ring          of the 8 tiles round the visit tile, how many are rock, water or a non-pickup object (median)
 *   nearest blocker       distance from the visit tile to the nearest blocked tile, median
 * and for the whole set: monsters per 1000 land tiles, crowded %, monsters sealing nothing %.
 */
const fs = require('fs');
const path = require('path');
const sight = require('../mapsight/lib/sight');

const N8 = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 0], [-1, 1]];
const cheb = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
function list(name) {
	const out = []; const a = process.argv;
	for (let i = a.indexOf(name) + 1; i > 0 && i < a.length && !a[i].startsWith('--'); i++) {
		const p = a[i];
		if (fs.existsSync(p) && fs.statSync(p).isDirectory()) fs.readdirSync(p).filter(f => f.endsWith('.vmap')).forEach(f => out.push(path.join(p, f)));
		else out.push(p);
	}
	return out;
}
const med = a => { const b = a.filter(v => v !== undefined).sort((x, y) => x - y); return b.length ? b[b.length >> 1] : NaN; };
const pct = (n, d) => d ? 100 * n / d : NaN;

const kindOf = o => {
	if (o.type === 'prison') return 'prison';
	if (o.cls === 'high') return o.type === 'spellScroll' ? 'scroll' : o.type === 'randomArtifactRelic' ? 'relic'
		: o.type === 'randomArtifactMajor' ? 'major' : o.type === 'pandoraBox' ? 'pandora' : 'artifact';
	if (o.cls === 'dwelling') return 'dwelling';
	if (o.cls === 'bank') return 'bank';
	if (o.cls === 'mine') return 'mine';
	return null;
};
const KINDS = ['relic', 'major', 'pandora', 'artifact', 'scroll', 'prison', 'dwelling', 'bank', 'mine'];

function measure(file) {
	const M = sight.load(file), W = M.W, H = M.H;
	let land = 0;
	for (let i = 0; i < M.terr.length; i++) if (M.ground(i)) land++;
	const monByLevel = [];
	for (let l = 0; l < M.NL; l++) monByLevel[l] = M.monsters.filter(m => m.l === l);
	const rows = Object.fromEntries(KINDS.map(k => [k, []]));
	const blockedAt = (l, x, y) => !M.inb(x, y) || !M.ground(M.idx(l, x, y)) || M.blocked[M.idx(l, x, y)] === 1;
	for (const o of M.objs) {
		const k = kindOf(o);
		if (!k) continue;
		const ms = monByLevel[o.l] || [];
		let near2 = 0, near1 = false, dist = 99, ringCover = false;
		const ap = M.approach(o).map(i => { const c = i % (W * H); return [c % W, Math.floor(c / W)]; });
		for (const m of ms) {
			const d = cheb(m.at, o.at);
			if (d < dist) dist = d;
			if (d <= 2) near2++;
			if (d <= 1) near1 = true;
			if (!ringCover && ap.some(a => cheb(a, m.at) <= 1)) ringCover = true;
		}
		let blockedRing = 0;
		for (const [dx, dy] of N8) if (blockedAt(o.l, o.at[0] + dx, o.at[1] + dy)) blockedRing++;
		let nb = 99;
		for (let r = 1; r <= 8 && nb === 99; r++)
			for (let dy = -r; dy <= r && nb === 99; dy++) for (let dx = -r; dx <= r; dx++) {
				if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
				if (blockedAt(o.l, o.at[0] + dx, o.at[1] + dy)) { nb = r; break; }
			}
		rows[k].push({ guarded: near2 > 0 || ringCover, flyer: !near1, near2, dist, blockedRing, nb });
	}
	let crowded = 0, sealNothing = 0;
	for (const m of M.monsters) {
		if (M.monsters.some(n => n !== m && n.l === m.l && cheb(n.at, m.at) <= 2)) crowded++;
		const hold = M.objs.some(o => kindOf(o) && o.l === m.l && cheb(o.at, m.at) <= 2) || M.objs.some(o => o.cls === 'low' && o.l === m.l && cheb(o.at, m.at) <= 2);
		if (!hold) sealNothing++;
	}
	return { file, land, rows, monsters: M.monsters.length, crowded, sealNothing, W, H, NL: M.NL };
}

function summarise(files) {
	const maps = files.map(f => { try { return measure(f); } catch (e) { console.error('skip', f, e.message); return null; } }).filter(Boolean);
	const land = maps.reduce((s, m) => s + m.land, 0), mons = maps.reduce((s, m) => s + m.monsters, 0);
	const out = { maps: maps.length, landPerMap: Math.round(land / maps.length), monPer1000: 1000 * mons / land,
		crowdedPct: pct(maps.reduce((s, m) => s + m.crowded, 0), mons), sealNothingPct: pct(maps.reduce((s, m) => s + m.sealNothing, 0), mons), kinds: {} };
	for (const k of KINDS) {
		const all = maps.flatMap(m => m.rows[k]);
		out.kinds[k] = { per1000: 1000 * all.length / land, n: all.length, unguardedPct: pct(all.filter(r => !r.guarded).length, all.length),
			flyerPct: pct(all.filter(r => r.flyer).length, all.length), beside: med(all.map(r => r.near2)), dist: med(all.map(r => r.dist)),
			blockedRing: med(all.map(r => r.blockedRing)), nb: med(all.map(r => r.nb)) };
	}
	return out;
}

if (require.main === module) {
	const O = summarise(list('--ours')), E = summarise(list('--engine'));
	const f = (v, d = 1) => (Number.isNaN(v) || v === undefined ? '-' : v.toFixed(d));
	console.log(`ours ${O.maps} maps (${O.landPerMap} land tiles a map), engine ${E.maps} maps (${E.landPerMap})`);
	console.log(`monsters per 1000 land tiles: ours ${f(O.monPer1000)}  engine ${f(E.monPer1000)}`);
	console.log(`crowded %: ours ${f(O.crowdedPct)}  engine ${f(E.crowdedPct)}; monsters beside no loot %: ours ${f(O.sealNothingPct)}  engine ${f(E.sealNothingPct)}`);
	console.log('kind        per1000 (ours|eng)   unguarded %      flyer-open %     guards beside   guard dist     blocked ring    nearest blocker');
	for (const k of KINDS) {
		const a = O.kinds[k], b = E.kinds[k];
		console.log(`${k.padEnd(10)}  ${f(a.per1000).padStart(6)} | ${f(b.per1000).padStart(6)}    ${f(a.unguardedPct).padStart(6)} | ${f(b.unguardedPct).padStart(6)}   ${f(a.flyerPct).padStart(6)} | ${f(b.flyerPct).padStart(6)}   ${f(a.beside, 0).padStart(4)} | ${f(b.beside, 0).padStart(4)}   ${f(a.dist, 0).padStart(4)} | ${f(b.dist, 0).padStart(4)}   ${f(a.blockedRing, 0).padStart(4)} | ${f(b.blockedRing, 0).padStart(4)}   ${f(a.nb, 0).padStart(4)} | ${f(b.nb, 0).padStart(4)}`);
	}
	const j = arg('--json', null);
	if (j) fs.writeFileSync(j, JSON.stringify({ ours: O, engine: E }, null, 1));
}
module.exports = { measure, summarise };
