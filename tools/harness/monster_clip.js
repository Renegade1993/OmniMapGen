/**
 * monster_clip.js - monsters whose sprite is drawn over another object (K, 2026-10-04: "multi-grid creatures improperly placed
 * clipping onto loot"). Every core creature's map sprite is 64x64 (tools/harness/creature_extents.js: 130 of 141 cover the tile to
 * the left and the tile above the anchor, the rest one of them), so a monster at (x,y) hides what stands on (x-1,y), (x,y-1) and
 * (x-1,y-1). Counted per other object by class: footprint cells of the object on one of those tiles.
 *   node tools/harness/monster_clip.js <map.vmap>...     one line per map, then the counts by class; MC_VERBOSE=1 lists them
 */
'use strict';
const sight = require('../mapsight/lib/sight');
const files = process.argv.slice(2);
const MON = /^(monster|randomMonster)/;
const total = {};
let monsters = 0, clipping = 0;
for (const f of files) {
	const M = sight.load(f);
	const at = new Map();     // level|cell -> objects with a footprint cell there
	for (const o of M.objs) {
		const m = o.template && o.template.mask;
		if (!m || !o.template.animation) continue;
		const h = m.length;
		for (let i = 0; i < h; i++) for (let j = 0; j < m[i].length; j++) {
			if (m[i][j] === ' ' || m[i][j] === '0') continue;
			const x = o.x - (m[i].length - 1 - j), y = o.y - (h - 1 - i);
			const k = `${o.l}|${x}|${y}`;
			if (!at.has(k)) at.set(k, []);
			at.get(k).push(o);
		}
	}
	let n = 0, bad = 0;
	for (const o of M.objs) {
		if (!MON.test(o.type)) continue;
		n++;
		const hit = new Set();
		for (const [dx, dy] of [[-1, 0], [0, -1], [-1, -1]])
			for (const p of at.get(`${o.l}|${o.x + dx}|${o.y + dy}`) || []) if (p !== o) hit.add(p);
		if (!hit.size) continue;
		bad++;
		for (const p of hit) {
			const cls = MON.test(p.type) ? 'monster' : (p.cls || p.type);
			total[cls] = (total[cls] || 0) + 1;
			if (process.env.MC_VERBOSE) console.log(`   ${o.type}${o.subtype ? ':' + o.subtype : ''} (${o.x},${o.y},L${o.l}) over ${p.type} (${p.x},${p.y})`);
		}
	}
	console.log(`${require('path').basename(f)}: ${bad} of ${n} monsters cover another object`);
	monsters += n; clipping += bad;
}
console.log(`total ${clipping} of ${monsters} monsters`);
for (const [k, c] of Object.entries(total).sort((a, b) => b[1] - a[1])) console.log(`  ${c}  over ${k}`);
