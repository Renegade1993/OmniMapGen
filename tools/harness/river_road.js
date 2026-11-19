'use strict';
// river_road.js MAP|DIR... : rivers over roads (S345, K: "they should never run longwise under a road"). Per map and level: the river tiles that share a tile with a road,
// split by their 4-connected runs: a crossing is a run of one tile (a river meeting a road at an angle), a lengthwise run is two tiles or more. Prints a row per map and a total.
const fs = require('fs'), path = require('path');
const { readVmap } = require('../../src/preview/render');
const RIVERS = new Set(['rw', 'ri', 'rm', 'rl', 'ra', 'lr', 'ww', 'ut', 'pw', 'sr']);
const FLIPS = new Set(['_', '-', '|', '+']);
function layers(code) {
	code = String(code);
	let i = 2;
	while (i < code.length && /[0-9]/.test(code[i])) i++;
	if (FLIPS.has(code[i])) i++;
	const out = [];
	while (i + 2 < code.length) {
		const kind = code.slice(i, i + 2);
		let j = i + 2;
		while (j < code.length && /[0-9]/.test(code[j])) j++;
		if (!FLIPS.has(code[j])) break;
		out.push(kind);
		i = j + 1;
	}
	return out;
}
const files = [];
for (const a of process.argv.slice(2)) {
	if (fs.statSync(a).isDirectory()) { for (const f of fs.readdirSync(a)) if (f.endsWith('.vmap')) files.push(path.join(a, f)); } else files.push(a);
}
const tot = { maps: 0, maps_with_river_road: 0, river: 0, shared: 0, crossings: 0, runs: 0, runTiles: 0, longest: 0, mapsWithRun: 0 };
console.log(['map', 'river tiles', 'on a road', 'crossings', 'lengthwise runs', 'tiles in runs', 'longest run'].join('\t'));
for (const f of files.sort()) {
	let v;
	try { v = readVmap(f); } catch { continue; }
	let river = 0, shared = 0, crossings = 0, runs = 0, runTiles = 0, longest = 0, where = null;
	for (const lv of v.levels) {
		const H = lv.rows.length, W = lv.rows[0].length;
		const both = new Uint8Array(W * H);
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			const L = layers(lv.rows[y][x]);
			const r = L.some(k => RIVERS.has(k)), d = L.some(k => !RIVERS.has(k));
			if (r) river++;
			if (r && d) { both[y * W + x] = 1; shared++; }
		}
		const seen = new Uint8Array(W * H);
		for (let c = 0; c < W * H; c++) {
			if (!both[c] || seen[c]) continue;
			const q = [c]; seen[c] = 1;
			for (let i = 0; i < q.length; i++) {
				const u = q[i] % W, w = (q[i] / W) | 0;
				for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
					const a = u + dx, b = w + dy;
					if (a < 0 || b < 0 || a >= W || b >= H) continue;
					const n = b * W + a;
					if (both[n] && !seen[n]) { seen[n] = 1; q.push(n); }
				}
			}
			if (q.length === 1) crossings++; else { runs++; runTiles += q.length; if (q.length > longest) { longest = q.length; where = q[0] % W + "," + ((q[0] / W) | 0); } }
		}
	}
	console.log([path.basename(f).replace(/\.vmap$/, ''), river, shared, crossings, runs, runTiles, longest, where || ''].join('\t'));
	tot.maps++; tot.river += river; tot.shared += shared; tot.crossings += crossings; tot.runs += runs; tot.runTiles += runTiles; tot.longest = Math.max(tot.longest, longest);
	if (shared) tot.maps_with_river_road++;
	if (runs) tot.mapsWithRun++;
}
console.log(`TOTAL ${tot.maps} maps: river tiles ${tot.river}, on a road ${tot.shared} in ${tot.maps_with_river_road} maps; crossings (one tile) ${tot.crossings}; lengthwise runs (two tiles or more) ${tot.runs} in ${tot.mapsWithRun} maps, ${tot.runTiles} tiles, longest ${tot.longest}`);
