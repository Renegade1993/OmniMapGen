/**
 * art_family.js - objects whose art belongs to one terrain family standing on ground that is not that family's (K, 2026-10-04:
 * "still seeing the frozen well in a highlands biome"). Ground the corpus knows (the eight core terrains): the corpus rule of
 * terrainArt.js. Ground it does not (a mod's highlands, deadland, wasteland...): an art that real maps stood on fewer than four
 * core grounds, unless the object is one a map cannot do without. The game's own table calls most of these legal, which is why
 * mapsight's terrain legality does not list them.
 *   node tools/harness/art_family.js <map.vmap>...     one line per map, then a count per object kind and ground
 */
'use strict';
const sight = require('../mapsight/lib/sight');
const { violates, CORE, artNeutral, essential } = require('../../src/biome/terrainArt');
const files = process.argv.slice(2);
const kinds = {};
let total = 0;
for (const f of files) {
	const M = sight.load(f);
	let n = 0, checked = 0;
	for (const o of M.objs) {
		if (o.cls === 'monster' || o.cls === 'town' || !o.template.animation) continue;
		const short = M.terr[M.idx(o.l, o.at[0], o.at[1])];
		if (['wa', 'wt', 'ro', 'rc'].includes(short)) continue;
		const anim = o.template.animation;
		let why = null;
		if (CORE[short]) { checked++; if (violates(o.type, o.subtype, anim, short)) why = `core ${CORE[short]}`; }
		else if (!essential(o.type)) { checked++; if (!/[\/]/.test(String(anim)) && artNeutral(anim) === false) why = 'mod ground'; }
		if (!why) continue;
		n++; total++;
		const key = `${o.type}:${o.subtype || ''} art ${String(anim).replace(/\.def$/, '')} on ${short} (${why})`;
		kinds[key] = (kinds[key] || 0) + 1;
		if (process.env.ART_VERBOSE) console.log(`   ${key} at (${o.at[0]},${o.at[1]},L${o.l})`);
	}
	console.log(`${require('path').basename(f)}: ${n} of ${checked} checked`);
}
console.log(`total ${total}`);
for (const [k, c] of Object.entries(kinds).sort((a, b) => b[1] - a[1])) console.log(`  ${c}  ${k}`);
