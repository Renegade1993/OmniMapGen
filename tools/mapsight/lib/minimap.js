'use strict';
/**
 * minimap.js - the whole map at a glance, ours beside the engine's. K, 2026-10-01: "what about a minimap snapshot
 * comparison or something?" Measures and patches look at parts; this shows the layout as a whole.
 *
 *   mapsight minimap --ours FILE --engine FILE [--cell 4] --out DIR
 *
 * Writes, per level: a picture with both maps side by side in game-minimap colours (terrain, darker where blocked, roads,
 * towns, guards, loot), and a text minimap where each character sums up a cell of c x c tiles:
 *   T town   ~ water   ^ rock   # mostly wall (under a third walkable)   $ 3+ loot or prizes   M 2+ guards
 *   = road with walkable ground   . open ground (half or more 3+ tiles from a wall)   : walkable, between walls
 * plus layout numbers that compare across seeds: the share of each cell kind, and how big the open and the walled
 * stretches are (connected cells of one kind).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const sight = require('./sight');
const { walls } = require('./relations');
const { TERRAIN_COLORS, terrainColor } = require('../../../src/preview/palette');

function opt(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }

function cells(file, c) {
	const A = sight.analyse(file), M = A.M, W = walls(M);
	const byTile = new Map();
	for (const o of M.objs) if (o.cls !== 'other' || o.visitable) byTile.set(M.idx(o.l, o.at[0], o.at[1]), o);
	const out = [];
	for (let l = 0; l < M.NL; l++) {
		const rows = [];
		for (let cy = 0; cy < Math.ceil(M.H / c); cy++) {
			let r = '';
			for (let cx = 0; cx < Math.ceil(M.W / c); cx++) {
				let n = 0, water = 0, rock = 0, walk = 0, open = 0, road = 0, town = 0, loot = 0, guards = 0;
				for (let y = cy * c; y < Math.min(M.H, cy * c + c); y++) for (let x = cx * c; x < Math.min(M.W, cx * c + c); x++) {
					const i = M.idx(l, x, y); n++;
					const t = M.terr[i];
					if (t === 'wa' || t === 'wt') water++; else if (t === 'rc' || t === 'ro') rock++;
					if (W.pass(i)) { walk++; if (W.dist[i] >= 3) open++; }
					if (M.road[i]) road++;
					const o = byTile.get(i);
					if (o) { if (o.cls === 'town') town++; else if (o.cls === 'monster') guards++; else if (['high', 'low', 'dwelling', 'bank'].includes(o.cls)) loot++; }
				}
				r += town ? 'T' : water * 2 > n ? '~' : rock * 2 > n ? '^' : walk * 3 < n ? '#' : loot >= 3 ? '$' : guards >= 2 ? 'M' : road && walk * 2 > n ? '=' : open * 2 >= walk ? '.' : ':';
			}
			rows.push(r);
		}
		out.push(rows);
	}
	return { A, M, W, levels: out };
}

/** Share of each cell kind, and mean size of connected stretches of open ('.') and walled ('#') cells. */
function layout(rows) {
	const H = rows.length, Wd = rows[0].length, n = H * Wd;
	const share = {};
	for (const r of rows) for (const ch of r) share[ch] = (share[ch] || 0) + 1 / n;
	const blobs = ch => {
		const seen = new Set(), sizes = [];
		for (let y = 0; y < H; y++) for (let x = 0; x < Wd; x++) {
			if (rows[y][x] !== ch || seen.has(y * Wd + x)) continue;
			const st = [[x, y]]; seen.add(y * Wd + x); let s = 0;
			while (st.length) {
				const [a, b] = st.pop(); s++;
				for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
					const X = a + dx, Y = b + dy;
					if (X < 0 || Y < 0 || X >= Wd || Y >= H || rows[Y][X] !== ch || seen.has(Y * Wd + X)) continue;
					seen.add(Y * Wd + X); st.push([X, Y]);
				}
			}
			sizes.push(s);
		}
		return { count: sizes.length, mean: sizes.length ? sizes.reduce((p, q) => p + q, 0) / sizes.length : 0, max: sizes.length ? Math.max(...sizes) : 0 };
	};
	return { share, open: blobs('.'), wall: blobs('#') };
}

/**
 * Clark-Evans ratio of a set of points on walkable ground: mean nearest-neighbour distance over what a random scatter of
 * the same density would give (0.5 / sqrt(density)). Under 1 clumped, about 1 random, over 1 evenly spread. Seen on the
 * Coldshadow minimaps (2026-10-01): the engine's treasure comes in clumps, ours is sprinkled evenly.
 */
function clarkEvans(X, l, pick) {
	const pts = X.M.objs.filter(o => o.l === l && pick(o)).map(o => o.at);
	if (pts.length < 5) return null;
	let walk = 0;
	for (let y = 0; y < X.M.H; y++) for (let x = 0; x < X.M.W; x++) if (X.W.pass(X.M.idx(l, x, y))) walk++;
	let sum = 0;
	for (const p of pts) { let b = 1e9; for (const q of pts) if (q !== p) b = Math.min(b, Math.hypot(p[0] - q[0], p[1] - q[1])); sum += b; }
	return (sum / pts.length) / (0.5 / Math.sqrt(pts.length / Math.max(1, walk)));
}
const SETS = [['high loot', o => o.cls === 'high'], ['all loot (pickups)', o => o.cls === 'high' || o.cls === 'low'], ['guards', o => o.cls === 'monster'],
	['dwellings', o => o.cls === 'dwelling'], ['creature banks', o => o.cls === 'bank']];

function main(args) {
	const ours = opt(args, '--ours'), eng = opt(args, '--engine'), out = opt(args, '--out'), c = +(opt(args, '--cell') || 4);
	if (!ours || !eng || !out) { console.log('minimap needs --ours FILE --engine FILE --out DIR'); process.exitCode = 2; return; }
	fs.mkdirSync(out, { recursive: true });
	const a = cells(ours, c), b = cells(eng, c);
	const md = [`# Minimap: ours ${path.basename(ours)} beside the engine's ${path.basename(eng)}`, '',
		`Each character is ${c}x${c} tiles: T town, ~ water, ^ rock, # mostly wall (under a third walkable), $ 3+ loot or prizes, M 2+ guards, = road through walkable ground, . open ground (half or more 3+ tiles from a wall), : walkable between walls.`, ''];
	const pct = v => `${Math.round(100 * (v || 0))}%`;
	for (let l = 0; l < Math.max(a.levels.length, b.levels.length); l++) {
		const ra = a.levels[l], rb = b.levels[l];
		md.push(`## Level ${l} (${l ? 'underground' : 'surface'})`, '');
		if (ra && rb) {
			const la = layout(ra), lb = layout(rb);
			md.push('| layout | ours | engine |', '|---|---|---|');
			for (const ch of ['.', ':', '#', '=', '$', 'M', 'T', '~', '^']) md.push(`| cells "${ch}" | ${pct(la.share[ch])} | ${pct(lb.share[ch])} |`);
			md.push(`| open stretches: count, mean size, largest (cells) | ${la.open.count}, ${la.open.mean.toFixed(1)}, ${la.open.max} | ${lb.open.count}, ${lb.open.mean.toFixed(1)}, ${lb.open.max} |`);
			md.push(`| walled stretches: count, mean size, largest | ${la.wall.count}, ${la.wall.mean.toFixed(1)}, ${la.wall.max} | ${lb.wall.count}, ${lb.wall.mean.toFixed(1)}, ${lb.wall.max} |`);
			for (const [name, pick] of SETS) {
				const ca = clarkEvans(a, l, pick), cb = clarkEvans(b, l, pick);
				md.push(`| clumping of ${name} (Clark-Evans: under 1 clumped, 1 random, over 1 even) | ${ca === null ? 'n/a' : ca.toFixed(2)} | ${cb === null ? 'n/a' : cb.toFixed(2)} |`);
			}
			md.push('');
		}
		md.push('```', `${'ours'.padEnd((ra ? ra[0].length : 0) + 2)}engine`);
		for (let y = 0; y < Math.max(ra ? ra.length : 0, rb ? rb.length : 0); y++) md.push(`${ra && ra[y] ? ra[y] : ''.padEnd(ra ? ra[0].length : 0)}  ${rb && rb[y] ? rb[y] : ''}`);
		md.push('```', '');
		// picture: both maps in minimap colours, 3 px a tile
		const dump = path.join(out, `level${l}.json`);
		const side = (X, lv) => {
			if (!X.levels[lv]) return null;
			const M = X.M, rows = [];
			for (let y = 0; y < M.H; y++) {
				const row = [];
				for (let x = 0; x < M.W; x++) {
					const i = M.idx(lv, x, y), t = M.terr[i];
					let col = t === 'rc' || t === 'ro' ? [20, 20, 20] : terrainColor(t);
					if (M.blocked[i] && !(t === 'rc' || t === 'ro')) col = col.map(v => Math.round(v * 0.55));
					if (M.road[i]) col = [150, 105, 60];
					row.push(col);
				}
				rows.push(row);
			}
			const marks = M.objs.filter(o => o.l === lv && ['town', 'monster', 'high', 'dwelling', 'bank', 'mine'].includes(o.cls)).map(o => ({ cls: o.cls, at: o.at, owner: o.options && o.options.owner }));
			return { title: path.basename(X.A.file || ''), rows, marks };
		};
		fs.writeFileSync(dump, JSON.stringify({ left: side(a, l), right: side(b, l), leftTitle: `OURS ${path.basename(ours)}`, rightTitle: `ENGINE ${path.basename(eng)}` }));
		spawnSync('py', [path.join(__dirname, '..', 'minimap.py'), dump, path.join(out, `minimap_level${l}.png`)], { timeout: 60000, windowsHide: true });
		fs.unlinkSync(dump);
		md.push(`Picture: minimap_level${l}.png (ours left).`, '');
	}
	fs.writeFileSync(path.join(out, 'minimap.md'), md.join('\n') + '\n');
	console.log(`minimap written to ${out}`);
}

module.exports = { main, cells, layout };
