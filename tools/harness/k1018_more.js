// k1018_more.js: three more checks merged into k1018_checks.js's CHECKS (K, 2026-10-18 15:36 via the lead: "connected almost by road, then the map generated
// terrain blockers over that, but there were still guards there like it was a choke point"). Appended to the module's CHECKS by a patch.
'use strict';
const N8 = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 0], [-1, 1]];
const ROAD_NEAR = 20, LIMIT_WALK = 200;

// tiles a hero reaches from the starts' doors: walkable land, a guard's tile (he fights it), water (he sails), and through every monolith pair
// and subterranean gate pair (the engine pairs gates by nearest, as mapsight does)
function reached(M) {
	const N = M.NL * M.W * M.H, seen = new Uint8Array(N), q = [];
	const monAt = new Set(M.objs.filter(o => o.cls === 'monster').map(o => M.idx(o.l || 0, o.at[0], o.at[1])));
	const WET = new Set(['wa', 'wt']);
	// a pickup's blocked tiles other than its entrance are walls: mapsight leaves pickups out of M.blocked, so the walk crossed a prison's
	// second tile into a pocket whose only way in was the prison's entrance, open to the pocket side only (Coldshadow 108x108 four players seed 45,
	// the prison (67..68,49) and the haspid (68,50) behind it)
	const wall = new Set();
	for (const o of M.objs) if (o.pickup) for (const [x, y] of o.cells) if (!o.entr.some(([ex, ey]) => ex === x && ey === y)) wall.add(M.idx(o.l || 0, x, y));
	const pass = i => monAt.has(i) || (!M.blocked[i] && !wall.has(i) && (M.ground(i) || WET.has(M.terr[i])));
	// ...until the pickup is taken: once a hero reaches its entrance the object goes (a freed prisoner becomes a hero standing on the entrance,
	// GameStatePackVisitor::visitGiveHero hides the prison and shows the hero, whose picture blocks its own tile only), and its other tiles
	// are ground. Kept walls, they made a pocket whose only door was a prison's second tile read unreached (36x36 six players two levels seed
	// 13 with the portal ends placed far apart: 7 guards on level 1 behind the prison (26,10), entered from below and reached)
	const freedBy = new Map();
	for (const o of M.objs) if (o.pickup) {
		const rest = o.cells.filter(([x, y]) => !o.entr.some(([ex, ey]) => ex === x && ey === y)).map(([x, y]) => M.idx(o.l || 0, x, y));
		if (rest.length) for (const [ex, ey] of o.entr) freedBy.set(M.idx(o.l || 0, ex, ey), rest);
	}
	const push = i => {
		if (i < 0 || i >= N || seen[i] || !pass(i)) return;
		seen[i] = 1; q.push(i);
		for (const f of freedBy.get(i) || []) { wall.delete(f); if (!seen[f] && pass(f)) { seen[f] = 1; q.push(f); } }
	};
	// a pickup's tile is stepped onto and off only through the sides its visitableFrom permits, both ends of the step, as the engine checks
	// (CMap::checkForVisitableDir): a '+' at vf[r][c] is the side (c-1, r-1). Without it the walk went through a lost wagon open below and to
	// its walled sides, into a pocket no hero enters (K's Coldshadow seed 2042393646: a reaper (79,55) and a golem (75,54) counted reached)
	const sides = new Map();
	const stepOffFree = new Set();
	for (const o of M.objs) {
		if (!o.pickup || !o.visitable) continue;
		const vf = o.template.visitableFrom || ['+++', '+-+', '+++'], ok = new Set();
		for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) if (vf[r] && vf[r][k] === '+') ok.add(`${k - 1},${r - 1}`);
		for (const [ex, ey] of o.entr) sides.set(M.idx(o.l || 0, ex, ey), ok);
		// a visited prison becomes the visitor's hero standing on that tile (CGHeroInstance.cpp, the prison's onHeroVisit): only the step ONTO the tile
		// is held to the prison's visitableFrom, the step off is a hero's own and goes any way (the Opus Reviewer, 2026-10-21: orphan-guards seeds 19 and 21 of
		// 36x36 six players, pockets whose only door is a prison)
		if (o.type === 'prison') for (const [ex, ey] of o.entr) stepOffFree.add(M.idx(o.l || 0, ex, ey));
	}
	const sight = require('../mapsight/lib/sight');
	for (const s of sight.starts(M)) {
		const t = M.objs.find(o => o.cls === 'town' && (o.l || 0) === s.l && Math.max(Math.abs(o.at[0] - s.at[0]), Math.abs(o.at[1] - s.at[1])) <= 1);
		if (t) for (const i of M.approach(t)) push(i);
		push(M.idx(s.l, s.at[0], s.at[1] + 1));
	}
	// teleports: each end's approach tiles lead to every other end of its kind
	const ends = new Map();
	for (const o of M.objs) {
		if (o.cls !== 'monolith' && o.cls !== 'gate') continue;
		const k = o.cls === 'gate' ? 'gate' : `${o.type}|${o.subtype}`;
		if (!ends.has(k)) ends.set(k, []);
		ends.get(k).push(o);
	}
	const hop = new Map();   // approach tile -> tiles of the other ends' approaches
	for (const [k, list] of ends) {
		if (k === 'gate') {
			const used = new Set();
			for (const g of list.filter(g => (g.l || 0) === 0)) {
				let best = null, bd = 1e9;
				for (const h of list) if ((h.l || 0) === 1 && !used.has(h)) { const d = Math.hypot(g.x - h.x, g.y - h.y); if (d < bd) { bd = d; best = h; } }
				if (!best) continue;
				used.add(best);
				for (const [a, b] of [[g, best], [best, g]]) for (const i of M.approach(a)) hop.set(i, [...(hop.get(i) || []), ...M.approach(b)]);
			}
		} else for (const a of list) for (const b of list) if (a !== b) for (const i of M.approach(a)) hop.set(i, [...(hop.get(i) || []), ...M.approach(b)]);
	}
	while (q.length) {
		const c = q.pop(), l = (c / (M.W * M.H)) | 0, r = c - l * M.W * M.H, x = r % M.W, y = (r / M.W) | 0;
		const off = stepOffFree.has(c) ? null : sides.get(c);
		for (const [dx, dy] of N8) {
			if (!M.inb(x + dx, y + dy)) continue;
			const n = M.idx(l, x + dx, y + dy), on = sides.get(n);
			if ((off && !off.has(`${dx},${dy}`)) || (on && !on.has(`${-dx},${-dy}`))) continue;
			push(n);
		}
		for (const j of hop.get(c) || []) push(j);
	}
	return seen;
}

// a guard with no tile beside it a hero reaches: it guards a passage that no longer exists, or stands walled in
function orphanGuards(M) {
	const seen = reached(M), bad = [];
	const mons = M.objs.filter(o => o.cls === 'monster');
	for (const m of mons) {
		let ok = false;
		for (const [dx, dy] of [[0, 0], ...N8]) { const x = m.at[0] + dx, y = m.at[1] + dy; if (M.inb(x, y) && seen[M.idx(m.l || 0, x, y)]) { ok = true; break; } }
		if (!ok) bad.push(`${m.type}:${m.subtype} L${m.l || 0} (${m.at})`);
	}
	return { pass: !bad.length, value: `${bad.length} of ${mons.length} guards with no tile beside them a hero reaches`, limit: 'none', items: bad.slice(0, 8), nums: { orphans: bad.length, guards: mons.length } };
}

// a road tile under a blocker: scenery's blocked cells over road a pass laid before it
function roadUnderBlocker(M) {
	const under = [];
	let roads = 0;
	const sceneryAt = new Map();
	// blocked cells only: a road onto a visiting tile is wanted, and a pickup vanishes when taken
	for (const o of M.objs) if (o.cls === 'other' && !o.pickup && o.cells) for (const [x, y] of o.cells) if (!o.entr.some(([ex, ey]) => ex === x && ey === y)) sceneryAt.set(M.idx(o.l || 0, x, y), o);
	for (let i = 0; i < M.NL * M.W * M.H; i++) {
		if (!M.road[i]) continue;
		roads++;
		const o = sceneryAt.get(i);
		if (o) { const l = (i / (M.W * M.H)) | 0, r = i - l * M.W * M.H; under.push(`L${l} (${r % M.W},${(r / M.W) | 0}) under ${o.type}`); }
	}
	if (!roads) return { skipped: 'no road' };
	return { pass: !under.length, value: `${under.length} of ${roads} road tiles under a blocker`, limit: 'none', items: under.slice(0, 8), nums: { under: under.length, roads } };
}

// one road piece touching both ends of a portal pair: the two zones meet by road there already
function portalRoadPair(M) {
	const N = M.NL * M.W * M.H, piece = new Int32Array(N).fill(-1);
	for (let s = 0, id = 0; s < N; s++) {
		if (!M.road[s] || piece[s] >= 0) continue;
		const q = [s]; piece[s] = id;
		while (q.length) {
			const c = q.pop(), l = (c / (M.W * M.H)) | 0, r = c - l * M.W * M.H, x = r % M.W, y = (r / M.W) | 0;
			for (const [dx, dy] of N8) if (M.inb(x + dx, y + dy)) { const n = M.idx(l, x + dx, y + dy); if (M.road[n] && piece[n] < 0) { piece[n] = id; q.push(n); } }
		}
		id++;
	}
	const touch = o => { const out = new Set(); const l = o.l || 0; for (const [dx, dy] of [[0, 0], ...N8]) { const x = o.at[0] + dx, y = o.at[1] + dy; if (M.inb(x, y)) { const p = piece[M.idx(l, x, y)]; if (p >= 0) out.add(p); } } return out; };
	const by = new Map();
	for (const o of M.objs) if (o.type === 'monolithTwoWay') { const k = String(o.subtype); if (!by.has(k)) by.set(k, []); by.get(k).push(o); }
	// the road walk between the two ends: from the road tiles beside one end to those beside the other, along road tiles only
	const near = o => { const out = []; const l = o.l || 0; for (const [dx, dy] of [[0, 0], ...N8]) { const x = o.at[0] + dx, y = o.at[1] + dy; if (M.inb(x, y) && M.road[M.idx(l, x, y)]) out.push(M.idx(l, x, y)); } return out; };
	const walk = (A, B) => {
		const goal = new Set(B), dist = new Map(A.map(i => [i, 0])), q = [...A];
		for (let h = 0; h < q.length; h++) {
			const c = q[h], d = dist.get(c);
			if (goal.has(c)) return d;
			if (d >= LIMIT_WALK) continue;
			const l = (c / (M.W * M.H)) | 0, r = c - l * M.W * M.H, x = r % M.W, y = (r / M.W) | 0;
			for (const [dx, dy] of N8) if (M.inb(x + dx, y + dy)) { const n = M.idx(l, x + dx, y + dy); if (M.road[n] && !dist.has(n)) { dist.set(n, d + 1); q.push(n); } }
		}
		return Infinity;
	};
	const bad = [], walks = []; let pairs = 0;
	for (const [k, v] of by) {
		if (v.length !== 2 || (v[0].l || 0) !== (v[1].l || 0)) continue;
		pairs++;
		const a = touch(v[0]), b = touch(v[1]);
		if (![...a].some(p => b.has(p))) continue;
		const w = walk(near(v[0]), near(v[1]));
		walks.push(w);
		if (w <= ROAD_NEAR) bad.push(`${k} L${v[0].l || 0} (${v[0].at}) and (${v[1].at}) ${w} road tiles apart`);
	}
	if (!pairs) return { skipped: 'no portal pair on one level' };
	return { pass: !bad.length, value: `${bad.length} of ${pairs} portal pairs whose two ends a road joins within ${ROAD_NEAR} tiles`, limit: 'none', items: bad, nums: { joined: bad.length, pairs, walks } };
}

// every pickup and every object a hero visits, reached on foot from a start (the walk above: monsters passable, a pickup entered only from
// the sides its visitableFrom permits, teleports joined). The last guard sweep takes the guards out of a pocket no hero enters, and
// orphan-guards then reads 0 while the pocket's loot stays shut (K's Coldshadow seed 2042393646: a relic, a major artifact, two Pandora's boxes, a
// resource and a lost wagon behind the wagon (74,52), whose open sides are walled); this keeps that counted (the Opus Reviewer, pass 174).
// A pickup counts reached when its own tile is; anything else when a tile it is visited from is. Bar: none.
function lootReach(M) {
	const seen = reached(M), bad = [];
	let n = 0;
	for (const o of M.objs) {
		if (!o.visitable || o.cls === 'monster') continue;
		n++;
		const ok = o.pickup ? o.entr.some(([x, y]) => seen[M.idx(o.l || 0, x, y)]) : M.approach(o).some(i => seen[i]);
		if (!ok) bad.push(`${o.type}:${o.subtype} L${o.l || 0} (${o.at})`);
	}
	return { pass: !bad.length, value: `${bad.length} of ${n} pickups and visited objects no hero reaches`, limit: 'none', items: bad.slice(0, 10), nums: { shut: bad.length, objects: n } };
}

// pickups the game draws another object over, half of their picture or more (overlap_scan.js: each sprite decoded and placed as the game
// places it, in CMap::compareObjectBlitOrder's order; the roots are VCMI_ROOT and VCMI_USER_DIR). The engine's own maps hide 4% to 11% of their
// pickups that way (ten maps of five templates, 2026-10-18); K: "crawling grids around instances of the shield and finding cases where the art
// could be overlapped". Bar: none. A map whose sprites cannot be read is skipped, never passed.
function pickupHidden(M) {
	const { scan } = require('./overlap_scan');
	const r = scan(M.file, { min: 1 });
	const pk = x => x.cls === 'low' || x.cls === 'high';
	const read = M.objs.filter(o => o.template && o.template.animation).length - r.missing.reduce((t, m) => t + m[1], 0);
	if (read <= 0) return { skipped: 'no sprite read (VCMI_ROOT, VCMI_USER_DIR)' };
	const bad = r.items.filter(x => pk(x) && x.share >= 0.5);
	return { pass: !bad.length, value: `${bad.length} of ${r.pickups} pickups half hidden or more under another object's picture`, limit: 'none',
		items: bad.slice(0, 8).map(x => `L${x.l} ${x.a} (${x.at}) ${Math.round(100 * x.share)}% under ${x.by[0]}`), nums: { hidden: bad.length, pickups: r.pickups } };
}

module.exports = { CHECKS: { 'orphan-guards': orphanGuards, 'road-under-blocker': roadUnderBlocker, 'portal-road-pair': portalRoadPair, 'loot-reach': lootReach, 'pickup-hidden': pickupHidden }, reached };
