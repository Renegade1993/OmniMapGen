'use strict';
/**
 * zonemap.js - the zone picture (the lead's order, 2026-10-15 09:25, after K: "if you colored them by type (starting town biome, neutral town
 * biome, high-loot, low-loot, template, etc.) that would be super helpful"): level 0 of each map, every zone's land coloured by its role, the
 * sea blue, zone borders black, each zone labelled with its id and land share, a zone of 60 cells or more under 40% land outlined red, the
 * starts as white squares, the dragon dwellings as black and white diamonds, and a white line from the middle of the zone's cells to the middle of its land (K: "the zones look to be offset from
 * the center a lot"). Several maps go side by side. Also prints, per zone, role, cells, land share and that offset as a share of the map's width.
 *
 *   node tools/mapsight/mapsight.js zonemap OUT.png MAP [MAP ...]
 *
 * Roles, from the zone sidecar (<map>.zones.json): start (class player with a start in it), empty start slot (class player, no start: a template's
 * start zone no player took), neutral town (class town), high loot, low loot, standard, junction (the template's junction type). Needs the sidecar.
 */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const sight = require('./sight');
const NO_WINDOW = process.platform === 'win32' ? { windowsHide: true } : {};

function roleOf(cls, type, hasStart) {
	if (type === 'junction') return 'junction';
	if (cls === 'player') return hasStart ? 'start' : 'empty start slot';
	if (cls === 'town') return 'neutral town';
	if (cls === 'highLoot') return 'high loot';
	if (cls === 'lowLoot') return 'low loot';
	return 'standard';
}

function dumpOf(file) {
	const M = sight.load(file);
	const side = JSON.parse(fs.readFileSync(file + '.zones.json', 'utf8')).levels[0];
	const W = M.W, H = M.H, N = W * H, zone = side.zone;
	const wet = new Array(N);
	for (let i = 0; i < N; i++) wet[i] = M.terr[M.idx(0, i % W, (i / W) | 0)] === 'wt' || M.terr[M.idx(0, i % W, (i / W) | 0)] === 'wa' ? 1 : 0;
	const starts = sight.starts(M).filter(s => s.l === 0).map(s => s.at);
	const acc = new Map();
	for (let i = 0; i < N; i++) {
		const z = zone[i];
		if (z === undefined || z < 0) continue;
		const e = acc.get(z) || acc.set(z, { cells: 0, land: 0, cx: 0, cy: 0, lx: 0, ly: 0 }).get(z);
		const x = i % W, y = (i / W) | 0;
		e.cells++; e.cx += x; e.cy += y;
		if (!wet[i]) { e.land++; e.lx += x; e.ly += y; }
	}
	const zones = [];
	for (const [z, e] of acc) {
		const hasStart = starts.some(([x, y]) => zone[y * W + x] === z);
		const role = roleOf(side.classes && side.classes[z], side.templateTypes && side.templateTypes[z], hasStart);
		const c = [e.cx / e.cells, e.cy / e.cells], lc = e.land ? [e.lx / e.land, e.ly / e.land] : null;
		const offset = lc ? Math.hypot(lc[0] - c[0], lc[1] - c[1]) / W : null;
		zones.push({ z, role, cells: e.cells, land: e.land, share: e.land / e.cells, c, lc, offset, flag: e.cells >= 60 && e.land / e.cells < 0.4 });
	}
	zones.sort((a, b) => a.z - b.z);
	// the dragon dwellings, marked on the picture (K, 2026-10-15: several small dragon islands or one large one)
	const dragons = M.objs.filter(o => o.l === 0 && o.cls === 'dwelling' && /^(frozenCliffs|crystalCavern|magicForest|sulfurousLair)$/i.test(String(o.subtype))).map(o => o.at);
	return { name: path.basename(file), W, H, zone, wet, starts, zones, dragons };
}

function main(args) {
	const [out, ...maps] = args;
	if (!out || !maps.length) { console.error('usage: mapsight.js zonemap OUT.png MAP [MAP ...]'); process.exit(2); }
	const dumps = maps.map(dumpOf);
	for (const d of dumps) {
		console.log(`${d.name}: ${d.zones.length} zones, ${d.zones.filter(z => z.flag).length} of 60+ cells under 40% land; offset of the land from the zone's middle, mean ${(100 * mean(d.zones.map(z => z.offset).filter(v => v !== null))).toFixed(1)}% of the width, most ${(100 * Math.max(...d.zones.map(z => z.offset || 0))).toFixed(1)}%`);
		for (const z of d.zones) console.log(`  z${z.z} ${z.role.padEnd(16)} cells ${String(z.cells).padStart(5)} land ${(100 * z.share).toFixed(0).padStart(3)}% offset ${z.offset === null ? '  -' : (100 * z.offset).toFixed(1) + '%'}${z.flag ? '  UNDER 40% LAND' : ''}`);
	}
	const json = out.replace(/\.png$/i, '') + '.zonemap.json';
	fs.writeFileSync(json, JSON.stringify(dumps));
	const r = spawnSync('py', [path.join(__dirname, '..', 'zonemap.py'), json, out], { encoding: 'utf8', timeout: 180000, ...NO_WINDOW });
	process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || '');
	fs.unlinkSync(json);
}
const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);

module.exports = { main, dumpOf, roleOf };
