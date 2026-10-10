'use strict';
/**
 * rockspecks.js - small rock clusters inside open floor: rock terrain (or any impassable terrain) in clusters of a few
 * tiles that touch walkable floor all round. K, 2026-10-03, on an underground: "two black missing texture looking
 * squares which are in the underground layer and labelled 'Rock'". The game draws rock's edge art on the floor around
 * it, and a lone tile or two of rock has no art that fits, so it shows as a black square.
 *
 *   node tools/geometry/rockspecks.js MAP... [--max 4]
 * Per level: clusters of rock of 1, 2, 3-4 tiles (8-way), and rock tiles in no 2x2 block of rock ("one tile wide").
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
		const rock = (x, y) => x < 0 || y < 0 || x >= W || y >= H || !M.ground(M.idx(l, x, y));
		const seen = new Uint8Array(W * H);
		const bins = { 1: 0, 2: 0, '3-4': 0 }, where = [];
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			if (seen[y * W + x] || !rock(x, y)) continue;
			const q = [[x, y]], cells = [];
			seen[y * W + x] = 1;
			let edge = false;
			while (q.length && cells.length <= MAX) {
				const [cx, cy] = q.pop();
				cells.push([cx, cy]);
				for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
					const u = cx + dx, v = cy + dy;
					if (u < 0 || v < 0 || u >= W || v >= H) { edge = true; continue; }
					if (seen[v * W + u] || !rock(u, v)) continue;
					seen[v * W + u] = 1;
					q.push([u, v]);
				}
			}
			if (edge || q.length || cells.length > MAX) {
				// a big mass or one on the map edge: mark the rest of it seen
				while (q.length) {
					const [cx, cy] = q.pop();
					for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
						const u = cx + dx, v = cy + dy;
						if (u < 0 || v < 0 || u >= W || v >= H || seen[v * W + u] || !rock(u, v)) continue;
						seen[v * W + u] = 1; q.push([u, v]);
					}
				}
				continue;
			}
			const n = cells.length;
			bins[n === 1 ? 1 : n === 2 ? 2 : '3-4']++;
			if (where.length < 4) where.push(`${cells[0][0]},${cells[0][1]}`);
		}
		// rock one tile wide: a rock tile in no 2x2 block of rock (the map edge counts as rock)
		let thin = 0; const thinAt = [];
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			if (!rock(x, y) || x === 0 || y === 0 || x === W - 1 || y === H - 1) continue;
			let inBlock = false;
			for (const [ox, oy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]])
				if (rock(x + ox, y + oy) && rock(x + ox + 1, y + oy) && rock(x + ox, y + oy + 1) && rock(x + ox + 1, y + oy + 1)) { inBlock = true; break; }
			if (!inBlock) { thin++; if (thinAt.length < 4) thinAt.push(`${x},${y}`); }
		}
		out.push(`L${l} specks 1:${bins[1]} 2:${bins[2]} 3-4:${bins['3-4']}${where.length ? ' at ' + where.join(' ') : ''}; one tile wide ${thin}${thinAt.length ? ' at ' + thinAt.join(' ') : ''}`);
	}
	console.log(`${f.split(/[\\/]/).pop().slice(-28).padEnd(29)} ${out.join(' | ')}`);
}
