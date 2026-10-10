'use strict';
/**
 * road_ends.js - the stricter road-end scan for K's road break (K, 2026-10-08 15:0x, picture k-close-castles-1008.png: "also note the nearby roadbreak
 * there, the first incorrect road break i have seen on this map"). A road end is a road tile with one road neighbour (or two that touch each
 * other), not at a map edge and not beside any visited object's visiting tile. Each such end is named by what lies within R tiles (default 6, any
 * ground, walls ignored): a tile of another road piece (the road was cut or never joined), or a town's front tile with no road (a town left out).
 * sight.roadEnds counts a gap only when a hero walks to the other piece in 4 steps; this one looks 6 tiles round whatever stands between.
 *
 *   node tools/harness/road_ends.js MAP|DIR... [--r 6] [--list] [--pics DIR]
 *
 * A road that stops at a small building's door while another road piece lies 3 to R tiles beyond is listed too (kind 'building').
 *
 * --pics DIR renders a 24 by 20 crop round each of the first 12 ends found per map (mapsight render, the end marked) into DIR.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sight = require('../mapsight/lib/sight');

const N8 = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 0], [-1, 1]];
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const R = +arg('--r', 6), LIST = process.argv.includes('--list'), PICS = arg('--pics', null);
const files = [];
process.argv.slice(2).forEach((a, i, v) => {
	if (a.startsWith('--') || (i > 0 && /^--(r|pics)$/.test(v[i - 1]))) return;
	if (fs.existsSync(a) && fs.statSync(a).isDirectory()) fs.readdirSync(a).filter(f => f.endsWith('.vmap')).sort().forEach(f => files.push(path.join(a, f)));
	else files.push(a);
});

/** The road ends of a loaded map, each with what lies within r tiles. */
function scan(M, r) {
	const { W, H, NL } = M;
	const dest = new Set();
	for (const o of M.objs) {
		if (!o.visitable && o.cls !== 'monster') continue;
		for (const i of [...M.approach(o), ...o.entr.map(([x, y]) => M.idx(o.l, x, y))]) dest.add(i);
		if (o.cls === 'monster') for (const [dx, dy] of N8) if (M.inb(o.at[0] + dx, o.at[1] + dy)) dest.add(M.idx(o.l, o.at[0] + dx, o.at[1] + dy));
	}
	const comp = new Int32Array(NL * W * H).fill(-1);
	let nc = 0;
	for (let s = 0; s < comp.length; s++) {
		if (!M.road[s] || comp[s] >= 0) continue;
		const st = [s]; comp[s] = nc;
		while (st.length) {
			const c = st.pop(), l = Math.floor(c / (W * H)), x = c % W, y = Math.floor(c / W) % H;
			for (const [dx, dy] of N8) { if (!M.inb(x + dx, y + dy)) continue; const k = M.idx(l, x + dx, y + dy); if (M.road[k] && comp[k] < 0) { comp[k] = nc; st.push(k); } }
		}
		nc++;
	}
	const towns = M.objs.filter(o => o.cls === 'town').map(o => ({ o, front: [o.entr[0][0], o.entr[0][1] + 1] })).filter(t => M.inb(t.front[0], t.front[1]) && !M.road[M.idx(t.o.l, t.front[0], t.front[1])] && !M.road[M.idx(t.o.l, t.o.entr[0][0], t.o.entr[0][1])]);
	const out = [];
	for (let l = 0; l < NL; l++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
		const i = M.idx(l, x, y);
		if (!M.road[i] || x === 0 || y === 0 || x === W - 1 || y === H - 1) continue;
		const nb = N8.map(([dx, dy]) => [x + dx, y + dy]).filter(([u, v]) => M.inb(u, v) && M.road[M.idx(l, u, v)]);
		const end = nb.length === 0 || nb.length === 1 || (nb.length === 2 && Math.max(Math.abs(nb[0][0] - nb[1][0]), Math.abs(nb[0][1] - nb[1][1])) <= 1);
		if (!end) continue;
		let atDest = false;
		for (const [dx, dy] of [[0, 0], ...N8]) if (M.inb(x + dx, y + dy) && dest.has(M.idx(l, x + dx, y + dy))) { atDest = true; break; }
		// a road that stops at a building's door and starts again beyond it (the tavern of K's picture): the end is at a small building and another road piece lies 3 to R tiles off
		const bld = [];
		for (const o of M.objs) if (o.l === l && o.visitable && !o.pickup && o.cls !== 'monster' && o.cls !== 'town' && o.cls !== 'gate' && o.cls !== 'monolith' && M.approach(o).some(a => Math.abs((a % W) - x) <= 1 && Math.abs((Math.floor(a / W) % H) - y) <= 1)) bld.push(o);
		if (atDest && !bld.length) continue;
		let best = null;
		for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
			const u = x + dx, v = y + dy;
			if ((!dx && !dy) || !M.inb(u, v)) continue;
			const k = M.idx(l, u, v), d = Math.max(Math.abs(dx), Math.abs(dy));
			if (M.road[k] && comp[k] !== comp[i] && (!best || d < best.d)) best = { d, what: `another road piece at (${u},${v})` };
		}
		for (const t of towns) if (t.o.l === l) {
			const d = Math.max(Math.abs(t.front[0] - x), Math.abs(t.front[1] - y));
			if (d <= r && (!best || d < best.d)) best = { d, what: `the unroaded front tile (${t.front}) of ${t.o.type} (${t.o.at})` };
		}
		if (atDest) best = null;
		let far = null;
		if (bld.length) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
			const u = x + dx, v = y + dy;
			if (!M.inb(u, v)) continue;
			const k = M.idx(l, u, v), d = Math.max(Math.abs(dx), Math.abs(dy));
			if (d >= 3 && M.road[k] && comp[k] !== comp[i] && (!far || d < far.d)) far = { d, what: `another road piece at (${u},${v}) beyond ${bld[0].type} (${bld[0].at})`, kind: 'building' };
		}
		if (best) out.push({ l, x, y, ...best, kind: 'end' });
		else if (far) out.push({ l, x, y, ...far });
	}
	return out;
}

if (require.main === module) {
	let total = 0;
	for (const f of files) {
		const M = sight.load(f), ends = scan(M, R);
		total += ends.length;
		console.log(`${path.basename(f)}: ${ends.length} road end(s) with another road piece or an unroaded town front within ${R} tiles (${ends.filter(e => e.kind === 'building').length} of them at a building with a road piece beyond it)`);
		ends.sort((a, b) => a.d - b.d);
		if (LIST) for (const e of ends) console.log(`    L${e.l} (${e.x},${e.y}) ${e.d} tile(s) from ${e.what}`);
		if (PICS) {
			fs.mkdirSync(PICS, { recursive: true });
			ends.slice(0, 12).forEach((e, k) => {
				const cx = Math.max(0, Math.min(M.W - 24, e.x - 12)), cy = Math.max(0, Math.min(M.H - 20, e.y - 10));
				const out = path.join(PICS, `${path.basename(f, '.vmap')}_L${e.l}_${e.x}_${e.y}.png`);
				try { execFileSync('node', [path.join(__dirname, '../mapsight/mapsight.js'), 'render', f, out, '--level', String(e.l), '--crop', `${cx},${cy},24,20`, '--px', '28', '--mark', `${e.x},${e.y}`], { stdio: 'ignore', windowsHide: true, timeout: 60000 }); } catch (err) { /* a picture is a help, not a result */ }
			});
		}
	}
	console.log(`${files.length} maps, ${total} road end(s)`);
}
module.exports = { scan };
