'use strict';
/**
 * rivers.js - K's two river complaints, counted (2026-10-07 18:3x: "instances of these creeks running through objects and dead-ending out in
 * the open").
 *
 *   node tools/harness/rivers.js MAP|DIR... [--list]
 *
 * Per map and level: river tiles; river ends (a river tile with one river neighbour or none, four-way, as the art joins them) and how many of
 * them are in the open (not on the map's edge and not beside water); river tiles under an object (a tile of any object's footprint but
 * a monster's) or in a guard's 3x3 ring. --list prints the coordinates of the bad ones.
 */
const fs = require('fs');
const path = require('path');
const sight = require('../mapsight/lib/sight');

const RIVERS = new Set(['rw', 'ri', 'rm', 'rl', 'ra', 'lr', 'ww', 'ut', 'pw', 'sr']);
const WET = new Set(['wa', 'wt']), ROCK = new Set(['ro', 'rc']);
const files = [];
for (const a of process.argv.slice(2)) {
	if (a.startsWith('--')) continue;
	if (fs.existsSync(a) && fs.statSync(a).isDirectory()) fs.readdirSync(a).filter(f => f.endsWith('.vmap')).forEach(f => files.push(path.join(a, f)));
	else files.push(a);
}
const LIST = process.argv.includes('--list');
const tot = { tiles: 0, ends: 0, open: 0, under: 0, ring: 0, maps: 0 };
for (const f of files) {
	const M = sight.load(f), W = M.W, H = M.H;
	tot.maps++;
	for (let l = 0; l < M.NL; l++) {
		const river = new Uint8Array(W * H);
		let n = 0;
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (sight.tileLayers(M.levels[l].rows[y][x]).some(c => RIVERS.has(c))) { river[y * W + x] = 1; n++; }
		if (!n) continue;
		const objAt = new Uint8Array(W * H), ringAt = new Uint8Array(W * H), sceneryAt = new Uint8Array(W * H);
		for (const o of M.objs) {
			if (o.l !== l) continue;
			if (o.cls === 'monster') { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (M.inb(o.at[0] + dx, o.at[1] + dy)) ringAt[(o.at[1] + dy) * W + o.at[0] + dx] = 1; continue; }
			for (const [x, y] of o.cells) (o.visitable || o.pickup ? objAt : sceneryAt)[y * W + x] = 1;
		}
		const terrAt = (x, y) => M.terr[M.idx(l, x, y)];
		let ends = 0, open = 0, under = 0, ring = 0, scen = 0;
		const bad = [];
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			const c = y * W + x;
			if (!river[c]) continue;
			if (objAt[c]) { under++; if (LIST) bad.push(`under object (${x},${y})`); }
			else if (ringAt[c]) { ring++; if (LIST) bad.push(`guard ring (${x},${y})`); }
			else if (sceneryAt[c]) scen++;
			let nb = 0;
			for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (M.inb(x + dx, y + dy) && river[(y + dy) * W + x + dx]) nb++;
			if (nb > 1) continue;
			ends++;
			const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1;
			let wet = false;
			for (let dy = -1; dy <= 1 && !wet; dy++) for (let dx = -1; dx <= 1; dx++) if (M.inb(x + dx, y + dy) && WET.has(terrAt(x + dx, y + dy))) { wet = true; break; }
			if (!edge && !wet) { open++; if (LIST) bad.push(`end in the open (${x},${y})`); }
		}
		tot.tiles += n; tot.ends += ends; tot.open += open; tot.under += under; tot.ring += ring; tot.scen = (tot.scen || 0) + scen;
		console.log(`${path.basename(f)} L${l}: ${n} river tiles, ${ends} ends, ${open} in the open, ${under} under a visitable object or pickup, ${ring} in a guard ring, ${scen} under plain scenery${LIST && bad.length ? '\n    ' + bad.slice(0, 20).join('\n    ') : ''}`);
	}
}
console.log(`total over ${tot.maps} maps: ${tot.tiles} river tiles, ${tot.ends} ends, ${tot.open} in the open, ${tot.under} under a visitable object or pickup, ${tot.ring} in a guard ring, ${tot.scen || 0} under plain scenery`);
