'use strict';
/**
 * shape.js - what a level looks like as ground and wall, measured: how open it is, how wide its passages are and how
 * much that varies, its open clearings, its rock islands, and how ragged its zone borders run.
 * K, 2026-10-01, on a map the score had passed at 85.8%: "THIS IS 300% WORSE" (round open bubbles where the engine has
 * winding tunnels) and "every single overworld biome is a fucking pentagon". The relation measures never saw either.
 *
 *   mapsight shape --ours FILE... --engine FILE...        medians per level, ours against the engine's range
 *
 * Per level (L0 the surface, L1 below):
 *   open             share of the level that is not rock or water
 *   width p10/p50/p90  passage width at the passages' middles (cells as far from a wall as any neighbour), walls are
 *                    rock, water, the map edge and blocking objects, in tiles (2 x distance - 1)
 *   width spread     (p90 - p10) / p50: how much the width varies
 *   clearings /1k    open areas (cells 3+ tiles from any wall, joined) per 1000 open tiles
 *   clearing p90     the 90th percentile clearing size, in tiles
 *   rock islands /1k rock or water masses not touching the map edge, per 1000 tiles of the level
 *   ragged           rock edge per rock tile (high = fingers and islands, low = a few big blocks)
 *   zone ragged      zone border length at 1 tile over the same border measured on a 4x4 grid (1.0 = straight lines,
 *                    the engine's borders wander); only with a zone sidecar
 *   zone compact     median zone perimeter^2 / (4 pi area) (a disc is 1, a Voronoi cell about 1.2)
 */
const sight = require('./sight');

const pc = (a, p) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(p * b.length))] : 0; };
const med = a => pc(a, 0.5);

function levelShape(M, l) {
	const { W, H } = M;
	const N = W * H, base = l * N;
	const rock = new Uint8Array(N), wall = new Uint8Array(N);
	let openN = 0;
	for (let c = 0; c < N; c++) {
		rock[c] = M.ground(base + c) ? 0 : 1;
		wall[c] = rock[c] || M.blocked[base + c] ? 1 : 0;
		if (!rock[c]) openN++;
	}
	// chessboard distance to the nearest wall (the map edge counts as wall)
	const dist = w => {
		const INF = 1e9, d = new Float64Array(N);
		for (let c = 0; c < N; c++) d[c] = w[c] ? 0 : INF;
		const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : d[y * W + x]);
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			const c = y * W + x; if (!d[c]) continue;
			d[c] = Math.min(d[c], at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + 1, at(x + 1, y - 1) + 1);
		}
		for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
			const c = y * W + x; if (!d[c]) continue;
			d[c] = Math.min(d[c], at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + 1, at(x - 1, y + 1) + 1);
		}
		d.at = at;
		return d;
	};
	// passage widths against rock and water only: the carve's own shape (blocking objects inside a passage made every
	// width 1 to 3 on both generators' maps)
	const dr = dist(rock), widths = [];
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
		const c = y * W + x; if (!dr[c] || dr[c] > 1e8) continue;
		let top = true;
		for (let dy = -1; dy <= 1 && top; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && dr.at(x + dx, y + dy) > dr[c]) { top = false; break; }
		if (top) widths.push(2 * dr[c] - 1);
	}
	// clearings against every wall, objects included: open ground a hero sees as a field
	const d = dist(wall);
	// clearings: cells 3+ from a wall, joined 8-ways
	const seen = new Uint8Array(N), clearings = [], clearingAt = [];
	for (let c = 0; c < N; c++) {
		if (seen[c] || d[c] < 3) continue;
		let n = 0, sx = 0, sy = 0; const st = [c]; seen[c] = 1;
		while (st.length) {
			const k = st.pop(); n++; sx += k % W; sy += (k / W) | 0;
			const x = k % W, y = (k / W) | 0;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const nx = x + dx, ny = y + dy; if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const m = ny * W + nx; if (!seen[m] && d[m] >= 3) { seen[m] = 1; st.push(m); }
			}
		}
		clearings.push(n);
		clearingAt.push({ n, x: Math.round(sx / n), y: Math.round(sy / n) });
	}
	// rock islands and rock edge
	const rs = new Uint8Array(N); let islands = 0, rockN = 0, rockEdge = 0;
	for (let c = 0; c < N; c++) {
		if (!rock[c]) continue;
		rockN++;
		const x = c % W, y = (c / W) | 0;
		for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < W && ny < H && !rock[ny * W + nx]) rockEdge++; }
		if (rs[c]) continue;
		let edge = false; const st = [c]; rs[c] = 1;
		while (st.length) {
			const k = st.pop(), kx = k % W, ky = (k / W) | 0;
			if (kx === 0 || ky === 0 || kx === W - 1 || ky === H - 1) edge = true;
			for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = kx + dx, ny = ky + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const m = ny * W + nx; if (rock[m] && !rs[m]) { rs[m] = 1; st.push(m); } }
		}
		if (!edge) islands++;
	}
	const p10 = pc(widths, 0.1), p50 = med(widths), p90 = pc(widths, 0.9);
	const out = {
		open: openN / N,
		'width p10': p10, 'width p50': p50, 'width p90': p90,
		'width spread': p50 ? (p90 - p10) / p50 : 0,
		'clearings /1k': openN ? 1000 * clearings.length / openN : 0,
		'clearing p90': pc(clearings, 0.9),
		'rock islands /1k': 1000 * islands / N,
		ragged: rockN ? rockEdge / rockN : 0,
	};
	Object.defineProperty(out, 'clearingAt', { value: clearingAt.sort((a, b) => b.n - a.n), enumerable: false });
	// zone borders
	if (M.zones && M.zones.zoneOf) {
		const z = c => { const v = M.zoneAt(l, c % W, (c / W) | 0); return v === undefined || v === null || v < 0 ? -1 : v; };
		const zs = new Int32Array(N); for (let c = 0; c < N; c++) zs[c] = z(c);
		let fine = 0;
		const area = new Map(), per = new Map();
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			const c = y * W + x, a = zs[c]; if (a < 0) continue;
			area.set(a, (area.get(a) || 0) + 1);
			for (const [dx, dy] of [[1, 0], [0, 1]]) {
				const nx = x + dx, ny = y + dy; if (nx >= W || ny >= H) continue;
				const b = zs[ny * W + nx]; if (b < 0 || b === a) continue;
				fine++; per.set(a, (per.get(a) || 0) + 1); per.set(b, (per.get(b) || 0) + 1);
			}
		}
		// the same borders on a 4x4 grid (each block takes its most common zone), scaled back to tiles
		const S = 4, w = Math.ceil(W / S), h = Math.ceil(H / S), g = new Int32Array(w * h).fill(-1);
		for (let by = 0; by < h; by++) for (let bx = 0; bx < w; bx++) {
			const cnt = new Map();
			for (let y = by * S; y < Math.min(H, by * S + S); y++) for (let x = bx * S; x < Math.min(W, bx * S + S); x++) { const a = zs[y * W + x]; if (a >= 0) cnt.set(a, (cnt.get(a) || 0) + 1); }
			let best = -1, bn = 0; for (const [a, n] of cnt) if (n > bn) { bn = n; best = a; }
			g[by * w + bx] = best;
		}
		let coarse = 0;
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
			const a = g[y * w + x]; if (a < 0) continue;
			if (x + 1 < w && g[y * w + x + 1] >= 0 && g[y * w + x + 1] !== a) coarse++;
			if (y + 1 < h && g[(y + 1) * w + x] >= 0 && g[(y + 1) * w + x] !== a) coarse++;
		}
		if (coarse && area.size > 1) {
			out['zone ragged'] = fine / (coarse * S);
			out['zone compact'] = med([...area].filter(([, A]) => A > 50).map(([a, A]) => (per.get(a) || 0) ** 2 / (4 * Math.PI * A)));
		}
	}
	return out;
}

/** Shape features of one map: { 'L0: open': ..., ... } */
function features(file) {
	const M = sight.analyse(file).M;
	const f = {};
	for (let l = 0; l < M.NL; l++) for (const [k, v] of Object.entries(levelShape(M, l))) f[`L${l}: ${k}`] = v;
	return f;
}

function list(args, name) {
	const out = [];
	args.forEach((a, i) => { if (a === name) for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) out.push(args[j]); });
	return out;
}

function main(args) {
	const O = list(args, '--ours').map(features), E = list(args, '--engine').map(features);
	const keys = [...new Set([...O, ...E].flatMap(x => Object.keys(x)))].sort();
	const r = v => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2));
	console.log(`shape: ours ${O.length} map(s), engine ${E.length}; ours median against the engine's median and range`);
	for (const k of keys) {
		const o = O.map(x => x[k]).filter(v => v !== undefined), e = E.map(x => x[k]).filter(v => v !== undefined);
		if (!o.length && !e.length) continue;
		const lo = e.length ? Math.min(...e) : NaN, hi = e.length ? Math.max(...e) : NaN, om = med(o);
		const flag = e.length && o.length && (om < lo || om > hi) ? '  OUTSIDE' : '';
		console.log(`  ${k.padEnd(24)} ours ${o.length ? r(om) : '-'}   engine ${e.length ? r(med(e)) : '-'} (${e.length ? r(lo) + ' to ' + r(hi) : '-'})${flag}`);
	}
}

module.exports = { main, features, levelShape };
