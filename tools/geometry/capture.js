'use strict';
/**
 * capture.js - a map's skeleton as geometry: points, road lines with their joints, zone polygons, cave centre lines.
 * Phase 0 of the new generation approach (VCMIMapGen\! LLM Files\Generation-Paradigm-Brainstorm-2026-10-02.md): the
 * same features are read from the engine's maps and from ours, so the plan can be learned from the engine and
 * compared feature by feature, locally, instead of by map-wide averages.
 *
 *   node tools/geometry/capture.js MAP.vmap... [--out DIR] [--png]
 *
 * Needs the map's zone sidecar (MAP.zones.json from the engine's rmgdump, MAP.vmap.zones.json from ours). Writes
 * DIR/<map>.geo.json (default: beside the map) and, with --png, DIR/<map>.geo_L<level>.png: the zones in pale colours
 * with their edges, road edges in colours by edge, joints and ends marked by what they touch, cave centre lines.
 * Coordinates are tiles (x right, y down), one level at a time.
 *
 * Features per level:
 *   points  every visitable object, town and monster: kind, subtype, class, zone, guarded (a monster's ring touches
 *           a tile it is visited from)
 *   roads   the road tiles as a graph over 4-neighbour steps (the way the game's roads join): nodes are ends (one
 *           neighbour) and joints (three or more, clustered), each end labelled by what it touches (town, mine,
 *           gate, monolith, dwelling, bank, guard, nothing); edges are the tile chains between nodes, with length,
 *           straightness (end-to-end distance over length), turns, mean straight run, and the share of turns that
 *           alternate (stair steps)
 *   zones   per template zone on the level: tiles, share of the level, open tiles, perimeter, compactness
 *           (4 pi A / P^2), convexity (area over hull area), elongation and orientation (principal axes), centroid
 *   caves   on a level with rock: centre-line tiles of the floor (ridges of the distance to rock) with the passage
 *           width at each, and the widths' p10/p50/p90
 */
const fs = require('fs');
const path = require('path');
const sight = require('../mapsight/lib/sight');

const N4 = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const N8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const q = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const r2 = v => (v === null || v === undefined || !Number.isFinite(v) ? v : Math.round(v * 100) / 100);

function capture(file) {
	const M = sight.load(file);
	const { W, H, NL } = M;
	const zoneAt = (l, x, y) => { const z = M.zoneAt(l, x, y); return z === undefined || z === null || z < 0 ? null : z; };
	const levels = [];
	for (let l = 0; l < NL; l++) {
		const base = l * W * H, N = W * H;
		const objs = M.objs.filter(o => o.l === l);
		// --- points
		const ring = new Int32Array(N).fill(-1);
		for (const m of objs.filter(o => o.cls === 'monster'))
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (M.inb(m.at[0] + dx, m.at[1] + dy)) ring[(m.at[1] + dy) * W + m.at[0] + dx] = 1;
		const points = [];
		const touch = new Map();   // tile -> kinds of things visited from or standing there
		for (const o of objs) {
			if (!o.visitable && o.cls !== 'monster') continue;
			const app = M.approach(o).map(i => i - base);
			const guarded = o.cls !== 'monster' && app.some(i => ring[i] >= 0);
			points.push({ kind: o.type, sub: o.subtype || null, cls: o.cls, x: o.at[0], y: o.at[1], zone: zoneAt(l, o.at[0], o.at[1]), guarded });
			const k = o.cls === 'monster' ? 'guard' : o.cls === 'other' ? 'building' : o.cls;
			for (const i of [...app, ...o.entr.map(([x, y]) => y * W + x)]) { if (!touch.has(i)) touch.set(i, new Set()); touch.get(i).add(k); }
		}
		// --- roads: a graph over 4-neighbour steps
		const isRoad = (x, y) => M.inb(x, y) && !!M.road[base + y * W + x];
		const deg = c => { const x = c % W, y = (c / W) | 0; let n = 0; for (const [dx, dy] of N4) if (isRoad(x + dx, y + dy)) n++; return n; };
		const roadTiles = [];
		for (let c = 0; c < N; c++) if (M.road[base + c]) roadTiles.push(c);
		const nodeOf = new Int32Array(N).fill(-1), nodes = [];
		const isNode = c => deg(c) !== 2;
		for (const c of roadTiles) {
			if (!isNode(c) || nodeOf[c] >= 0) continue;
			// a joint is a cluster of touching node tiles
			const id = nodes.length, tiles = [c]; nodeOf[c] = id;
			for (let h = 0; h < tiles.length; h++) {
				const t = tiles[h], x = t % W, y = (t / W) | 0;
				for (const [dx, dy] of N4) { const m = (y + dy) * W + x + dx; if (isRoad(x + dx, y + dy) && isNode(m) && nodeOf[m] < 0 && deg(m) >= 3 && deg(t) >= 3) { nodeOf[m] = id; tiles.push(m); } }
			}
			const d = Math.max(...tiles.map(deg));
			const near = new Set();
			for (const t of tiles) { const x = t % W, y = (t / W) | 0; for (const [dx, dy] of [[0, 0], ...N8]) { const m = (y + dy) * W + x + dx; if (M.inb(x + dx, y + dy) && touch.has(m)) for (const k of touch.get(m)) near.add(k); } }
			const kind = d <= 1 ? 'end' : d === 3 ? 'T' : d >= 4 ? 'X' : 'node';
			nodes.push({ id, kind, x: tiles[0] % W, y: (tiles[0] / W) | 0, tiles: tiles.length, touches: [...near].sort(), zone: zoneAt(l, tiles[0] % W, (tiles[0] / W) | 0) });
		}
		const edges = [], used = new Uint8Array(N);
		const trace = (start, first) => {
			const chain = [start, first];
			let prev = start, cur = first;
			while (nodeOf[cur] < 0) {
				used[cur] = 1;
				const x = cur % W, y = (cur / W) | 0;
				let next = -1;
				for (const [dx, dy] of N4) { const m = (y + dy) * W + x + dx; if (isRoad(x + dx, y + dy) && m !== prev) { next = m; break; } }
				if (next < 0 || next === start) break;
				prev = cur; cur = next; chain.push(cur);
				if (chain.length > N) break;
			}
			return chain;
		};
		const measure = (chain, a, b) => {
			const pts = chain.map(c => [c % W, (c / W) | 0]);
			let turns = 0, alt = 0, lastDir = null, lastTurn = 0, run = 0;
			const runs = [];
			for (let i = 1; i < pts.length; i++) {
				const d = `${pts[i][0] - pts[i - 1][0]},${pts[i][1] - pts[i - 1][1]}`;
				if (lastDir !== null && d !== lastDir) {
					const [ax, ay] = lastDir.split(',').map(Number), [bx, by] = d.split(',').map(Number);
					const side = Math.sign(ax * by - ay * bx);
					if (lastTurn && side === -lastTurn) alt++;
					lastTurn = side; turns++; runs.push(run); run = 0;
				}
				lastDir = d; run++;
			}
			runs.push(run);
			const steps = pts.length - 1, chord = Math.hypot(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1]);
			return { a, b, length: steps, straight: r2(steps ? chord / steps : 1), turns, meanRun: r2(runs.reduce((s, v) => s + v, 0) / runs.length),
				stairShare: r2(turns > 1 ? alt / (turns - 1) : 0), zone: zoneAt(l, pts[pts.length >> 1][0], pts[pts.length >> 1][1]), line: pts };
		};
		for (const n of nodes) {
			for (const c of roadTiles.filter(t => nodeOf[t] === n.id)) {
				const x = c % W, y = (c / W) | 0;
				for (const [dx, dy] of N4) {
					const m = (y + dy) * W + x + dx;
					if (!isRoad(x + dx, y + dy) || nodeOf[m] === n.id || used[m]) continue;
					if (nodeOf[m] >= 0) { if (n.id < nodeOf[m]) edges.push(measure([c, m], n.id, nodeOf[m])); continue; }
					const chain = trace(c, m);
					const end = chain[chain.length - 1];
					edges.push(measure(chain, n.id, nodeOf[end] >= 0 ? nodeOf[end] : -1));
				}
			}
		}
		// loops with no node at all
		for (const c of roadTiles) if (nodeOf[c] < 0 && !used[c]) { const x = c % W, y = (c / W) | 0; const nb = N4.map(([dx, dy]) => (y + dy) * W + x + dx).find((m, i) => isRoad(x + N4[i][0], y + N4[i][1])); if (nb !== undefined) edges.push(measure(trace(c, nb), -1, -1)); }
		// --- zones
		const zt = new Map();
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			const z = zoneAt(l, x, y); if (z === null) continue;
			if (!zt.has(z)) zt.set(z, []);
			zt.get(z).push([x, y]);
		}
		const zones = [];
		for (const [z, tiles] of zt) {
			let per = 0, open = 0, sx = 0, sy = 0;
			for (const [x, y] of tiles) {
				sx += x; sy += y;
				if (M.ground(base + y * W + x) && !M.blocked[base + y * W + x]) open++;
				for (const [dx, dy] of N4) if (!M.inb(x + dx, y + dy) || zoneAt(l, x + dx, y + dy) !== z) per++;
			}
			const A = tiles.length, cx = sx / A, cy = sy / A;
			let sxx = 0, syy = 0, sxy = 0;
			for (const [x, y] of tiles) { sxx += (x - cx) ** 2; syy += (y - cy) ** 2; sxy += (x - cx) * (y - cy); }
			const tr = (sxx + syy) / A, det = (sxx * syy - sxy * sxy) / (A * A), disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
			const l1 = tr / 2 + disc, l2 = Math.max(1e-9, tr / 2 - disc);
			// convex hull of the tile corners (monotone chain)
			const pts = []; for (const [x, y] of tiles) pts.push([x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]);
			pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
			const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
			const lo = [], up = [];
			for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
			for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
			const hull = lo.slice(0, -1).concat(up.slice(0, -1));
			let ha = 0; for (let i = 0; i < hull.length; i++) { const a = hull[i], b = hull[(i + 1) % hull.length]; ha += a[0] * b[1] - b[0] * a[1]; }
			zones.push({ zone: z, tiles: A, share: r2(A / N), open, perimeter: per, compact: r2(4 * Math.PI * A / (per * per)), convex: r2(A / (Math.abs(ha) / 2)),
				elongation: r2(Math.sqrt(l1 / l2)), orientation: r2(Math.atan2(2 * sxy, sxx - syy) / 2 * 180 / Math.PI), cx: r2(cx), cy: r2(cy) });
		}
		zones.sort((a, b) => a.zone - b.zone);
		// --- caves: ridges of the distance to rock
		let rockTiles = 0;
		for (let c = 0; c < N; c++) if (!M.ground(base + c)) rockTiles++;
		let caves = null;
		if (rockTiles > N * 0.15) {
			const d = new Int16Array(N).fill(-1), qq = [];
			for (let c = 0; c < N; c++) if (!M.ground(base + c)) { d[c] = 0; qq.push(c); }
			for (let c = 0; c < N; c++) { const x = c % W, y = (c / W) | 0; if (d[c] < 0 && (x === 0 || y === 0 || x === W - 1 || y === H - 1)) { d[c] = 1; qq.push(c); } }
			for (let h = 0; h < qq.length; h++) { const c = qq[h], x = c % W, y = (c / W) | 0; for (const [dx, dy] of N8) { if (!M.inb(x + dx, y + dy)) continue; const m = (y + dy) * W + x + dx; if (d[m] < 0) { d[m] = d[c] + 1; qq.push(m); } } }
			const ridge = [];
			const D = (x, y) => (M.inb(x, y) ? d[y * W + x] : 0);
			for (let c = 0; c < N; c++) {
				if (d[c] <= 0) continue;
				const x = c % W, y = (c / W) | 0, v = d[c];
				if ([[1, 0], [0, 1], [1, 1], [1, -1]].some(([dx, dy]) => v >= D(x + dx, y + dy) && v >= D(x - dx, y - dy) && (v > D(x + dx, y + dy) || v > D(x - dx, y - dy)))) ridge.push([x, y, 2 * v - 1]);
			}
			const w = ridge.map(r => r[2]);
			caves = { floor: N - rockTiles, ridgeTiles: ridge.length, widthP10: q(w, 0.1), widthP50: q(w, 0.5), widthP90: q(w, 0.9), ridge };
		}
		levels.push({ level: l, points, roads: { tiles: roadTiles.length, nodes, edges }, zones, caves });
	}
	return { file: path.basename(file), W, H, levels: NL, data: levels };
}

function summary(G) {
	const out = [];
	for (const L of G.data) {
		const e = L.roads.edges, ends = L.roads.nodes.filter(n => n.kind === 'end');
		const endKinds = {};
		for (const n of ends) { const k = n.touches.filter(t => t !== 'low' && t !== 'high').join('+') || 'nothing'; endKinds[k] = (endKinds[k] || 0) + 1; }
		const long = e.filter(x => x.length >= 6);
		out.push(`  L${L.level}: points ${L.points.length}; road tiles ${L.roads.tiles}, edges ${e.length}, joints T ${L.roads.nodes.filter(n => n.kind === 'T').length} X ${L.roads.nodes.filter(n => n.kind === 'X').length}, ends ${ends.length} ${JSON.stringify(endKinds)}`);
		if (long.length) out.push(`      road edges 6+ tiles: straightness p50 ${q(long.map(x => x.straight), 0.5)}, mean run p50 ${q(long.map(x => x.meanRun), 0.5)}, stair share p50 ${q(long.map(x => x.stairShare), 0.5)}, length p50 ${q(long.map(x => x.length), 0.5)} p90 ${q(long.map(x => x.length), 0.9)}`);
		const z = L.zones;
		if (z.length) out.push(`      zones ${z.length}: compact p50 ${q(z.map(x => x.compact), 0.5)}, convex p50 ${q(z.map(x => x.convex), 0.5)}, elongation p50 ${q(z.map(x => x.elongation), 0.5)}`);
		if (L.caves) out.push(`      caves: floor ${L.caves.floor}, centre-line tiles ${L.caves.ridgeTiles}, width p10/p50/p90 ${L.caves.widthP10}/${L.caves.widthP50}/${L.caves.widthP90}`);
	}
	return out.join('\n');
}

function picture(G, file, outDir) {
	const { encodePng } = require('../../src/preview/png');
	const S = 4;
	for (const L of G.data) {
		const W = G.W, H = G.H, img = Buffer.alloc(W * S * H * S * 4, 255);
		const put = (x, y, c, size = S) => { for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) { const px = x * S + dx, py = y * S + dy; if (px < 0 || py < 0 || px >= W * S || py >= H * S) continue; const i = (py * W * S + px) * 4; img[i] = c[0]; img[i + 1] = c[1]; img[i + 2] = c[2]; img[i + 3] = 255; } };
		const M = sight.load(file);
		const zc = z => [170 + ((z * 37) % 70), 170 + ((z * 59) % 70), 170 + ((z * 83) % 70)];
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			const i = L.level * W * H + y * W + x;
			const z = M.zoneAt(L.level, x, y);
			put(x, y, !M.ground(i) ? [25, 25, 25] : z === undefined || z === null || z < 0 ? [200, 200, 200] : zc(z));
			if (z !== undefined && z !== null && M.inb(x + 1, y) && M.zoneAt(L.level, x + 1, y) !== z) put(x, y, [255, 255, 255], 1);
		}
		if (L.caves) for (const [x, y] of L.caves.ridge) put(x, y, [90, 90, 160], 2);
		L.roads.edges.forEach((e, k) => { const c = [(k * 97) % 200, 60 + (k * 53) % 150, (k * 151) % 200]; for (const [x, y] of e.line) put(x, y, c); });
		const NK = { end: [255, 0, 0], T: [0, 0, 255], X: [255, 0, 255], node: [0, 0, 0] };
		for (const n of L.roads.nodes) { const c = n.kind === 'end' && n.touches.some(t => ['town', 'mine', 'gate', 'monolith'].includes(t)) ? [0, 180, 0] : NK[n.kind]; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) put(n.x + dx, n.y + dy, c, 2); }
		for (const p of L.points) if (p.cls === 'town') for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) put(p.x + dx, p.y + dy, [0, 0, 0]);
		fs.writeFileSync(path.join(outDir, G.file.replace(/\.vmap$/i, '') + `.geo_L${L.level}.png`), encodePng(W * S, H * S, img));
	}
}

if (require.main === module) {
	const args = process.argv.slice(2);
	const oi = args.indexOf('--out'), outDir = oi >= 0 ? args[oi + 1] : null;
	const files = args.filter((a, i) => /\.vmap$/i.test(a) && args[i - 1] !== '--out');
	for (const f of files) {
		const G = capture(f);
		const dir = outDir || path.dirname(f);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, G.file.replace(/\.vmap$/i, '') + '.geo.json'), JSON.stringify(G));
		if (args.includes('--png')) picture(G, f, dir);
		console.log(G.file + '\n' + summary(G));
	}
}

module.exports = { capture, summary };
