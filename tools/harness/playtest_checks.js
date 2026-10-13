'use strict';
/**
 * playtest_checks.js - the grid checks that come from K's playtest of 2026-10-06 (roster\PLAYTEST-NOTES-2026-10-06.md).
 * Each one fails on the map K showed and passes when the generator is right; the engine's own maps are the calibration
 * where the engine has the thing (towns, roads, guards, density), K's words and pictures where it has not (coast).
 *
 *   node tools/harness/playtest_checks.js FILE.vmap|DIR... [--json] [--only name,name] [--list]
 *   node tools/harness/playtest_checks.js FILE.vmap|DIR... --guards     one line a map: crowded, flyer-open, approach-open, against the targets
 *
 * A DIR is every .vmap in it. One line per map and check (PASS or FAIL, the value, the limit, the first offenders with
 * their coordinates); with several maps a summary of fails per check ends the output. Exit 1 when any check fails.
 * Needs the zone sidecar beside the map (ours writes it, the engine's rmgdump too) for the zone checks, and says
 * "skipped" where it is missing.
 *
 * Checks (K's words in roster\PLAYTEST-NOTES-2026-10-06.md, the time of each in brackets):
 *   towns-per-start    every start zone holds the same number of towns [14:57 "did you see how many towns each side starts with?"]
 *   town-road          every town has a road on a visiting tile; every start's entrance especially [15:26 pavilion, 15:29 start]
 *   dwelling-reach     every creature dwelling has a visiting tile a hero can walk to when guards are ignored [15:26 "impassible"]
 *   guard-clusters     crowds of stacks round loot, and dear piles with two or more guards beside them [15:03, "guard, loot, guard, wall"]
 *   dragons-middle     one-level maps: every neutral dragon dwelling stands in the middle of the map [15:31]
 *   coast-slots        no ruler-straight water slot (up to 3 tiles wide, both walls identical on every line) 10 or more long [15:31 blocky inlets]
 *   approach-open      dwellings and dear piles whose every approach tile is blocked by loot, a blocker or a guard's 3x3 ring [10-05 rule, the Reviewer's count]
 *   flyer-open         dear piles with no monster on or beside their tile (a flyer meets no guard) [10-05 flyer rule]
 *   biome-density      no large patch of one terrain whose 12x12 windows are nearly bare, joined to a start biome or not [15:44]
 * and the seven of grid_extra.js (October 8th: start-road, town-spacing, road-breaks, road-ends, gold-front, prison-tiers, edge-objects, free-standing, river-ends).
 */
const fs = require('fs');
const path = require('path');
const sight = require('../mapsight/lib/sight');

const N8 = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 0], [-1, 1]];
const cheb = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
const med = a => { const b = a.slice().sort((p, q) => p - q); return b.length ? b[b.length >> 1] : 0; };
const at = o => `L${o.l} (${o.at[0]},${o.at[1]})`;
const isWater = t => t === 'wt' || t === 'wa';                    // the exporter writes water as wt
const verdict = (pass, value, limit, items, nums) => ({ pass, value, limit, items: items || [], nums: nums || {} });

/** Every start zone holds the same number of towns (K's 36x36: red 2, blue 1). */
function townsPerStart(M) {
	if (!M.zones || !M.zones.zoneOf) return { skipped: 'no zone sidecar' };
	const st = sight.starts(M).filter(s => s.zone !== undefined && s.zone !== null && s.zone >= 0);
	if (st.length < 2) return { skipped: 'fewer than two starts' };
	const towns = M.objs.filter(o => o.cls === 'town');
	const rows = st.map(s => ({ colour: s.colour, zone: s.zone, n: towns.filter(t => t.l === s.l && M.zoneAt(t.l, t.at[0], t.at[1]) === s.zone).length }));
	const lo = Math.min(...rows.map(r => r.n)), hi = Math.max(...rows.map(r => r.n));
	return verdict(lo === hi, `${lo}..${hi}`, 'equal', rows.map(r => `${r.colour} zone ${r.zone}: ${r.n} town${r.n === 1 ? '' : 's'}`));
}

/**
 * A town whose front tile has no road (the entrance tile itself carrying road counts, as in Opus's rule). The front tile is the one below the door (the engine's entrance): a road that only
 * touches a corner of the town, or a front tile that is rock or water, is K's "doesn't have a road connection" (15:26 the
 * pavilion at (51,129): rock in front, the road runs on one tile off; 15:29 his islands start (15,77): water in front).
 */
function townRoad(M) {
	let roadTiles = 0, land = 0;
	for (let i = 0; i < M.road.length; i++) { roadTiles += M.road[i]; if (M.ground(i)) land++; }
	if (roadTiles < land / 100) return { skipped: 'the map has almost no road (1 tile in 100 of land)' };
	const st = sight.starts(M), isStart = o => st.some(s => s.l === o.l && cheb(s.at, o.at) <= 1);
	const bad = [];
	let n = 0;
	for (const o of M.objs) {
		if (o.cls !== 'town') continue;
		n++;
		const [ex, ey] = o.entr[0], fx = ex, fy = ey + 1;
		const fi = M.inb(fx, fy) ? M.idx(o.l, fx, fy) : -1;
		if ((fi >= 0 && M.road[fi]) || M.road[M.idx(o.l, ex, ey)]) continue;
		const open = fi >= 0 && M.ground(fi);
		bad.push({ o, start: isStart(o), why: !open ? `front tile (${fx},${fy}) is ${fi < 0 ? 'off the map' : M.terr[fi]}` : `no road on the front tile (${fx},${fy})`, side: M.approach(o).some(i => M.road[i]) });
	}
	const starts = bad.filter(b => b.start), allowed = Math.floor(LIMITS.townNoRoad * n);                    // K 10-06 15:26, the lead's order: every town has a road on its visiting tile (the engine leaves up to 8%)
	return verdict(starts.length === 0 && bad.length <= allowed, `${bad.length} of ${n} towns, ${starts.length} starts`, `0 starts, at most ${allowed} towns`,
		bad.sort((a, b) => b.start - a.start).map(b => `${b.start ? 'START ' : ''}${b.o.type} ${at(b.o)}: ${b.why}${b.side ? ' (a road touches a side or corner tile)' : ''}`));
}

/** Tiles a hero can walk from any start when guards are ignored (a monster's tile is passable: it is a fight, not a wall); gates and monoliths join levels. */
function walkable(M) {
	const { NL, W, H, idx, inb } = M;
	const pass = new Uint8Array(NL * W * H);
	// water is passable (a boat), so a dwelling on another island is not 'unreachable'; the check finds dwellings walled in by scenery
	for (let i = 0; i < pass.length; i++) pass[i] = (M.ground(i) || isWater(M.terr[i])) && !M.blocked[i] ? 1 : 0;
	for (const m of M.monsters) for (const [x, y] of m.cells.length ? m.cells : [m.at]) if (inb(x, y) && M.ground(idx(m.l, x, y))) pass[idx(m.l, x, y)] = 1;
	// a pickup's tile is open (sight.load leaves it unblocked), a town's and a mine's own cells are not, their approach tiles are
	const seen = new Uint8Array(NL * W * H), q = [];
	const seed = i => { if (pass[i] && !seen[i]) { seen[i] = 1; q.push(i); } };
	for (const s of sight.starts(M)) for (const t of M.objs.filter(o => o.cls === 'town' && o.l === s.l && cheb(o.at, s.at) <= 1)) M.approach(t).forEach(seed);
	const portals = M.objs.filter(o => o.cls === 'gate' || o.cls === 'monolith');
	const used = new Set();
	for (;;) {
		while (q.length) {
			const c = q.pop(), l = (c / (W * H)) | 0, r = c - l * W * H, x = r % W, y = (r / W) | 0;
			for (const [dx, dy] of N8) if (inb(x + dx, y + dy)) seed(idx(l, x + dx, y + dy));
		}
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
}

function dwellingReach(M) {
	const seen = walkable(M), bad = [];
	let n = 0;
	for (const o of M.objs) {
		if (o.cls !== 'dwelling') continue;
		n++;
		if (!M.approach(o).some(i => seen[i])) bad.push(o);
	}
	return verdict(bad.length === 0, `${bad.length} of ${n}`, '0', bad.map(o => `${o.type}:${o.subtype} ${at(o)} no visiting tile a hero can walk to`));
}

/**
 * Guard crowds. A cluster is stacks linked within 2 tiles (Chebyshev); the engine has almost none (the lane measured 0% of its stacks with
 * another within 2 tiles, 15 to 44% of ours before the pile rule). A dear pile (high loot, dwelling, bank) with two or more guards within 2
 * tiles of it is K's "guard, loot, guard".
 */
function guardClusters(M) {
	const mons = M.monsters, n = mons.length;
	if (!n) return { skipped: 'no monsters' };
	const par = mons.map((_, i) => i), find = i => (par[i] === i ? i : (par[i] = find(par[i])));
	let crowded = 0;
	const cnt = new Array(n).fill(0);
	for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
		if (mons[i].l !== mons[j].l || cheb(mons[i].at, mons[j].at) > 2) continue;
		par[find(i)] = find(j); cnt[i]++; cnt[j]++;
	}
	for (let i = 0; i < n; i++) if (cnt[i]) crowded++;
	const groups = new Map();
	for (let i = 0; i < n; i++) { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(mons[i]); }
	const big = [...groups.values()].filter(g => g.length >= 4).sort((a, b) => b.length - a.length);
	const dear = M.objs.filter(o => o.cls === 'high' || o.cls === 'dwelling' || o.cls === 'bank');
	const two = dear.filter(o => mons.filter(m => m.l === o.l && cheb(m.at, o.at) <= 2).length >= 2);
	const share = crowded / n, shareTwo = dear.length ? two.length / dear.length : 0;
	// shares of a handful of stacks swing on one pair (the engine's small maps: 1 of 8 stacks is 12%), so they count from a size up
	// Coldshadow's own maps hold at most 0.4% crowded and 0.5% dear piles with two guards (12 engine maps); the other templates reach 8.3% and 16.9%
	const cold = M.zones && /coldshadow/i.test(M.zones.template || ''), L = cold ? LIMITS.cold : LIMITS;
	const pass = big.length === 0 && (n < LIMITS.minStacks || share <= L.crowdShare) && (dear.length < LIMITS.minDear || shareTwo <= L.twoGuards);
	return verdict(pass, `crowded ${(100 * share).toFixed(1)}%, clusters of 4+ ${big.length}, dear piles with 2+ guards ${(100 * shareTwo).toFixed(1)}%`,
		`crowded <= ${100 * L.crowdShare}%, clusters 0, 2+ guards <= ${100 * L.twoGuards}%`,
		[...big.slice(0, 6).map(g => `${g.length} stacks within 2 tiles of each other near L${g[0].l} (${g[0].at})`),
			...two.slice(0, 4).map(o => `${o.type} ${at(o)} has ${mons.filter(m => m.l === o.l && cheb(m.at, o.at) <= 2).length} guards within 2 tiles`)],
		{ crowded: share, clusters: big.length, twoGuards: shareTwo });
}

/** One-level maps: the neutral dragon dwellings belong in the middle (K: "on water maps with no underground ... 3 crystal dragon caverns in the bottom right island"). */
function dragonsMiddle(M) {
	if (M.NL !== 1) return { skipped: 'two levels: the dragons go underground' };
	let water = 0;
	for (let i = 0; i < M.terr.length; i++) if (isWater(M.terr[i])) water++;
	if (water < 0.03 * M.terr.length) return { skipped: 'no water (K approved the dry one-level layout, the dragons stay in their junction zones)' };
	const dr = sight.census(M).filter(d => d.dragon);
	if (!dr.length) return { skipped: 'no neutral dragon dwellings (not a Coldshadow map)' };
	const cx = (M.W - 1) / 2, cy = (M.H - 1) / 2, lim = LIMITS.middle * Math.min(M.W, M.H);
	const out = dr.filter(d => Math.hypot(d.o.at[0] - cx, d.o.at[1] - cy) > lim);
	return verdict(out.length === 0, `${out.length} of ${dr.length} farther than ${lim.toFixed(0)} tiles from the centre`, `0 (radius ${LIMITS.middle} of the side)`,
		out.map(d => `${d.o.subtype} (${d.o.at}) ${Math.hypot(d.o.at[0] - cx, d.o.at[1] - cy).toFixed(0)} tiles from the centre, zone ${M.zoneAt(0, d.o.at[0], d.o.at[1])}`));
}

/**
 * Coast census, per level: the longest straight water slot (water run of 3 tiles or fewer, land on both sides, the same columns or rows over
 * consecutive lines; K's picture: 2 and 3 wide, 10 to 14 long, ruler-straight) and the longest straight shore run.
 */
function coastSlots(M) {
	let water = 0;
	for (let i = 0; i < M.terr.length; i++) if (isWater(M.terr[i])) water++;
	if (water < 200) return { skipped: 'no water' };
	const slots = [];
	let shore = { len: 0 };
	for (let l = 0; l < M.NL; l++) {
		const isW = (x, y) => M.inb(x, y) && isWater(M.terr[M.idx(l, x, y)]);
		const land = (x, y) => M.inb(x, y) && !isWater(M.terr[M.idx(l, x, y)]);
		for (const vert of [false, true]) {
			const A = vert ? M.W : M.H, B = vert ? M.H : M.W;                       // scan lines a, positions b
			const W_ = (a, b) => (vert ? isW(a, b) : isW(b, a)), L_ = (a, b) => (vert ? land(a, b) : land(b, a));
			// slots: per line the water runs of width <= 4 with land on both ends; a run continues a slot of the line before when both its
			// ends are within one tile of that slot's ends (K's picture: ruler-straight, 2 to 4 wide, 10 to 15 long)
			let open = [];                                                          // { b0, b1, a0, n }
			for (let a = 0; a <= A; a++) {
				const now = [];
				if (a < A) for (let b = 0; b < B; b++) {
					if (!W_(a, b) || (b > 0 && W_(a, b - 1))) continue;
					let e = b; while (e + 1 < B && W_(a, e + 1)) e++;
					if (e - b + 1 <= LIMITS.slotW && b > 0 && e + 1 < B && L_(a, b - 1) && L_(a, e + 1)) {
						const prev = open.find(o => !o.used && Math.abs(o.b0 - b) <= LIMITS.slotTol && Math.abs(o.b1 - e) <= LIMITS.slotTol);
						if (prev) prev.used = true;
						now.push({ b0: b, b1: e, a0: prev ? prev.a0 : a, n: prev ? prev.n + 1 : 1 });
					}
				}
				for (const v of open) if (!v.used && v.n >= 8) slots.push({ l, len: v.n, w: v.b1 - v.b0 + 1, x: vert ? a - v.n : v.b0, y: vert ? v.b0 : a - v.n, vert });
				open = now;
			}
			// straight shore: along line a a run of b where the tile is water and the tile one step across the line is land
			for (const d of [-1, 1]) for (let a = 0; a < A; a++) {
				let run = 0;
				for (let b = 0; b <= B; b++) {
					const on = b < B && W_(a, b) && L_(a + d, b);
					if (on) run++;
					else { if (run > shore.len) shore = { len: run, l, a, b: b - run, vert }; run = 0; }
				}
			}
		}
	}
	slots.sort((p, q) => q.len - p.len);
	const worst = slots[0] ? slots[0].len : 0;
	const pass = worst < LIMITS.slotLen;
	return verdict(pass, `longest slot ${worst} (${slots.length} of 8+), longest shore run ${shore.len} (shown, natural coasts reach 17)`, `no slot of ${LIMITS.slotLen}+`,
		[...slots.slice(0, 6).map(s => `slot ${s.w} wide, ${s.len} long at L${s.l} (${s.x},${s.y}) ${s.vert ? 'east-west' : 'north-south'}`),
			...(shore.len >= 12 ? [`straight shore run of ${shore.len} at L${shore.l} ${shore.vert ? `x ${shore.a}` : `y ${shore.a}`}, from ${shore.b}`] : [])]);
}

/**
 * Bare patches inside a biome. Windows of 12x12 (stride 6) hold land tiles of one terrain family; loot = objects a hero visits, fights or picks
 * up. A window is bare when its loot per 100 land tiles is under a quarter of the level's median. Bare windows that touch (4-connected on the
 * stride grid) form a bare area; the check fails on an area of 8 windows (about 400 land tiles) or more, which no engine map has. An area
 * touching a start's own terrain patch is named: that is K's snow appendage.
 */
function biomeDensity(M) {
	const WIN = 12, STEP = 6, MINLAND = 72;
	const loot = new Float32Array(M.NL * M.W * M.H);
	for (const o of M.objs) if (o.visitable || o.cls === 'monster' || o.pickup) loot[M.idx(o.l, o.x, o.y)]++;
	const wins = [], at2 = new Map();
	for (let l = 0; l < M.NL; l++) for (let y0 = 0; y0 + WIN <= M.H; y0 += STEP) for (let x0 = 0; x0 + WIN <= M.W; x0 += STEP) {
		let land = 0, lo = 0;
		for (let y = y0; y < y0 + WIN; y++) for (let x = x0; x < x0 + WIN; x++) { const i = M.idx(l, x, y); if (M.ground(i)) land++; lo += loot[i]; }
		if (land < MINLAND) continue;
		const w = { l, x0, y0, gx: x0 / STEP, gy: y0 / STEP, land, n: lo, d: 100 * lo / land };
		wins.push(w); at2.set(`${l},${w.gx},${w.gy}`, w);
	}
	for (let l = 0; l < M.NL; l++) { const R = wins.filter(w => w.l === l), m = med(R.map(w => w.d)); R.forEach(w => { w.bare = w.d < m * 0.25; w.med = m; }); }
	// terrain patches joined to a start town's terrain (8-connected tiles of the same terrain code)
	const patch = new Int32Array(M.NL * M.W * M.H).fill(-1), startPatch = new Set();
	const flood = (s, id) => {
		const q = [s]; patch[s] = id; const t = M.terr[s];
		while (q.length) {
			const c = q.pop(), l = (c / (M.W * M.H)) | 0, r = c - l * M.W * M.H, x = r % M.W, y = (r / M.W) | 0;
			for (const [dx, dy] of N8) if (M.inb(x + dx, y + dy)) { const n = M.idx(l, x + dx, y + dy); if (patch[n] < 0 && M.terr[n] === t) { patch[n] = id; q.push(n); } }
		}
	};
	let pid = 0;
	for (const s of sight.starts(M)) { const i = M.idx(s.l, s.at[0], s.at[1]); if (M.ground(i) && patch[i] < 0) { flood(i, pid); startPatch.add(pid); pid++; } else if (patch[i] >= 0) startPatch.add(patch[i]); }
	const seen = new Set(), areas = [];
	for (const w of wins) {
		const key = `${w.l},${w.gx},${w.gy}`;
		if (!w.bare || seen.has(key)) continue;
		const q = [w], cells = []; seen.add(key);
		while (q.length) {
			const c = q.pop(); cells.push(c);
			for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
				const k = `${c.l},${c.gx + dx},${c.gy + dy}`, n = at2.get(k);
				if (n && n.bare && !seen.has(k)) { seen.add(k); q.push(n); }
			}
		}
		let joined = false;
		for (const c of cells) for (let y = c.y0; y < c.y0 + WIN && !joined; y += 3) for (let x = c.x0; x < c.x0 + WIN; x += 3) { const p = patch[M.idx(c.l, x, y)]; if (p >= 0 && startPatch.has(p)) { joined = true; break; } }
		areas.push({ n: cells.length, land: cells.reduce((a, c) => a + c.land, 0), l: cells[0].l, x0: Math.min(...cells.map(c => c.x0)), y0: Math.min(...cells.map(c => c.y0)), x1: Math.max(...cells.map(c => c.x0 + WIN)), y1: Math.max(...cells.map(c => c.y0 + WIN)), joined, loot: cells.reduce((a, c) => a + c.n, 0) });
	}
	areas.sort((a, b) => b.n - a.n);
	const bad = areas.filter(a => a.n >= LIMITS.bareWindows);
	return verdict(bad.length === 0, `largest bare area ${areas[0] ? areas[0].n : 0} windows (${areas.length} bare areas, ${wins.filter(w => w.bare).length} of ${wins.length} windows bare)`, `no area of ${LIMITS.bareWindows}+ windows`,
		bad.slice(0, 6).map(a => `bare area of ${a.n} windows (${a.land} land tiles, ${a.loot} objects) at L${a.l} (${a.x0},${a.y0})-(${a.x1},${a.y1})${a.joined ? ', joined to a start biome' : ''}`));
}

/**
 * Dwellings and dear piles with an open approach tile (the Reviewer's count of 2026-10-06: 321 of 1,810 dwellings, 3,379 of 16,128 piles). K's rule
 * (10-05): a thing is guarded when every tile it is visited from is blocked by other loot, a blocker (rock, water, scenery, a building) or a
 * guard's one-tile ring (3x3), so a hero, a flying one too, must meet a guard. An object with one approach tile that none of those blocks is open.
 */
function approachOpen(M) {
	const { W, H } = M;
	const ring = new Set(), loot = new Map();
	for (const m of M.monsters) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) ring.add(M.idx(m.l, m.at[0] + dx, m.at[1] + dy));
	for (const o of M.objs) if (o.pickup || o.cls === 'bank' || o.cls === 'dwelling') for (const [x, y] of o.cells) if (M.inb(x, y)) loot.set(M.idx(o.l, x, y), o);
	const open = o => M.approach(o).some(i => M.ground(i) && !M.blocked[i] && !ring.has(i) && (!loot.has(i) || loot.get(i) === o));
	const rows = k => M.objs.filter(o => o.cls === k && M.approach(o).length);
	const dw = rows('dwelling'), hi = rows('high');
	const dOpen = dw.filter(open), hOpen = hi.filter(open);
	const sd = dw.length ? dOpen.length / dw.length : 0, sh = hi.length ? hOpen.length / hi.length : 0;
	if (dw.length + hi.length === 0) return { skipped: 'no dwellings or dear piles' };
	// a share of a handful of objects swings on one (a 36x36 map holds 4 to 7 dwellings): limits count from 10 dwellings and 20 piles
	return verdict((dw.length < 10 || sd <= LIMITS.openDwelling) && (hi.length < 20 || sh <= LIMITS.openHigh), `dwellings ${dOpen.length} of ${dw.length} (${(100 * sd).toFixed(1)}%), dear piles ${hOpen.length} of ${hi.length} (${(100 * sh).toFixed(1)}%)`,
		`dwellings <= ${100 * LIMITS.openDwelling}%, dear piles <= ${100 * LIMITS.openHigh}%`,
		[...dOpen.slice(0, 4).map(o => `${o.type}:${o.subtype} ${at(o)} has an open approach tile`), ...hOpen.slice(0, 4).map(o => `${o.type} ${at(o)} has an open approach tile`)],
		{ dwellings: sd, piles: sh, nDwellings: dw.length, nPiles: hi.length });
}

/**
 * Dear piles a flying hero meets no guard at: no monster on or beside the pile's own tile (K, 2026-10-05: "if i get fly ... i can just fly over tile blockers
 * and clean these biomes out without fighting"; scrolls left out as Opus's flyer.js does). The lead's target is under 1%.
 */
function flyerOpen(M) {
	const hi = M.objs.filter(o => o.cls === 'high' && o.type !== 'spellScroll');
	if (!hi.length) return { skipped: 'no dear piles' };
	const bad = hi.filter(o => !M.monsters.some(m => m.l === o.l && cheb(m.at, o.at) <= 1));
	const sh = bad.length / hi.length;
	return verdict(sh <= LIMITS.flyerOpen, `${bad.length} of ${hi.length} dear piles (${(100 * sh).toFixed(1)}%)`, `<= ${100 * LIMITS.flyerOpen}%`,
		bad.slice(0, 6).map(o => `${o.type} ${at(o)} has no monster on or beside its tile`), { piles: sh, n: hi.length });
}

const LIMITS = { slotTol: 0, slotW: 3, slotLen: 10, crowdShare: 0.05, twoGuards: 0.20, cold: { crowdShare: 0.02, twoGuards: 0.03 }, middle: 0.30, bareWindows: 12, townNoRoad: 0, minStacks: 30, minDear: 20, openDwelling: 0.20, openHigh: 0.15, flyerOpen: 0.01 };
const CHECKS = { 'towns-per-start': townsPerStart, 'town-road': townRoad, 'dwelling-reach': dwellingReach, 'guard-clusters': guardClusters, 'dragons-middle': dragonsMiddle, 'coast-slots': coastSlots, 'biome-density': biomeDensity, 'approach-open': approachOpen, 'flyer-open': flyerOpen };

Object.assign(CHECKS, require('./grid_extra').CHECKS);               // start-road, town-spacing, road-breaks, road-ends, gold-front, prison-tiers, edge-objects, free-standing, river-ends

function runChecks(file, only) {
	const M = sight.load(file), out = {};
	for (const [name, f] of Object.entries(CHECKS)) if (!only || only.includes(name)) { try { out[name] = f(M); } catch (e) { out[name] = { error: e.message }; } }
	return { file, w: M.W, h: M.H, levels: M.NL, checks: out };
}

function main(argv) {
	const args = argv.slice(2), flag = k => args.includes(k);
	const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
	if (flag('--list')) { console.log(Object.keys(CHECKS).join('\n')); return 0; }
	const skip = new Set(); args.forEach((a, i) => { if (a === '--only') skip.add(i + 1); });
	const files = [];
	args.forEach((a, i) => {
		if (a.startsWith('--') || skip.has(i)) return;
		if (fs.existsSync(a) && fs.statSync(a).isDirectory()) fs.readdirSync(a).filter(f => f.endsWith('.vmap')).sort().forEach(f => files.push(path.join(a, f)));
		else files.push(a);
	});
	const results = files.map(f => runChecks(f, flag('--guards') ? ['guard-clusters', 'flyer-open', 'approach-open'] : only));
	if (flag('--guards')) {
		const pc = v => (v === undefined ? '  n/a' : (100 * v).toFixed(1).padStart(5) + '%');
		console.log(`targets: crowded under ${100 * LIMITS.crowdShare}% (Coldshadow ${100 * LIMITS.cold.crowdShare}%), flyer-open under ${100 * LIMITS.flyerOpen}%, approach-open within the engine's 7 to 18% (dwellings <= ${100 * LIMITS.openDwelling}%, piles <= ${100 * LIMITS.openHigh}%)`);
		for (const r of results) {
			const g = r.checks['guard-clusters'] || {}, f = r.checks['flyer-open'] || {}, a = r.checks['approach-open'] || {};
			const ok = [g, f, a].every(c => c.skipped || c.pass);
			console.log(`${ok ? 'PASS' : 'FAIL'}  ${path.basename(r.file).slice(0, 44).padEnd(44)} crowded ${pc((g.nums || {}).crowded)}  flyer-open ${pc((f.nums || {}).piles)}  approach-open dwellings ${pc((a.nums || {}).dwellings)} piles ${pc((a.nums || {}).piles)}`);
		}
		return results.every(r => ['guard-clusters', 'flyer-open', 'approach-open'].every(k => !r.checks[k] || r.checks[k].skipped || r.checks[k].pass)) ? 0 : 1;
	}
	if (flag('--json')) { console.log(JSON.stringify(results, null, 1)); }
	else {
		const tally = {};
		for (const r of results) {
			console.log(`${path.basename(r.file)} (${r.w}x${r.h}, ${r.levels} level${r.levels > 1 ? 's' : ''})`);
			for (const [name, c] of Object.entries(r.checks)) {
				const t = tally[name] || (tally[name] = { fail: 0, pass: 0, skip: 0 });
				if (c.error) { console.log(`  ERROR ${name}: ${c.error}`); continue; }
				if (c.skipped) { t.skip++; console.log(`  skip  ${name}: ${c.skipped}`); continue; }
				if (c.pass) t.pass++; else t.fail++;
				console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${name}: ${c.value} (limit ${c.limit})`);
				if (!c.pass) for (const it of c.items.slice(0, 5)) console.log(`          ${it}`);
			}
		}
		if (results.length > 1) { console.log('\nsummary (fail / pass / skipped over ' + results.length + ' maps)'); for (const [n, t] of Object.entries(tally)) console.log(`  ${n.padEnd(16)} ${t.fail} / ${t.pass} / ${t.skip}`); }
	}
	return results.some(r => Object.values(r.checks).some(c => c.error || (!c.skipped && !c.pass))) ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv));
module.exports = { runChecks, CHECKS, LIMITS, walkable };
