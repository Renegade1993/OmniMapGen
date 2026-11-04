'use strict';
/**
 * layout_dump.js - the data behind a layout picture, as JSON, for layout_render.py (DMB Dev, 2026-11-03, K: labelled starts, colour-coded portal lanes, a legend).
 *
 *   node layout_dump.js --tip DIR --out FILE MAP.vmap
 *
 * Same reading of the map as layout_preview.js (the tip's mapsight library, the .zones.json sidecar, the template's own connection list when the map came from a
 * template, zone pairs with an open passage tile otherwise), but nothing is drawn: the file holds, per level, the zone id of every tile, the zone table (role, centre),
 * the lanes (zone pair, wide or not, on one level or between two) and the starts (player colour, level, tile).
 */
const fs = require('fs'), path = require('path');
const argv = process.argv.slice(2);
const get = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const tip = get('--tip'), out = get('--out');
const mapFile = argv.filter(a => /\.vmap$/i.test(a))[0];
if (!tip || !out || !mapFile) { console.error('usage: node layout_dump.js --tip DIR --out FILE MAP.vmap'); process.exit(2); }
const sight = require(path.join(path.resolve(tip), 'tools', 'mapsight', 'lib', 'sight'));
const ROLE = t => ({ player: 'start', playerStart: 'start', cpuStart: 'cpuStart', treasure: 'treasure', highLoot: 'treasure', lowLoot: 'lowLoot', junction: 'junction', town: 'town', standard: 'standard' }[t] || 'standard');

const M = sight.load(mapFile);
let side = null;
for (const c of [mapFile.replace(/\.vmap$/i, '.zones.json'), mapFile + '.zones.json']) if (c !== mapFile && fs.existsSync(c)) { side = JSON.parse(fs.readFileSync(c, 'utf8')); break; }
const typeOf = (l, z) => {
	if (side && Array.isArray(side.levels) && side.levels[l] && Array.isArray(side.levels[l].classes)) {
		const lv = side.levels[l];
		const idx = lv.templateIds && lv.templateIds.some(v => v !== null) ? lv.templateIds.indexOf(z) : z;
		return (lv.templateTypes && lv.templateTypes[idx]) || lv.classes[idx] || 'standard';
	}
	const e = M.zones && M.zones.zones && M.zones.zones.get(z);
	return (e && e.type) || 'standard';
};
const grid = [], water = [], zones = {}, pairs = new Set();
for (let l = 0; l < M.NL; l++) {
	const g = new Array(M.W * M.H).fill(-1);
	const wt = new Array(M.W * M.H).fill(0);   // water tiles (K item 18: the water layouts' pictures show the sea)
	for (let y = 0; y < M.H; y++) for (let x = 0; x < M.W; x++) { const c = M.terr[M.idx(l, x, y)]; if (c === 'wa' || c === 'wt') wt[y * M.W + x] = 1; }
	water.push(wt);
	for (let y = 0; y < M.H; y++) for (let x = 0; x < M.W; x++) {
		const z = M.zoneAt(l, x, y);
		if (z === undefined || z === null || z < 0) continue;
		g[y * M.W + x] = z;
		const i = M.idx(l, x, y), open = M.ground(i) && !M.blocked[i];
		const key = l + ':' + z;
		const e = zones[key] || (zones[key] = { l, z, role: ROLE(typeOf(l, z)), sx: 0, sy: 0, n: 0 });
		e.sx += x; e.sy += y; e.n++;
		for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
			if (!M.inb(x + dx, y + dy)) continue;
			const zz = M.zoneAt(l, x + dx, y + dy), j = M.idx(l, x + dx, y + dy);
			if (zz === undefined || zz === null || zz < 0 || zz === z || !open || !(M.ground(j) && !M.blocked[j])) continue;
			pairs.add(`${l}:${Math.min(z, zz)}-${Math.max(z, zz)}`);
		}
	}
	grid.push(g);
}
for (const e of Object.values(zones)) { e.cx = e.sx / e.n + 0.5; e.cy = e.sy / e.n + 0.5; delete e.sx; delete e.sy; }
const tplName = side && side.options && side.options.template;
let tplLinks = null;
if (tplName) {
	try {
		const raw = require(path.join(path.resolve(tip), 'src', 'rmg', 'template')).loadTemplate(tplName).raw;
		tplLinks = (raw.connections || []).map(c => ({ a: String(c.a), b: String(c.b), wide: c.type === 'wide' }));
	} catch (e) { tplLinks = null; }
}
const levelOfZone = new Map();
if (tplLinks && side && Array.isArray(side.levels)) side.levels.forEach((lv, l) => (lv.templateIds || []).forEach(id => { if (id !== null && id !== undefined) levelOfZone.set(String(id), [l, id]); }));
const lanes = [];
if (tplLinks && levelOfZone.size) {
	for (const k of tplLinks) {
		const A = levelOfZone.get(k.a), B = levelOfZone.get(k.b);
		if (!A || !B || !zones[A[0] + ':' + A[1]] || !zones[B[0] + ':' + B[1]]) continue;
		lanes.push({ a: [A[0], A[1]], b: [B[0], B[1]], wide: k.wide });
	}
} else {
	for (const key of pairs) { const m = /^(\d+):(\d+)-(\d+)$/.exec(key); lanes.push({ a: [+m[1], +m[2]], b: [+m[1], +m[3]], wide: false }); }
}
// portals: a two-way monolith pair joins the zones of its two ends; a lane between those zones is marked a portal, and a pair whose zones have no lane gets one
const portalKey = new Set();
{
	const groups = new Map();
	for (const t of M.objs) if (t.cls === 'monolith' && /TwoWay/i.test(t.type)) { const k = t.type + '|' + t.subtype; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
	const zk = t => [t.l, M.zoneAt(t.l, t.at[0], t.at[1])];
	for (const [, g] of groups) if (g.length === 2) {
		const A = zk(g[0]), B = zk(g[1]);
		if (A[1] === null || A[1] === undefined || B[1] === null || B[1] === undefined || (A[0] === B[0] && A[1] === B[1])) continue;
		const key = [A.join(':'), B.join(':')].sort().join('-');
		if (portalKey.has(key)) continue;
		portalKey.add(key);
		const lane = lanes.find(n => [n.a.join(':'), n.b.join(':')].sort().join('-') === key);
		const ends = [[g[0].l, g[0].at[0] + 0.5, g[0].at[1] + 0.5], [g[1].l, g[1].at[0] + 0.5, g[1].at[1] + 0.5]];
		if (lane) { lane.portal = true; lane.portalEnds = ends; } else if (zones[A.join(':')] && zones[B.join(':')]) lanes.push({ a: A, b: B, wide: false, portal: true, portalEnds: ends });
	}
}
// a way between levels is drawn at its real gates (Opus Reviewer, 2026-11-04: squares at the zone centre piled onto the castles and towns): each subterranean gate
// on the surface paired with the nearest free one below (as startgate.js), and a lane between two levels takes the first unused pair joining its two zones
{
	const gates = M.objs.filter(t => t.cls === 'gate'), used = new Set(), gpairs = [];
	for (const g of gates.filter(g => g.l === 0)) {
		let best = null, bd = 1e9;
		for (const h of gates) if (h.l === 1 && !used.has(h)) { const d = Math.hypot(g.at[0] - h.at[0], g.at[1] - h.at[1]); if (d < bd) { bd = d; best = h; } }
		if (best) { used.add(best); gpairs.push([g, best]); }
	}
	const zk = t => t.l + ':' + M.zoneAt(t.l, t.at[0], t.at[1]);
	const taken = new Set();
	for (const n of lanes) {
		if (n.a[0] === n.b[0] || n.portal) continue;
		const A = n.a.join(':'), B = n.b.join(':');
		const i = gpairs.findIndex((p, k) => !taken.has(k) && ((zk(p[0]) === A && zk(p[1]) === B) || (zk(p[0]) === B && zk(p[1]) === A)));
		if (i < 0) continue;
		taken.add(i);
		const [g0, g1] = zk(gpairs[i][0]) === A ? gpairs[i] : [gpairs[i][1], gpairs[i][0]];
		n.ends = [[g0.l, g0.at[0] + 0.5, g0.at[1] + 0.5], [g1.l, g1.at[0] + 0.5, g1.at[1] + 0.5]];
	}
}
// a passage is drawn where its two zones meet (Opus Reviewer, 2026-11-04: lines to the zone centres knotted on Headquarters and the Nostalgia
// undergrounds): the border tile of zone a next to zone b closest to the middle of that border, walkable tiles first, and the way across it
for (const n of lanes) {
	if (n.portal || n.a[0] !== n.b[0]) continue;
	const l = n.a[0], za = n.a[1], zb = n.b[1], pts = [], walkPts = [];
	for (let y = 0; y < M.H; y++) for (let x = 0; x < M.W; x++) {
		if (M.zoneAt(l, x, y) !== za) continue;
		for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
			if (!M.inb(x + dx, y + dy) || M.zoneAt(l, x + dx, y + dy) !== zb) continue;
			const pt = [x + 0.5 + dx / 2, y + 0.5 + dy / 2, dx, dy];
			pts.push(pt);
			const i = M.idx(l, x, y), j = M.idx(l, x + dx, y + dy);
			if (M.ground(i) && !M.blocked[i] && M.ground(j) && !M.blocked[j]) walkPts.push(pt);
		}
	}
	const use = walkPts.length ? walkPts : pts;
	if (!use.length) continue;
	const mx = use.reduce((a, p) => a + p[0], 0) / use.length, my = use.reduce((a, p) => a + p[1], 0) / use.length;
	let best = use[0], bd = Infinity;
	for (const p of use) { const d = (p[0] - mx) ** 2 + (p[1] - my) ** 2; if (d < bd) { bd = d; best = p; } }
	n.border = [l, best[0], best[1], best[2], best[3]];
}
const starts = sight.starts(M).map(s => ({ colour: s.colour, l: s.l, x: s.at[0] + 0.5, y: s.at[1] + 0.5, zone: s.zone }));
// every town on the map (K, 2026-11-03: "little castles, colored for player starts, grey for non"); the renderer marks the ones that are starts
const towns = M.objs.filter(t => t.cls === 'town').map(t => ({ l: t.l, x: t.at[0] + 0.5, y: t.at[1] + 0.5, zone: M.zoneAt(t.l, t.at[0], t.at[1]) }));
const o = (side && side.options) || {};
fs.writeFileSync(out, JSON.stringify({ W: M.W, H: M.H, NL: M.NL, template: o.template || null, players: +o.players || starts.length, grid, water, zones: Object.values(zones), lanes, starts, towns, options: o }));
console.log(JSON.stringify({ out, W: M.W, H: M.H, NL: M.NL, zones: Object.keys(zones).length, lanes: lanes.length, starts: starts.map(s => s.colour + '@' + s.l), towns: towns.length }));
