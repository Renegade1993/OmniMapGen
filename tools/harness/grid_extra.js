'use strict';
/**
 * grid_extra.js - the grid checks from K's October 8th playtest (roster\QUEUE-MapGen Dev.md, K's lines of 2026-10-07 and 2026-10-08), merged into
 * playtest_checks.js (node tools/harness/playtest_checks.js MAP|DIR --only start-road,town-spacing,...). The measures are Opus Map Vision's where he
 * wrote them first (edge_objects.js, rivers.js, prison_tiers.js, stack_effect.js, sight.roadEnds); here they return a PASS or FAIL with a limit.
 *
 *   start-road       every start town has a road on its front or entrance tile, joined to a road of at least 8 tiles [K 10-08 15:5x islands start]
 *   town-spacing     two towns closer than 15 walking tiles are the extreme exception; never two starts, never a start and a neutral [K 10-08 15:0x]
 *   road-breaks      a gap of 1 to 4 tiles between two road ends, near a town especially [K 10-08 15:0x "the first incorrect road break"]
 *   road-ends        a road that stops at a small building's door with another road piece 3 to 6 tiles beyond, or ends 6 tiles or less from another road piece or an unroaded town front [K 10-08 15:0x tavern and castle]
 *   prison-tiers     prisons of 90000 or more experience stay out of start and town zones and keep a monster beside them [K 10-07 18:3x]
 *   edge-objects     no visited object's picture crosses the top or left edge of the map [K 10-08 14:3x outcasts and school of magic]
 *   free-standing    stacks that close nothing (no object, no passage) [K 10-08 15:2x "essentially freestanding"]
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

function roadEnds(M) {
	let roadTiles = 0, land = 0;
	for (let i = 0; i < M.road.length; i++) { roadTiles += M.road[i]; if (M.ground(i)) land++; }
	if (roadTiles < land / 100) return { skipped: 'the map has almost no road' };
	const ends = require('./road_ends').scan(M, LIMITS.endReach), bld = ends.filter(e => e.kind === 'building');
	return verdict(ends.length === 0, `${ends.length} road ends (${bld.length} at a small building's door with a road piece beyond, ${ends.length - bld.length} within ${LIMITS.endReach} tiles of another road piece or an unroaded town front)`, '0 (the engine leaves one on 18% of its maps)',
		ends.slice(0, 6).map(e => `road end L${e.l} (${e.x},${e.y}): ${e.d} tiles from ${e.what}`), { ends: ends.length, building: bld.length });
}

function prisonTiers(M) {
	const pr = M.objs.filter(o => o.type === 'prison');
	if (!pr.length) return { skipped: 'no prisons' };
	if (!M.zones) return { skipped: 'no zone sidecar' };
	const bad = [], tiers = {}, byZone = {};
	for (const o of pr) {
		const exp = (o.options && o.options.experience) || 0, z = M.zones.zones.get(M.zoneAt(o.l, o.at[0], o.at[1])), zt = z ? z.type : '?';
		tiers[exp] = (tiers[exp] || 0) + 1;
		const row = byZone[zt] || (byZone[zt] = {}); row[exp] = (row[exp] || 0) + 1;
		if (exp < 90000) continue;
		const poor = /start|town|player/i.test(zt || '') || (z && z.townType !== undefined && z.townType !== null && /start/i.test(zt || ''));
		const guarded = M.monsters.some(m => m.l === o.l && cheb(m.at, o.at) <= 1);
		if (poor) bad.push(`prison of ${exp} experience ${at(o)} in a ${zt} zone`);
		else if (!guarded) bad.push(`prison of ${exp} experience ${at(o)} has no monster beside it`);
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
	return verdict(share <= LIMITS.ineffective, `${idle.length} of ${stacks.length} stacks close nothing (${(100 * share).toFixed(1)}%)`, `<= ${100 * LIMITS.ineffective}% (the engine's own maps: about 3.6%)`,
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

const CHECKS = { 'start-road': startRoad, 'town-spacing': townSpacing, 'road-breaks': roadBreaks, 'road-ends': roadEnds, 'prison-tiers': prisonTiers, 'edge-objects': edgeObjects, 'free-standing': freeStanding, 'river-ends': riverEnds };
module.exports = { CHECKS, LIMITS };
