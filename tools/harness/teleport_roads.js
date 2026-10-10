/**
 * teleport_roads.js - subterranean gates, monoliths and the other enterable teleports whose visiting tile is more than one tile from
 * a road (K, 2026-10-04: "portals and subterranean gates are still being missed by roads"). The real engine puts the road on the
 * visiting tile of the ones it connects, so a teleport that shares no road within one tile is a miss.
 *   node tools/harness/teleport_roads.js <map.vmap>...     one line per map, then every miss with its distance to the nearest road
 * TELE_VERBOSE=1 lists every object, not only the misses.
 */
'use strict';
const sight = require('../mapsight/lib/sight');
const TELE = /^(subterraneanGate|monolith|whirlpool|portal|sanctuaryGate|borderGate)/i;
const files = process.argv.slice(2);
let tot = 0, miss = 0, off = 0;
for (const f of files) {
	const M = sight.load(f);
	let n = 0, bad = 0, offTile = 0;
	const rows = [];
	for (const o of M.objs) {
		if (!TELE.test(o.type) || !o.visitable) continue;
		const [x, y] = o.at, l = o.l;
		let best = Infinity;
		for (let d = 0; d <= 12 && best === Infinity; d++)
			for (let dy = -d; dy <= d; dy++) for (let dx = -d; dx <= d; dx++) {
				if (Math.max(Math.abs(dx), Math.abs(dy)) !== d || !M.inb(x + dx, y + dy)) continue;
				if (M.road[M.idx(l, x + dx, y + dy)]) { best = d; break; }
			}
		n++;
		if (best > 0) { offTile++; if (best === 1) rows.push(`   beside ${o.type} (${x},${y},L${l}): the road is next to the visiting tile, not on it`); }
		if (best > 1) { bad++; rows.push(`   ${o.type} at (${x},${y},L${l}) road ${best === Infinity ? 'none within 12' : best + ' tiles'}${o.guarded ? '' : ''}`); }
		else if (process.env.TELE_VERBOSE) rows.push(`   ok ${o.type} (${x},${y},L${l}) road ${best}`);
	}
	console.log(`${require('path').basename(f)}: ${bad} of ${n} teleports more than 1 tile from a road, ${offTile} with no road ON the visiting tile`);
	for (const r of rows) console.log(r);
	tot += n; miss += bad; off += offTile;
}
console.log(`total ${miss} of ${tot} more than 1 tile from a road; ${off} of ${tot} not on the visiting tile`);
