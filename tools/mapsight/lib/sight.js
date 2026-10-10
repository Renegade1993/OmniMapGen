'use strict';
/**
 * sight.js - read one map into a structure an agent can reason about, and run the structural checks on it.
 *
 * Works on any .vmap: ours, the engine's (tools/rmgdump), a map K's game wrote, or an original .h3m converted by
 * convert.py. Everything is computed from the map file itself, plus the zone sidecar when one lies beside it
 * (<map>.zones.json from the engine, <map>.vmap.zones.json from ours) and the asset index when VCMI_ROOT is set
 * (creature levels, factions, the terrains each object's art allows).
 *
 * Geometry follows the engine: an object is anchored at its mask's bottom-right cell, mask[i][j] covers
 * (x - (w-1-j), y - (h-1-i)); 'B' blocks, 'A' blocks and is the visitable cell; visitableFrom is the 3x3 ring
 * around the visitable cell. A monster guards the 8 cells around its visitable cell.
 */
const fs = require('fs');
const path = require('path');
const { readVmap, parseTileCode } = require('../../../src/preview/render');

const N8 = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]]; // clockwise ring
const BLOCK_TERR = new Set(['wa', 'wt', 'ro', 'rc']);      // water and rock (the engine writes rock as rc)
// the four neutral dragon dwellings (Azure, Crystal, Faerie, Rust); dragonVault is the Bone Dragon's and goldenPavilion
// the Naga's, which an earlier list counted by mistake (2026-10-01)
const NEUTRAL_DRAGON_DWELLINGS = /^(frozenCliffs|crystalCavern|magicForest|sulfurousLair)$/i;
const HIGH = new Set(['randomArtifactMajor', 'randomArtifactRelic', 'pandoraBox', 'spellScroll', 'artifact']);
const LOW = new Set(['resource', 'randomResource', 'treasureChest', 'randomArtifactTreasure', 'randomArtifactMinor',
	'randomArtifact', 'campfire', 'seaChest', 'flotsam']);

// river layer codes (config/rivers.json and the mods' rivers: core rw ri rm rl, then acid, lazur, deadland water,
// underwater trench, spoiled-land toxic water, star river); anything else in the layer slots is a road (pd pg pc ...)
const RIVERS = new Set(['rw', 'ri', 'rm', 'rl', 'ra', 'lr', 'ww', 'ut', 'pw', 'sr']);
const FLIPS = new Set(['_', '-', '|', '+']);
/** The road and river layer codes on a tile code "<terr><view><flip>[<layer><view><flip>]...". */
function tileLayers(code) {
	code = String(code);
	let i = 2;
	while (i < code.length && /[0-9]/.test(code[i])) i++;
	if (FLIPS.has(code[i])) i++;
	const out = [];
	while (i + 2 < code.length) {
		const kind = code.slice(i, i + 2);
		let j = i + 2;
		while (j < code.length && /[0-9]/.test(code[j])) j++;
		if (!FLIPS.has(code[j])) break;
		out.push(kind);
		i = j + 1;
	}
	return out;
}

let INDEX = null;     // loaded once, only when VCMI_ROOT is set
function index() {
	if (INDEX !== null) return INDEX;
	INDEX = false;
	if (!process.env.VCMI_ROOT) return INDEX;
	try {
		const { loadIndex, lookups } = require('../../map_metrics');
		const ix = loadIndex();
		const lk = lookups(ix);
		const terrName = new Map();
		const T = ix.terrains instanceof Map ? [...ix.terrains.entries()] : Object.entries(ix.terrains || {});
		for (const [short, t] of T) terrName.set(short, String(t.name || short).replace(/^.*:/, '').toLowerCase());
		const creatures = ix.creatures instanceof Map ? ix.creatures : new Map(Object.entries(ix.creatures || {}));
		const creature = n => n && (creatures.get(n) || creatures.get(`core:${n}`) ||
			[...creatures.entries()].find(([k]) => k.endsWith(`:${n}`))?.[1]);
		// one art can carry several templates (the magic well's AVXwelr0: one for highlands, one for wasteland), so
		// take the union per animation; map_metrics' lookup keeps the last one only. Absent: allowed on any land.
		const anims = new Map();
		const art = a => String(a || '').toLowerCase().replace(/\.def$/, '').replace(/^.*\//, '');
		for (const [, o] of ix.objects) for (const t of o.templates || []) {
			const a = art(t.raw && t.raw.animation);
			if (!a) continue;
			if (!t.allowedTerrains || !t.allowedTerrains.length) { anims.set(a, null); continue; }
			if (anims.has(a) && anims.get(a) === null) continue;
			const s = anims.get(a) || new Set();
			for (const n of t.allowedTerrains) s.add(String(n).replace(/^.*:/, '').toLowerCase());
			anims.set(a, s);
		}
		INDEX = { ix, lk, terrName, creature, anims, art };
	} catch (e) {
		process.stderr.write(`mapsight: asset index not loaded (${e.message}); terrain and tier checks are off\n`);
	}
	return INDEX;
}

/** The zone sidecar beside a map, normalised to { zoneOf(l,x,y), zones: Map(id -> {type, town, underground, objects}) }. */
function loadZones(file, W, H) {
	const cands = [file.replace(/\.vmap$/i, '.zones.json'), file + '.zones.json'];
	const f = cands.find(p => p !== file && fs.existsSync(p));
	if (!f) return null;
	const z = JSON.parse(fs.readFileSync(f, 'utf8'));
	const zones = new Map();
	for (const q of z.zones || []) zones.set(q.id, { id: q.id, type: q.type, townType: q.townType, underground: q.underground, objects: q.objects || {}, tiles: q.tiles });
	for (const q of z.templateZones || []) if (!zones.has(q.id)) zones.set(q.id, { id: q.id, type: q.type, objects: {} });
	let tiles = null;
	if (Array.isArray(z.zoneTiles)) tiles = z.zoneTiles;                                   // engine, rmgdump after 2026-10-01
	else if (Array.isArray(z.levels) && z.levels[0] && Array.isArray(z.levels[0].zone)) {
		// ours: a per-level index into the level's zone list; with templateIds (opus-coldshadow generate.js, 2026-10-01)
		// the index is mapped to the template's zone id, so ours and the engine's compare zone by zone
		tiles = z.levels.map(lv => (Array.isArray(lv.templateIds) && lv.templateIds.some(v => v !== null)
			? lv.zone.map(i => (lv.templateIds[i] ?? -1)) : lv.zone));
		for (const lv of z.levels) (lv.templateIds || []).forEach((id, i) => {
			if (id !== null && !zones.has(id)) zones.set(id, { id, type: (lv.templateTypes || [])[i] || null, objects: {} });
		});
	}
	return {
		file: f, zones, template: z.templateUsed || z.template || null, settings: z.settings || null,
		zoneOf: tiles ? (l, x, y) => (tiles[l] ? tiles[l][y * W + x] : undefined) : null,
	};
}

/** Read a map and build the model every check works from. */
function load(file) {
	const { objects, levels, header } = readVmap(file);
	const objs = (Array.isArray(objects) ? objects : Object.values(objects)).filter(o => o && o.template);
	const NL = levels.length, H = levels[0].rows.length, W = levels[0].rows[0].length;
	const idx = (l, x, y) => (l * H + y) * W + x;
	const inb = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
	const terr = new Array(NL * W * H), road = new Uint8Array(NL * W * H);
	for (let l = 0; l < NL; l++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
		const t = parseTileCode(levels[l].rows[y][x]);
		terr[idx(l, x, y)] = t.terr;
		// parseTileCode puts a river in the road slot when a tile has no road (2026-10-01: every road measure here counted
		// the engine's rivers as roads until this); a road is any layer code that is not a river
		if (tileLayers(levels[l].rows[y][x]).some(c => !RIVERS.has(c))) road[idx(l, x, y)] = 1;
	}
	const blocked = new Uint8Array(NL * W * H);
	// Pickups (resources, chests, campfires, artifacts, scrolls, Pandora's boxes) and prisons vanish when visited, so
	// the tile under them is walkable afterwards: the engine packs treasure piles so that taking the front item opens
	// the way to the next (2026-10-01). They are not walls for any flood here; their own visiting tiles still count.
	objs.forEach((o, k) => {
		o.k = k;
		o.cls = classify(o);
		o.pickup = o.cls === 'high' || o.cls === 'low' || o.type === 'prison';
		const m = o.template.mask || [];
		o.cells = []; o.entr = [];
		for (let i = 0; i < m.length; i++) for (let j = 0; j < m[i].length; j++) {
			const c = m[i][j];
			if (c !== 'B' && c !== 'A') continue;
			const x = o.x - (m[i].length - 1 - j), y = o.y - (m.length - 1 - i);
			if (!inb(x, y)) continue;
			if (!o.pickup) blocked[idx(o.l, x, y)] = 1;
			o.cells.push([x, y]);
			if (c === 'A') o.entr.push([x, y]);
		}
		o.visitable = o.entr.length > 0;                 // scenery has no visitable cell
		if (!o.entr.length) o.entr.push([o.x, o.y]);
		o.at = o.entr[0];                               // the standing / visitable tile: where it is on the map
	});
	const M = { file, objs, levels, header, NL, W, H, idx, inb, terr, road, blocked, zones: loadZones(file, W, H) };
	M.ground = i => !BLOCK_TERR.has(terr[i]);
	M.approach = o => {
		const vf = o.template.visitableFrom || ['+++', '+-+', '+++'];
		const out = [];
		for (const [ex, ey] of o.entr) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			if ((!dx && !dy) || (vf[dy + 1] || '')[dx + 1] !== '+' || !inb(ex + dx, ey + dy)) continue;
			out.push(idx(o.l, ex + dx, ey + dy));
		}
		return out;
	};
	M.zoneAt = (l, x, y) => (M.zones && M.zones.zoneOf ? M.zones.zoneOf(l, x, y) : undefined);
	buildRegions(M);
	return M;
}

function classify(o) {
	if (o.type === 'town' || o.type === 'randomTown') return 'town';
	if (o.type === 'monster' || /^randomMonster/.test(o.type)) return 'monster';
	if (HIGH.has(o.type)) return 'high';
	if (LOW.has(o.type)) return 'low';
	if (/^creatureGenerator/.test(o.type)) return 'dwelling';
	if (o.type === 'mine' || o.type === 'abandonedMine') return 'mine';
	if (o.type === 'creatureBank') return 'bank';
	if (o.type === 'subterraneanGate') return 'gate';
	if (/^monolith/.test(o.type)) return 'monolith';
	return 'other';
}
const BUILDING = new Set(['town', 'mine', 'dwelling', 'bank', 'gate', 'monolith']);

/** Guard rings, free regions (passable, outside every ring, 8-connected) and the links between them. */
function buildRegions(M) {
	const { objs, NL, W, H, idx, inb, blocked } = M;
	const guardOf = new Int32Array(NL * W * H).fill(-1);
	M.monsters = objs.filter(o => o.cls === 'monster');
	for (const m of M.monsters) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
		const x = m.at[0] + dx, y = m.at[1] + dy;
		if (inb(x, y)) guardOf[idx(m.l, x, y)] = m.k;
	}
	const free = i => M.ground(i) && !blocked[i] && guardOf[i] < 0;
	const region = new Int32Array(NL * W * H).fill(-1);
	const regions = [];
	for (let l = 0; l < NL; l++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
		const s = idx(l, x, y);
		if (region[s] >= 0 || !free(s)) continue;
		const id = regions.length, q = [s];
		region[s] = id;
		let n = 0;
		while (q.length) {
			const c = q.pop(); n++;
			const cx = c % W, cy = ((c / W) | 0) % H;
			for (const [dx, dy] of N8) {
				if (!inb(cx + dx, cy + dy)) continue;
				const t = idx(l, cx + dx, cy + dy);
				if (region[t] < 0 && free(t)) { region[t] = id; q.push(t); }
			}
		}
		regions.push({ id, l, tiles: n, x: x, y: y });
	}
	const regionsOf = o => [...new Set(M.approach(o).map(i => region[i]).filter(r => r >= 0))];
	const links = new Map();
	const link = (a, b) => {
		if (a === b) return;
		if (!links.has(a)) links.set(a, new Set());
		if (!links.has(b)) links.set(b, new Set());
		links.get(a).add(b); links.get(b).add(a);
	};
	// the engine pairs each surface gate with the nearest unpaired underground gate
	const gates = objs.filter(o => o.cls === 'gate'), used = new Set();
	for (const g of gates.filter(g => g.l === 0)) {
		let best = null, bd = 1e9;
		for (const h of gates) if (h.l === 1 && !used.has(h)) {
			const d = Math.hypot(g.x - h.x, g.y - h.y);
			if (d < bd) { bd = d; best = h; }
		}
		if (!best) continue;
		used.add(best);
		for (const a of regionsOf(g)) for (const b of regionsOf(best)) link(a, b);
	}
	const mono = new Map();
	for (const o of objs.filter(o => o.cls === 'monolith')) {
		const k = `${o.type}|${o.subtype}`;
		if (!mono.has(k)) mono.set(k, []);
		mono.get(k).push(o);
	}
	for (const [, list] of mono) {
		const rs = [...new Set(list.flatMap(regionsOf))];
		for (let i = 1; i < rs.length; i++) link(rs[0], rs[i]);
	}
	Object.assign(M, { guardOf, region, regions, regionsOf, links });
	M.closure = seed => {
		const seen = new Set(seed), q = [...seed];
		while (q.length) for (const n of links.get(q.pop()) || []) if (!seen.has(n)) { seen.add(n); q.push(n); }
		return seen;
	};
}

const cheb = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));

/** Starts: each player's main town (ours writes the anchor, the engine 2 tiles up-left of it: take the nearest town). */
function starts(M) {
	const out = [];
	for (const [colour, p] of Object.entries((M.header && M.header.players) || {})) {
		if (!p || !p.mainTown) continue;
		let t = null, bd = 9;
		for (const o of M.objs) if (o.cls === 'town' && o.l === p.mainTown.l) {
			const d = Math.max(Math.abs(o.x - p.mainTown.x), Math.abs(o.y - p.mainTown.y));
			if (d < bd) { bd = d; t = o; }
		}
		out.push({ colour, l: p.mainTown.l, at: t ? t.at : [p.mainTown.x, p.mainTown.y], zone: t ? M.zoneAt(t.l, t.at[0], t.at[1]) : undefined, regions: t ? M.regionsOf(t) : [] });
	}
	return out;
}

/** Loot and dwellings: nearest guard, and whether a hero can walk to it from a start without a fight. */
function guarding(M, st) {
	const open = M.closure(st.flatMap(s => s.regions));
	const rows = [];
	for (const o of M.objs) {
		if (!['high', 'low', 'dwelling', 'mine', 'bank'].includes(o.cls)) continue;
		let g = null, gd = 99;
		for (const m of M.monsters) if (m.l === o.l) { const d = cheb(m.at, o.at); if (d < gd) { gd = d; g = m; } }
		rows.push({ o, guardDist: gd, guard: g, walkable: M.regionsOf(o).some(r => open.has(r)) });
	}
	return rows;
}

/** Road graph per level: pieces, orphan pieces, entrance joins, stubs and the T arms they hang from. */
function roads(M) {
	const { objs, NL, W, H, idx, inb, road } = M;
	const out = [];
	const comp = new Int32Array(NL * W * H).fill(-1);
	const ringOf = (l, x, y) => N8.map(([dx, dy]) => (inb(x + dx, y + dy) && road[idx(l, x + dx, y + dy)] ? 1 : 0));
	const runs = ring => { let r = 0; for (let k = 0; k < 8; k++) if (ring[k] && !ring[(k + 7) % 8]) r++; return r || (ring.some(Boolean) ? 1 : 0); };
	const nearEntrance = new Uint8Array(NL * W * H);
	for (const o of objs) if (BUILDING.has(o.cls)) for (const [ex, ey] of o.entr)
		for (let dy = -1; dy <= 2; dy++) for (let dx = -1; dx <= 1; dx++)
			if (inb(ex + dx, ey + dy)) nearEntrance[idx(o.l, ex + dx, ey + dy)] = 1;
	for (let l = 0; l < NL; l++) {
		let pieces = 0;
		const size = [];
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			const s = idx(l, x, y);
			if (!road[s] || comp[s] >= 0) continue;
			const q = [s]; comp[s] = pieces; let n = 0;
			while (q.length) {
				const c = q.pop(), cx = c % W, cy = ((c / W) | 0) % H; n++;
				for (const [dx, dy] of N8) {
					if (!inb(cx + dx, cy + dy)) continue;
					const t = idx(l, cx + dx, cy + dy);
					if (road[t] && comp[t] < 0) { comp[t] = pieces; q.push(t); }
				}
			}
			size.push(n); pieces++;
		}
		// entrance joins: a road on a tile the building is visited from. A near miss is a road END within 3 tiles of a
		// building none of whose visiting tiles has road: the road was heading there and stopped short (K's picture,
		// 2026-10-01). A road merely passing within 3 tiles is not one (the engine roads few dwellings and banks).
		const isEnd = (x, y) => {
			if (!road[idx(l, x, y)]) return false;
			const ring = ringOf(l, x, y), n = ring.reduce((a, b) => a + b, 0);
			return n <= 1 || (n === 2 && runs(ring) === 1);
		};
		const joins = { joined: 0, nearMiss: [], noRoad: 0, byKind: {} };
		const piecesWithBuilding = new Set();
		for (const o of objs) {
			if (o.l !== l || !BUILDING.has(o.cls)) continue;
			const app = M.approach(o);
			const on = app.filter(i => road[i]);
			const kind = joins.byKind[o.cls] || (joins.byKind[o.cls] = { n: 0, joined: 0, nearMiss: 0 });
			kind.n++;
			if (on.length) { joins.joined++; kind.joined++; for (const i of on) piecesWithBuilding.add(comp[i]); continue; }
			let near = null, any = false;
			for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
				const x = o.at[0] + dx, y = o.at[1] + dy;
				if (!inb(x, y) || !road[idx(l, x, y)]) continue;
				any = true; piecesWithBuilding.add(comp[idx(l, x, y)]);
				if (!near && isEnd(x, y)) near = [x, y];
			}
			if (near) { joins.nearMiss.push({ o, road: near }); kind.nearMiss++; } else if (!any) joins.noRoad++;
		}
		const orphanTiles = size.reduce((a, n, c) => a + (piecesWithBuilding.has(c) ? 0 : n), 0);
		const orphanSet = new Set();
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = idx(l, x, y); if (road[i] && !piecesWithBuilding.has(comp[i])) orphanSet.add(i); }
		const orphanPieces = size.map((n, c) => ({ c, n })).filter(p => !piecesWithBuilding.has(p.c));
		// stubs: a road end (all road neighbours in two adjacent directions) away from entrances, guards and the edge;
		// ends within 2 tiles count once. Each is traced back to its junction: a short arm is a T to nowhere.
		const stubs = [];
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			const s = idx(l, x, y);
			if (!road[s] || nearEntrance[s]) continue;
			const ring = ringOf(l, x, y), n = ring.reduce((a, b) => a + b, 0);
			if (n > 2 || (n === 2 && runs(ring) !== 1)) continue;
			if (x <= 1 || y <= 1 || x >= W - 2 || y >= H - 2) continue;
			let atGuard = false;
			for (let dy = -2; dy <= 2 && !atGuard; dy++) for (let dx = -2; dx <= 2; dx++)
				if (inb(x + dx, y + dy) && M.guardOf[idx(l, x + dx, y + dy)] >= 0) { atGuard = true; break; }
			if (atGuard || stubs.some(q => cheb(q.at, [x, y]) <= 2)) continue;
			// walk back to the first tile where three or more road runs meet
			const dist = new Map([[s, 0]]), q = [s];
			let junction = null;
			while (q.length && !junction) {
				const c = q.shift(), cx = c % W, cy = ((c / W) | 0) % H, d = dist.get(c);
				if (d > 30) break;
				if (d > 1 && runs(ringOf(l, cx, cy)) >= 3) { junction = { at: [cx, cy], arm: d }; break; }
				for (const [dx, dy] of N8) {
					if (!inb(cx + dx, cy + dy)) continue;
					const t = idx(l, cx + dx, cy + dy);
					if (road[t] && !dist.has(t)) { dist.set(t, d + 1); q.push(t); }
				}
			}
			stubs.push({ at: [x, y], junction });
		}
		const towns = objs.filter(o => o.l === l && o.cls === 'town');
		const townPieces = new Set();
		for (const t of towns) for (const i of M.approach(t)) if (road[i]) townPieces.add(comp[i]);
		out.push({ l, tiles: size.reduce((a, b) => a + b, 0), pieces, orphanTiles, orphanSet, orphanPieces: orphanPieces.length, joins, stubs,
			towns: towns.length, townPieces: townPieces.size });
	}
	return out;
}

/**
 * The free region an object belongs to: its own visiting tiles' region, else the nearest free tile within 4 (a guarded
 * object's visiting tiles lie inside its guard's ring). Regions are bounded by guards, so on a map with no zone
 * sidecar (K's game writes none) they stand in for zones: a zone is one large region plus small pockets.
 */
function regionNear(M, o) {
	const own = M.regionsOf(o);
	if (own.length) return own[0];
	for (let r = 1; r <= 4; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
		if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
		const x = o.at[0] + dx, y = o.at[1] + dy;
		if (M.inb(x, y) && M.region[M.idx(o.l, x, y)] >= 0) return M.region[M.idx(o.l, x, y)];
	}
	return -1;
}

/**
 * Every road end, judged by the rule the engine's own 744 maps follow (2026-10-01, tier-1 grid, rivers excluded): 98% of
 * its road ends touch a town, mine, monolith or gate and 1% a guard ring; the rest are one-tile overshoots at a corner.
 * Improper, each about once in 30 to 100 engine maps and never on an engine map wider than 72:
 *   "at nothing"  - touches no destination, guard or object, and runs 2+ tiles back to the junction or turn it hangs from
 *   "at an object" - ends at loot, a bank, a dwelling or a small building instead of a destination, arm 2+
 *   "gap"          - an end within 3 tiles of a different road piece: two roads that nearly meet and do not
 */
const ROAD_DEST = new Set(['town', 'mine', 'monolith', 'gate']);
function roadEnds(M) {
	const isRoad = (l, x, y) => M.inb(x, y) && M.road[M.idx(l, x, y)];
	const ringRuns = (l, x, y) => { const r = N8.map(([dx, dy]) => (isRoad(l, x + dx, y + dy) ? 1 : 0)); let n = 0; for (let k = 0; k < 8; k++) if (r[k] && !r[(k + 7) % 8]) n++; return { n: r.reduce((a, b) => a + b, 0), runs: n }; };
	const near = new Map();
	for (const o of M.objs) {
		if (!o.visitable && o.cls !== 'monster') continue;
		const kind = o.cls === 'other' ? `small building ${o.type}` : o.cls;
		for (const i of [...M.approach(o), ...o.entr.map(([x, y]) => M.idx(o.l, x, y))]) { if (!near.has(i)) near.set(i, []); near.get(i).push({ kind, o }); }
	}
	const comp = new Int32Array(M.NL * M.W * M.H).fill(-1);
	for (let s = 0; s < comp.length; s++) {
		if (!M.road[s] || comp[s] >= 0) continue;
		const st = [s]; comp[s] = s;
		while (st.length) {
			const c = st.pop(), l = Math.floor(c / (M.W * M.H)), x = c % M.W, y = Math.floor(c / M.W) % M.H;
			for (const [dx, dy] of N8) { if (!M.inb(x + dx, y + dy)) continue; const n = M.idx(l, x + dx, y + dy); if (M.road[n] && comp[n] < 0) { comp[n] = s; st.push(n); } }
		}
	}
	const armOf = (l, x0, y0) => {
		const seen = new Set([`${x0},${y0}`]);
		let cur = [x0, y0], prev = null;
		for (let d = 1; d <= 40; d++) {
			const nb = N8.map(([dx, dy]) => [cur[0] + dx, cur[1] + dy, dx, dy]).filter(([x, y]) => isRoad(l, x, y) && !seen.has(`${x},${y}`));
			if (!nb.length) return { arm: d, to: 'a dead end' };
			nb.sort((a, b) => (Math.abs(a[2]) + Math.abs(a[3])) - (Math.abs(b[2]) + Math.abs(b[3])));
			const [x, y, dx, dy] = nb[0];
			for (const [ax, ay] of nb) seen.add(`${ax},${ay}`);
			if (ringRuns(l, x, y).runs >= 3) return { arm: d, to: `a junction at (${x},${y})` };
			if (prev && (prev[0] !== dx || prev[1] !== dy) && d === 1) return { arm: d, to: 'a turn' };
			prev = [dx, dy]; cur = [x, y];
		}
		return { arm: 41, to: 'a long road' };
	};
	const out = [];
	for (let l = 0; l < M.NL; l++) for (let y = 0; y < M.H; y++) for (let x = 0; x < M.W; x++) {
		if (!isRoad(l, x, y)) continue;
		const r = ringRuns(l, x, y);
		if (!(r.n <= 1 || (r.n === 2 && r.runs === 1))) continue;
		const touch = [], seenO = new Set();
		let guard = false;
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			if (!M.inb(x + dx, y + dy)) continue;
			const i = M.idx(l, x + dx, y + dy);
			for (const t of near.get(i) || []) if (!seenO.has(t.o)) { seenO.add(t.o); touch.push(t); }
			if (M.guardOf[i] >= 0) guard = true;
		}
		const e = { l, at: [x, y], touch: touch.map(t => `${t.kind}(${t.o.at[0]},${t.o.at[1]})`), kind: 'proper' };
		// a gap: another road piece a hero walks to in 4 steps or fewer, over open ground, pickups and guards (2026-10-03:
		// two roads 3 tiles apart with a wall between counted as a gap; a break a player sees is open ground)
		const c = comp[M.idx(l, x, y)];
		{
			const dist = new Map([[M.idx(l, x, y), 0]]), q = [[x, y]];
			for (let h = 0; h < q.length && e.kind === 'proper'; h++) {
				const [qx, qy] = q[h], d = dist.get(M.idx(l, qx, qy));
				if (d >= 4) continue;
				for (let dy = -1; dy <= 1 && e.kind === 'proper'; dy++) for (let dx = -1; dx <= 1; dx++) {
					const u = qx + dx, v = qy + dy;
					if ((!dx && !dy) || !M.inb(u, v)) continue;
					const i = M.idx(l, u, v);
					if (dist.has(i)) continue;
					if (M.road[i] && comp[i] !== c) { e.kind = 'gap'; e.gapTo = [u, v]; break; }
					if (!M.ground(i) || M.blocked[i]) continue;
					dist.set(i, d + 1); q.push([u, v]);
				}
			}
		}
		if (e.kind === 'proper' && !touch.some(t => ROAD_DEST.has(t.kind)) && !guard) {
			const a = armOf(l, x, y);
			e.arm = a.arm; e.to = a.to;
			if (a.arm >= 2) e.kind = touch.filter(t => t.kind !== 'monster').length ? 'at an object' : 'at nothing';
		}
		out.push(e);
	}
	return out;
}

/** Dwellings by level, tier and zone; the neutral dragon dwellings singled out. */
function census(M) {
	const I = index();
	const rows = [];
	for (const o of M.objs) {
		if (o.cls !== 'dwelling') continue;
		let tier = null, creature = null, neutral = null;
		if (I) {
			const e = I.lk.bySubtype.get(`${o.type}|${o.subtype}`);
			creature = e && (e.creature || (e.creatures || [])[0]);
			const c = I.creature(creature);
			if (c) { tier = c.level; neutral = c.faction === 'neutral'; }
		}
		const dragon = NEUTRAL_DRAGON_DWELLINGS.test(o.subtype) || (neutral && /dragon/i.test(creature || ''));
		rows.push({ o, tier, creature, dragon, zone: M.zoneAt(o.l, o.at[0], o.at[1]), region: regionNear(M, o) });
	}
	return rows;
}

/**
 * Objects whose art does not belong on the ground they stand on (K's well on wasteland, 2026-10-01).
 * Core ground: the corpus rule the generator itself uses (src/biome/terrainArt.js, from 71 game-made maps), because the
 * asset index holds only the mods' templates for most core arts. Mod ground (wasteland, highlands, ...): the index's
 * allowedTerrains for that art when the index has it, else the corpus when it shows the art on one core ground only.
 */
const { violates, CORE, artNeutral, essential } = require('../../../src/biome/terrainArt');
/**
 * The core game's own rule for its arts: Objects.txt in the .lod archives lists, per art, the terrains it may stand on
 * (read as tools/extract_h3_templates.js reads it). Used for core arts on mod ground, where neither the asset index nor
 * the corpus has a word (the snow well AVXwlsn0 on wasteland). Data folder: MAPSIGHT_H3DATA, else <VCMI_USER_DIR>/Data.
 */
let CORE_ARTS;
const LAND = ['dirt', 'sand', 'grass', 'snow', 'swamp', 'rough', 'subterra', 'lava'];
function coreArts() {
	if (CORE_ARTS !== undefined) return CORE_ARTS;
	CORE_ARTS = null;
	const dir = process.env.MAPSIGHT_H3DATA || (process.env.VCMI_USER_DIR && path.join(process.env.VCMI_USER_DIR, 'Data'));
	if (!dir) return CORE_ARTS;
	try {
		const { readLod, TERRAINS } = require('../../extract_h3_templates');
		let txt = null;
		for (const f of ['H3ab_bmp.lod', 'H3bitmap.lod']) if (!txt && fs.existsSync(path.join(dir, f))) txt = readLod(path.join(dir, f)).read('Objects.txt');
		if (!txt) return CORE_ARTS;
		CORE_ARTS = new Map();
		for (const line of txt.toString('latin1').split(/\r?\n/).slice(1)) {
			const s = line.trim().split(' ');
			if (s.length !== 9) continue;
			const a = s[0].toLowerCase().replace(/\.def$/, '');
			const set = CORE_ARTS.get(a) || new Set();
			TERRAINS.forEach((t, i) => { if (s[4][8 - i] === '1') set.add(t); });
			CORE_ARTS.set(a, set);
		}
	} catch (e) {
		process.stderr.write(`mapsight: core art terrains not read (${e.message})
`);
	}
	return CORE_ARTS;
}
const ART = require('../../../src/biome/objectTerrains.json').art;
function terrainLegality(M) {
	const I = index();
	const bad = [];
	let checked = 0;
	for (const o of M.objs) {
		if (o.cls === 'monster' || o.cls === 'town' || !o.template.animation) continue;
		const short = M.terr[M.idx(o.l, o.at[0], o.at[1])];
		if (BLOCK_TERR.has(short)) continue;
		const art = String(o.template.animation).toLowerCase().replace(/\.def$/, '');
		if (CORE[short]) {
			checked++;
			if (violates(o.type, o.subtype, o.template.animation, short)) {
				const e = ART[art] || ART[art.replace(/^.*\//, '')];
				bad.push({ o, terrain: CORE[short], allowed: e ? Object.keys(e.terrains) : ['?'], by: 'corpus' });
			}
			continue;
		}
		const name = (I && I.terrName.get(short)) || short;
		// mod ground: an art real maps stood on under four core grounds (the snow well, the snow trading post) is one
		// terrain family's art, wrong here whatever the game's tables allow (MapGen Dev's art_family.js rule)
		if (!essential(o.type) && !/[\/]/.test(String(o.template.animation)) && artNeutral(o.template.animation) === false) {
			checked++;
			bad.push({ o, terrain: name, allowed: ['one core family'], by: 'corpus family' });
			continue;
		}
		const core = coreArts();
		const own = core && core.get(art.replace(/^.*\//, ''));
		// an art the core table allows on all eight land terrains counts as any land, mod ground included
		if (own && LAND.every(t => own.has(t))) continue;
		if (own) { checked++; if (!own.has(name)) bad.push({ o, terrain: name, allowed: [...own], by: 'Objects.txt' }); continue; }
		if (!I) continue;
		const set = I.anims.get(I.art(o.template.animation));
		if (set) { checked++; if (!set.has(name)) bad.push({ o, terrain: name, allowed: [...set], by: 'index' }); continue; }
		const e = ART[art] || ART[art.replace(/^.*\//, '')];
		if (!e || e.n < 20) continue;
		checked++;
		const [top, c] = Object.entries(e.terrains).sort((a, b) => b[1] - a[1])[0];
		if (c / e.n >= 0.9) bad.push({ o, terrain: name, allowed: [top], by: 'corpus' });
	}
	// keep only the actionable ones: another art of the same object type stands on that ground (the wasteland well
	// exists, the snow well was used). A type with one art for every ground (most resources) is not flagged.
	const fits = altArts(I);
	// also keep an art made for one or two grounds (the snow well, a lava mine) standing on another: it shows the wrong
	// ground whether or not a fitting art exists, and the fix is then to drop or swap the object. Gates are left out:
	// the engine's underground gate art lists only surface grounds.
	const narrow = b => b.allowed.length <= 2 && !b.allowed.includes('?');
	return { checked, bad: bad.filter(b => b.o.type !== 'subterraneanGate' && (narrow(b) || (fits.get(`${b.o.type}|${b.o.subtype}`) || fits.get(b.o.type) || new Set()).has(b.terrain))) };
}

/** For each object type (and type|subtype): every ground some art of it may stand on, from the index, corpus and core table. */
let ALT;
function altArts(I) {
	if (ALT) return ALT;
	ALT = new Map();
	const add = (k, t) => { if (!ALT.has(k)) ALT.set(k, new Set()); ALT.get(k).add(t); };
	if (I) for (const [, o] of I.ix.objects) for (const t of o.templates || [])
		for (const n of t.allowedTerrains || []) { const g = String(n).replace(/^.*:/, '').toLowerCase(); add(`${o.type}|${o.subtype}`, g); add(o.type, g); }
	for (const e of Object.values(ART)) for (const [g, c] of Object.entries(e.terrains)) if (c >= 2) { add(`${e.type}|${e.subtype}`, g); add(e.type, g); }
	return ALT;
}

const POCKET = 30;
/** True when a hero can step onto a visiting tile of o from open ground (a free area over POCKET tiles) without a fight. */
function openAccess(M, o) { return M.regionsOf(o).some(r => M.regions[r].tiles > POCKET); }

/** Everything about one map, as plain data (the card prints it; compare.js reads it). */
function analyse(file) {
	const M = load(file);
	const st = starts(M);
	const g = guarding(M, st);
	const r = roads(M);
	const re = roadEnds(M);
	const c = census(M);
	const t = terrainLegality(M);
	const share = (rows, f) => (rows.length ? rows.filter(f).length / rows.length : null);
	const of = k => g.filter(e => e.o.cls === k);
	const zoneRows = new Map();
	for (const d of c) {
		const z = d.zone === undefined ? null : d.zone;
		if (z === null) continue;
		if (!zoneRows.has(z)) zoneRows.set(z, { zone: z, dwellings: 0, dragons: {}, tiers: {} });
		const e = zoneRows.get(z);
		e.dwellings++;
		if (d.tier) e.tiers[d.tier] = (e.tiers[d.tier] || 0) + 1;
		if (d.dragon) e.dragons[d.o.subtype] = (e.dragons[d.o.subtype] || 0) + 1;
	}
	const metrics = {
		levels: M.NL, size: `${M.W}x${M.H}`,
		starts_underground: st.filter(s => s.l > 0).length, starts: st.length,
		dwellings: c.length,
		neutral_dragon_dwellings: c.filter(d => d.dragon).length,
		neutral_dragon_surface: c.filter(d => d.dragon && d.o.l === 0).length,
		// guarded means access is blocked: every visiting tile lies inside a guard's ring or in a small pocket of free
		// ground (30 tiles or less) whose only way out is through a ring. A guard standing near but not in the way does
		// not count (K, 2026-10-01: "its not the distance, its the spatial relationship. the guards have to block access")
		high_open: share(of('high'), e => openAccess(M, e.o)),
		dwelling_open: share(of('dwelling'), e => openAccess(M, e.o)),
		prize_open: g.filter(e => /Relic|Major|pandora/i.test(e.o.type) && openAccess(M, e.o)).length,
		high_guarded_2: share(of('high'), e => e.guardDist <= 2),
		dwelling_guarded_2: share(of('dwelling'), e => e.guardDist <= 2),
		mine_guarded_2: share(of('mine'), e => e.guardDist <= 2),
		high_walkable: share(of('high'), e => e.walkable),
		dwelling_walkable: share(of('dwelling'), e => e.walkable),
		road_tiles: r.reduce((a, x) => a + x.tiles, 0),
		road_pieces: r.reduce((a, x) => a + x.pieces, 0),
		road_orphan_tiles: r.reduce((a, x) => a + x.orphanTiles, 0),
		road_stubs: r.reduce((a, x) => a + x.stubs.length, 0),
		road_t_arms: r.reduce((a, x) => a + x.stubs.filter(s => s.junction && s.junction.arm <= 15).length, 0),
		entrance_near_miss: r.reduce((a, x) => a + x.joins.nearMiss.length, 0),
		road_end_at_nothing: re.filter(e => e.kind === 'at nothing').length,
		road_end_at_object: re.filter(e => e.kind === 'at an object').length,
		road_gap: re.filter(e => e.kind === 'gap').length,
		town_joined: (() => { const k = r.map(x => x.joins.byKind.town || { n: 0, joined: 0 }); const n = k.reduce((a, b) => a + b.n, 0); return n ? k.reduce((a, b) => a + b.joined, 0) / n : null; })(),
		// zones (or, with no sidecar, regions) without a town that hold neutral dragon dwellings: Coldshadow's central
		// dragon caches are junction zones like that (K, 2026-10-01: "the non-town coldshadows central dragon cache ones")
		dragon_zones_no_town: (() => {
			const key = d => (d.zone !== undefined ? `z${d.zone}` : `r${d.region}`);
			const townKeys = new Set(M.objs.filter(o => o.cls === 'town').map(o => {
				const z = M.zoneAt(o.l, o.at[0], o.at[1]);
				return z !== undefined ? `z${z}` : `r${regionNear(M, o)}`;
			}));
			return new Set(c.filter(d => d.dragon && !townKeys.has(key(d))).map(key)).size;
		})(),
		terrain_illegal: t ? t.bad.filter(b => b.o.visitable).length : null,
		terrain_illegal_scenery: t ? t.bad.filter(b => !b.o.visitable).length : null,
	};
	return { file, M, starts: st, guarding: g, roads: r, roadEnds: re, census: c, zones: [...zoneRows.values()].sort((a, b) => a.zone - b.zone), terrain: t, metrics };
}

// a zone sidecar's "type:subtype" key that is a neutral dragon dwelling (the crystal mine's subtype is crystalCavern too)
const isDragonKey = k => /^creatureGenerator/.test(k) && NEUTRAL_DRAGON_DWELLINGS.test(k.split(':')[1] || '');

module.exports = { tileLayers, roadEnds, openAccess, isDragonKey, load, analyse, starts, guarding, roads, census, terrainLegality, index, cheb, NEUTRAL_DRAGON_DWELLINGS };
