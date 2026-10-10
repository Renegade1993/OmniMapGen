'use strict';
/**
 * terrainspecks.js - small patches of one walkable terrain inside another: clusters of up to MAX tiles (8-way) of a
 * terrain, wholly ringed by one other walkable terrain. K, 2026-10-03, on an underground: "lava square standing out on
 * its own". Per level: patches of 1, 2, 3-4 tiles and the first few, with their terrain and the one around them.
 *
 *   node tools/geometry/terrainspecks.js MAP... [--max 4]
 */
const sight = require('../mapsight/lib/sight');
const args = process.argv.slice(2);
const mi = args.indexOf('--max');
const MAX = mi >= 0 ? Number(args[mi + 1]) : 4;
const files = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1] === '--max'));
for (const f of files) {
	const M = sight.load(f);
	const W = M.W, H = M.H, out = [];
	for (let l = 0; l < M.NL; l++) {
		const t = (x, y) => M.terr[M.idx(l, x, y)];
		const seen = new Uint8Array(W * H), bins = { 1: 0, 2: 0, '3-4': 0, more: 0 }, where = [];
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			const c = y * W + x;
			if (seen[c] || !M.ground(M.idx(l, x, y))) continue;
			const me = t(x, y), cells = [], q = [[x, y]];
			seen[c] = 1;
			const around = new Set();
			let edge = false;
			while (q.length) {
				const [cx, cy] = q.pop();
				cells.push([cx, cy]);
				for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
					const u = cx + dx, v = cy + dy;
					if ((!dx && !dy)) continue;
					if (u < 0 || v < 0 || u >= W || v >= H) { edge = true; continue; }
					const tt = t(u, v);
					if (tt === me) { if (!seen[v * W + u]) { seen[v * W + u] = 1; q.push([u, v]); } }
					else around.add(M.ground(M.idx(l, u, v)) ? tt : 'rock');
				}
			}
			around.delete('rock');
			if (edge || cells.length > MAX || around.size !== 1) continue;
			const n = cells.length;
			bins[n === 1 ? 1 : n === 2 ? 2 : n <= 4 ? '3-4' : 'more']++;
			if (where.length < 4) where.push(`${me} in ${[...around][0]} at ${x},${y}`);
		}
		out.push(`L${l} 1:${bins[1]} 2:${bins[2]} 3-4:${bins['3-4']} 5+:${bins.more}${where.length ? ' (' + where.join('; ') + ')' : ''}`);
	}
	console.log(`${f.split(/[\/]/).pop().slice(-28).padEnd(29)} ${out.join(' | ')}`);
}
