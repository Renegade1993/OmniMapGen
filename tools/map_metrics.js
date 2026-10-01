/**
 * map_metrics.js - per-feature measures of a generated map against real ones.
 *
 * K, 2026-09-30: "we need to advance our map measuring metrics for codebase
 * verification. The rough statistical analysis we are doing is NOT cutting it."
 * Each measure here answers one thing K can see on the map, and is computed the
 * same way on a real game-made map and on ours, so the gap is a number:
 *
 *   roads      share of buildings whose entrance has a road on or beside it, by
 *              kind (town, mine, dwelling, bank); share of road tiles in road
 *              pieces that touch no building entrance (the "8-looping chunk")
 *   dwellings  share of faction dwellings standing on their own faction's native
 *              terrain; share with a town of another faction within 15 tiles as
 *              the nearest town
 *   terrain    objects standing on ground their template does not allow, per
 *              1000 objects (the frost well on lava), and the worst kinds
 *   prisons    share of prisons with another visitable building within 1 and 2
 *              tiles of their entrance
 *   guards     share of artifacts that a monster stands over, by class; share of
 *              level 5 to 7 monsters with nothing to guard within 3 tiles
 *   biomes     the compactness of terrain regions (4 pi area / perimeter^2, 1 is
 *              a circle) and their convexity (area / convex hull area)
 *   water      water pieces, land masses, and how mirrored the land is (the best
 *              match of the land mask with its own flips and quarter turns)
 *
 * Usage: node tools/map_metrics.js <label>=<folder or .vmap>[::<name regex>] ...
 *        (several labels make one column each; the first is the reference)
 *        --per-map prints one line per map
 * Needs VCMI_ROOT (the install whose config names terrains, creatures, objects).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { readVmap, parseTileCode } = require('../src/preview/render');
const { locateVcmiRoots, crawlMods, resolveLoadOrder, loadActivationState } = require('../src/parser/modCrawler');
const { buildAssetIndex } = require('../src/parser/assetIndex');
const { blockingCells, visitableCells, allowedDirs } = require('../src/biome/content');
const { violates, CORE } = require('../src/biome/terrainArt');

// ---- the install's own names -------------------------------------------------
function loadIndex() {
	const roots = locateVcmiRoots();
	if (!roots.installDir) throw new Error('set VCMI_ROOT');
	const mods = crawlMods(roots);
	const ordered = resolveLoadOrder(mods, loadActivationState(roots.userDir));
	return buildAssetIndex(path.join(roots.installDir, 'config'), ordered);
}

const bare = s => String(s || '').slice(String(s || '').lastIndexOf(':') + 1).toLowerCase();

function lookups(index) {
	const bySubtype = new Map();                    // "type|subtype" -> index entry
	const terrainsOfAnim = new Map();               // animation -> allowed terrain identifiers (absent: any land)
	for (const [, o] of index.objects) {
		bySubtype.set(`${o.type}|${o.subtype}`, o);
		for (const t of o.templates || []) {
			const a = t.raw && t.raw.animation;
			if (a && t.allowedTerrains) terrainsOfAnim.set(String(a).toLowerCase(), t.allowedTerrains.map(bare));
		}
	}
	const creatureByBare = new Map();
	for (const [id, c] of index.creatures) if (!creatureByBare.has(bare(id))) creatureByBare.set(bare(id), c);
	const terrainOfShort = new Map();               // "dt" -> "dirt"
	for (const [short, t] of index.terrains) terrainOfShort.set(short, bare(t.identifier || t.name));
	const nativeOf = new Map();                     // faction bare name -> its terrain
	for (const [id, f] of index.factions) if (f.nativeTerrain) nativeOf.set(bare(id), bare(f.nativeTerrain));
	return { bySubtype, terrainsOfAnim, creatureByBare, terrainOfShort, nativeOf };
}

// ---- one map -----------------------------------------------------------------
const DWELLING = /^creatureGenerator/;
const DECOR = /^(mountain|tree|trees|rock|decor|obstacle|pineTrees|oakTrees|dirtHills|grassHills|shrub|flowers|lake|crater|mushrooms|deadVegetation|stump|lavaFlow|lavaLake|outcropping|canyon|log|swampFoliage|snowHills|roughHills|sandDune|volcano|mdtBarrels|ptbones|bones|corpse|subterraneanRocks|wastelandsFissures|cactus|reef|kelp|flotsam)$/i;
const BUILDING = o => /^(town|randomTown|mine|creatureBank|dragonUtopia|crypt|derelictShip|shipwreck|pyramid|cartographer|witchHut|windmill|waterWheel|marlettoTower|schoolOfWar|schoolOfMagic|arena|learningStone|library|mercenaryCamp|magicWell|fountainOfFortune|fountainOfYouth|oasis|watchtower|redwoodObservatory|hillFort|garrison|garrison2|sanctuary|shrine.*|temple|treeOfKnowledge|universityOfMagic|libraryOfEnlightenment|stables|gazebo|idolOfFortune|faerieRing|mysticalGarden|swanPond|tradingPost|scholar|seerHut|questGuard|keymasterTent|borderGate|obelisk|redTower|den|lighthouse|hut|mageFieldGuard|campfire|cursedGround|ruins)/i.test(o.type) || DWELLING.test(o.type);

function analyse(file, L) {
	const { objects, levels } = readVmap(file);
	const lv = levels.find(l => l.name === 'surface') || levels[0];
	const H = lv.rows.length, W = lv.rows[0].length;
	const nLev = levels.length;
	// parseTileCode puts a river in the road slot when a tile has no road; roads are pd, pg and pc (config/roads.json)
	const tiles = levels.map(l => l.rows.map(r => r.map(c => { const t = parseTileCode(c); return { ...t, road: /^p[dgc]$/.test(t.road || '') ? t.road : null }; })));
	const terrAt = (l, x, y) => tiles[l] && tiles[l][y] && tiles[l][y][x] ? tiles[l][y][x].terr : null;
	const isWater = (l, x, y) => terrAt(l, x, y) === 'wt';
	const roadAt = (l, x, y) => !!(tiles[l] && tiles[l][y] && tiles[l][y][x] && tiles[l][y][x].road);
	const m = { file: path.basename(file), W, H, levels: nLev };

	// visitable objects, with entrance cells
	const info = [];
	for (const o of objects) {
		if (!o.template || !o.template.mask || DECOR.test(o.type)) continue;
		const l = o.l || 0;
		const vis = visitableCells(o.template, o.x, o.y).filter(([x, y]) => x >= 0 && y >= 0 && x < W && y < H);
		if (!vis.length) continue;
		const appr = [];
		for (const [vx, vy] of vis)
			for (const [dx, dy] of allowedDirs(o.template)) {
				const x = vx + dx, y = vy + dy;
				if (x >= 0 && y >= 0 && x < W && y < H) appr.push([x, y]);
			}
		const kind = /^(town|randomTown)$/.test(o.type) ? 'town' : o.type === 'mine' ? 'mine'
			: DWELLING.test(o.type) ? 'dwelling' : /^(creatureBank|dragonUtopia|crypt|derelictShip|shipwreck)$/.test(o.type) ? 'bank'
				: o.type === 'prison' ? 'prison' : /^(monster|randomMonster)/.test(o.type) ? 'monster' : 'other';
		info.push({ o, l, vis, appr, kind });
	}

	// roads: entrances on a road, and road pieces that serve nothing
	const R = { town: [0, 0, 0], mine: [0, 0, 0], dwelling: [0, 0, 0], bank: [0, 0, 0] };
	const roadPiece = new Map();      // "l:x,y" -> piece id
	let pieceN = 0, roadCells = 0, landCells = 0;
	for (let l = 0; l < nLev; l++) {
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++) {
				const t = terrAt(l, x, y);
				if (t !== 'wt' && t !== 'rc') landCells++;
				if (!roadAt(l, x, y) || roadPiece.has(`${l}:${x},${y}`)) continue;
				const q = [[x, y]];
				roadPiece.set(`${l}:${x},${y}`, pieceN);
				for (let h = 0; h < q.length; h++)
					for (let dy = -1; dy <= 1; dy++)
						for (let dx = -1; dx <= 1; dx++) {
							const u = q[h][0] + dx, v = q[h][1] + dy;
							if (u < 0 || v < 0 || u >= W || v >= H || !roadAt(l, u, v) || roadPiece.has(`${l}:${u},${v}`)) continue;
							roadPiece.set(`${l}:${u},${v}`, pieceN);
							q.push([u, v]);
						}
				pieceN++;
			}
	}
	roadCells = roadPiece.size;
	const served = new Set();
	for (const e of info) {
		if (!R[e.kind]) continue;
		const onVis = e.vis.some(([x, y]) => roadAt(e.l, x, y));
		const onAppr = e.appr.some(([x, y]) => roadAt(e.l, x, y));
		const near = e.vis.some(([vx, vy]) => {
			for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (roadAt(e.l, vx + dx, vy + dy)) return true;
			return false;
		});
		R[e.kind][0]++;
		if (onVis || onAppr) R[e.kind][1]++;
		if (near) R[e.kind][2]++;
		for (const [vx, vy] of e.vis)
			for (let dy = -2; dy <= 2; dy++)
				for (let dx = -2; dx <= 2; dx++) {
					const p = roadPiece.get(`${e.l}:${vx + dx},${vy + dy}`);
					if (p !== undefined) served.add(p);
				}
	}
	for (const k of Object.keys(R)) m[`road_${k}_at`] = R[k][0] ? R[k][1] / R[k][0] : null;
	for (const k of Object.keys(R)) m[`road_${k}_near2`] = R[k][0] ? R[k][2] / R[k][0] : null;
	const pieceSize = new Array(pieceN).fill(0);
	for (const p of roadPiece.values()) pieceSize[p]++;
	let idle = 0;
	pieceSize.forEach((n, p) => { if (!served.has(p)) idle += n; });
	// road ends in the open: a tile with exactly one road neighbour that is not within 2 tiles of any building's entrance
	const entrance = new Set();
	for (const e of info) if (e.kind !== 'monster' && e.kind !== 'prison') for (const [vx, vy] of e.vis) entrance.add(e.l + ':' + vx + ',' + vy);
	let ends = 0, stray = 0;
	for (const key of roadPiece.keys()) {
		const [l, xy] = key.split(':'), [x, y] = xy.split(',').map(Number);
		let deg = 0;
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && roadAt(+l, x + dx, y + dy)) deg++;
		if (deg !== 1) continue;
		ends++;
		let near = false;
		for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2; dx++) if (entrance.has(l + ':' + (x + dx) + ',' + (y + dy))) { near = true; break; }
		if (!near && x > 1 && y > 1 && x < W - 2 && y < H - 2) stray++;
	}
	m.road_ends_stray_per1000 = landCells ? 1000 * stray / landCells : null;
	m.road_ends_stray_share = ends ? stray / ends : null;
	// thick road: a road tile in a 2x2 block of road tiles (the tile art draws rungs and loops between them: K's
	// "8-looping road chunk that goes nowhere"), and 3-tile bends around a corner of road cells
	let thick = 0;
	for (const key of roadPiece.keys()) {
		const [l, xy] = key.split(':'), [x, y] = xy.split(',').map(Number);
		let inBlock = false;
		for (const [ox, oy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]])
			if (roadAt(+l, x + ox, y + oy) && roadAt(+l, x + ox + 1, y + oy) && roadAt(+l, x + ox, y + oy + 1) && roadAt(+l, x + ox + 1, y + oy + 1)) inBlock = true;
		if (inBlock) thick++;
	}
	let tri = 0;
	for (const key of roadPiece.keys()) {
		const [l, xy] = key.split(':'), [x, y] = xy.split(',').map(Number);
		const nb = [];
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && roadAt(+l, x + dx, y + dy)) nb.push([x + dx, y + dy]);
		let t = false;
		for (let i = 0; i < nb.length && !t; i++) for (let j = i + 1; j < nb.length; j++)
			if (Math.max(Math.abs(nb[i][0] - nb[j][0]), Math.abs(nb[i][1] - nb[j][1])) <= 1) { t = true; break; }
		if (t) tri++;
	}
	m.road_triangle_share = roadCells ? tri / roadCells : null;
	m.road_thick_share = roadCells ? thick / roadCells : null;
	m.road_per1000 = landCells ? 1000 * roadCells / landCells : null;
	m.road_idle_share = roadCells ? idle / roadCells : null;
	m.road_pieces_per1000 = landCells ? 1000 * pieceN / landCells : null;
	m.road_largest_share = roadCells ? Math.max(0, ...pieceSize) / roadCells : null;

	// dwellings against their faction's terrain, and against the nearest town
	// a random-town placeholder has no faction yet (the game rolls it at load): only concrete towns count
	const towns = info.filter(e => e.kind === 'town' && e.o.type === 'town').map(e => {
		const f = bare(e.o.subtype);
		return { x: e.o.x, y: e.o.y, l: e.l, f };
	});
	let dw = 0, dwKnown = 0, dwNative = 0, dwNear = 0, dwNearMis = 0;
	for (const e of info) {
		if (e.kind !== 'dwelling') continue;
		dw++;
		const def = L.bySubtype.get(`${e.o.type}|${e.o.subtype}`);
		const cre = def && def.creature ? L.creatureByBare.get(bare(def.creature)) : null;
		const fac = cre && cre.faction ? bare(cre.faction) : null;
		if (!fac || fac === 'neutral') continue;
		const nat = L.nativeOf.get(fac);
		if (!nat) continue;
		dwKnown++;
		const ter = L.terrainOfShort.get(terrAt(e.l, e.o.x, e.o.y));
		if (ter === nat) dwNative++;
		let best = null;
		for (const t of towns) {
			if (t.l !== e.l) continue;
			const d = Math.max(Math.abs(t.x - e.o.x), Math.abs(t.y - e.o.y));
			if (!best || d < best.d) best = { d, f: t.f };
		}
		if (best && best.d <= 15) { dwNear++; if (best.f !== fac) dwNearMis++; }
	}
	m.dwellings = dw;
	m.dwelling_known_share = dw ? dwKnown / dw : null;
	m.dwelling_on_native = dwKnown ? dwNative / dwKnown : null;
	m.dwelling_next_to_other_town = dwNear ? dwNearMis / dwNear : null;

	// objects on ground real maps never put their art on (src/biome/terrainArt.js, from the corpus)
	let checked = 0, wrong = 0;
	const worst = {};
	for (const o of objects) {
		if (!o.template || !o.template.animation) continue;
		const short = terrAt(o.l || 0, o.x, o.y);
		if (!short || !CORE[short]) continue;
		checked++;
		if (violates(o.type, o.subtype, o.template.animation, short)) { wrong++; const k = `${o.type}:${o.subtype} on ${CORE[short]}`; worst[k] = (worst[k] || 0) + 1; }
	}
	m.terrain_objects_checked = checked;
	m.terrain_wrong_per1000 = checked ? 1000 * wrong / checked : null;
	m.terrain_worst = Object.entries(worst).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} x${v}`).join('; ');

	// prisons beside other buildings
	let pr = 0, pr1 = 0, pr2 = 0;
	const others = info.filter(e => e.kind !== 'prison' && e.kind !== 'monster' && BUILDING(e.o));
	for (const p of info.filter(e => e.kind === 'prison')) {
		pr++;
		let best = Infinity;
		for (const e of others) {
			if (e.l !== p.l) continue;
			for (const [px, py] of p.vis)
				for (const [vx, vy] of e.vis) best = Math.min(best, Math.max(Math.abs(px - vx), Math.abs(py - vy)));
		}
		if (best <= 1) pr1++;
		if (best <= 2) pr2++;
	}
	m.prisons = pr;
	m.prison_within1 = pr ? pr1 / pr : null;
	m.prison_within2 = pr ? pr2 / pr : null;

	// guards: artifacts under a monster, and monsters with nothing to guard
	const monsters = info.filter(e => e.kind === 'monster');
	const monsterTier = e => {
		const r = e.o.type.match(/^randomMonsterLevel([1-7])$/);
		if (r) return +r[1];
		const c = L.creatureByBare.get(bare(e.o.subtype));
		return c && c.level ? c.level : null;
	};
	const covered = (l, cells) => cells.some(([x, y]) => monsters.some(g => g.l === l
		&& g.vis.some(([gx, gy]) => Math.max(Math.abs(gx - x), Math.abs(gy - y)) <= 1)));
	const art = { relic: [0, 0], major: [0, 0], minor: [0, 0], treasure: [0, 0], artifact: [0, 0], pandora: [0, 0], bank: [0, 0], dwelling: [0, 0], chest: [0, 0] };
	for (const e of info) {
		const r = e.o.type.match(/^randomArtifact(Relic|Major|Minor|Treasure)?$/) || (e.o.type === 'artifact' ? ['', 'artifact'] : null)
			|| (e.o.type === 'pandoraBox' ? ['', 'pandora'] : e.kind === 'bank' ? ['', 'bank'] : e.kind === 'dwelling' ? ['', 'dwelling'] : e.o.type === 'treasureChest' ? ['', 'chest'] : null);
		if (!r) continue;
		const k = (r[1] || 'artifact').toLowerCase();
		if (!art[k]) continue;
		art[k][0]++;
		if (covered(e.l, e.vis)) art[k][1]++;
	}
	for (const k of Object.keys(art)) m[`guarded_${k}`] = art[k][0] ? art[k][1] / art[k][0] : null;
	let hi = 0, idleHi = 0, idleHi1 = 0;
	for (const g of monsters) {
		const t = monsterTier(g);
		if (!(t >= 5)) continue;
		hi++;
		const within = r => info.some(e => e !== g && e.kind !== 'monster' && e.l === g.l
			&& e.vis.some(([x, y]) => g.vis.some(([gx, gy]) => Math.max(Math.abs(gx - x), Math.abs(gy - y)) <= r)));
		if (!within(3)) idleHi++;
		if (!within(1)) idleHi1++;
	}
	m.monsters_5_7 = hi;
	m.monsters_per1000 = landCells ? 1000 * monsters.length / landCells : null;
	m.monsters_5_7_per1000 = landCells ? 1000 * hi / landCells : null;
	m.idle_high_monster_share = hi ? idleHi / hi : null;
	m.idle_high_monster_r1 = hi ? idleHi1 / hi : null;

	// terrain regions: compactness and convexity on the surface
	const reg = regionStats(tiles[0], W, H);
	m.region_count = reg.count;
	m.region_compact = reg.compact;
	m.region_convex = reg.convex;
	m.region_roughness = reg.rough;

	// water and mirror symmetry (surface)
	const wat = new Uint8Array(W * H);
	let wn = 0;
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (isWater(0, x, y)) { wat[y * W + x] = 1; wn++; }
	m.water_share = wn / (W * H);
	const comp = (val, min) => {
		const seen = new Uint8Array(W * H);
		let n = 0;
		for (let c0 = 0; c0 < W * H; c0++) {
			if (seen[c0] || wat[c0] !== val) continue;
			const q = [c0];
			seen[c0] = 1;
			for (let h = 0; h < q.length; h++) {
				const c = q[h], x = c % W, y = (c / W) | 0;
				for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
					const u = x + d[0], v = y + d[1];
					if (u >= 0 && v >= 0 && u < W && v < H && !seen[v * W + u] && wat[v * W + u] === val) { seen[v * W + u] = 1; q.push(v * W + u); }
				}
			}
			if (q.length >= min) n++;
		}
		return n;
	};
	m.water_pieces = wn ? comp(1, 25) : 0;
	m.land_masses = comp(0, 100);
	m.land_mirror = wn ? mirror(wat, W, H) : null;
	return m;
}

function BUILDING_OR_PICKUP(e) { return e.kind !== 'prison'; }

function regionStats(rows, W, H) {
	const code = (x, y) => rows[y][x].terr;
	const seen = new Uint8Array(W * H);
	let count = 0, cs = 0, vs = 0, rs = 0, tot = 0;
	for (let c0 = 0; c0 < W * H; c0++) {
		if (seen[c0]) continue;
		const t0 = code(c0 % W, (c0 / W) | 0);
		if (t0 === 'wt' || t0 === 'rc') { seen[c0] = 1; continue; }
		const q = [c0];
		seen[c0] = 1;
		for (let h = 0; h < q.length; h++) {
			const c = q[h], x = c % W, y = (c / W) | 0;
			for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
				const u = x + d[0], v = y + d[1];
				if (u >= 0 && v >= 0 && u < W && v < H && !seen[v * W + u] && code(u, v) === t0) { seen[v * W + u] = 1; q.push(v * W + u); }
			}
		}
		if (q.length < 150) continue;
		const inR = new Set(q);
		let per = 0;
		for (const c of q) {
			const x = c % W, y = (c / W) | 0;
			for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
				const u = x + d[0], v = y + d[1];
				if (u < 0 || v < 0 || u >= W || v >= H || !inR.has(v * W + u)) per++;
			}
		}
		const hull = hullArea(q.map(c => [c % W, (c / W) | 0]));
		count++;
		tot += q.length;
		cs += q.length * (4 * Math.PI * q.length / (per * per));
		vs += q.length * (q.length / Math.max(hull, q.length));
		// boundary roughness: the perimeter against the perimeter of a same-area square
		rs += q.length * (per / (4 * Math.sqrt(q.length)));
	}
	return { count, compact: tot ? cs / tot : null, convex: tot ? vs / tot : null, rough: tot ? rs / tot : null };
}

function hullArea(pts) {
	pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
	const lo = [], up = [];
	for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
	for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
	const h = lo.slice(0, -1).concat(up.slice(0, -1));
	let a = 0;
	for (let i = 0; i < h.length; i++) { const p = h[i], q = h[(i + 1) % h.length]; a += p[0] * q[1] - q[0] * p[1]; }
	return Math.abs(a) / 2 + h.length / 2 + 1;
}

// the best agreement of the land mask with a flip or quarter turn of itself
function mirror(wat, W, H) {
	const at = (x, y) => wat[y * W + x];
	const same = f => {
		let eq = 0, tot = 0;
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			const [u, v] = f(x, y);
			if (u < 0 || v < 0 || u >= W || v >= H) continue;
			tot++;
			if (at(x, y) === at(u, v)) eq++;
		}
		return tot ? eq / tot : 0;
	};
	const flips = [(x, y) => [W - 1 - x, y], (x, y) => [x, H - 1 - y], (x, y) => [W - 1 - x, H - 1 - y]];
	if (W === H) flips.push((x, y) => [y, x], (x, y) => [H - 1 - y, W - 1 - x], (x, y) => [y, W - 1 - x], (x, y) => [H - 1 - y, x]);
	return Math.max(...flips.map(same));
}

// ---- command line --------------------------------------------------------------
const FIELDS = [
	['road_town_at', 'towns with a road on or at the entrance'], ['road_mine_at', 'mines, same'],
	['road_dwelling_at', 'dwellings, same'], ['road_bank_at', 'banks, same'],
	['road_town_near2', 'towns with a road within 2'], ['road_mine_near2', 'mines, same'],
	['road_per1000', 'road tiles per 1000 land tiles'], ['road_idle_share', 'road tiles in pieces serving no building'],
	['road_ends_stray_per1000', 'road ends in the open per 1000 land tiles'], ['road_ends_stray_share', 'share of road ends that are in the open'], ['road_thick_share', 'road tiles in a 2x2 block of road (loops and rungs)'], ['road_triangle_share', 'road tiles with two road neighbours that touch each other'], ['road_pieces_per1000', 'road pieces per 1000 land tiles'], ['road_largest_share', 'road tiles in the biggest piece'],
	['dwellings', 'dwellings (count)'], ['dwelling_known_share', 'dwellings with a known faction'],
	['dwelling_on_native', 'faction dwellings on their native terrain'],
	['dwelling_next_to_other_town', 'with a town within 15, that town is another faction'],
	['terrain_wrong_per1000', 'objects on forbidden terrain per 1000 checked'],
	['prisons', 'prisons (count)'], ['prison_within1', 'prisons with a building within 1'], ['prison_within2', 'prisons with a building within 2'],
	['guarded_relic', 'relics with a monster over them'], ['guarded_major', 'majors, same'], ['guarded_minor', 'minors, same'], ['guarded_pandora', 'pandora boxes, same'], ['guarded_bank', 'banks, same'], ['guarded_dwelling', 'dwellings, same'], ['guarded_chest', 'chests, same'],
	['monsters_per1000', 'monsters per 1000 land tiles'], ['monsters_5_7_per1000', 'level 5-7 monsters per 1000 land tiles'], ['idle_high_monster_share', 'of those, nothing within 3 to guard'], ['idle_high_monster_r1', 'of those, nothing adjacent (within 1)'],
	['region_count', 'terrain regions of 150+ tiles'], ['region_compact', 'compactness (1 = circle)'],
	['region_convex', 'convexity (area / hull)'], ['region_roughness', 'boundary roughness (1 = square)'],
	['water_share', 'water share'], ['water_pieces', 'water pieces (25+)'], ['land_masses', 'land masses (100+)'],
	['land_mirror', 'mirror match of the water mask'],
];

function expand(spec) {
	const [label, rest] = spec.split(/=(.+)/);
	const [p, rx] = rest.split('::');
	const files = [];
	const add = f => { if (/\.vmap$/i.test(f) && (!rx || new RegExp(rx, 'i').test(path.basename(f)))) files.push(f); };
	for (const one of p.split(',')) {
		if (fs.statSync(one).isDirectory()) for (const f of fs.readdirSync(one)) add(path.join(one, f));
		else add(one);
	}
	return { label, files };
}

function main() {
	const args = process.argv.slice(2);
	const perMap = args.includes('--per-map');
	const groups = args.filter(a => !a.startsWith('--')).map(expand);
	if (!groups.length) { console.error('usage: map_metrics.js label=folder-or-vmap[::regex] ...'); process.exit(2); }
	const L = lookups(loadIndex());
	const results = groups.map(g => ({ label: g.label, maps: g.files.map(f => { try { return analyse(f, L); } catch (e) { console.error(`${f}: ${e.message}`); return null; } }).filter(Boolean) }));
	const mean = (maps, k) => {
		const v = maps.map(m => m[k]).filter(x => typeof x === 'number' && Number.isFinite(x));
		return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
	};
	const fmt = v => v === null ? '   -' : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
	console.log(['measure'.padEnd(52), ...results.map(r => `${r.label}(${r.maps.length})`.padStart(14))].join(' '));
	for (const [k, label] of FIELDS)
		console.log([`${k}: ${label}`.slice(0, 52).padEnd(52), ...results.map(r => fmt(mean(r.maps, k)).padStart(14))].join(' '));
	for (const r of results) {
		const worst = {};
		for (const mp of r.maps) for (const s of (mp.terrain_worst || '').split('; ').filter(Boolean)) {
			const mm = s.match(/^(.*) x(\d+)$/);
			if (mm) worst[mm[1]] = (worst[mm[1]] || 0) + +mm[2];
		}
		const top = Object.entries(worst).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} x${v}`).join('; ');
		if (top) console.log(`worst on forbidden terrain, ${r.label}: ${top}`);
	}
	if (perMap)
		for (const r of results) for (const mp of r.maps)
			console.log(`${r.label} ${mp.file} ${mp.W}x${mp.H}x${mp.levels}: ` + FIELDS.slice(0, 10).map(([k]) => `${k.replace(/^road_/, '')}=${fmt(mp[k])}`).join(' '));
}

if (require.main === module) main();
module.exports = { analyse, lookups, loadIndex, FIELDS };
