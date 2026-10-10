'use strict';
/**
 * dragonzones.js - per zone: its tiles, its neutral dragon dwellings, and dwellings per 1000 tiles. Coldshadow keeps its
 * dragons in its four junctions (17-20); comparing the rate per 1000 tiles against the engine's separates "too many
 * dragons" from "a zone too big" (2026-10-03: 60 on a 180 two-level map, 27 of them in one junction of 4685 tiles).
 *
 *   node tools/geometry/dragonzones.js MAP...
 */
const sight = require('../mapsight/lib/sight');
const DRAGON = /sulfurousLair|crystalCavern|frozenCliffs|magicForest/;
for (const f of process.argv.slice(2)) {
	const M = sight.load(f);
	const tiles = {}, dr = {};
	for (let l = 0; l < M.NL; l++) for (let y = 0; y < M.H; y++) for (let x = 0; x < M.W; x++) {
		const z = M.zoneAt(l, x, y);
		if (z !== undefined && z !== null && z >= 0) tiles[z] = (tiles[z] || 0) + 1;
	}
	for (const o of M.objs) if (DRAGON.test(String(o.subtype)) && o.type !== 'mine') {
		const z = M.zoneAt(o.l, o.at[0], o.at[1]);
		dr[z] = (dr[z] || 0) + 1;
	}
	const rows = Object.keys(dr).map(Number).sort((a, b) => a - b)
		.map(z => `z${z} ${dr[z]}/${tiles[z] || '?'} = ${tiles[z] ? (1000 * dr[z] / tiles[z]).toFixed(1) : '?'}`);
	const tot = Object.values(dr).reduce((a, b) => a + b, 0);
	console.log(`${f.split(/[\\/]/).pop().padEnd(28)} ${tot} dragon dwellings | ${rows.join(' | ')}`);
}
