'use strict';
/**
 * relations.js - describe every object by its relationship to what is around it, so an agent can "see" spatial
 * relationships the way a person takes them in at a glance. K, 2026-10-01: "i want a measurement on everything since an
 * agent cant 'see' spatial relationships all at once like a human, it needs a way to do so".
 *
 * Each measure is a share: of the objects of one kind, how many stand in one particular relationship. Every measure keeps
 * the coordinates of the objects that have it, so a difference can be opened on the map (mapsight near / render).
 * diff.js compares these shares with the engine's own maps and ranks the differences.
 *
 * Terms. Wall: rock or water, or a blocked mass of 25+ tiles (scattered small obstacles are not walls). Free area: walkable
 * ground outside every guard ring. Open ground: a free area over 30 tiles. Sealed: no visiting tile on open ground, so a
 * hero must pass a guard to reach it. Area: a guard-bounded free region; "town area" when a town is visited from it.
 */
const sight = require('./sight');

const POCKET = 30, WALL_MASS = 25, AREA_MIN = 150;
const N8 = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];

/** Distance (8-way) from every tile to the nearest wall, and the share of blocked ground that is scatter. */
function walls(M) {
	const pass = i => M.ground(i) && !M.blocked[i];
	const comp = new Int32Array(M.NL * M.W * M.H).fill(-1), size = [];
	for (let i = 0; i < comp.length; i++) {
		if (comp[i] >= 0 || pass(i) || !M.ground(i)) continue;
		const id = size.length, st = [i]; comp[i] = id; let n = 0;
		while (st.length) {
			const c = st.pop(), l = Math.floor(c / (M.W * M.H)), x = c % M.W, y = Math.floor(c / M.W) % M.H; n++;
			for (const [dx, dy] of N8) {
				if (!M.inb(x + dx, y + dy)) continue;
				const t = M.idx(l, x + dx, y + dy);
				if (comp[t] < 0 && !pass(t) && M.ground(t)) { comp[t] = id; st.push(t); }
			}
		}
		size.push(n);
	}
	const isWall = i => !M.ground(i) || (comp[i] >= 0 && size[comp[i]] >= WALL_MASS);
	const dist = new Int16Array(M.NL * M.W * M.H).fill(-1), q = [];
	for (let i = 0; i < dist.length; i++) if (isWall(i)) { dist[i] = 0; q.push(i); }
	for (let h = 0; h < q.length; h++) {
		const c = q[h], l = Math.floor(c / (M.W * M.H)), x = c % M.W, y = Math.floor(c / M.W) % M.H;
		for (const [dx, dy] of N8) {
			if (!M.inb(x + dx, y + dy)) continue;
			const n = M.idx(l, x + dx, y + dy);
			if (dist[n] < 0) { dist[n] = dist[c] + 1; q.push(n); }
		}
	}
	let blockedGround = 0, scatter = 0;
	for (let i = 0; i < comp.length; i++) if (comp[i] >= 0) { blockedGround++; if (size[comp[i]] < WALL_MASS) scatter++; }
	return { dist, isWall, pass, scatterShare: blockedGround ? scatter / blockedGround : null };
}

/** All relational measures of one analysed map (sight.analyse). Returns { measures: {name: share}, examples: {name: [..]} }. */
function describe(A, scope) {
	const M = A.M, W = A._walls || (A._walls = walls(M));
	const meas = {}, ex = {}, counter = {}, counts = {};
	const put = (name, objs0, has, label) => {
		const objs = scope ? objs0.filter(e => areaOf(e) === scope.area) : objs0;
		if (!objs.length) return;
		const yes = objs.filter(has), no = objs.filter(o => !has(o));
		meas[name] = yes.length / objs.length;
		counts[name] = objs.length;
		ex[name] = yes.slice(0, 8).map(label || (o => at(o)));
		counter[name] = no.slice(0, 8).map(label || (o => at(o)));
	};
	const at = o => `${o.type}${o.subtype && o.subtype !== 'object' ? ':' + o.subtype : ''}(${o.at[0]},${o.at[1]}${o.l ? ',L' + o.l : ''})`;
	const open = o => sight.openAccess(M, o);
	const wd = o => W.dist[M.idx(o.l, o.at[0], o.at[1])];
	// the walkable tiles a hero visits o from, and how much walkable ground surrounds them
	const appr = o => M.approach(o).filter(W.pass);
	const towns0 = M.objs.filter(o => o.cls === 'town');
	const townRegions = new Set(towns0.flatMap(o => M.regionsOf(o)));
	const area = o => { const r = M.regionsOf(o); return r.length ? (r.some(x => townRegions.has(x)) ? 'town area' : 'wild area') : 'sealed'; };
	const I = sight.index();
	const lvl = m => { const c = I && I.creature(m.subtype); return c ? c.level : null; };

	// ---- guards: what each one closes off ------------------------------------------------------------------------
	const vis = new Map();
	for (const o of M.objs) if (['high', 'low', 'dwelling', 'mine', 'bank'].includes(o.cls)) for (const i of M.approach(o)) {
		if (!vis.has(i)) vis.set(i, []); vis.get(i).push(o);
	}
	const pocketHas = new Map();
	for (const [i, os] of vis) { const r = M.region[i]; if (r >= 0) { if (!pocketHas.has(r)) pocketHas.set(r, []); pocketHas.get(r).push(...os); } }
	const role = new Map(), closes = new Map(), besideOf = new Map();
	for (const m of M.monsters) {
		const ring = [], adj = new Set();
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const x = m.at[0] + dx, y = m.at[1] + dy; if (M.inb(x, y)) ring.push(M.idx(m.l, x, y)); }
		for (const i of ring) {
			const x = i % M.W, y = Math.floor(i / M.W) % M.H;
			for (const [dx, dy] of N8) { if (!M.inb(x + dx, y + dy)) continue; const r = M.region[M.idx(m.l, x + dx, y + dy)]; if (r >= 0) adj.add(r); }
		}
		const small = [...adj].filter(r => M.regions[r].tiles <= POCKET && pocketHas.has(r));
		const big = [...adj].filter(r => M.regions[r].tiles > POCKET);
		const near = [...new Set([...ring.flatMap(i => vis.get(i) || []), ...small.flatMap(r => pocketHas.get(r))])];
		const sealed = near.filter(o => !open(o));
		closes.set(m, sealed);
		if (near.length) besideOf.set(m, near[0]);
		role.set(m, sealed.some(o => o.cls === 'high' || o.cls === 'dwelling') ? 'prize' : sealed.length ? 'loot'
			: near.length ? 'beside' : big.length >= 2 ? 'passage' : 'nothing');
	}
	// ---- areas: the open ground a zone is made of (a guard-free region of AREA_MIN+ tiles) and what belongs to each ----
	const big = r => r >= 0 && M.regions[r].tiles >= AREA_MIN;
	const guardArea = new Map(), closedBy = new Map();
	for (const m of M.monsters) {
		let best = -1;
		for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
			const x = m.at[0] + dx, y = m.at[1] + dy;
			if (!M.inb(x, y)) continue;
			const r = M.region[M.idx(m.l, x, y)];
			if (big(r) && (best < 0 || M.regions[r].tiles > M.regions[best].tiles)) best = r;
		}
		guardArea.set(m, best);
		for (const o of closes.get(m)) if (!closedBy.has(o)) closedBy.set(o, m);
	}
	const objArea = o => {
		const own = M.regionsOf(o).filter(big);
		if (own.length) return own[0];
		if (closedBy.has(o)) return guardArea.get(closedBy.get(o));
		for (let r = 1; r <= 6; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
			if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || !M.inb(o.at[0] + dx, o.at[1] + dy)) continue;
			const g = M.region[M.idx(o.l, o.at[0] + dx, o.at[1] + dy)];
			if (big(g)) return g;
		}
		return -1;
	};
	const areaOf = e => (typeof e === 'number' ? (big(M.region[e]) ? M.region[e] : -1)
		: e.tiles !== undefined && e.id !== undefined ? e.id
		: Array.isArray(e) ? (big(M.region[M.idx(e[0], e[1], e[2])]) ? M.region[M.idx(e[0], e[1], e[2])] : -1)
		: e.cls === 'monster' ? guardArea.get(e)
		: e.type === 'start' ? objArea(towns0.find(t => t.l === e.l && t.at[0] === e.at[0] && t.at[1] === e.at[1]) || { ...e, template: {}, entr: [e.at] })
		: objArea(e));
	A._areaOf = areaOf;
	const G = M.monsters;
	const gl = m => `${(m.options && m.options.amount) || '?'} ${m.subtype}(${m.at[0]},${m.at[1]}${m.l ? ',L' + m.l : ''})`;
	put('guard: blocks the only way to a prize (high loot or dwelling)', G, m => role.get(m) === 'prize', gl);
	put('guard: blocks the only way to other loot', G, m => role.get(m) === 'loot', gl);
	put('guard: stands beside loot a hero can walk around it to', G, m => role.get(m) === 'beside',
		m => (besideOf.get(m) ? `${gl(m)} beside ${at(besideOf.get(m))}` : gl(m)));
	put('guard: in a passage between two open areas', G, m => role.get(m) === 'passage', gl);
	put('guard: in open ground, closing nothing', G, m => role.get(m) === 'nothing', gl);
	put('guard: stands in a corridor (wall within 1 tile)', G, m => wd(m) <= 1, gl);
	put('guard: stands on open floor (3+ tiles from a wall)', G, m => wd(m) >= 3, gl);
	put('guard: stands on a road', G, m => M.road[M.idx(m.l, m.at[0], m.at[1])], gl);
	const blockers = G.filter(m => role.get(m) === 'prize' || role.get(m) === 'loot');
	put('guard holding something: closes 3+ objects (a pile)', blockers, m => closes.get(m).length >= 3, gl);
	put('guard holding a prize: level 5+ creature', G.filter(m => role.get(m) === 'prize' && lvl(m) !== null), m => lvl(m) >= 5, gl);
	put('guard holding only low loot: level 5+ creature', G.filter(m => role.get(m) === 'loot' && lvl(m) !== null), m => lvl(m) >= 5, gl);

	// ---- treasure, dwellings, mines, banks: where they stand and what stands in front of them ------------------------
	const kinds = { high: 'high loot', low: 'low loot', dwelling: 'dwelling', mine: 'mine', bank: 'creature bank' };
	for (const [cls, name] of Object.entries(kinds)) {
		const os = M.objs.filter(o => o.cls === cls);
		put(`${name}: sealed behind a guard`, os, o => !open(o));
		put(`${name}: at the end of a spur (dead end of walkable ground)`, os, o => {
			const a = appr(o);
			return a.length > 0 && a.every(i => {
				const x = i % M.W, y = Math.floor(i / M.W) % M.H;
				return N8.filter(([dx, dy]) => M.inb(x + dx, y + dy) && W.pass(M.idx(o.l, x + dx, y + dy))).length <= 3;
			});
		});
		put(`${name}: against a wall`, os, o => wd(o) <= 1);
		put(`${name}: on open floor (3+ tiles from a wall)`, os, o => wd(o) >= 3);
		put(`${name}: in a town's area`, os, o => area(o) === 'town area');
		put(`${name}: with another of its kind within 2 tiles`, os, o => os.some(p => p !== o && p.l === o.l && sight.cheb(p.at, o.at) <= 2));
		if (cls !== 'low') put(`${name}: road at its entrance`, os, o => M.approach(o).some(i => M.road[i]));
	}
	for (const [cls, name] of [['gate', 'subterranean gate'], ['monolith', 'monolith']]) {
		const os = M.objs.filter(o => o.cls === cls);
		put(`${name}: sealed behind a guard`, os, o => !open(o));
		put(`${name}: road at its entrance`, os, o => M.approach(o).some(i => M.road[i]));
		put(`${name}: in a town's area`, os, o => area(o) === 'town area');
	}
	const highOpen = M.objs.filter(o => o.cls === 'high' && open(o));
	put('high loot lying open: a guard within 3 tiles that does not block it', highOpen,
		o => M.monsters.some(m => m.l === o.l && sight.cheb(m.at, o.at) <= 3));

	// ---- dwellings and towns ------------------------------------------------------------------------------------
	const towns = M.objs.filter(o => o.cls === 'town');
	const nearestTown = o => { let b = null, d = 1e9; for (const t of towns) if (t.l === o.l) { const e = sight.cheb(t.at, o.at); if (e < d) { d = e; b = t; } } return { t: b, d }; };
	const facDw = I ? A.census.filter(d => !d.dragon && d.creature && I.creature(d.creature) && I.creature(d.creature).faction && I.creature(d.creature).faction !== 'neutral') : [];
	put('faction dwelling: within 15 tiles of a town of its own faction', facDw.map(d => d.o),
		o => { const d = facDw.find(e => e.o === o); const n = nearestTown(o); return n.t && n.d <= 15 && n.t.subtype === I.creature(d.creature).faction; });
	put('dwelling level 6+: sealed behind a guard', A.census.filter(d => d.tier >= 6).map(d => d.o), o => !open(o));
	put('town: road at its entrance', towns, o => M.approach(o).some(i => M.road[i]));
	put('town: a mine within 10 tiles', towns, o => M.objs.some(m => m.cls === 'mine' && m.l === o.l && sight.cheb(m.at, o.at) <= 10));
	put('neutral town: sealed behind a guard', towns.filter(t => !(t.options && t.options.owner)), o => !open(o));

	// ---- roads ----------------------------------------------------------------------------------------------------
	const roadTiles = [];
	for (let l = 0; l < M.NL; l++) for (let y = 0; y < M.H; y++) for (let x = 0; x < M.W; x++) if (M.road[M.idx(l, x, y)]) roadTiles.push([l, x, y]);
	const rt = (p, f) => f(M.idx(p[0], p[1], p[2]));
	const rl = p => `road(${p[1]},${p[2]}${p[0] ? ',L' + p[0] : ''})`;
	put('road tile: in a corridor (wall within 1 tile)', roadTiles, p => rt(p, i => W.dist[i] <= 1), rl);
	put('road tile: on open floor (3+ tiles from a wall)', roadTiles, p => rt(p, i => W.dist[i] >= 3), rl);
	put('road tile: inside a guard ring', roadTiles, p => rt(p, i => M.guardOf[i] >= 0), rl);
	put('road tile: in a piece that reaches no building', roadTiles, p => {
		const r = A.roads.find(x => x.l === p[0]);
		return r && r.orphanSet && r.orphanSet.has(M.idx(p[0], p[1], p[2]));
	}, rl);

	// ---- ground and shape -------------------------------------------------------------------------------------------
	const free = [];
	for (let i = 0; i < M.region.length; i++) if (M.region[i] >= 0) free.push(i);
	const fl = i => `(${i % M.W},${Math.floor(i / M.W) % M.H}${Math.floor(i / (M.W * M.H)) ? ',L1' : ''})`;
	put('walkable ground: 4+ tiles from a wall (open floor)', free, i => W.dist[i] >= 4, fl);
	put('walkable ground: in a corridor 1 to 3 wide (wall within 1 tile)', free, i => W.dist[i] <= 1, fl);
	put('walkable ground: in a town area', free, i => {
		const r = M.region[i]; return townRegions.has(r);
	}, fl);
	if (W.scatterShare !== null) { meas['blocked ground: scattered obstacles, not walls'] = W.scatterShare; ex['blocked ground: scattered obstacles, not walls'] = []; }
	const wild = M.regions.filter(r => r.tiles > POCKET && !townRegions.has(r.id));
	if (wild.length) {
		const tot = M.regions.filter(r => r.tiles > POCKET).reduce((a, r) => a + r.tiles, 0);
		meas['open areas: share of open ground in areas with no town'] = wild.reduce((a, r) => a + r.tiles, 0) / tot;
		ex['open areas: share of open ground in areas with no town'] = wild.slice(0, 5).map(r => `area of ${r.tiles} tiles from (${r.x},${r.y}${r.l ? ',L1' : ''})`);
	}
	// ---- open areas: what each one is, how many ways lead in ------------------------------------------------------
	const areas = M.regions.filter(r => r.tiles > POCKET);
	const ways = new Map(areas.map(r => [r.id, 0]));
	for (const m of M.monsters) if (role.get(m) === 'passage') {
		const adj = new Set();
		for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
			const x = m.at[0] + dx, y = m.at[1] + dy;
			if (M.inb(x, y)) { const r = M.region[M.idx(m.l, x, y)]; if (r >= 0 && ways.has(r)) adj.add(r); }
		}
		for (const r of adj) ways.set(r, ways.get(r) + 1);
	}
	for (const [, list] of [...M.links].map(([a, b]) => [a, b])) void list;
	const al = r => `area of ${r.tiles} tiles from (${r.x},${r.y}${r.l ? ',L1' : ''})`;
	put('open area: holds a town', areas, r => townRegions.has(r.id), al);
	put('open area: one guarded way in (a dead-end area)', areas, r => ways.get(r.id) === 1, al);
	put('open area: 3+ guarded ways in (a crossroads)', areas, r => ways.get(r.id) >= 3, al);
	put('open area: no guarded passage at all (closed off, or reached only by gate or monolith)', areas, r => ways.get(r.id) === 0, al);
	put('open area: 300+ tiles', areas, r => r.tiles >= 300, al);
	// found by random patches (Dwarven Tunnels underground, 2026-10-01): the engine runs roads through areas with no town
	const roadArea = new Set();
	for (let i = 0; i < M.road.length; i++) if (M.road[i] && M.region[i] >= 0) roadArea.add(M.region[i]);
	put('open area of 150+ tiles with no town: a road runs through it', areas.filter(r => r.tiles >= 150 && !townRegions.has(r.id)), r => roadArea.has(r.id), al);
	put('open area of 150+ tiles with a town: a road runs through it', areas.filter(r => r.tiles >= 150 && townRegions.has(r.id)), r => roadArea.has(r.id), al);

	// ---- guards between the starts and each prize (fewest guard rings a hero must enter to reach it) -------------------
	const cost = A._cost || (A._cost = new Int16Array(M.NL * M.W * M.H).fill(-1));
	if (!A._costDone) {
		A._costDone = true;
		const dq = [];
		for (const s of A.starts) {
			const t = towns.find(o => o.l === s.l && o.at[0] === s.at[0] && o.at[1] === s.at[1]);
			for (const i of t ? M.approach(t) : []) if (W.pass(i) || M.guardOf[i] >= 0) { cost[i] = 0; dq.push(i); }
		}
		const monTile = new Set(M.monsters.map(m => M.idx(m.l, m.at[0], m.at[1])));
		const step = i => M.ground(i) && (!M.blocked[i] || monTile.has(i));
		// 0-1 BFS: entering a guard ring from outside one costs 1
		let head = 0;
		const buf = dq.slice();
		const front = [];
		while (head < buf.length || front.length) {
			const c = front.length ? front.pop() : buf[head++];
			const l = Math.floor(c / (M.W * M.H)), x = c % M.W, y = Math.floor(c / M.W) % M.H;
			for (const [dx, dy] of N8) {
				if (!M.inb(x + dx, y + dy)) continue;
				const n = M.idx(l, x + dx, y + dy);
				if (!step(n)) continue;
				const w = M.guardOf[n] >= 0 && M.guardOf[c] < 0 ? 1 : 0;
				const nc = cost[c] + w;
				if (cost[n] < 0 || nc < cost[n]) { cost[n] = nc; if (w) buf.push(n); else front.push(n); }
			}
		}
	}
	const guardsTo = o => { let b = 99; for (const i of M.approach(o)) if (cost[i] >= 0) b = Math.min(b, cost[i]); return b; };
	const prizes = M.objs.filter(o => o.cls === 'high');
	put('high loot: 2+ guards between it and every start', prizes, o => guardsTo(o) >= 2 && guardsTo(o) < 99);
	put('high loot: no guard between it and a start', prizes, o => guardsTo(o) === 0);
	put('dwelling level 6+: 2+ guards between it and every start', A.census.filter(d => d.tier >= 6).map(d => d.o), o => guardsTo(o) >= 2 && guardsTo(o) < 99);

	// ---- strength and value against distance from the starts -------------------------------------------------------------
	const startTiles = A.starts.map(s => ({ l: s.l, at: s.at }));
	const nearStart = (o, r) => startTiles.some(s => s.l === o.l && sight.cheb(s.at, o.at) <= r);
	const known = G.filter(m => lvl(m) !== null);
	put('guard within 12 tiles of a start: level 1 to 4 creature', known.filter(m => nearStart(m, 12)), m => lvl(m) <= 4, gl);
	put('guard in an area with no town: level 6+ creature', known.filter(m => !M.regionsOf(m).some(r => townRegions.has(r)) && !nearStart(m, 20)), m => lvl(m) >= 6, gl);
	put('high loot: within 15 tiles of a start', prizes, o => nearStart(o, 15));
	put('guard holding a prize: holds lesser loot with it (a mixed pile)', G.filter(m => role.get(m) === 'prize'),
		m => closes.get(m).some(o => o.cls === 'low') && closes.get(m).some(o => o.cls === 'high' || o.cls === 'dwelling'), gl);

	// ---- guards crowding each other, roads doubled or thick (seen on Jebus Cross crops, 2026-10-01) ------------------------
	put('guard: another guard within 2 tiles (rings overlap)', G, m => G.some(n => n !== m && n.l === m.l && sight.cheb(n.at, m.at) <= 2), gl);
	put('guard: 3+ other guards within 4 tiles (a cluster)', G, m => G.filter(n => n !== m && n.l === m.l && sight.cheb(n.at, m.at) <= 4).length >= 3, gl);
	const isRoad = (l, x, y) => M.inb(x, y) && M.road[M.idx(l, x, y)];
	put('road tile: part of a 2x2 block of road (road 2+ wide)', roadTiles, ([l, x, y]) =>
		[[0, 0], [-1, 0], [0, -1], [-1, -1]].some(([ox, oy]) => isRoad(l, x + ox, y + oy) && isRoad(l, x + ox + 1, y + oy) && isRoad(l, x + ox, y + oy + 1) && isRoad(l, x + ox + 1, y + oy + 1)), rl);
	{
		// a second strand: a road tile of another piece within 2 tiles
		const comp = new Int32Array(M.NL * M.W * M.H).fill(-1);
		let n = 0;
		for (const [l, x, y] of roadTiles) {
			const s0 = M.idx(l, x, y);
			if (comp[s0] >= 0) continue;
			const st = [[l, x, y]]; comp[s0] = n;
			while (st.length) {
				const [cl, cx, cy] = st.pop();
				for (const [dx, dy] of N8) if (isRoad(cl, cx + dx, cy + dy) && comp[M.idx(cl, cx + dx, cy + dy)] < 0) { comp[M.idx(cl, cx + dx, cy + dy)] = n; st.push([cl, cx + dx, cy + dy]); }
			}
			n++;
		}
		put('road tile: another road piece within 2 tiles (a parallel strand)', roadTiles, ([l, x, y]) => {
			const c = comp[M.idx(l, x, y)];
			for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (isRoad(l, x + dx, y + dy) && comp[M.idx(l, x + dx, y + dy)] !== c) return true;
			return false;
		}, rl);
	}
	put('guard on a road: at a junction (3+ road directions)', G.filter(m => M.road[M.idx(m.l, m.at[0], m.at[1])]), m => {
		const ring = N8.map(([dx, dy]) => (isRoad(m.l, m.at[0] + dx, m.at[1] + dy) ? 1 : 0));
		let runs = 0; for (let k = 0; k < 8; k++) if (ring[k] && !ring[(k + 7) % 8]) runs++;
		return runs >= 3;
	}, gl);

	// ---- seen on Nostalgia crops: a dwelling in a notch with treasure beside it, roads that wind ---------------------------
	const dws = M.objs.filter(o => o.cls === 'dwelling');
	put('dwelling: no guard within 4 tiles (unattended)', dws, o => !G.some(m => m.l === o.l && sight.cheb(m.at, o.at) <= 4));
	put('dwelling behind a guard: shares the guard with treasure (a dwelling-and-pile pocket)', dws.filter(o => closedBy.has(o)),
		o => closes.get(closedBy.get(o)).some(p => p.cls === 'high' || p.cls === 'low'));
	{
		// straight runs: a road tile is on a straight run when 8+ road tiles line up through it in one direction
		const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
		const straight = ([l, x, y]) => dirs.some(([dx, dy]) => {
			let n = 1;
			for (let k = 1; k < 8 && isRoad(l, x + k * dx, y + k * dy); k++) n++;
			for (let k = 1; k < 8 && isRoad(l, x - k * dx, y - k * dy); k++) n++;
			return n >= 8;
		});
		put('road tile: on a straight run of 8+ tiles', roadTiles, straight, rl);
	}

	// ---- found by random patches (Nostalgia, 2026-10-01): clutter round towns, gates bunched at towns, buildings in clumps ---
	const nearTown = (o, r) => towns0.some(t => t.l === o.l && sight.cheb(t.at, o.at) <= r);
	put('creature bank: within 10 tiles of a town', M.objs.filter(o => o.cls === 'bank'), o => nearTown(o, 10));
	put('high loot: within 10 tiles of a town', M.objs.filter(o => o.cls === 'high'), o => nearTown(o, 10));
	put('guard: within 10 tiles of a town', G, m => nearTown(m, 10), gl);
	put('small building: within 10 tiles of a town', M.objs.filter(o => o.cls === 'other' && o.visitable && o.cells.length <= 6), o => nearTown(o, 10));
	const gatesAll = M.objs.filter(o => o.cls === 'gate');
	put('subterranean gate: within 10 tiles of a town', gatesAll, o => nearTown(o, 10));
	put('subterranean gate: another gate within 8 tiles on its level', gatesAll, o => gatesAll.some(g => g !== o && g.l === o.l && sight.cheb(g.at, o.at) <= 8));
	const monos = M.objs.filter(o => o.cls === 'monolith');
	put('monolith: another monolith within 4 tiles (side by side)', monos, o => monos.some(p => p !== o && p.l === o.l && sight.cheb(p.at, o.at) <= 4));
	const smalls = M.objs.filter(o => o.cls === 'other' && o.visitable && o.cells.length <= 6);
	put('small building: another small building within 4 tiles', smalls, o => smalls.some(p => p !== o && p.l === o.l && sight.cheb(p.at, o.at) <= 4));

	// ---- objects nobody can use, and objects standing in each other ----------------------------------------------------
	const usable = M.objs.filter(o => o.visitable && o.cls !== 'monster' && o.cls !== 'town');
	put('visitable object: no walkable tile to visit it from', usable, o => !M.approach(o).some(i => W.pass(i) || M.guardOf[i] >= 0));
	const owner = new Map();
	const overl = new Set();
	for (const o of M.objs) for (const [x, y] of o.cells) {
		const i = M.idx(o.l, x, y);
		if (owner.has(i) && owner.get(i) !== o) { overl.add(o); overl.add(owner.get(i)); } else owner.set(i, o);
	}
	put('visitable object: its footprint overlaps another object', usable, o => overl.has(o));
	// the small buildings: shrines, wells, signs, learning stones, markets and the rest
	const minor = M.objs.filter(o => o.cls === 'other' && o.visitable && o.cells.length <= 6);
	put('small building (shrine, well, stone...): sealed behind a guard', minor, o => !open(o));
	put('small building: in a town\'s area', minor, o => area(o) === 'town area');
	put('small building: against a wall', minor, o => wd(o) <= 1);
	// each start's wood and ore
	const startTowns = A.starts.map(s => towns0.find(t => t.l === s.l && t.at[0] === s.at[0] && t.at[1] === s.at[1])).filter(Boolean);
	const basicMine = /sawmill|orePit|lumber|wood|ore/i;
	put('start town: a wood or ore mine within 12 tiles', startTowns,
		t => M.objs.some(o => o.cls === 'mine' && o.l === t.l && basicMine.test(o.subtype || '') && sight.cheb(o.at, t.at) <= 12));
	put('start town: 2+ mines within 15 tiles', startTowns,
		t => M.objs.filter(o => o.cls === 'mine' && o.l === t.l && sight.cheb(o.at, t.at) <= 15).length >= 2);
	// gates: the engine pairs each surface gate with the nearest underground one
	const gs = M.objs.filter(o => o.cls === 'gate');
	put('subterranean gate: another gate within 10 tiles of the same spot on the other level', gs,
		g => gs.some(h => h.l !== g.l && sight.cheb(h.at, g.at) <= 10));

	// starts
	const st = A.starts;
	put('start: on the surface', st.map(s => ({ ...s, type: 'start', subtype: s.colour, at: s.at, l: s.l })), s => s.l === 0, s => `${s.colour}(${s.at},L${s.l})`);
	return { measures: meas, examples: ex, counter, counts };
}

module.exports = { describe, walls, AREA_MIN };
