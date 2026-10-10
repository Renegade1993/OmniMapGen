'use strict';
/**
 * roadloops.js - independent loops in each level's road (4-neighbour graph: edges - tiles + pieces), with the
 * bounding box of each loop's piece, so a ring road (K, 2026-10-02: "busted road logic....look at that loop") is a
 * number and a place. 2x2 road blocks count as a loop too (real roads have none).
 *   node tools/geometry/roadloops.js MAP...
 */
const sight = require('../mapsight/lib/sight');
for (const f of process.argv.slice(2)) {
	const M = sight.load(f), W = M.W, H = M.H;
	const out = [];
	for (let l = 0; l < M.NL; l++) {
		const has = (x, y) => x >= 0 && y >= 0 && x < W && y < H && M.road[M.idx(l, x, y)];
		const seen = new Uint8Array(W * H);
		let total = 0;
		const where = [];
		for (let y0 = 0; y0 < H; y0++) for (let x0 = 0; x0 < W; x0++) {
			if (!has(x0, y0) || seen[y0 * W + x0]) continue;
			let V = 0, E = 0, bx0 = x0, bx1 = x0, by0 = y0, by1 = y0;
			const st = [[x0, y0]]; seen[y0 * W + x0] = 1;
			while (st.length) {
				const [x, y] = st.pop(); V++;
				bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y);
				if (has(x + 1, y)) E++; if (has(x, y + 1)) E++;
				for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (has(x + dx, y + dy) && !seen[(y + dy) * W + x + dx]) { seen[(y + dy) * W + x + dx] = 1; st.push([x + dx, y + dy]); }
			}
			const loops = E - V + 1;
			if (loops > 0) { total += loops; where.push(`${loops}@${bx0},${by0}-${bx1},${by1}`); }
		}
		out.push(`L${l} loops ${total}${where.length ? ' (' + where.join(' ') + ')' : ''}`);
	}
	console.log(f.split(/[\/]/).pop(), out.join(' | '));
}
