'use strict';
/**
 * grid_extra.js - the grid checks from K's October 8th playtest (roster\QUEUE-MapGen Dev.md, K's lines of 2026-10-07 and 2026-10-08), merged into
 * playtest_checks.js (node tools/harness/playtest_checks.js MAP|DIR --only start-road,town-spacing,...). The measures are Opus Map Vision's where he
 * wrote them first (edge_objects.js, rivers.js, prison_tiers.js, stack_effect.js, sight.roadEnds); here they return a PASS or FAIL with a limit.
 *
 *   start-road       every start town has a road on its front or entrance tile, joined to a road of at least 8 tiles [K 10-08 15:5x islands start]
 *   town-spacing     two towns closer than 15 walking tiles are the extreme exception; never two starts, never a start and a neutral [K 10-08 15:0x]
 *   road-breaks      a gap of 1 to 4 tiles between two road ends, near a town especially [K 10-08 15:0x "the first incorrect road break"]
 *   road-corners     two road tiles touching at a corner with neither shared side tile a road: VCMI draws each end as a dead end [K 10-10 road report; Opus Reviewer R27 10-11]
 *   town-loot        a dear pile (artifact, Pandora's box; not a scroll) within 5 tiles of a town with no monster in its 3x3 and an open way in outside every ring [Opus Reviewer R28 10-11: Pandora's box (44,51) beside the town (45,48), seed 670084743]
 *   loot-by-zone     a report with no limit: dear piles (not scrolls) by zone class (highLoot, player, lowLoot, standard, town) and by guard level, to compare between builds [Opus Reviewer R36 10-11: open dear loot traded into player zones]
 *   road-ends        a road that stops at a small building's door with another road piece 3 to 6 tiles beyond, or ends 6 tiles or less from another road piece or an unroaded town front [K 10-08 15:0x tavern and castle]
 *   gold-front       a gold mine with a free entrance tile outside every stack's 3x3 ring (Opus Reviewer 10-09, K 10-08 "a completely unguarded gold mine in my start biome"; the engine guards all)
 *   prison-tiers     prisons of 90000 or more experience stay out of start and town zones and keep a monster beside them [K 10-07 18:3x]
 *   edge-objects     no visited object's picture crosses the top or left edge of the map [K 10-08 14:3x outcasts and school of magic]
 *   free-standing    stacks that close nothing (no object, no passage) [K 10-08 15:2x "essentially freestanding"]
 *   approach-shadow  an entrance object's picture (monolith, gate; the passable V cells too) on an approach tile or on the cells of a pile, dwelling, mine or bank [K 10-11 monolith on the gem pond; lead 10-13]
 *   road-stubs       a lone road piece under 8 tiles that touches no visiting tile and no map edge [K 10-11 road terminations]
 *   water-objects    a land object with cells on water, a water object on land [K 10-12 Mediterranean XL]
 *   water-content    objects on the water per 1000 water tiles against loot objects on land per 1000 land tiles; ratio limit proposed [K 10-12 17:55 Mediterranean XL: not enough mod loot and structures on the water]
 *   prison-hero      a prison hero's four stats against its level, from stored primarySkills or an engine log beside the map [K 10-11 Ayden level 30 with 1/1/2/1]
 *   water            the water share against the share asked, land share per zone (under 45% named), zones drowned or cut off, the shape of the water against the layout asked, every start walking to a town and a mine [lead 10-10, K's Mediterranean complaint]
 *   water-type      the water against the Age of Empires map type the layout lever stands for (Research\AoE-map-types): measures per type (the amount of water is the waterCoverage lever's, judged by the water check, not here), thresholds proposed, not accepted [K 10-11: the AoE wikis are the source]
 *   river-ends       a river ends at a map edge or at water, never in the open, and runs under no visited object [K 10-07 18:3x creeks]
 */
const sight = require('../mapsight/lib/sight');

const N8 = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 0], [-1, 1]];
const cheb = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
const at = o => `L${o.l} (${o.at[0]},${o.at[1]})`;
const verdict = (pass, value, limit, items, nums) => ({ pass, value, limit, items: items || [], nums: nums || {} });
const RIVERS = new Set(['rw', 'ri', 'rm', 'rl', 'ra', 'lr', 'ww', 'ut', 'pw', 'sr']);
const WET = new Set(['wa', 'wt']);

const LIMITS = {
	roadMin: 8,                       // tiles of road a start's road must join
	closeWalk: 15,                    // town to town, walking tiles
	closeShare: 0.05,                 // share of neutral towns with a neighbour inside it
	gapNearTown: 10,                  // a road gap within this many tiles of a town is named
	gapShare: 0.5,                    // gaps per 100 road tiles
	minStacks: 30, ineffective: 0.05,
	riverOpen: 0, riverUnder: 0,
	waterTol: 0.05,                   // water share against the share asked, in points of the surface
	waterLandMin: 0.45,               // land share a zone keeps on a map with water (lead 10-10)
	startLootShare: 1,                 // loot-by-zone is a report: no limit (K's road map holds 34% of its dear piles in player zones on 084ac2c, K's 18 about 7%)
	townLootR: 5,                     // town-loot: tiles from a town's cells that make a pile "beside" it
	seaLootRatio: 0.5,                 // water-content: objects per 1000 water tiles over objects per 1000 land tiles (a proposal; K: "not enough mod loot + structures on the water")
	stubMax: 8,                        // road-stubs: a road piece under this many tiles that touches no destination
	endReach: 6,                      // road_ends.js: tiles round a road end that name another road piece or a town front
};

const startTowns = M => { const st = sight.starts(M); return M.objs.filter(o => o.cls === 'town' && st.some(s => s.l === o.l && cheb(s.at, o.at) <= 1)); };

/** Road component sizes (8-connected road tiles). */
function roadComponents(M) {
	const comp = new Int32Array(M.NL * M.W * M.H).fill(-1), size = [];
	for (let s = 0; s < comp.length; s++) {
		if (!M.road[s] || comp[s] >= 0) continue;
		const id = size.length; let n = 0; const st = [s]; comp[s] = id;
		while (st.length) {
			const c = st.pop(); n++;
			const l = Math.floor(c / (M.W * M.H)), x = c % M.W, y = Math.floor(c / M.W) % M.H;
			for (const [dx, dy] of N8) { if (!M.inb(x + dx, y + dy)) continue; const k = M.idx(l, x + dx, y + dy); if (M.road[k] && comp[k] < 0) { comp[k] = id; st.push(k); } }
		}
		size.push(n);
	}
	return { comp, size };
}

function startRoad(M) {
	const towns = startTowns(M);
	if (!towns.length) return { skipped: 'no start towns' };
	const { comp, size } = roadComponents(M), bad = [];
	for (const o of towns) {
		const [ex, ey] = o.entr[0], fi = M.inb(ex, ey + 1) ? M.idx(o.l, ex, ey + 1) : -1, ei = M.idx(o.l, ex, ey);
		const i = fi >= 0 && M.road[fi] ? fi : M.road[ei] ? ei : -1;
		if (i < 0) { bad.push(`${o.type} ${at(o)}: no road on the front tile (${ex},${ey + 1}) or the entrance`); continue; }
		if (size[comp[i]] < LIMITS.roadMin) bad.push(`${o.type} ${at(o)}: its road is a stub of ${size[comp[i]]} tiles`);
	}
	return verdict(bad.length === 0, `${bad.length} of ${towns.length} start towns`, '0', bad);
}

/** Walking distance in tiles from a town's visiting tiles, 8-connected over open ground (pickups and monsters are passable: a fight or a pickup, not a wall). */
function walkFrom(M, o, limit) {
	const dist = new Map(), q = [];
	for (const i of M.approach(o)) if (M.ground(i) && !M.blocked[i]) { dist.set(i, 0); q.push(i); }
	for (let h = 0; h < q.length; h++) {
		const c = q[h], d = dist.get(c);
		if (d >= limit) continue;
		const l = Math.floor(c / (M.W * M.H)), x = c % M.W, y = Math.floor(c / M.W) % M.H;
		for (const [dx, dy] of N8) {
			if (!M.inb(x + dx, y + dy)) continue;
			const k = M.idx(l, x + dx, y + dy);
			if (dist.has(k) || !M.ground(k) || M.blocked[k]) continue;
			dist.set(k, d + 1); q.push(k);
		}
	}
	return dist;
}

function townSpacing(M) {
	const towns = M.objs.filter(o => o.cls === 'town');
	if (towns.length < 2) return { skipped: 'fewer than two towns' };
	const starts = new Set(startTowns(M)), close = [];
	for (let a = 0; a < towns.length; a++) {
		let dist = null;
		for (let b = a + 1; b < towns.length; b++) {
			if (towns[a].l !== towns[b].l || cheb(towns[a].at, towns[b].at) > LIMITS.closeWalk) continue;
			dist = dist || walkFrom(M, towns[a], LIMITS.closeWalk);
			let best = 99;
			for (const i of M.approach(towns[b])) if (dist.has(i)) best = Math.min(best, dist.get(i));
			if (best < LIMITS.closeWalk) close.push({ a: towns[a], b: towns[b], d: best + 1 });
		}
	}
	const neutral = towns.filter(t => !starts.has(t)), inPair = new Set();
	const startPairs = close.filter(p => starts.has(p.a) || starts.has(p.b));
	for (const p of close) if (!starts.has(p.a) && !starts.has(p.b)) { inPair.add(p.a); inPair.add(p.b); }
	const share = neutral.length ? inPair.size / neutral.length : 0, allowed = Math.max(1, Math.floor(LIMITS.closeShare * neutral.length));
	close.sort((p, q) => p.d - q.d);
	return verdict(startPairs.length === 0 && inPair.size <= allowed,
		`${close.length} close pairs (${startPairs.length} with a start), ${inPair.size} of ${neutral.length} neutral towns (${(100 * share).toFixed(1)}%), nearest ${close[0] ? close[0].d : '-'} tiles`,
		`no pair with a start, at most ${allowed} neutral towns inside ${LIMITS.closeWalk} walking tiles`,
		close.slice(0, 6).map(p => `${p.a.type} ${at(p.a)} and ${p.b.type} ${at(p.b)}: ${p.d} walking tiles${starts.has(p.a) || starts.has(p.b) ? ' (a start)' : ''}`),
		{ pairs: close.length, startPairs: startPairs.length, neutralShare: share });
}

function roadBreaks(M) {
	let roadTiles = 0, land = 0;
	for (let i = 0; i < M.road.length; i++) { roadTiles += M.road[i]; if (M.ground(i)) land++; }
	if (roadTiles < land / 100) return { skipped: 'the map has almost no road' };
	const ends = sight.roadEnds(M), gaps = ends.filter(e => e.kind === 'gap'), towns = M.objs.filter(o => o.cls === 'town');
	const near = gaps.filter(g => towns.some(t => t.l === g.l && cheb(t.at, g.at) <= LIMITS.gapNearTown));
	const per100 = 100 * gaps.length / Math.max(1, roadTiles);
	return verdict(near.length === 0 && per100 <= LIMITS.gapShare, `${gaps.length} gaps (${per100.toFixed(2)} per 100 road tiles), ${near.length} within ${LIMITS.gapNearTown} tiles of a town; dead ends at nothing ${ends.filter(e => e.kind === 'at nothing').length}`,
		`no gap near a town, at most ${LIMITS.gapShare} per 100 road tiles`,
		[...near, ...gaps.filter(g => !near.includes(g))].slice(0, 6).map(g => `road end L${g.l} (${g.at}) lies ${g.gapTo ? Math.max(Math.abs(g.gapTo[0] - g.at[0]), Math.abs(g.gapTo[1] - g.at[1])) : '?'} tiles from another road at (${g.gapTo})`),
		{ gaps: gaps.length, nearTown: near.length, per100 });
}

/** Corner-only road steps (Opus's roaddiag.js): two road tiles that touch at a corner while neither tile beside them is a road. The game draws each as two dead ends. */
function roadCorners(M) {
	let tiles = 0; const list = [];
	const has = (l, x, y) => M.inb(x, y) && M.road[M.idx(l, x, y)];
	for (let l = 0; l < M.NL; l++) for (let y = 0; y < M.H; y++) for (let x = 0; x < M.W; x++) {
		if (!has(l, x, y)) continue; tiles++;
		for (const [dx, dy] of [[1, 1], [1, -1]]) if (has(l, x + dx, y + dy) && !has(l, x + dx, y) && !has(l, x, y + dy)) list.push({ l, a: [x, y], b: [x + dx, y + dy] });
	}
	if (tiles < 30) return { skipped: 'the map has almost no road' };
	return verdict(list.length === 0, `${list.length} corner-only steps in ${tiles} road tiles`, '0 (each shows as two dead ends in the game)',
		list.slice(0, 6).map(s => `L${s.l} (${s.a})-(${s.b})`), { steps: list.length, roadTiles: tiles });
}

/** A dear pile beside a town that a walker takes without a fight (Reviewer R28): outside every monster's 3x3 ring (own tile) and with an open approach tile outside every ring. */
function townLoot(M) {
	const towns = M.objs.filter(o => o.cls === 'town');
	const hi = M.objs.filter(o => o.cls === 'high' && o.type !== 'spellScroll');
	if (!towns.length || !hi.length) return { skipped: 'no towns or dear piles' };
	const ring = new Set();
	for (const m of M.monsters) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (M.inb(m.at[0] + dx, m.at[1] + dy)) ring.add(M.idx(m.l, m.at[0] + dx, m.at[1] + dy));
	const near = hi.filter(o => towns.some(t => t.l === o.l && t.cells.some(c => cheb(c, o.at) <= LIMITS.townLootR)));
	const bad = near.filter(o => !o.cells.some(([x, y]) => ring.has(M.idx(o.l, x, y))) && M.approach(o).some(i => M.ground(i) && !M.blocked[i] && !ring.has(i)));
	return verdict(bad.length === 0, `${bad.length} of ${near.length} dear piles within ${LIMITS.townLootR} tiles of a town are open to a walker`, '0 (K and Reviewer R28; by this test the engine leaves 24% of them open, 97 of 411 on its 81 sample maps with towns, so the rule is stricter than the engine)',
		bad.slice(0, 6).map(o => `${o.type} ${at(o)} beside a town, no guard ring on it and an open way in`), { open: bad.length, near: near.length });
}

/** Dear loot by zone (Reviewer R36). Start zones are playerStart or cpuStart (the sidecar's zone type; ours also carry the class player, highLoot, lowLoot, standard, town). */
function lootByZone(M) {
	const hi = M.objs.filter(o => o.cls === 'high' && o.type !== 'spellScroll');
	if (!hi.length) return { skipped: 'no dear piles' };
	if (!M.zones) return { skipped: 'no zone sidecar' };
	let side = null; try { side = JSON.parse(require('fs').readFileSync(M.zones.file, 'utf8')); } catch (e) { /* the engine's sidecar has no classes */ }
	const cls = { player: 0, highLoot: 0, lowLoot: 0, standard: 0, town: 0 }; let start = 0, none = 0, weak = 0, known = 0;
	const idx = sight.index && sight.index();
	for (const o of hi) {
		const z = M.zoneAt(o.l, o.at[0], o.at[1]), zi = M.zones.zones.get(z);
		if (zi && (zi.type === 'playerStart' || zi.type === 'cpuStart')) start++;
		const lv = side && side.levels && side.levels[o.l];
		if (lv && lv.classes) { const c = lv.classes[lv.zone[o.at[1] * M.W + o.at[0]]]; if (c in cls) cls[c]++; }
		const g = M.monsters.filter(m => m.l === o.l && cheb(m.at, o.at) <= 1);
		if (!g.length) { none++; continue; }
		const ls = g.map(m => { const c = idx && idx.creature(m.subtype); return c && c.level != null ? c.level : null; }).filter(v => v !== null);
		if (ls.length) { known++; if (Math.max(...ls) <= 2) weak++; }
	}
	const share = start / hi.length;
	return verdict(share <= LIMITS.startLootShare, `${start} of ${hi.length} dear piles in start zones (${(100 * share).toFixed(1)}%); by class highLoot ${cls.highLoot}, player ${cls.player}, lowLoot ${cls.lowLoot}, standard ${cls.standard}, town ${cls.town}; ${weak} behind level 1 or 2 guards (of ${known} with a known guard level), ${none} with no guard beside them`,
		"none: compare builds on the same map (084ac2c on K road map 2090: highLoot 28, player 20 of 58; the engine start-type zones hold 12.3% pooled on 81 sample maps, class names exist only in our sidecar)",
		[], { start, n: hi.length, share, weak, known, none, ...cls });
}

function roadEnds(M) {
	let roadTiles = 0, land = 0;
	for (let i = 0; i < M.road.length; i++) { roadTiles += M.road[i]; if (M.ground(i)) land++; }
	if (roadTiles < land / 100) return { skipped: 'the map has almost no road' };
	const ends = require('./road_ends').scan(M, LIMITS.endReach), bld = ends.filter(e => e.kind === 'building');
	return verdict(ends.length === 0, `${ends.length} road ends (${bld.length} at a small building's door with a road piece beyond, ${ends.length - bld.length} within ${LIMITS.endReach} tiles of another road piece or an unroaded town front)`, '0 (the engine leaves one on 18% of its maps)',
		ends.slice(0, 6).map(e => `road end L${e.l} (${e.x},${e.y}): ${e.d} tiles from ${e.what}`), { ends: ends.length, building: bld.length });
}

/** A gold mine a walker takes without a fight (Opus's gold_front.js: a free entrance tile outside every monster's ring; a tile holding another pile counts as blocked, K's 10-05 rule). */
function goldFront(M) {
	const ring = new Set();
	for (const m of M.monsters) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (M.inb(m.at[0] + dx, m.at[1] + dy)) ring.add(M.idx(m.l, m.at[0] + dx, m.at[1] + dy));
	const gold = M.objs.filter(q => q.cls === 'mine' && /gold/i.test(String(q.subtype || q.type)));
	if (!gold.length) return { skipped: 'no gold mines' };
	// K's rule (10-05, as approach-open): an entrance tile that holds another pile is blocked too, a walker takes the pile first and meets the next guard
	const loot = new Set();
	for (const o of M.objs) if (o.pickup || o.cls === 'bank' || o.cls === 'dwelling') for (const [x, y] of o.cells) if (M.inb(x, y)) loot.add(M.idx(o.l, x, y));
	const open = gold.filter(q => M.approach(q).filter(i => M.ground(i) && !M.blocked[i] && !loot.has(i)).some(i => !ring.has(i)));
	return verdict(open.length === 0, `${open.length} of ${gold.length} gold mines open to a walker`, '0 (the engine guards every gold mine)',
		open.slice(0, 6).map(q => `${q.subtype || q.type} ${at(q)} has a free entrance tile outside every guard ring`), { open: open.length, n: gold.length });
}

function prisonTiers(M) {
	const pr = M.objs.filter(o => o.type === 'prison');
	if (!pr.length) return { skipped: 'no prisons' };
	if (!M.zones) return { skipped: 'no zone sidecar' };
	const bad = [], tiers = {}, byZone = {};
	// guarded: a monster within 1 tile (the engine's way; the open-side test alone fails 290 of its 90000+ prisons on the 91 engine sample maps), or, Reviewer R1 10-10,
	// every tile the prison is visited from closed by rock, scenery, other loot or a guard's 3x3 ring (e0cfc5c seed 902, 500000 prison L1 (19,34), stacks 2 tiles off)
	const ring = new Set(), loot = new Map();
	for (const m of M.monsters) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (M.inb(m.at[0] + dx, m.at[1] + dy)) ring.add(M.idx(m.l, m.at[0] + dx, m.at[1] + dy));
	for (const o of M.objs) if (o.pickup || o.cls === 'bank' || o.cls === 'dwelling') for (const [x, y] of o.cells) if (M.inb(x, y)) loot.set(M.idx(o.l, x, y), o);
	const openWay = o => M.approach(o).some(i => M.ground(i) && !M.blocked[i] && !ring.has(i) && (!loot.has(i) || loot.get(i) === o));
	for (const o of pr) {
		const exp = (o.options && o.options.experience) || 0, z = M.zones.zones.get(M.zoneAt(o.l, o.at[0], o.at[1])), zt = z ? z.type : '?';
		tiers[exp] = (tiers[exp] || 0) + 1;
		const row = byZone[zt] || (byZone[zt] = {}); row[exp] = (row[exp] || 0) + 1;
		if (exp < 90000) continue;
		const poor = /start|town|player/i.test(zt || '') || (z && z.townType !== undefined && z.townType !== null && /start/i.test(zt || ''));
		const guarded = M.monsters.some(m => m.l === o.l && cheb(m.at, o.at) <= 1) || (M.approach(o).length > 0 && !openWay(o));
		if (poor) bad.push(`prison of ${exp} experience ${at(o)} in a ${zt} zone`);
		else if (!guarded) bad.push(`prison of ${exp} experience ${at(o)} has no monster beside it and an open way in (an entrance tile outside rock, loot and every guard ring)`);
	}
	return verdict(bad.length === 0, `${bad.length} of ${pr.length} prisons wrong; tiers ${JSON.stringify(tiers)}`, 'none of 90000+ in a start or town zone, all guarded', bad, { byZone, tiers });
}

function edgeObjects(M) {
	const bad = [], other = { top: 0, left: 0 };
	for (const o of M.objs) {
		if (!o.template || !o.template.mask || o.cls === 'monster') continue;
		const h = o.template.mask.length, w = Math.max(...o.template.mask.map(r => r.length));
		const t = o.y - (h - 1) < 0, lf = o.x - (w - 1) < 0;
		if (!t && !lf) continue;
		if (o.visitable) bad.push(`${o.type}:${o.subtype} (${o.x},${o.y}) L${o.l} is ${w}x${h}: ${t ? 'crosses the top edge' : ''}${t && lf ? ', ' : ''}${lf ? 'crosses the left edge' : ''}`);
		else { if (t) other.top++; if (lf) other.left++; }
	}
	return verdict(bad.length === 0, `${bad.length} visited objects over the top or left edge (scenery over: ${other.top} top, ${other.left} left, shown)`, '0', bad);
}

function freeStanding(M) {
	const stacks = M.monsters;
	if (stacks.length < LIMITS.minStacks) return { skipped: `fewer than ${LIMITS.minStacks} stacks` };
	const ring = new Map();
	for (const m of stacks) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
		if (!M.inb(m.at[0] + dx, m.at[1] + dy)) continue;
		const i = M.idx(m.l, m.at[0] + dx, m.at[1] + dy);
		if (!ring.has(i)) ring.set(i, []);
		ring.get(i).push(m);
	}
	const monAt = new Set(stacks.map(m => M.idx(m.l, m.at[0], m.at[1])));
	const lootAt = new Set();
	for (const o of M.objs) if (o.pickup) for (const [x, y] of o.cells) lootAt.add(M.idx(o.l, x, y));
	const DEAR = /^(randomArtifactRelic|randomArtifactMajor|artifact|pandoraBox)$/;
	const need = new Map(stacks.map(m => [m, 0]));
	for (const o of M.objs.filter(o => o.visitable && (o.pickup || ['dwelling', 'bank', 'mine', 'gate', 'monolith'].includes(o.cls)))) {
		const own = new Set(o.cells.map(([x, y]) => M.idx(o.l, x, y)));
		const flyer = DEAR.test(o.type) || (o.type === 'prison' && o.options && o.options.experience >= 90000);
		const beside = stacks.filter(m => m.l === o.l && cheb(m.at, o.at) <= 1);
		let open = false;
		const sole = new Set();
		for (const i of M.approach(o).filter(i => !own.has(i))) {
			if (!M.ground(i) || (M.blocked[i] && !monAt.has(i)) || lootAt.has(i)) continue;
			const r = ring.get(i) || [];
			if (!r.length) { open = true; break; }
			if (r.length === 1) sole.add(r[0]);
		}
		if (open || (flyer && !beside.length)) continue;
		for (const m of sole) need.set(m, need.get(m) + 1);
		if (flyer && beside.length === 1) need.set(beside[0], need.get(beside[0]) + 1);
	}
	const idle = [];
	for (const m of stacks) {
		if (need.get(m) > 0) continue;
		const z0 = M.zoneAt(m.l, m.at[0], m.at[1]);
		let pass = false;
		for (let dy = -1; dy <= 1 && !pass; dy++) for (let dx = -1; dx <= 1; dx++) {
			if (!M.inb(m.at[0] + dx, m.at[1] + dy)) continue;
			const z = M.zoneAt(m.l, m.at[0] + dx, m.at[1] + dy);
			if (z !== undefined && z !== null && z >= 0 && z0 !== undefined && z !== z0) { pass = true; break; }
		}
		if (!pass) idle.push(m);
	}
	const share = idle.length / stacks.length;
	return verdict(share <= LIMITS.ineffective, `${idle.length} of ${stacks.length} stacks close nothing (${(100 * share).toFixed(1)}%)`, `<= ${100 * LIMITS.ineffective}% (the engine's own maps, 69 of the 91 sample with 30+ stacks: pooled 4.9%, per map median 5.2%, 90th percentile 12.9%, highest 20.6%; 5% a map fails half of them, read the pooled share)`,
		idle.slice(0, 6).map(m => `${m.subtype} stack ${at(m)} closes no object's access and no zone passage`), { idle: share, n: stacks.length });
}

function riverEnds(M) {
	let tiles = 0, openEnds = 0, under = 0;
	const bad = [];
	for (let l = 0; l < M.NL; l++) {
		const W = M.W, H = M.H, river = new Uint8Array(W * H);
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (sight.tileLayers(M.levels[l].rows[y][x]).some(c => RIVERS.has(c))) { river[y * W + x] = 1; tiles++; }
		const objAt = new Uint8Array(W * H);
		for (const o of M.objs) if (o.l === l && o.cls !== 'monster') for (const [x, y] of o.cells) if (o.visitable || o.pickup) objAt[y * W + x] = 1;
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			const c = y * W + x;
			if (!river[c]) continue;
			if (objAt[c]) { under++; if (bad.length < 8) bad.push(`river under a visited object or pickup at L${l} (${x},${y})`); }
			let nb = 0;
			for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (M.inb(x + dx, y + dy) && river[(y + dy) * W + x + dx]) nb++;
			if (nb > 1) continue;
			const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1;
			let wet = false;
			for (let dy = -1; dy <= 1 && !wet; dy++) for (let dx = -1; dx <= 1; dx++) if (M.inb(x + dx, y + dy) && WET.has(M.terr[M.idx(l, x + dx, y + dy)])) { wet = true; break; }
			if (!edge && !wet) { openEnds++; if (bad.length < 8) bad.push(`river ends in the open at L${l} (${x},${y})`); }
		}
	}
	if (!tiles) return { skipped: 'no rivers' };
	return verdict(openEnds <= LIMITS.riverOpen && under <= LIMITS.riverUnder, `${tiles} river tiles, ${openEnds} ends in the open, ${under} under visited objects`, '0 and 0', bad);
}

/**
 * Water (lead's order 2026-10-10 19:5x, K's Mediterranean complaint): the water share of the surface against the share asked (the sidecar's bio.waterCoverage),
 * the land share of every zone (a zone under 45% land is named), a zone drowned (under 5% land or under 40 land tiles) or cut off (its land lies in no piece a start reaches on foot),
 * the shape the water makes against the layout asked (bio.waterShape: 3 Mediterranean wants a sea in the middle, 2 Continental a ring, 1 Coastal strips on one or two sides),
 * and whether every start walks to another town and to a mine over land (shapes 5 Islands and 6 Archipelago need boats and are reported, not failed).
 * Pass needs none of those to fail; the numbers are in nums for the tables.
 */
function waterReport(M) {
	const { W, H } = M, N = W * H;
	const isW = i => WET.has(M.terr[i]);
	let nw = 0;
	for (let i = 0; i < N; i++) if (isW(i)) nw++;
	let opts = {};
	try { if (M.zones && M.zones.file) opts = JSON.parse(require('fs').readFileSync(M.zones.file, 'utf8')).options || {}; } catch (e) { opts = {}; }
	const asked = opts['bio.waterCoverage'] !== undefined ? Number(opts['bio.waterCoverage']) : null;
	const shapeId = opts['bio.waterShape'] !== undefined ? Math.round(Number(opts['bio.waterShape'])) : null;
	const content = opts['bio.waterContent'] !== undefined ? Math.round(Number(opts['bio.waterContent'])) : null;
	const share = nw / N;
	if (!nw && (asked === null || asked <= 0)) return { skipped: 'dry map' };
	const SHAPES = ['lakes', 'coastal', 'continental', 'mediterranean', 'highland', 'islands', 'archipelago', 'random', 'template'];
	const items = [], nums = { share, asked, shape: shapeId === null ? null : SHAPES[shapeId], content };
	const boats = shapeId === 5 || shapeId === 6 || content === 2;

	// the share against the share asked (a template's own water, shape 8, and an unknown ask are reported only)
	if (asked !== null && asked > 0 && shapeId !== 8 && Math.abs(share - asked) > LIMITS.waterTol) items.push(`water ${(100 * share).toFixed(1)}% of the surface against ${(100 * asked).toFixed(0)}% asked`);

	// land share of each zone on the surface
	const zl = new Map();
	if (M.zones && M.zones.zoneOf) {
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			const z = M.zoneAt(0, x, y);
			if (z === undefined || z === null || z < 0) continue;
			const r = zl.get(z) || { land: 0, water: 0 };
			if (isW(M.idx(0, x, y))) r.water++; else r.land++;
			zl.set(z, r);
		}
	}
	const low = [], drowned = [];
	for (const [z, r] of [...zl].sort((a, b) => a[0] - b[0])) {
		const t = r.land + r.water, sh = r.land / t, zt = (M.zones.zones.get(z) || {}).type || '?';
		if (r.water === 0) continue;
		if (r.land < 40 || sh < 0.05) drowned.push(`zone ${z} (${zt}): ${r.land} land tiles of ${t}`);
		else if (sh < LIMITS.waterLandMin) low.push(`zone ${z} (${zt}): ${(100 * sh).toFixed(1)}% land (${r.land} of ${t})`);
	}
	nums.zoneLand = Object.fromEntries([...zl].map(([z, r]) => [z, +(r.land / (r.land + r.water)).toFixed(3)]));
	nums.lowZones = low.length; nums.drownedZones = drowned.length;
	for (const s of drowned) items.push(`drowned ${s}`);
	for (const s of low) items.push(`under ${100 * LIMITS.waterLandMin}% land: ${s}`);

	// walking over land from each start: other towns, mines, and the zones whose land lies in a piece no start reaches
	const soft = new Set();
	for (const o of M.objs) {
		if (o.l !== 0) continue;
		if (o.cls === 'monster') soft.add(M.idx(0, o.at[0], o.at[1]));
		else if (o.pickup) for (const [x, y] of (o.cells || [])) if (M.inb(x, y)) soft.add(M.idx(0, x, y));
	}
	// over land only (a boat is the way over water) and with water passable (what dwelling-reach walks): a zone reached the second way only is cut off by water,
	// one reached neither way is walled in by scenery
	const passLand = i => M.ground(i) && !isW(i) && (!M.blocked[i] || soft.has(i));
	const passAll = i => (M.ground(i) || isW(i)) && (!M.blocked[i] || soft.has(i));
	const starts = startTowns(M).filter(o => o.l === 0);
	const towns = M.objs.filter(o => o.cls === 'town' && o.l === 0), mines = M.objs.filter(o => o.cls === 'mine' && o.l === 0);
	// monoliths of one colour (and the gates) join places on the level as the dwelling-reach walk takes them
	const portals = M.objs.filter(o => o.l === 0 && (o.cls === 'gate' || o.cls === 'monolith'));
	const flood = (s, pass) => {
		const seen = new Uint8Array(N), q = [], used = new Set();
		const seed = i => { if (pass(i) && !seen[i]) { seen[i] = 1; q.push(i); } };
		M.approach(s).forEach(seed);
		for (;;) {
			for (let h = 0; h < q.length; h++) {
				const c = q[h], x = c % W, y = (c / W) | 0;
				for (const [dx, dy] of N8) if (M.inb(x + dx, y + dy)) seed(M.idx(0, x + dx, y + dy));
			}
			q.length = 0;
			let grew = false;
			for (const p of portals) {
				if (used.has(p) || !M.approach(p).some(i => seen[i])) continue;
				used.add(p); grew = true;
				for (const o of portals) if (o.type === p.type && o.subtype === p.subtype) M.approach(o).forEach(seed);
				if (p.cls === 'gate') for (const o of portals) if (o.cls === 'gate') M.approach(o).forEach(seed);
			}
			if (!grew && !q.length) break;
		}
		return seen;
	};
	const reachSets = [], reachAll = [];
	const startFail = [];
	for (const s of starts) {
		const seen = flood(s, passLand);
		reachSets.push(seen); reachAll.push(flood(s, passAll));
		const hits = list => list.filter(o => o !== s && M.approach(o).some(i => seen[i]));
		const t = hits(towns), m = hits(mines);
		if (!t.length || !m.length) startFail.push(`start ${at(s)} reaches ${t.length ? '' : 'no other town'}${!t.length && !m.length ? ' and ' : ''}${m.length ? '' : 'no mine'} on foot`);
	}
	nums.starts = starts.length; nums.startsStranded = startFail.length;
	if (!boats) for (const s of startFail) items.push(s);
	const reached = i => reachSets.some(r => r[i]);
	const reachedAll = i => reachAll.some(r => r[i]);
	const cut = [], walled = [];
	if (!boats && starts.length) {
		for (const [z, r] of [...zl].sort((a, b) => a[0] - b[0])) {
			if (r.land < 40 || r.land / (r.land + r.water) < 0.05) continue;
			let land = 0, ok = 0, okAll = 0;
			for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
				if (M.zoneAt(0, x, y) !== z) continue;
				const i = M.idx(0, x, y);
				if (!passLand(i)) continue;
				land++; if (reached(i)) ok++; if (reachedAll(i)) okAll++;
			}
			const nm = `zone ${z} (${(M.zones.zones.get(z) || {}).type || '?'})`;
			if (land >= 40 && ok < 0.5 * land) { if (okAll >= 0.5 * land) cut.push(`${nm}: ${ok} of ${land} walkable land tiles reachable from a start on foot, ${okAll} with the water crossed`); else walled.push(`${nm}: ${okAll} of ${land} walkable tiles reachable even across water`); }
		}
	}
	nums.cutZones = cut.length; nums.walledZones = walled.length;
	for (const s of cut) items.push(`cut off by water: ${s}`);

	// the shape of the water: bands along the four edges, the middle box, the largest body
	const bw = Math.max(4, Math.round(0.12 * Math.min(W, H)));
	const sides = [[0, 0, W, bw], [0, H - bw, W, bw], [0, 0, bw, H], [W - bw, 0, bw, H]];
	const frac = ([x0, y0, w, h]) => { let n = 0; for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (isW(M.idx(0, x, y))) n++; return n / (w * h); };
	const side = sides.map(frac);
	const mid = frac([Math.round(W / 4), Math.round(H / 4), Math.round(W / 2), Math.round(H / 2)]);
	const seenW = new Uint8Array(N); let big = 0, bigCx = 0, bigCy = 0, bigSeed = -1;
	for (let s = 0; s < N; s++) {
		if (!isW(s) || seenW[s]) continue;
		const st = [s]; seenW[s] = 1; let n = 0, sx = 0, sy = 0;
		while (st.length) {
			const c = st.pop(); n++; const x = c % W, y = (c / W) | 0; sx += x; sy += y;
			for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const u = x + dx, v = y + dy; if (!M.inb(u, v)) continue; const k = M.idx(0, u, v); if (isW(k) && !seenW[k]) { seenW[k] = 1; st.push(k); } }
		}
		if (n > big) { big = n; bigCx = sx / n; bigCy = sy / n; bigSeed = s; }
	}
	const bigShare = nw ? big / nw : 0;
	// the largest body against a Mediterranean (lead 10-11, K: "a sea in the middle with land around the shore"): how central its centre of mass is (distance from the
	// map centre as a share of the half side), the share of the map it covers, the land in a 3-tile band along its shore, and how many of 16 rays from its centre meet land
	// (not the map edge) right after leaving the body
	const inBody = new Uint8Array(N);
	if (bigSeed >= 0) { const st = [bigSeed]; inBody[bigSeed] = 1; while (st.length) { const c = st.pop(), x = c % W, y = (c / W) | 0; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const u = x + dx, v = y + dy; if (!M.inb(u, v)) continue; const k = M.idx(0, u, v); if (isW(k) && !inBody[k]) { inBody[k] = 1; st.push(k); } } } }
	let ring = 0, ringLand = 0;
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
		const i = M.idx(0, x, y); if (inBody[i]) continue;
		let near = false;
		for (let dy = -3; dy <= 3 && !near; dy++) for (let dx = -3; dx <= 3; dx++) { if (M.inb(x + dx, y + dy) && inBody[M.idx(0, x + dx, y + dy)]) { near = true; break; } }
		if (!near) continue;
		ring++; if (!isW(i)) ringLand++;
	}
	let raysLand = 0, raysEdge = 0, raysWater = 0;
	if (bigSeed >= 0) for (let k = 0; k < 16; k++) {
		const a = (k / 16) * 2 * Math.PI, ux = Math.cos(a), uy = Math.sin(a);
		let t = 0, out = false, hit = null;
		for (; t < 2 * Math.max(W, H); t += 0.5) {
			const x = Math.round(bigCx + ux * t), y = Math.round(bigCy + uy * t);
			if (!M.inb(x, y)) { hit = 'edge'; break; }
			const i = M.idx(0, x, y), inb = inBody[i];
			if (!out) { if (!inb) out = true; else continue; }
			if (!isW(i)) { hit = 'land'; break; }
			if (!inb && isW(i)) { hit = 'water'; break; }
		}
		if (hit === 'land') raysLand++; else if (hit === 'water') raysWater++; else raysEdge++;
	}
	const bodyShareOfMap = big / N, centDist = Math.hypot((bigCx - W / 2) / (W / 2), (bigCy - H / 2) / (H / 2));
	const centred = Math.abs(bigCx - W / 2) < 0.15 * W && Math.abs(bigCy - H / 2) < 0.15 * H;
	const edgeSides = side.filter(v => v >= 0.35).length;
	let label;
	if (!nw) label = 'none';
	else if (bigShare >= 0.6 && centred && mid >= 1.2 * share && mid >= 0.3) label = 'sea in the middle';
	else if (edgeSides === 4) label = 'ring';
	else if (edgeSides >= 1) label = `edge strips (${edgeSides} side${edgeSides > 1 ? 's' : ''})`;
	else if (bigShare < 0.5) label = 'scattered lakes';
	else label = 'one body off centre';
	Object.assign(nums, { shapeSeen: label, mid, side, bigShare, bigAt: [Math.round(bigCx), Math.round(bigCy)], bodyShareOfMap, centDist, ringLand: ring ? ringLand / ring : null, raysLand, raysEdge, raysWater });

	return verdict(items.length === 0,
		`water ${(100 * share).toFixed(1)}% (asked ${asked === null ? '?' : (100 * asked).toFixed(0) + '%'}), shape: ${label}, zones under ${100 * LIMITS.waterLandMin}% land: ${low.length}, drowned: ${drowned.length}, cut off by water: ${cut.length} (walled in by scenery: ${walled.length}), starts stranded: ${startFail.length} of ${starts.length}${boats ? ' (boats needed)' : ''}`,
		`within ${100 * LIMITS.waterTol} points of the share asked, every zone 45% land or more, none drowned or cut off, the layout asked, every start walks to a town and a mine`, items, nums);
}

/**
 * The water against the AoE map type the waterShape lever stands for (Research\AoE-map-types, thresholds are proposals): 1 coastal, 2 continental, 3 mediterranean,
 * 4 highland, 5 islands, 6 archipelago. Always reports the measures; the verdict names which of the type's measures the map misses. Shapes 0, 7 and 8 (lakes, random, the
 * template's own water) have no AoE reference and are reported without a verdict.
 */
function waterType(M) {
	const { W, H } = M, N = W * H, isW = i => WET.has(M.terr[i]);
	let opts = {};
	try { if (M.zones && M.zones.file) opts = JSON.parse(require('fs').readFileSync(M.zones.file, 'utf8')).options || {}; } catch (e) { opts = {}; }
	const shapeId = opts['bio.waterShape'] !== undefined ? Math.round(Number(opts['bio.waterShape'])) : null;
	const players = Number(opts.players) || 0;
	let nw = 0; for (let i = 0; i < N; i++) if (isW(i)) nw++;
	if (!nw) return { skipped: 'dry map' };
	const share = nw / N;
	// water bodies (4-connected) and land pieces (8-connected) on the surface
	const comp = (pred, nb) => { const id = new Int32Array(N).fill(-1), sizes = [], cx = [], cy = []; for (let s0 = 0; s0 < N; s0++) { if (id[s0] >= 0 || !pred(s0)) continue; const k = sizes.length; let n = 0, sx = 0, sy = 0; const st = [s0]; id[s0] = k; while (st.length) { const c = st.pop(); n++; const x = c % W, y = (c / W) | 0; sx += x; sy += y; for (const [dx, dy] of nb) { const u = x + dx, v = y + dy; if (!M.inb(u, v)) continue; const j = M.idx(0, u, v); if (id[j] < 0 && pred(j)) { id[j] = k; st.push(j); } } } sizes.push(n); cx.push(sx / n); cy.push(sy / n); } return { id, sizes, cx, cy }; };
	const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
	const wb = comp(isW, N4), lp = comp(i => !isW(i) && (M.ground(i) || M.blocked[i]), N8);
	const order = wb.sizes.map((n, k) => [n, k]).sort((a, b) => b[0] - a[0]);
	const big = order.length ? order[0][1] : -1, bigN = order.length ? order[0][0] : 0, second = order.length > 1 ? order[1][0] : 0;
	const centDist = big >= 0 ? Math.hypot((wb.cx[big] - W / 2) / (W / 2), (wb.cy[big] - H / 2) / (H / 2)) : 1;
	let raysLand = 0;
	if (big >= 0) for (let k = 0; k < 16; k++) { const a = (k / 16) * 2 * Math.PI, ux = Math.cos(a), uy = Math.sin(a); let out = false, hit = 'edge'; for (let t = 0; t < 2 * Math.max(W, H); t += 0.5) { const x = Math.round(wb.cx[big] + ux * t), y = Math.round(wb.cy[big] + uy * t); if (!M.inb(x, y)) break; const i = M.idx(0, x, y), inb = wb.id[i] === big; if (!out) { if (!inb) out = true; else continue; } if (!isW(i)) { hit = 'land'; break; } if (!inb) { hit = 'water'; break; } } if (hit === 'land') raysLand++; }
	const bw = Math.max(4, Math.round(0.12 * Math.min(W, H)));
	const band = ([x0, y0, w, h]) => { let n = 0; for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (isW(M.idx(0, x, y))) n++; return n / (w * h); };
	const sides = [band([0, 0, W, bw]), band([0, H - bw, W, bw]), band([0, 0, bw, H]), band([W - bw, 0, bw, H])];
	const landTotal = lp.sizes.reduce((a, b) => a + b, 0) || 1;
	const lorder = lp.sizes.slice().sort((a, b) => b - a);
	const landBig = (lorder[0] || 0) / landTotal;
	const pieces = f => lp.sizes.filter(n => n >= f * N).length;
	const m = { waterShare: share, bigBodyShare: bigN / N, centDist, raysLand, sides, sidesMin: Math.min(...sides), sidesMax: Math.max(...sides), sidesOver35: sides.filter(v => v >= 0.35).length, sidesOver50: sides.filter(v => v >= 0.5).length, secondOverBig: bigN ? second / bigN : 0, landBig, pieces2: pieces(0.02), pieces1: pieces(0.01) };
	const miss = [], T = { 1: 'coastal', 2: 'continental', 3: 'mediterranean', 4: 'highland', 5: 'islands', 6: 'archipelago' }[shapeId];
	const need = (ok, text) => { if (!ok) miss.push(text); };
	const pc = x => (100 * x).toFixed(0) + '%';
	if (shapeId === 3) {
		need(m.bigBodyShare >= 0.15, `largest water body ${pc(m.bigBodyShare)} of the map, 15% or more wanted`);
		need(m.centDist <= 0.2, `its centre is ${m.centDist.toFixed(2)} from the map centre, 0.20 or less wanted`);
		need(m.raysLand === 16, `land on ${m.raysLand} of 16 rays from its centre, 16 wanted`);
		need(m.sidesMax < 0.05, `water in the outer band up to ${pc(m.sidesMax)}, under 5% on every side wanted`);
		need(m.landBig >= 0.9, `largest land piece ${pc(m.landBig)} of the land, 90% or more wanted (one land ring)`);
		need(m.secondOverBig <= 0.33, `a second water body ${pc(m.secondOverBig)} of the sea, a third or less wanted`);
	} else if (shapeId === 5) {
		need(m.pieces2 >= players, `${m.pieces2} land pieces of 2% or more for ${players} players, one each wanted`);
		need(m.sidesMin >= 0.5, `the sea reaches the outer band only to ${pc(m.sidesMin)} on one side, 50% or more on all four wanted`);
	} else if (shapeId === 6) {
		need(m.pieces1 >= 4, `${m.pieces1} land pieces of 1% or more, 4 or more wanted`);
		need(lorder[0] / landTotal <= 0.4, `largest piece ${pc(landBig)} of the land, 40% or less wanted`);
		need(m.sidesMin >= 0.35, `the sea reaches the outer band only to ${pc(m.sidesMin)} on one side, 35% or more on all four wanted`);
	} else if (shapeId === 2) {
		need(m.landBig >= 0.9, `largest land piece ${pc(m.landBig)} of the land, 90% or more wanted`);
		need(m.sidesOver35 === 4, `ocean in the outer band on ${m.sidesOver35} of 4 sides at 35% or more, all four wanted`);
	} else if (shapeId === 1) {
		need(m.landBig >= 0.8, `largest land piece ${pc(m.landBig)} of the land, 80% or more wanted`);
		need(m.sidesOver35 >= 2, `sea in the outer band on ${m.sidesOver35} sides at 35% or more, 2 or more wanted`);
	} else if (shapeId === 4) {
		need(m.bigBodyShare < 0.05, `largest water body ${pc(m.bigBodyShare)} of the map, under 5% wanted (no sea)`);
		need(m.landBig >= 0.95, `largest land piece ${pc(m.landBig)} of the land, 95% or more wanted`);
		need(m.sidesMax < 0.05, `water in the outer band up to ${pc(m.sidesMax)}, under 5% on every side wanted`);
	} else {
		return { pass: true, value: `shape ${shapeId === null ? '?' : shapeId}: no AoE reference, measures only (water ${pc(share)}, largest body ${pc(m.bigBodyShare)}, centre ${centDist.toFixed(2)}, largest land piece ${pc(m.landBig)})`, limit: 'no reference', items: [], nums: m };
	}
	return verdict(miss.length === 0, `${T}: water ${pc(share)}, largest body ${pc(m.bigBodyShare)} at ${centDist.toFixed(2)} from the middle, rays on land ${raysLand}/16, sides ${sides.map(pc).join('/')}, largest land piece ${pc(landBig)}, pieces ${m.pieces2} (2%) ${m.pieces1} (1%)`, `the AoE ${T} measures (Research\\AoE-map-types\\${T}.md; thresholds proposed)`, miss, m);
}

/** ---- 2026-10-13 checks (lead's order, brief Tuesday): entrance pictures over approach tiles, lone road pieces, land objects on water, prison hero against its level ---- */

/** An entrance object: a monolith end, a gate, a portal or whirlpool-like object a hero steps onto to be moved. */
const entranceObj = o => o.cls === 'monolith' || o.cls === 'gate' || /monolith|subterraneanGate|portal|dimensionDoor/i.test(String(o.type));

/** Every tile the object's picture stands on: each visible mask cell (V, B, A), the passable V ones too. [x, y] pairs. */
function pictureCells(o) {
	const m = (o.template && o.template.mask) || [], out = [];
	for (let i = 0; i < m.length; i++) for (let j = 0; j < m[i].length; j++) if (/[VBA]/.test(m[i][j])) out.push([o.x - (m[i].length - 1 - j), o.y - (m.length - 1 - i)]);
	return out;
}

const nameOf = o => `${o.type}${o.subtype && o.subtype !== o.type ? ':' + o.subtype : ''}`;

/**
 * K 10-11 "two-way monolith blocking nearby gem pond": a monolith's picture (its passable V cells included) lies on the entrance of the pond, so the pond
 * cannot be entered and cannot be seen. Lead 10-13: a monolith and any entrance object counts as a blocker when the approaches to a pile are counted.
 * For every pile (dear or cheap), dwelling, mine, bank and prison: the approach tiles an entrance object's picture covers, and its own cells under one.
 */
function approachShadow(M) {
	const shadow = new Map();
	for (const e of M.objs.filter(entranceObj)) for (const [x, y] of pictureCells(e)) if (M.inb(x, y)) shadow.set(M.idx(e.l, x, y), e);
	if (!shadow.size) return { skipped: 'no entrance objects' };
	const targets = M.objs.filter(o => !entranceObj(o) && (o.pickup || ['dwelling', 'mine', 'bank'].includes(o.cls)));
	const bad = [];
	let lostTiles = 0, partial = 0;
	for (const o of targets) {
		const ap = M.approach(o).filter(i => M.ground(i) && !M.blocked[i]);
		const lost = ap.filter(i => shadow.has(i) && shadow.get(i) !== o);
		const own = pictureCells(o).filter(([x, y]) => M.inb(x, y) && shadow.has(M.idx(o.l, x, y)) && shadow.get(M.idx(o.l, x, y)) !== o);
		lostTiles += lost.length;
		if (lost.length) partial++;
		// failing: every open way in lies under the picture, or the picture covers the object's own cells (K's pond); a picture over some of several approach tiles is a count
		if (!(lost.length && ap.length === lost.length) && !own.length) continue;
		const e = shadow.get(lost.length ? lost[0] : M.idx(o.l, own[0][0], own[0][1]));
		bad.push(`${nameOf(o)} ${at(o)}: ${lost.length} of ${M.approach(o).length} approach tiles and ${own.length} of its ${pictureCells(o).length} picture cells under ${e.type} ${at(e)}; ${ap.length - lost.length} open approach tiles left`);
	}
	return verdict(bad.length === 0, `${bad.length} of ${targets.length} piles, dwellings, mines and banks lose every open approach tile to an entrance object's picture or have it on their own cells; ${partial} more lose some approach tiles (${lostTiles} in all)`, '0 (K 10-11: a monolith standing on the gem pond; the engine leaves it on 18 of its 91 sample maps and shuts 3 objects, 141 more lose a tile)', bad.slice(0, 8), { bad: bad.length, targets: targets.length, lostTiles, partial });
}

/**
 * K 10-11 "lots of incorrect road terminations": a lone road piece (an 8-connected road of fewer than stubMax tiles) that joins fewer than two places (a visiting
 * tile or entrance of a town, mine, dwelling, bank, gate, monolith or any visitable building) and no map edge. Each shows as a road that starts or ends in
 * the open or leads nowhere (K 10-11: a 3 tile road to a monolith from nowhere). sight.roadEnds judges ends, not whole pieces: its 'at nothing' needs a junction or turn 2 tiles back and its 'proper' accepts any visitable object.
 */
function roadStubs(M) {
	let roadTiles = 0, land = 0;
	for (let i = 0; i < M.road.length; i++) { roadTiles += M.road[i]; if (M.ground(i)) land++; }
	if (roadTiles < land / 100) return { skipped: 'the map has almost no road' };
	const dest = new Map();
	for (const o of M.objs) {
		if (!o.visitable || o.pickup || o.cls === 'monster') continue;      // a road that ends at loot or a stack joins nothing
		for (const i of [...M.approach(o).filter(k => M.ground(k) && !M.blocked[k]), ...o.entr.map(([x, y]) => M.idx(o.l, x, y))]) { if (!dest.has(i)) dest.set(i, new Set()); dest.get(i).add(o); }   // a shut approach tile (rock, another object) is no way in
	}
	const { W, H } = M, comp = new Int32Array(M.NL * W * H).fill(-1), tiles = [];
	for (let s = 0; s < comp.length; s++) {
		if (!M.road[s] || comp[s] >= 0) continue;
		const id = tiles.length, mine = [s], st = [s]; comp[s] = id;
		while (st.length) {
			const c = st.pop(), l = Math.floor(c / (W * H)), x = c % W, y = Math.floor(c / W) % H;
			for (const [dx, dy] of N8) { if (!M.inb(x + dx, y + dy)) continue; const k = M.idx(l, x + dx, y + dy); if (M.road[k] && comp[k] < 0) { comp[k] = id; st.push(k); mine.push(k); } }
		}
		tiles.push(mine);
	}
	const bad = [];
	for (const t of tiles) {
		if (t.length >= LIMITS.stubMax) continue;
		const objs = new Set();
		let edge = false;
		for (const c of t) {
			const l = Math.floor(c / (W * H)), x = c % W, y = Math.floor(c / W) % H;
			if (x === 0 || y === 0 || x === W - 1 || y === H - 1) edge = true;
			for (const o of dest.get(c) || []) objs.add(o);                      // a road tile on a visiting or entrance tile
		}
		// a road joins two places: a short piece that touches fewer than two visitable objects (and no map edge) goes nowhere
		if (objs.size >= 2 || edge) continue;
		const c0 = t[0], one = [...objs][0];
		bad.push(`road piece of ${t.length} tiles at L${Math.floor(c0 / (W * H))} (${c0 % W},${Math.floor(c0 / W) % H}) ${one ? `reaches only ${nameOf(one)} ${at(one)}` : "touches no visiting tile"}`);
	}
	return verdict(bad.length === 0, `${bad.length} lone road pieces under ${LIMITS.stubMax} tiles that join fewer than two places (${tiles.length} road pieces in all)`, '0 (K 10-11 road terminations)', bad.slice(0, 8), { stubs: bad.length, pieces: tiles.length });
}

/** Objects made for the water (the generator's H3_WATER and the mods' sea objects): they stand on water and nowhere else. */
const WATER_NATIVE = /^(flotsam|seaChest|shipwreckSurvivor|buoy|oceanBottle|starBottle|shipwreck|derelictShip|sirens?|mermaids?|magellansMaps|whirlpool|boat|jetsam|kelp|reef|vialOfMana)$|^sea|ocean|jetsam|coral/i;   // observatory and starBottle (mod objects) are not listed: not shown to be water-only, so they are judged as neither
const WATER_UNSURE = /^(observatory|starBottle)$/;   // a shipyard, a watering place, a shrine and an altar are land: the shipyard stands on the shore

/**
 * K 10-12 Mediterranean XL "loot and structures on the water": an object that needs land (a pile, mine, dwelling, bank, town, prison or any building) with a
 * blocked or visiting cell on a water tile, and a water-made object (flotsam, sea chest, shipwreck, ...) on land. Pictures hanging over water by their passable
 * V cells are counted apart (a note, no failure).
 */
function waterObjects(M) {
	const wet = i => WET.has(M.terr[i]);
	let anyWater = false;
	for (let i = 0; i < M.terr.length && !anyWater; i++) if (wet(i)) anyWater = true;
	if (!anyWater) return { skipped: 'no water' };
	// a template that names only water (the asset index: HotA's water shrine and observation tower stand on water, their land twins do not) is water-made whatever its type
	const IDX = sight.index(), waterTemplate = o => { if (!IDX) return false; const s = IDX.anims.get(IDX.art(o.template && o.template.animation)); return !!s && s.size > 0 && [...s].every(n => n === 'water'); };
	const onWater = [], onLand = [];
	let hang = 0, checked = 0;
	for (const o of M.objs) {
		if (o.cls === 'monster' || WATER_UNSURE.test(String(o.type))) continue;
		const native = WATER_NATIVE.test(String(o.type)) || WATER_NATIVE.test(String(o.subtype || '')) || waterTemplate(o);
		const cells = o.cells.filter(([x, y]) => M.inb(x, y)).map(([x, y]) => M.idx(o.l, x, y));
		if (!cells.length) continue;
		const real = o.pickup || o.visitable || ['town', 'mine', 'dwelling', 'bank'].includes(o.cls);
		if (!real) continue;
		checked++;
		const wetCells = cells.filter(wet);
		const entr = o.entr.filter(([x, y]) => M.inb(x, y)).map(([x, y]) => M.idx(o.l, x, y));
		if (native) { if (cells.every(i => !wet(i)) && entr.every(i => !wet(i))) onLand.push(`${nameOf(o)} ${at(o)} is a water object on land`); continue; }
		if (wetCells.length || entr.some(wet)) onWater.push(`${nameOf(o)} ${at(o)} (${o.cls}): ${wetCells.length} of ${cells.length} cells on water${entr.some(wet) ? ', its entrance too' : ''}`);
		else if (pictureCells(o).some(([x, y]) => M.inb(x, y) && wet(M.idx(o.l, x, y)))) hang++;
	}
	const items = [...onWater, ...onLand];
	return verdict(items.length === 0, `${onWater.length} land objects with cells on water, ${onLand.length} water objects on land (of ${checked} objects looked at${IDX ? '' : '; asset index not loaded (set VCMI_ROOT and VCMI_USER_DIR): water-only templates known by type name only'}); ${hang} pictures hang over water by passable cells (note only)`, '0 (K 10-12: loot and structures on the Mediterranean XL water)', items.slice(0, 10), { onWater: onWater.length, onLand: onLand.length, hang, checked });
}


/** Objects made for the water: by type name, or by a template that names only water (the asset index). */
const CORE_WATER = /^(flotsam|seaChest|shipwreckSurvivor|buoy|oceanBottle|shipwreck|derelictShip|sirens?|mermaids?|magellansMaps|whirlpool|boat|kelp|reef)$/;   // the base game's water objects; the rest on the water is mod content
function waterMadeFn() {
	const IDX = sight.index();
	const tpl = o => { if (!IDX) return false; const s = IDX.anims.get(IDX.art(o.template && o.template.animation)); return !!s && s.size > 0 && [...s].every(n => n === 'water'); };
	return { IDX, made: o => WATER_NATIVE.test(String(o.type)) || WATER_NATIVE.test(String(o.subtype || '')) || tpl(o) };
}

/**
 * K 10-12 17:55, Mediterranean XL: "Not enough mod loot + structures on the water". Lead 10-12 17:58: count per water tile against the land zones. Objects on the
 * water (pickups: flotsam, sea chests, jetsam, barrels; sites and banks: buoys, mermaids, sirens, whirlpools, shipwrecks, derelict ships, observatories, shrines, mod
 * buildings) per 1000 water tiles, against the loot objects on land (pickups, sites, banks, dwellings, mines) per 1000 land tiles. The ratio limit is a proposal.
 */
function waterContent(M) {
	const wet = i => WET.has(M.terr[i]);
	let waterTiles = 0, landTiles = 0;
	for (let i = 0; i < M.terr.length; i++) { if (wet(i)) waterTiles++; else if (M.ground(i)) landTiles++; }
	if (waterTiles < 400) return { skipped: 'no water body' };
	const { IDX, made } = waterMadeFn();
	const sea = { pickup: 0, site: 0, mod: 0, monster: 0 }, seaTypes = {};
	let land = 0;
	for (const o of M.objs) {
		const cells = o.cells.filter(([x, y]) => M.inb(x, y)).map(([x, y]) => M.idx(o.l, x, y));
		if (!cells.length) continue;
		if (o.cls === 'monster') { if (wet(cells[0])) sea.monster++; continue; }
		const real = o.pickup || o.visitable || ['mine', 'dwelling', 'bank'].includes(o.cls);
		if (!real) continue;
		const onWater = cells.some(wet) || o.entr.some(([x, y]) => M.inb(x, y) && wet(M.idx(o.l, x, y)));
		if (made(o) || onWater) {
			if (o.pickup) sea.pickup++; else sea.site++;
			if (!CORE_WATER.test(String(o.type))) sea.mod++;
			seaTypes[nameOf(o)] = (seaTypes[nameOf(o)] || 0) + 1;
		} else land++;
	}
	const seaN = sea.pickup + sea.site, perWater = 1000 * seaN / waterTiles, perLand = 1000 * land / Math.max(1, landTiles), ratio = perLand ? perWater / perLand : 0;
	return verdict(ratio >= LIMITS.seaLootRatio, `${seaN} objects on the water (${sea.pickup} pickups, ${sea.site} sites and banks, ${sea.mod} from mods; ${sea.monster} stacks) on ${waterTiles} water tiles = ${perWater.toFixed(1)} per 1000; land ${land} objects on ${landTiles} tiles = ${perLand.toFixed(1)} per 1000; ratio sea to land ${ratio.toFixed(2)}${IDX ? '' : '; asset index not loaded: mod water objects known by type name only'}`,
		`sea to land ratio ${LIMITS.seaLootRatio} or more (a proposal: K said "not enough mod loot + structures on the water", no number set)`, Object.entries(seaTypes).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${v} x ${k}`), { seaN, pickup: sea.pickup, site: sea.site, mod: sea.mod, monsters: sea.monster, waterTiles, landTiles, perWater, perLand, ratio });
}

/** The engine's level table (CHeroHandler::loadExperience): level L needs EXP[L-1]; past 15 entries each gap is the one before plus a fifth. */
const EXP = [0, 1000, 2000, 3200, 4600, 6200, 8000, 10000, 12200, 14700, 17500, 20600, 24320, 28784, 34140];
for (let g = EXP[14] - EXP[13]; EXP.length < 80;) { g += Math.trunc(g / 5); EXP.push(EXP[EXP.length - 1] + g); }
const levelOfExp = e => { let l = 1; while (l < EXP.length && EXP[l] <= e) l++; return l; };
/** Four primary stats of a hero of level L: the class start (4 to 8 points over all classes) plus one point a level gained. */
const statRange = L => [L - 1 + 4, L - 1 + 8];

/**
 * Lead 10-13 (K 10-11, Nate's prison hero Ayden: level 30, 500000 experience, stats 1/1/2/1): a prison hero's stats must match its level. The map stores an
 * experience and, as generated, no stats; the engine must roll one primary point per level. This reads what the map stores (explicit primarySkills) and what an
 * engine run logged beside the map (MAP.prison.log, lines "Prison hero core:x: level L, experience E, attack a, defence d, power p, knowledge k", from
 * tools/harness/prison_hero.js --run), and fails a hero whose four stats sum below level - 1 + 4 or above level - 1 + 8. Secondary skills are not in the engine's line.
 */
function prisonHero(M) {
	const pr = M.objs.filter(o => o.type === 'prison');
	if (!pr.length) return { skipped: 'no prisons' };
	const fs = require('fs'), log = M.file + '.prison.log';
	const engine = new Map();
	if (fs.existsSync(log)) for (const line of fs.readFileSync(log, 'utf8').split(/\r?\n/)) {
		const m = /Prison hero (\S+): level (\d+), experience (\d+), attack (\d+), defence (\d+), power (\d+), knowledge (\d+)/.exec(line);
		if (m) engine.set(m[1], { level: +m[2], exp: +m[3], stats: [+m[4], +m[5], +m[6], +m[7]] });
	}
	const bad = [], rows = [];
	let judged = 0, unjudged = 0;
	for (const o of pr) {
		const opt = o.options || {}, exp = opt.experience || 0, L = levelOfExp(exp), name = String(opt.type || '');
		const sk = opt.primarySkills ? [opt.primarySkills.attack || 0, opt.primarySkills.defence || 0, opt.primarySkills.spellpower || 0, opt.primarySkills.knowledge || 0] : null;
		const eng = engine.get(name);
		const stats = eng ? eng.stats : sk;
		const lvl = eng ? eng.level : L;
		if (L <= 1) continue;
		if (!stats) { unjudged++; rows.push({ name, exp, level: L, stats: null }); continue; }
		judged++;
		const sum = stats.reduce((a, b) => a + b, 0), [lo, hi] = statRange(lvl);
		rows.push({ name, exp, level: lvl, stats, sum, source: eng ? 'engine log' : 'map' });
		if (sum < lo || sum > hi) bad.push(`prison hero ${name} ${at(o)}: level ${lvl} (${exp} experience), stats ${stats.join('/')} sum ${sum}, a hero of that level has ${lo} to ${hi} (${eng ? 'engine log' : 'stored in the map'})`);
	}
	if (!judged && unjudged) return { skipped: `${unjudged} prison heroes with experience and no stats in the map or an engine log (${log}); run prison_hero.js --run to read what the engine makes of them`, rows };
	return verdict(bad.length === 0, `${bad.length} of ${judged} prison heroes with a level above 1 have stats that do not match it${unjudged ? `; ${unjudged} more not judged (no stats stored, no engine log)` : ''}`, 'four stats sum to level - 1 + 4 .. 8 (K 10-11 Ayden: level 30, 1/1/2/1)', bad.slice(0, 8), { judged, unjudged, rows });
}


const CHECKS = { 'approach-shadow': approachShadow, 'road-stubs': roadStubs, 'water-objects': waterObjects, 'water-content': waterContent, 'prison-hero': prisonHero, 'water': waterReport, 'water-type': waterType, 'start-road': startRoad, 'town-spacing': townSpacing, 'road-breaks': roadBreaks, 'road-corners': roadCorners, 'town-loot': townLoot, 'loot-by-zone': lootByZone, 'road-ends': roadEnds, 'gold-front': goldFront, 'prison-tiers': prisonTiers, 'edge-objects': edgeObjects, 'free-standing': freeStanding, 'river-ends': riverEnds };
module.exports = { CHECKS, LIMITS, levelOfExp, statRange, pictureCells, entranceObj };
