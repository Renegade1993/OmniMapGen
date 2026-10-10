'use strict';
/**
 * gold_front.js - gold mines a walker takes without a fight (Opus Reviewer, 2026-10-09: "every approach to the entrance passes a guard", the
 * engine guards 100% of its gold mines; K, 2026-10-08: "found a completely unguarded gold mine in my start biome").
 *
 *   node tools/harness/gold_front.js MAP|DIR...
 *
 * A gold mine is open when a tile it is entered from is open ground outside every monster's 3x3 ring. One line a map, a total, and the open ones.
 */
const fs = require('fs');
const path = require('path');
const sight = require('../mapsight/lib/sight');
const files = [];
for (const a of process.argv.slice(2)) {
	if (fs.existsSync(a) && fs.statSync(a).isDirectory()) fs.readdirSync(a).filter(f => f.endsWith('.vmap')).forEach(f => files.push(path.join(a, f)));
	else files.push(a);
}
let all = 0, open = 0;
const list = [];
for (const f of files) {
	const M = sight.load(f);
	const ring = new Set();
	for (const m of M.objs) if (m.cls === 'monster') for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (M.inb(m.at[0] + dx, m.at[1] + dy)) ring.add(M.idx(m.l, m.at[0] + dx, m.at[1] + dy));
	let n = 0, o = 0;
	for (const q of M.objs) {
		if (q.cls !== 'mine' || !/gold/i.test(String(q.subtype || q.type))) continue;
		n++;
		const free = M.approach(q).filter(i => M.ground(i) && !M.blocked[i]);
		if (free.some(i => !ring.has(i))) { o++; list.push(`${path.basename(f)} L${q.l} (${q.at}): ${free.filter(i => !ring.has(i)).length} of ${free.length} free entrance tiles outside every guard ring`); }
	}
	all += n; open += o;
	console.log(`${path.basename(f)}: gold mines ${n}, open to a walker ${o}`);
}
console.log(`total: ${open} of ${all} gold mines open to a walker`);
for (const l of list) console.log('  ' + l);
