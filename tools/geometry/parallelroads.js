'use strict';
/**
 * parallelroads.js - two roads running side by side. K, 2026-10-03: "a couple roads at still running parallel to each
 * other in close proximity for long distances...this is not a desired feature".
 *
 * A road tile is "parallel" when another road tile lies within R tiles of it (8-way, default 3) but more than D steps
 * away along the roads (default 12): a separate road, not a bend of its own. Parallel tiles that touch form a run; the
 * report gives the parallel share of road tiles and the runs of RUN tiles or more (default 8), longest first, with a
 * tile of each to look at.
 *
 *   node tools/geometry/parallelroads.js MAP... [--r 3] [--d 12] [--run 8]
 */
const sight = require('../mapsight/lib/sight');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? Number(args[i + 1]) : d; };
const R = opt('r', 3), D = opt('d', 12), RUN = opt('run', 8);
const files = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));

for (const f of files) {
	const M = sight.load(f);
	const W = M.W, H = M.H;
	const out = [];
	let roadTiles = 0, parTiles = 0;
	for (let l = 0; l < M.NL; l++) {
		const road = c => M.road[M.idx(l, c % W, (c / W) | 0)];
		const cells = [];
		for (let c = 0; c < W * H; c++) if (road(c)) cells.push(c);
		roadTiles += cells.length;
		const isPar = new Uint8Array(W * H);
		const dist = new Int32Array(W * H).fill(-1);
		for (const s of cells) {
			// along the road, D steps out
			const seen = [s]; dist[s] = 0;
			for (let h = 0; h < seen.length; h++) {
				const c = seen[h];
				if (dist[c] >= D) continue;
				const x = c % W, y = (c / W) | 0;
				for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
					const u = x + dx, v = y + dy;
					if ((!dx && !dy) || u < 0 || v < 0 || u >= W || v >= H) continue;
					const m = v * W + u;
					if (dist[m] >= 0 || !road(m)) continue;
					dist[m] = dist[c] + 1; seen.push(m);
				}
			}
			const x = s % W, y = (s / W) | 0;
			for (let dy = -R; dy <= R && !isPar[s]; dy++) for (let dx = -R; dx <= R; dx++) {
				const u = x + dx, v = y + dy;
				if (u < 0 || v < 0 || u >= W || v >= H) continue;
				const m = v * W + u;
				if (road(m) && dist[m] < 0) { isPar[s] = 1; break; }
			}
			for (const c of seen) dist[c] = -1;
		}
		// runs: parallel tiles that touch
		const done = new Uint8Array(W * H);
		for (const s of cells) {
			if (!isPar[s] || done[s]) continue;
			const comp = [s]; done[s] = 1;
			for (let h = 0; h < comp.length; h++) {
				const c = comp[h], x = c % W, y = (c / W) | 0;
				for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
					const u = x + dx, v = y + dy;
					if (u < 0 || v < 0 || u >= W || v >= H) continue;
					const m = v * W + u;
					if (isPar[m] && !done[m]) { done[m] = 1; comp.push(m); }
				}
			}
			parTiles += comp.length;
			if (comp.length >= RUN) out.push({ n: comp.length, at: `${comp[0] % W},${(comp[0] / W) | 0}${l ? ',L' + l : ''}` });
		}
	}
	out.sort((a, b) => b.n - a.n);
	console.log(`${f.split(/[\\/]/).pop().slice(-28).padEnd(29)} road ${roadTiles}, parallel ${parTiles} (${roadTiles ? (100 * parTiles / roadTiles).toFixed(1) : 0}%), runs of ${RUN}+: ${out.length}${out.length ? ' | ' + out.slice(0, 6).map(r => `${r.n} at (${r.at})`).join(' ') : ''}`);
}
