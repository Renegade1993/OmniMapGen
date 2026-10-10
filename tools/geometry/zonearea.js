'use strict';
/**
 * zonearea.js - each template zone's tiles (both levels) per map, on which levels, and whether it is one piece, so a
 * zone that came out a fraction of the engine's, split across levels, or split into separate territories shows per seed.
 *   node tools/geometry/zonearea.js MAP...
 * u: underground only; *: on both levels; #N: on one level in N separate pieces of at least 50 tiles (8-way), which
 * the engine's zones never are: the fill counts the zone's whole area and puts it all in the piece its objects reach
 * (2026-10-03: a giant map's underground start in two corners, its loot packed into one).
 */
const sight = require('../mapsight/lib/sight');
const rows = [];
let zones = new Set();
for (const f of process.argv.slice(2)) {
	const M = sight.load(f), n = new Map(), parts = new Map();
	for (let l = 0; l < M.NL; l++) {
		const seen = new Uint8Array(M.W * M.H);
		for (let y = 0; y < M.H; y++) for (let x = 0; x < M.W; x++) {
			const z = M.zoneAt(l, x, y);
			if (z === undefined || z === null || z < 0) continue;
			if (!n.has(z)) n.set(z, [0, 0]);
			n.get(z)[l]++;
			if (seen[y * M.W + x]) continue;
			let size = 0;
			const st = [[x, y]]; seen[y * M.W + x] = 1;
			while (st.length) {
				const [a, b] = st.pop(); size++;
				for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
					const u = a + dx, v = b + dy;
					if (u < 0 || v < 0 || u >= M.W || v >= M.H || seen[v * M.W + u] || M.zoneAt(l, u, v) !== z) continue;
					seen[v * M.W + u] = 1; st.push([u, v]);
				}
			}
			if (size >= 50) parts.set(`${z}|${l}`, (parts.get(`${z}|${l}`) || 0) + 1);
		}
	}
	for (const z of n.keys()) zones.add(z);
	rows.push([f.split(/[\\/]/).pop().slice(-22), n, parts]);
}
zones = [...zones].sort((a, b) => a - b);
console.log('map'.padEnd(23) + zones.map(z => String(z).padStart(7)).join(''));
for (const [name, n, parts] of rows) console.log(name.padEnd(23) + zones.map(z => {
	const v = n.get(z);
	if (!v) return '      -';
	const t = v[0] + v[1], split = Math.max(parts.get(`${z}|0`) || 0, parts.get(`${z}|1`) || 0);
	return (String(t) + (v[0] && v[1] ? '*' : v[1] ? 'u' : ' ') + (split > 1 ? '#' + split : '')).padStart(7);
}).join(''));
console.log('u: underground only, *: on both levels, #N: N separate pieces on one level');
