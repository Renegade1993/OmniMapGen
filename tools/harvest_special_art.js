'use strict';
/**
 * harvest_special_art.js - the art of the special buildings (S350), in the table terrainArt.js reads (objectTerrains.json's shape: animation -> { type,
 * subtype, n, terrains, mask, visitableFrom }), from the converted original scenarios: how many times each art stood on each core ground.
 * Writes src/biome/special.art.json. Read-only on the maps. Arrogance and the Allied copies are left out, as in the S343 census.
 *   node tools/harvest_special_art.js [folder of converted .vmap files]   (default .tmp/mapsight/h3m under the project root)
 * Also prints the pooled rates per 1,000 ground tiles (overworld, underground) that special.js RATES carries.
 */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const sight = require('./mapsight/lib/sight');
const SRC = process.argv[2] || path.join('C:/AI Projects/Heroes 3/.tmp/mapsight/h3m');
const CORE = { dt: 'dirt', sa: 'sand', gr: 'grass', sn: 'snow', sw: 'swamp', rg: 'rough', sb: 'subterra', lv: 'lava' };
// the kinds written by special.js; university, sanctuary and the trading posts have their art in objectTerrains.json already
const WANT = t => /^(hillFort|sign|cartographer|monolithOneWayEntrance|monolithOneWayExit)$/.test(t);
const names = fs.readdirSync(SRC).filter(f => f.endsWith('.vmap')).map(f => f.replace(/\.vmap$/, ''));
const skip = new Set(['Arrogance', 'Arrogance_Allied']);
const isAllied = n => /(_-_Allied|_Allied|_Allies_?)$/.test(n);
const plainOf = n => n.replace(/(_-_Allied|_Allied|_Allies_?)$/, '');
const maps = names.filter(n => !skip.has(n)).filter(n => !(isAllied(n) && names.includes(plainOf(n))));
const art = {};
let nm = 0;
for (const name of maps) {
	let M; try { M = sight.load(path.join(SRC, name + '.vmap')); } catch (e) { continue; }
	nm++;
	for (const o of M.objs) {
		if (!WANT(o.type) || !o.template || !o.template.animation) continue;
		const anim = String(o.template.animation);
		const e = art[anim] || (art[anim] = { type: o.type, subtype: o.subtype || 'object', n: 0, terrains: {}, mask: o.template.mask, visitableFrom: o.template.visitableFrom });
		e.n++;
		const t = CORE[String(M.terr[M.idx(o.l, o.at[0], o.at[1])]).slice(0, 2)];
		if (t) e.terrains[t] = (e.terrains[t] || 0) + 1;
	}
}
const out = { _provenance: `Harvested ${new Date().toISOString().slice(0, 10)} (S350) from ${nm} converted original scenarios: the art of the hill fort, sign, cartographer and one-way monolith kinds and the core grounds each stood on. Same shape as objectTerrains.json art.`, art };
fs.writeFileSync(path.join(ROOT, 'src', 'biome', 'special.art.json'), JSON.stringify(out, null, 1) + '\n');
console.log('maps', nm, 'arts', Object.keys(art).length);
for (const [a, e] of Object.entries(art).sort((x, y) => x[1].type.localeCompare(y[1].type) || y[1].n - x[1].n)) console.log(a.padEnd(10), e.type, e.subtype, e.n, JSON.stringify(e.terrains), JSON.stringify(e.mask));
