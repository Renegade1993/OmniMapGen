'use strict';
/**
 * Dwellings and dear piles are closed to a flying hero (K, 2026-10-05 15:14 and 2026-10-06 15:03).
 *
 * K's order of interdiction is guard, loot, guard, wall. A walker is stopped by anything on the tiles it would visit from; a flyer
 * goes over terrain and is stopped only by an object on the tile or by a monster whose 3x3 it enters. So every tile an object can
 * be visited from (its visitableFrom round its entrance) must be taken by an object, stand in a monster's ring, or be closed.
 * The guard passes before this one post a monster beside the object, and one monster covers only the tiles next to it: the
 * rest of the approach stayed open (the Opus Reviewer's test, flyerdw.js: 17.7% of dwellings and 21.0% of dear piles on the
 * 80-map grid). K: the second pass that closes those gaps should use terrain blockers, not more guards.
 *
 * For each dwelling and dear pile: an object with no monster in reach of any approach tile gets one on an approach tile (the one
 * whose ring covers the most others); every other open approach tile gets a one-tile obstacle of its zone's ground, provided
 * the tile is not a road, a reserved or held tile, nor the last way to another object, and provided taking it away leaves the
 * walkable ground round it joined (the simple-point test on its eight neighbours, so no pocket is made and no path cut). A tile
 * that cannot be closed gets a guard as before; one that can be neither stays open and is counted.
 */

const KIND = /^(randomArtifactRelic|randomArtifactMajor|pandoraBox|artifact|spellScroll|creatureGenerator)/;
const MON = /^(monster|randomMonster)/;
const DRAGON = /^(frozenCliffs|crystalCavern|magicForest|sulfurousLair)$/i;
const PICKUP =/^(resource|randomResource|treasureChest|randomArtifact\w*|artifact|campfire|seaChest|flotsam|spellScroll|pandoraBox|prison)$/;
const LEVEL = { randomArtifactRelic: 6, randomArtifactMajor: 5, pandoraBox: 5, artifact: 4, spellScroll: 3 };

function closeApproaches(pl, l, W, H, blocked, p, d) {
	const out = { objects: 0, closed: 0, posted: 0, left: 0 };
	const zone = pl.zone;
	if (!zone || !pl.biomeTerrain) return out;
	const { OCCUPIED, RESERVED, APPROACH, blockingCells, visitableCells, allowedDirs, footprintBlock, objectEntry, singleTemplate, rng } = d;
	const base = l * W * H, roads = pl.roadCells || new Set(), water = pl.p && pl.p.water;
	const dwellingsOn = Number(p.guardDwellings) !== 0;
	const land = c => zone[c] >= 0 && !(water && water[c]) && (!pl.openMask || pl.openMask[c]);
	const at = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? y * W + x : -1);

	// the tiles a hero may visit an object from, open or not
	const approachAll = o => {
		const own = new Set(blockingCells(o.template, o.x, o.y).map(([a, b]) => b * W + a));
		const res = new Set();
		for (const [vx, vy] of visitableCells(o.template, o.x, o.y))
			for (const [dx, dy] of allowedDirs(o.template)) {
				const c = at(vx + dx, vy + dy);
				if (c >= 0 && !own.has(c)) res.add(c);
			}
		return [...res];
	};
	const monsterAt = new Set(), ring = new Set();
	const addRing = c => {
		const x = c % W, y = (c / W) | 0;
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const n = at(x + dx, y + dy); if (n >= 0) ring.add(n); }
	};
	for (const o of pl.objects) if ((o.l || 0) === l && MON.test(o.type)) { monsterAt.add(o.y * W + o.x); addRing(o.y * W + o.x); }

	// who else needs a tile: the approach tiles of every other visitable object but a monster
	const owners = new Map(), appOf = new Map();
	for (const o of pl.objects) {
		if ((o.l || 0) !== l || !o.template || !o.template.mask || MON.test(o.type)) continue;
		const a = approachAll(o);
		if (!a.length) continue;
		appOf.set(o, a);
		for (const c of a) { if (!owners.has(c)) owners.set(c, []); owners.get(c).push(o); }
	}
	// a monster that is another object's guard too (a pile, a mine, a dwelling, a bank within a tile of it) is not moved
	const servesOther = (m, o) => pl.objects.some(q => q !== o && q !== m && (q.l || 0) === l && q.template && q.template.mask && !MON.test(q.type)
		&& (PICKUP.test(q.type) || visitableCells(q.template, q.x, q.y).length)
		&& blockingCells(q.template, q.x, q.y).some(([a, b]) => Math.max(Math.abs(a - m.x), Math.abs(b - m.y)) <= 1));
	const isFree = c => land(c) && !(blocked[base + c] & OCCUPIED);
	const wayIn = c => isFree(c) || (process.env.VMAPGEN_WAY_PAST_GUARD !== '0' && monsterAt.has(c));
	// guard spacing (content.js, the guard register): a tile within 2 of another stack takes a guard only where nothing else will do
	const GAP = require('./content').GUARD_GAP;
	const farAt = (c, but = -1) => { const x = c % W, y = (c / W) | 0; for (const m of monsterAt) if (m !== c && m !== but && Math.max(Math.abs(m % W - x), Math.abs(((m / W) | 0) - y)) < GAP) return false; return true; };
	// within 2 of another stack: never posted where an open tile can stay instead
	const crowdAt = (c, but = -1) => { const x = c % W, y = (c / W) | 0; for (const m of monsterAt) if (m !== c && m !== but && Math.max(Math.abs(m % W - x), Math.abs(((m / W) | 0) - y)) <= 2) return true; return false; };
	const DEAR_TYPE = /^(randomArtifactRelic|randomArtifactMajor|pandoraBox|artifact)$/;
	// and a prison of 90000 experience or more, as guardDearLoot counts it (a flyer lands beside it): the thin step took the only guard of a
	// 90000 prison when this knew only the piles (K's XL underground seed 1594927109, 2026-10-09)
	const DEAR = { test: (t, q) => DEAR_TYPE.test(t) || (t === 'prison' && !!q && !!q.options && q.options.experience >= 90000) };
	// a dear pile whose visiting tile is beside the monster: taking the monster away leaves it unguarded for a flyer that lands on it
	const leansOn = (q, m) => DEAR.test(q.type, q) && visitableCells(q.template, q.x, q.y).some(([a, b]) => Math.max(Math.abs(a - m.x), Math.abs(b - m.y)) <= 1);
	// a monster on or beside a tile of the object (MapGen Dev's flyer-open: a dear pile with none is open to a flyer that lands on it)
	const monsterBeside = q => visitableCells(q.template, q.x, q.y).some(([fx, fy]) => { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const c = at(fx + dx, fy + dy); if (c >= 0 && monsterAt.has(c)) return true; } return false; });
	// a hero walks onto a pickup (and fights a monster), so both stand on ground that is walked
	const pickAt = new Set();
	for (const o of pl.objects)
		if ((o.l || 0) === l && o.template && o.template.mask && PICKUP.test(o.type))
			for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) { const c = at(fx, fy); if (c >= 0) pickAt.add(c); }
	const walk = c => c >= 0 && land(c) && (!(blocked[base + c] & OCCUPIED) || monsterAt.has(c) || pickAt.has(c));

	// the eight neighbours of c that a hero can stand on are one piece (so taking c away cuts nothing)
	const simple = c => {
		const x = c % W, y = (c / W) | 0, nb = [];
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			if (!dx && !dy) continue;
			const n = at(x + dx, y + dy);
			if (n >= 0 && walk(n)) nb.push([dx, dy]);
		}
		if (nb.length <= 1) return true;
		// the walkable neighbours must still meet by a way within 6 tiles of c that does not use c
		const R = 6, seen = new Set(), stack = [];
		const first = at(x + nb[0][0], y + nb[0][1]);
		seen.add(first); stack.push(first);
		while (stack.length) {
			const i = stack.pop(), ix = i % W, iy = (i / W) | 0;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue;
				const n = at(ix + dx, iy + dy);
				if (n < 0 || n === c || seen.has(n) || Math.abs(n % W - x) > R || Math.abs(((n / W) | 0) - y) > R || !walk(n)) continue;
				seen.add(n); stack.push(n);
			}
		}
		return nb.every(([dx, dy]) => seen.has(at(x + dx, y + dy)));
	};
	// the walkable neighbours of c still meet without c anywhere on the level (a longer way round than simple() looks at; the engine closes a
	// pile's border wherever its zone stays joined). Bounded by the level's size.
	const joinedWithout = c => {
		const x = c % W, y = (c / W) | 0, nb = [];
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; const n = at(x + dx, y + dy); if (n >= 0 && walk(n)) nb.push(n); }
		if (nb.length <= 1) return true;
		const want = new Set(nb.slice(1)), seen = new Uint8Array(W * H), stack = [nb[0]];
		seen[nb[0]] = 1; seen[c] = 1;
		while (stack.length && want.size) {
			const i = stack.pop(), ix = i % W, iy = (i / W) | 0;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue;
				const n = at(ix + dx, iy + dy);
				if (n < 0 || seen[n] || !walk(n)) continue;
				seen[n] = 1; want.delete(n); stack.push(n);
			}
		}
		return !want.size;
	};
	const guardOk = (c, o) => {
		const x = c % W, y = (c / W) | 0;
		if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) return false;
		if (!isFree(c) || (blocked[base + c] & RESERVED) || roads.has(c)) return false;
		if (zone[c] !== zone[o.y * W + o.x]) return false;
		for (let ey = -1; ey <= 1; ey++) for (let ex = -1; ex <= 1; ex++) if (roads.has((y + ey) * W + x + ex)) return false;
		return true;
	};
	const post = (c, o) => {
		// a template map's guard stands at the strength the engine's own maps give what it stands over (content.js lootGuard)
		const zi = zone[o.y * W + o.x], meta = pl.zoneMeta && pl.zoneMeta[zi];
		if (pl.objectPools && pl.objectPools.guards && meta && meta.spec && d.lootGuard) {
			const kind = /^creatureGenerator/.test(o.type) ? (DRAGON.test(o.subtype || '') ? 'dragonDwelling' : 'dwelling') : o.type;
			const g = d.lootGuard(kind, p, rng, d.zoneGuardPool(pl.objectPools.guards, meta.spec));
			if (g) {
				const x = c % W, y = (c / W) | 0;
				const ge = objectEntry(`randomMonsterLevel${g.level}`, x, y, l, d.monsterTpl, 'object', { character: 'hostile', amount: d.scaledAmount ? d.scaledAmount(g.amount, p) : g.amount });
				ge.guardCreature = g.creature;
				pl.objects.push(ge);
				footprintBlock(d.monsterTpl, x, y, l, W, H, blocked);
				monsterAt.add(c); addRing(c);
				out.posted++;
				return;
			}
		}
		let level = Math.max(1, Math.min(7, (/^creatureGenerator/.test(o.type) ? 4 : (LEVEL[o.type] || 4)) + Math.round(Number(p.monsterStrength) || 0)));
		let lend = null, ld = Infinity;
		for (const m of pl.objects) {
			if ((m.l || 0) !== l || !MON.test(m.type) || !m.guardCreature) continue;
			if (zone[m.y * W + m.x] !== zone[o.y * W + o.x]) continue;
			const dd = Math.max(Math.abs(m.x - o.x), Math.abs(m.y - o.y));
			if (dd < ld) { ld = dd; lend = m; }
		}
		if (lend) { const lv = /Level(\d)/.exec(lend.type); if (lv) level = +lv[1]; }
		const x = c % W, y = (c / W) | 0;
		const ge = objectEntry(`randomMonsterLevel${level}`, x, y, l, d.monsterTpl, 'object', lend && lend.options ? { ...lend.options } : d.monsterOptions(level, p, rng));
		if (lend) ge.guardCreature = lend.guardCreature;
		pl.objects.push(ge);
		footprintBlock(d.monsterTpl, x, y, l, W, H, blocked);
		monsterAt.add(c); addRing(c);
		out.posted++;
	};
	const why = out.why = {};
	const trial = [];    // the blockers laid since it was last emptied, so a guard taken away can be put back
	let lastNo = '';
	const no = k => { why[k] = (why[k] || 0) + 1; lastNo = k; return false; };
	const block = (c, o) => {
		if (!isFree(c)) return no('taken');
		if (blocked[base + c] & RESERVED) return no('reserved');
		if (roads.has(c)) return no('road');
		if (zone[c] !== zone[o.y * W + o.x]) return no('other zone');
		// the object itself keeps a free way in: closing a mine's two open front tiles left only the tile under a subterranean gate in its
		// guard's ring, and the mine was sealed (grid, 72x72 two levels four players seed 2, 2026-10-09)
		// a guard's tile is a way in too (a hero beats it and steps there): two piles whose only free tile was a dead end below them, reached
		// by a flyer alone, kept it open while their guard stood on the tile above (K's small underground map seed 1750425234, (6,5) and (7,5)
		// level 1; dear piles open 11 of 36). VMAPGEN_WAY_PAST_GUARD=0 counts free tiles only.
		if (appOf.get(o) && !appOf.get(o).some(a => a !== c && wayIn(a))) return no('own last way');
		for (const q of owners.get(c) || []) {
			if (q === o) continue;
			if (!appOf.get(q).some(a => a !== c && wayIn(a))) return no('last way of another');
		}
		if (!simple(c) && !joinedWithout(c)) return no('would cut');
		let st = singleTemplate(pl.biomeTerrain[zone[c]], rng);
		if ((!st || !st.tpl.mask || st.tpl.mask.length !== 1 || st.tpl.mask[0].length !== 1) && !pl.openMask) st = singleTemplate('dt', rng);
		if (!st || !st.tpl.mask || st.tpl.mask.length !== 1 || st.tpl.mask[0].length !== 1) return no('no art');
		const x = c % W, y = (c / W) | 0;
		const be = objectEntry(st.type, x, y, l, st.tpl, st.subtype || 'object');
		pl.objects.push(be);
		trial.push({ e: be, c });
		footprintBlock(st.tpl, x, y, l, W, H, blocked);
		out.closed++;
		return true;
	};

	// a dear pile has a monster on or beside its tile (a flyer that lands on it meets the ring; MapGen Dev's flyer-open, the Reviewer's 0.1% before this pass)
	// a start's own zone: no guard on its roads or beside them (a stack there stands across the start's way out; 36x36 eight players seed 901)
	// the ways from each start to the other towns of its zone (plan.js startWayCells): no guard whose ring covers one (a stack there stands across
	// the start's way out; 36x36 eight players seed 901); this replaced "no guard on or beside a road in a start's zone", which left a Pandora's box
	// beside a start's road with no guard (the Opus Reviewer, M8)
	const startWay = d.startWayCells ? d.startWayCells(pl, l, W, H, blocked) : new Set();
	const byStartRoad = c => { if (!startWay.size) return false; const x = c % W, y = (c / W) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const u = x + dx, v = y + dy; if (u >= 0 && v >= 0 && u < W && v < H && startWay.has(v * W + u)) return true; } return false; };
	// no exception for a gold mine's guard: one stood on a start's road when no town was within 8 tiles (written when the set was every road of a start's
	// zone), and once the set became the start's ways to its own towns, the final gold run put a guard on green's way from (135,32) to its second town
	// (136,77) at (139,44), grid 144x144 four players one level seed 1 (own town behind a guard; 084ac2c passes)
	const roadBlock = c => byStartRoad(c);
	// a stack's ring cuts a way when ground just outside it meets only through it (walked tiles; a monster or pickup counts as walked)
	const cutsWay = c => {
		const x = c % W, y = (c / W) | 0, R = new Set(), B = [];
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const n = at(x + dx, y + dy); if (n >= 0) R.add(n); }
		for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { if (Math.max(Math.abs(dx), Math.abs(dy)) < 2) continue; const n = at(x + dx, y + dy); if (n >= 0 && walk(n)) B.push(n); }
		if (B.length <= 1) return false;
		const reach = through => {
			const seen = new Uint8Array(W * H), st = [B[0]];
			seen[B[0]] = 1;
			while (st.length) {
				const i = st.pop(), ix = i % W, iy = (i / W) | 0;
				for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
					const n = at(ix + dx, iy + dy);
					if (n < 0 || seen[n] || !walk(n) || (!through && R.has(n))) continue;
					seen[n] = 1; st.push(n);
				}
			}
			return seen;
		};
		const without = reach(false);
		if (B.every(n => without[n])) return false;
		const withR = reach(true);
		return B.some(n => withR[n] && !without[n]);
	};
	// a guard on a corridor held clear (RESERVED) or beside a road, where no other tile in front of the object can take one: never on a road
	// or a start's way, and only where its ring cuts no way. A dwelling whose whole front lay on a corridor kept no guard at all (K's large
	// two players map seed 406757261, magic lantern (90,103), no monster within 6; three of ten dwellings open)
	const wayGuardOk = (c, o) => {
		if (process.env.VMAPGEN_GUARD_ON_WAY === '0') return false;
		const x = c % W, y = (c / W) | 0;
		if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) return false;
		if (!isFree(c) || roads.has(c) || zone[c] !== zone[o.y * W + o.x] || byStartRoad(c)) return false;
		return !cutsWay(c);
	};
	const besideFix = o => {
		if (!DEAR.test(o.type, o) || monsterBeside(o)) return;
		const foot = new Set(blockingCells(o.template, o.x, o.y).map(([a, b]) => at(a, b)));
		const vis = visitableCells(o.template, o.x, o.y).map(([a, b]) => at(a, b)).filter(c => c >= 0);
		const cs = new Set();
		for (const f of vis) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const c = at((f % W) + dx, ((f / W) | 0) + dy); if (c >= 0 && !foot.has(c)) cs.add(c); }
		const pick = [...cs].filter(c => guardOk(c, o)).sort((a, b) => (crowdAt(a) ? 2 : farAt(a) ? 0 : 1) - (crowdAt(b) ? 2 : farAt(b) ? 0 : 1));
		// none a guard may usually take: a free tile of the zone beside a road, then the road itself, as the engine stands guards on roads
		// (a 500000 prison by a road with no monster beside it, 144x144 eight players seed 2, MapGen Dev 2026-10-09)
		if (!pick.length) {
			const last = [...cs].filter(c => isFree(c) && !byStartRoad(c) && zone[c] === zone[o.y * W + o.x] && c % W > 0 && ((c / W) | 0) > 0 && c % W < W - 1 && ((c / W) | 0) < H - 1)
				.sort((u, v) => ((roads.has(u) ? 2 : 0) + ((blocked[base + u] & RESERVED) ? 1 : 0)) - ((roads.has(v) ? 2 : 0) + ((blocked[base + v] & RESERVED) ? 1 : 0)));
			if (last.length) pick.push(last[0]);
		}
		if (pick.length) { post(pick[0], o); out.beside = (out.beside || 0) + 1; }
		else { const r = [...cs].map(c => (!isFree(c) ? 'occ' : (blocked[base + c] & RESERVED) ? 'res' : roads.has(c) ? 'road' : zone[c] !== zone[o.y * W + o.x] ? 'zone' : 'nearroad')); for (const k of r) no('beside ' + k); }
	};
	// The guard of an object that still has an open approach tile moves to the tile whose ring covers every open one, when it guards nothing
	// else, the tile is free and a guard may stand there, and no other stack is within 2 of it (2026-10-08: a dwelling's approach is up to five
	// tiles wide, and the spacing rule took away the second guard its corners used to get; dwellings open 21 to 38% on K's maps).
	const resite = (o, app, nearRoad = false) => {
		const openNow = app.filter(c => isFree(c) && !ring.has(c));
		if (!openNow.length) return false;
		const vis = visitableCells(o.template, o.x, o.y);
		const own = pl.objects.filter(m => MON.test(m.type) && (m.l || 0) === l && !(blocked[base + m.y * W + m.x] & RESERVED)
			&& app.some(c => Math.max(Math.abs(c % W - m.x), Math.abs(((c / W) | 0) - m.y)) <= 1) && !servesOther(m, o));
		for (const m of own) {
			const mc = m.y * W + m.x;
			// the rings of every other stack
			const others = new Set();
			for (const k of monsterAt) if (k !== mc) { const kx = k % W, ky = (k / W) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const n = at(kx + dx, ky + dy); if (n >= 0) others.add(n); } }
			const need = app.filter(c => (isFree(c) || c === mc) && !others.has(c));
			const cands = new Set();
			for (const [vx, vy] of vis) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const c = at(vx + dx, vy + dy); if (c >= 0 && c !== mc) cands.add(c); }
			for (const c of cands) {
				if (nearRoad === 'way' ? !wayGuardOk(c, o) : nearRoad ? !(isFree(c) && !(blocked[base + c] & RESERVED) && !roads.has(c) && zone[c] === zone[o.y * W + o.x] && c % W > 0 && ((c / W) | 0) > 0 && c % W < W - 1 && ((c / W) | 0) < H - 1) : !guardOk(c, o)) continue;
				const cx = c % W, cy = (c / W) | 0;
				if ([...monsterAt].some(k => k !== mc && Math.max(Math.abs(k % W - cx), Math.abs(((k / W) | 0) - cy)) <= 2)) continue;
				if (!need.every(a => a === c || Math.max(Math.abs(a % W - cx), Math.abs(((a / W) | 0) - cy)) <= 1)) continue;
				if (!simple(c)) continue;
				blocked[base + mc] &= ~OCCUPIED; monsterAt.delete(mc);
				m.x = cx; m.y = cy; m.instanceName = `${m.type}_${cx}_${cy}_${l}`;
				footprintBlock(d.monsterTpl, cx, cy, l, W, H, blocked);
				monsterAt.add(c);
				ring.clear(); for (const k of monsterAt) addRing(k);
				out.resited = (out.resited || 0) + 1;
				return true;
			}
		}
		return false;
	};
	// d.only 'gold': the last run, after the late passes (guards for gold mines whose door the passes opened, no walls, no regrouping of stacks)
	const goldOnly = d.only === 'gold';
	stages: {
	if (goldOnly) break stages;
	for (const o of pl.objects.slice()) {
		if ((o.l || 0) !== l || !KIND.test(o.type) || !o.template || !o.template.mask) continue;
		if (/^creatureGenerator/.test(o.type) && !dwellingsOn) continue;
		const app = approachAll(o);
		const open = () => app.filter(c => isFree(c) && !ring.has(c));
		let todo = open();
		if (!todo.length) { besideFix(o); continue; }
		out.objects++;
		// no monster within reach of the approach: one goes on the approach tile whose ring covers the most of the rest
		if (!app.some(c => ring.has(c))) {
			// a guard that stands against this object's back and is no other object's goes to the approach tile instead of another being posted
			// (and is no crowding there: it leaves where it stood)
			const footTiles = [...new Set(blockingCells(o.template, o.x, o.y).map(([a, b]) => at(a, b)))];
			const back = pl.objects.find(m => MON.test(m.type) && (m.l || 0) === l && m.guardCreature && !(blocked[base + m.y * W + m.x] & RESERVED)
				&& footTiles.some(f => f >= 0 && Math.max(Math.abs(f % W - m.x), Math.abs(((f / W) | 0) - m.y)) <= 1) && !servesOther(m, o));
			const backAt = back ? back.y * W + back.x : -1;
			let best = -1, bn = -1;
			for (const c of todo) {
				const ok = guardOk(c, o);
				if (!ok && (crowdAt(c, backAt) || !wayGuardOk(c, o))) continue;
				// a tile a guard may usually take wins a tie
				let n = (crowdAt(c, backAt) ? -100 : farAt(c, backAt) ? 0 : -50) + (ok ? 0.5 : 0);
				for (const e of todo) if (Math.max(Math.abs(e % W - c % W), Math.abs(((e / W) | 0) - ((c / W) | 0))) <= 1) n++;
				if (n > bn) { bn = n; best = c; }
			}
			if (best >= 0) {
				if (back) {
					blocked[base + back.y * W + back.x] &= ~OCCUPIED;
					monsterAt.delete(back.y * W + back.x);
					back.x = best % W; back.y = (best / W) | 0;
					back.instanceName = `${back.type}_${back.x}_${back.y}_${l}`;
					footprintBlock(d.monsterTpl, back.x, back.y, l, W, H, blocked);
					monsterAt.add(best);
					ring.clear();
					for (const c of monsterAt) addRing(c);
					out.moved = (out.moved || 0) + 1;
				} else { post(best, o); out.first = (out.first || 0) + 1; }
			}
		}
		// a way in must stay: an approach tile that is free or holds the guard, inside a ring. With none (no guard could stand), nothing is closed
		if (!app.some(c => ring.has(c) && (isFree(c) || monsterAt.has(c)))) { out.left++; continue; }
		const skip = new Set();
		for (let n = 0; n < 16; n++) {
			todo = open().filter(c => !skip.has(c));
			if (!todo.length) break;
			const c = todo[0];
			if (block(c, o)) continue;
			// cannot be closed: a guard on it, as before; if that cannot stand either it stays open
			// not beside another stack: the tile stays open instead (approach-open has room under the engine's 7 to 18%; a second
			// stack beside the first is the crowding the engine never shows)
			if (guardOk(c, o) && !crowdAt(c)) { post(c, o); continue; }
			if (!crowdAt(c) && wayGuardOk(c, o)) { post(c, o); out.onWay = (out.onWay || 0) + 1; continue; }
			if (process.env.VMAPGEN_THIN_TRACE && /^creatureGenerator/.test(o.type)) { const k = 'dw open: ' + lastNo + (guardOk(c, o) ? ' (guard would crowd)' : ' (no guard: ' + ((blocked[base + c] & RESERVED) ? 'reserved' : roads.has(c) ? 'road' : 'near road/edge/zone') + ')'); why[k] = (why[k] || 0) + 1; }
			skip.add(c);
			out.left++;
		}
		if (open().length && (resite(o, app) || resite(o, app, 'way'))) out.left -= Math.min(out.left, skip.size);
		besideFix(o);
	}
	// Phase 1c (K, 2026-10-08: "there are loads of monsters in ours that might be close to loot, but they aren't affectively guarding the loot, so they
	// are essentially freestanding"). Of the objects with a stack within 2 of their visit tile, a walker took 69% of the cheap piles, 40% of the banks
	// and 49% of the mines past it (the engine's 16%, 2% and 0%; stack_effect.js). A bank, a mine or a cheap pile with a guard's ring over one of its
	// ways in has its other open ways closed with blockers, under the same tests as above (no road, no reserved tile, not another object's last way,
	// no cut). No guard is posted for them: the stack beside it is the guard.
	out.closedBeside = 0;
	const BESIDE = /^(creatureBank|dragonUtopia|crypt|mine|abandonedMine|resource|randomResource|treasureChest|campfire|randomArtifactTreasure|randomArtifactMinor)$/;
	for (const o of pl.objects.slice()) {
		if ((o.l || 0) !== l || !BESIDE.test(o.type) || !o.template || !o.template.mask) continue;
		const app = appOf.get(o);
		if (!app || !app.some(c => ring.has(c))) continue;
		for (const c of app.filter(c => isFree(c) && !ring.has(c))) if (block(c, o)) out.closedBeside++;
		// a bank or a mine still open: its own guard (one that serves nothing else) moves to cover every open way, beside a road if it must
		if (/^(creatureBank|dragonUtopia|crypt|mine|abandonedMine)$/.test(o.type) && app.some(c => isFree(c) && !ring.has(c)) && resite(o, app, true)) out.resitedBeside = (out.resitedBeside || 0) + 1;
	}
	// a cheap pile still open beside a stack goes into that stack's ring, as phase 1b moves a dear pile (relocate, below, is defined later: the
	// list is kept and done after it)
	const cheapOpen = pl.objects.filter(o => (o.l || 0) === l && /^(resource|randomResource|treasureChest|campfire|randomArtifactTreasure|randomArtifactMinor)$/.test(o.type)
		&& o.template && o.template.mask && !o.__walled && appOf.get(o) && appOf.get(o).some(c => ring.has(c)) && appOf.get(o).some(c => isFree(c) && !ring.has(c)));
	// Guards that crowd one another (K, 2026-10-05: "loot guard clusters are now popping up everywhere and are the only thing that really
	// diverges from basegame"; MapGen Dev's guard-clusters check: 30 to 55% of our stacks have another within 2 tiles on K's maps, the
	// engine's Coldshadow maps 0.4%). A stack with another within 2 tiles is taken away, the weakest first, when every dwelling and dear
	// pile it stood beside is still guarded after it (a way in inside some other guard's ring, every other open approach closed with a
	// blocker) and nothing else near it (a cheap pile, a mine, a bank) loses the guard it had. Otherwise it stays.
	const values = require('./creature_values.json');
	const strengthOf = m => (m.guardCreature && values[m.guardCreature] && m.options ? m.options.amount * values[m.guardCreature].aiValue : 0);
	const monsOf = () => pl.objects.filter(m => (m.l || 0) === l && MON.test(m.type));
	const ringCount = () => {
		const rc = new Map();
		for (const m of monsOf()) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const n = at(m.x + dx, m.y + dy); if (n >= 0) rc.set(n, (rc.get(n) || 0) + 1); }
		return rc;
	};
	out.thinned = 0;
	for (let round = 0; round < 3; round++) {
		let removed = 0;
		const all = monsOf();
		const cands = all.filter(m => !(blocked[base + m.y * W + m.x] & RESERVED) && all.some(n => n !== m && Math.max(Math.abs(n.x - m.x), Math.abs(n.y - m.y)) <= 2))
			.sort((a, b) => strengthOf(a) - strengthOf(b));
		for (const m of cands) {
			if (!pl.objects.includes(m)) continue;
			const rc = ringCount();
			const mc = m.y * W + m.x;
			// still crowded by another stack?
			if (!monsOf().some(n => n !== m && Math.max(Math.abs(n.x - m.x), Math.abs(n.y - m.y)) <= 2)) continue;
			const lost = new Set();
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const n = at(m.x + dx, m.y + dy); if (n >= 0 && rc.get(n) === 1) lost.add(n); }
			const affected = [];
			let ok = true;
			for (const [q, a] of appOf) {
				if (!a.some(c => lost.has(c) && (isFree(c) || monsterAt.has(c))) && !leansOn(q, m)) continue;
			if (!KIND.test(q.type) || (/^creatureGenerator/.test(q.type) && !dwellingsOn)) { ok = false; break; }
				affected.push([q, a]);
			}
			if (!ok) continue;
			// take it away, then see whether each affected object is still a way in plus closed
			pl.objects.splice(pl.objects.indexOf(m), 1);
			blocked[base + mc] &= ~OCCUPIED;
			monsterAt.delete(mc);
			ring.clear();
			for (const c of monsterAt) addRing(c);
			trial.length = 0;
			let good = true;
			for (const [q, a] of affected) {
				if (!a.some(c => ring.has(c) && (isFree(c) || monsterAt.has(c))) || (DEAR.test(q.type, q) && !monsterBeside(q))) { good = false; break; }
				for (const c of a.filter(c => isFree(c) && !ring.has(c))) if (!block(c, q)) { good = false; break; }
				if (!good) break;
			}
			if (good) { removed++; out.thinned++; continue; }
			// put it back with what was laid for it taken away
			for (const { e, c } of trial.reverse()) { pl.objects.splice(pl.objects.indexOf(e), 1); blocked[base + c] &= ~OCCUPIED; out.closed--; }
			pl.objects.push(m);
			blocked[base + mc] |= OCCUPIED;
			monsterAt.add(mc);
			ring.clear();
			for (const c of monsterAt) addRing(c);
		}
		if (!removed) break;
	}
	// Phase 3, the engine's layout (the lead, 2026-10-07: a pile in a closed pocket with one guard in the mouth; MapGen Dev's pile_structure.js: the engine's
	// stacks are crowded 0.1%, ours 40%, "every pile gets its own guard whether or not a ring guard already covers it"). A stack that still has another within
	// 2 tiles goes when every pile it guards (a pickup that is not already walled in a pocket) can stand in the other stack's ring instead: the pile moves to a
	// free tile within 2 of that stack, the open sides of its approach are closed with blockers, and nothing but piles depended on the stack. Rolled back otherwise.
	const moveCells = (q, nx, ny) => blockingCells(q.template, nx, ny).map(([a, b]) => at(a, b));
	const relocate = (q, tx, ty) => {
		const old = { x: q.x, y: q.y, name: q.instanceName, app: appOf.get(q), cells: moveCells(q, q.x, q.y) };
		for (const c of old.cells) { blocked[base + c] &= ~OCCUPIED; pickAt.delete(c); }
		for (const c of old.app || []) { const ow = owners.get(c); if (ow) { const i = ow.indexOf(q); if (i >= 0) ow.splice(i, 1); } }
		q.x = tx; q.y = ty; q.instanceName = `${q.type}_${tx}_${ty}_${l}`;
		footprintBlock(q.template, tx, ty, l, W, H, blocked);
		if (d.markApproach) d.markApproach(q.template, tx, ty, l, W, H, blocked);
		for (const c of moveCells(q, tx, ty)) pickAt.add(c);
		const na = approachAll(q);
		appOf.set(q, na);
		for (const c of na) { if (!owners.has(c)) owners.set(c, []); owners.get(c).push(q); }
		return old;
	};
	const unrelocate = (q, old) => {
		for (const c of moveCells(q, q.x, q.y)) { blocked[base + c] &= ~OCCUPIED; pickAt.delete(c); }
		for (const c of appOf.get(q) || []) { const ow = owners.get(c); if (ow) { const i = ow.indexOf(q); if (i >= 0) ow.splice(i, 1); } }
		q.x = old.x; q.y = old.y; q.instanceName = old.name;
		for (const c of old.cells) { blocked[base + c] |= OCCUPIED; pickAt.add(c); }
		appOf.set(q, old.app);
		for (const c of old.app || []) { if (!owners.has(c)) owners.set(c, []); owners.get(c).push(q); }
	};
	const undoTrial = () => { for (const { e, c } of trial.reverse()) { pl.objects.splice(pl.objects.indexOf(e), 1); blocked[base + c] &= ~OCCUPIED; out.closed--; } trial.length = 0; };
	const goodNow = q => { const a = appOf.get(q); return (!DEAR.test(q.type, q) || monsterBeside(q)) && a.some(c => ring.has(c) && (isFree(c) || monsterAt.has(c))) && !a.some(c => isFree(c) && !ring.has(c)); };
	// Phase 1b (guard spacing, 2026-10-08): a pile left with an open approach tile, because the tile could take neither a blocker nor a guard
	// that would not stand beside another stack, moves into the ring of a guard of its zone within 12 tiles, onto a free tile beside the guard
	// where every approach tile of its new place is in a ring or closes with a blocker. The engine's piles share their guard this way. Each
	// try is rolled back when it does not hold.
	out.intoRing = 0;
	for (const q of pl.objects.slice()) {
		if ((q.l || 0) !== l || !KIND.test(q.type) || !PICKUP.test(q.type) || !q.template || !q.template.mask || q.__walled) continue;
		if (blockingCells(q.template, q.x, q.y).length !== 1) continue;
		const a0 = appOf.get(q);
		if (!a0 || !a0.some(c => isFree(c) && !ring.has(c))) continue;
		const qz = zone[q.y * W + q.x];
		const near = monsOf().filter(m => Math.max(Math.abs(m.x - q.x), Math.abs(m.y - q.y)) <= 12 && zone[m.y * W + m.x] === qz)
			.sort((a, b) => Math.max(Math.abs(a.x - q.x), Math.abs(a.y - q.y)) - Math.max(Math.abs(b.x - q.x), Math.abs(b.y - q.y)));
		let done = false;
		for (const S of near) {
			for (let dy = -1; dy <= 1 && !done; dy++) for (let dx = -1; dx <= 1 && !done; dx++) {
				if (!dx && !dy) continue;
				const tx = S.x + dx, ty = S.y + dy;
				const cells = moveCells(q, tx, ty);
				if (cells.some(c => c < 0 || !isFree(c) || (blocked[base + c] & RESERVED) || roads.has(c) || zone[c] !== qz || (owners.get(c) || []).some(o2 => o2 !== q))) continue;
				trial.length = 0;
				const old = relocate(q, tx, ty);
				let fine = appOf.get(q).some(c => ring.has(c) && (isFree(c) || monsterAt.has(c))) && (!DEAR.test(q.type, q) || monsterBeside(q));
				if (fine) for (const c of appOf.get(q).filter(c => isFree(c) && !ring.has(c))) if (!block(c, q)) { fine = false; break; }
				if (fine) { done = true; out.intoRing++; break; }
				undoTrial();
				unrelocate(q, old);
			}
			if (done) break;
		}
	}
	out.cheapIntoRing = 0;
	for (const q of cheapOpen) {
		if (!pl.objects.includes(q) || blockingCells(q.template, q.x, q.y).length !== 1) continue;
		const a0 = appOf.get(q);
		if (!a0 || !a0.some(c => isFree(c) && !ring.has(c))) continue;
		const qz = zone[q.y * W + q.x];
		const near = monsOf().filter(m => Math.max(Math.abs(m.x - q.x), Math.abs(m.y - q.y)) <= 3 && zone[m.y * W + m.x] === qz)
			.sort((a, b) => Math.max(Math.abs(a.x - q.x), Math.abs(a.y - q.y)) - Math.max(Math.abs(b.x - q.x), Math.abs(b.y - q.y)));
		let done = false;
		for (const S of near) {
			for (let dy = -1; dy <= 1 && !done; dy++) for (let dx = -1; dx <= 1 && !done; dx++) {
				if (!dx && !dy) continue;
				const tx = S.x + dx, ty = S.y + dy;
				const cells = moveCells(q, tx, ty);
				if (cells.some(c => c < 0 || !isFree(c) || (blocked[base + c] & RESERVED) || roads.has(c) || zone[c] !== qz || (owners.get(c) || []).some(o2 => o2 !== q))) continue;
				trial.length = 0;
				const old = relocate(q, tx, ty);
				let fine = true;
				for (const c of appOf.get(q).filter(c => isFree(c) && !ring.has(c))) if (!block(c, q)) { fine = false; break; }
				if (fine) { done = true; out.cheapIntoRing++; break; }
				undoTrial();
				unrelocate(q, old);
			}
			if (done) break;
		}
	}
	out.merged = 0; out.moved = out.moved || 0;
	const w3 = out.why3 = {};
	const bump = k => { w3[k] = (w3[k] || 0) + 1; };
	for (let round = 0; round < 3; round++) {
		let did = 0;
		const all = monsOf();
		const cands = all.filter(m => !(blocked[base + m.y * W + m.x] & RESERVED) && all.some(n => n !== m && Math.max(Math.abs(n.x - m.x), Math.abs(n.y - m.y)) <= 2))
			.sort((a, b) => strengthOf(a) - strengthOf(b));
		for (const m of cands) {
			if (!pl.objects.includes(m)) continue;
			const near = monsOf().filter(n => n !== m && Math.max(Math.abs(n.x - m.x), Math.abs(n.y - m.y)) <= 2).sort((a, b) => strengthOf(b) - strengthOf(a));
			if (!near.length) continue;
			const rc = ringCount(), mc = m.y * W + m.x;
			const lost = new Set();
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const n = at(m.x + dx, m.y + dy); if (n >= 0 && rc.get(n) === 1) lost.add(n); }
			const deps = []; let ok = true;
			for (const [q, a] of appOf) {
				if (!a.some(c => lost.has(c) && (isFree(c) || monsterAt.has(c))) && !leansOn(q, m)) continue;
				if (!PICKUP.test(q.type) || q.__walled || !q.template.mask) { ok = false; bump(q.__walled ? 'walled pile' : 'not a pile: ' + q.type.replace(/:.*/, '')); break; }
				deps.push(q);
			}
			if (!ok) continue;
			const S = near[0];
			// take m away
			pl.objects.splice(pl.objects.indexOf(m), 1);
			blocked[base + mc] &= ~OCCUPIED; monsterAt.delete(mc);
			ring.clear(); for (const c of monsterAt) addRing(c);
			trial.length = 0;
			const moves = [];
			let good = true;
			for (const q of deps) {
				if (goodNow(q)) {
					// still a way in and closed: only the sides that lost the ring need closing
					let fine = true;
					for (const c of appOf.get(q).filter(c => isFree(c) && !ring.has(c))) if (!block(c, q)) { fine = false; break; }
					if (fine) continue;
				}
				// a free tile within 2 of S for the pile, the nearest to where it stood
				const cs = [];
				for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) cs.push([S.x + dx, S.y + dy]);
				cs.sort((a, b) => Math.hypot(a[0] - q.x, a[1] - q.y) - Math.hypot(b[0] - q.x, b[1] - q.y));
				let placed = false;
				for (const [tx, ty] of cs.slice(0, 16)) {
					const cells = moveCells(q, tx, ty);
					if (cells.some(c => c < 0 || !isFree(c) || (blocked[base + c] & (RESERVED | APPROACH)) || roads.has(c) || zone[c] !== zone[q.y * W + q.x] || (owners.get(c) || []).some(o2 => o2 !== q))) continue;
					const mark = trial.length;
					const old = relocate(q, tx, ty);
					let fine = appOf.get(q).some(c => ring.has(c) && (isFree(c) || monsterAt.has(c))) && (!DEAR.test(q.type, q) || monsterBeside(q));
					if (fine) for (const c of appOf.get(q).filter(c => isFree(c) && !ring.has(c))) if (!block(c, q)) { fine = false; break; }
					if (fine) { moves.push({ q, old }); placed = true; break; }
					// not here: the move and the blockers laid for it come back
					for (const { e, c } of trial.splice(mark).reverse()) { pl.objects.splice(pl.objects.indexOf(e), 1); blocked[base + c] &= ~OCCUPIED; out.closed--; }
					unrelocate(q, old);
				}
				if (!placed) { good = false; bump('no place for a pile'); break; }
			}
			if (good) { did++; out.merged++; out.moved += moves.length; bump('merged'); continue; }
			// back as it was
			for (const { q, old } of moves.reverse()) unrelocate(q, old);
			undoTrial();
			pl.objects.push(m); blocked[base + mc] |= OCCUPIED; monsterAt.add(mc);
			ring.clear(); for (const c of monsterAt) addRing(c);
		}
		if (!did) break;
	}
	// Phase 4: two stacks within 2 tiles of each other become one (K's "guard, loot, guard, wall" with the engine's spacing: its stacks are crowded 0.1%, ours 40%
	// with about 1.4 times its stacks to the tile, which placed at random is what 40% is). The stronger moves to a free tile within a tile of either's place and the other
	// goes, when every dwelling, pile and bank either stood beside is still guarded after it (a way in inside the ring, a dear pile with the stack beside its tile, the other
	// open approach tiles closed with blockers). Rolled back otherwise.
	out.pairs = 0;
	const dependsOn = (m, rc) => {
		const lost = new Set();
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const n = at(m.x + dx, m.y + dy); if (n >= 0) lost.add(n); }
		const res = [];
		for (const [q, a] of appOf) if (a.some(c => lost.has(c) && (isFree(c) || monsterAt.has(c))) || leansOn(q, m)) res.push(q);
		return res;
	};
	for (let round = 0; round < 3; round++) {
		let did = 0;
		const all = monsOf();
		const cands = all.filter(m => !(blocked[base + m.y * W + m.x] & RESERVED) && all.some(n => n !== m && Math.max(Math.abs(n.x - m.x), Math.abs(n.y - m.y)) <= 2))
			.sort((a, b) => strengthOf(a) - strengthOf(b));
		for (const m of cands) {
			if (!pl.objects.includes(m)) continue;
			const partners = monsOf().filter(n => n !== m && Math.max(Math.abs(n.x - m.x), Math.abs(n.y - m.y)) <= 2 && !(blocked[base + n.y * W + n.x] & RESERVED));
			if (!partners.length) continue;
			for (const n of partners.sort((a, b) => Math.max(Math.abs(a.x - m.x), Math.abs(a.y - m.y)) - Math.max(Math.abs(b.x - m.x), Math.abs(b.y - m.y)))) {
				const deps = new Set([...dependsOn(m), ...dependsOn(n)]);
				// only what a hero is guarded from: dear piles, dwellings and the like; a mine, a town, a monolith near it keeps the pair as it is
				let fine = true;
				for (const q of deps) if (!(PICKUP.test(q.type) || KIND.test(q.type) || /^creatureBank|^dragonUtopia|^crypt/.test(q.type))) { fine = false; break; }
				if (!fine) continue;
				const [keep, gone] = strengthOf(m) >= strengthOf(n) ? [m, n] : [n, m];
				// the tiles the kept stack may stand on: free, within a tile of either one's place, a guard's place
				const spots = new Map();
				for (const s0 of [m, n]) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
					const c = at(s0.x + dx, s0.y + dy);
					if (c < 0) continue;
					if (c === keep.y * W + keep.x || c === gone.y * W + gone.x || guardOk(c, keep)) spots.set(c, 1);
				}
				const order = [...spots.keys()].sort((a, b) => {
					const da = Math.hypot((a % W) - (m.x + n.x) / 2, ((a / W) | 0) - (m.y + n.y) / 2), db = Math.hypot((b % W) - (m.x + n.x) / 2, ((b / W) | 0) - (m.y + n.y) / 2);
					return da - db;
				});
				const kc0 = keep.y * W + keep.x, gc0 = gone.y * W + gone.x;
				let merged = false;
				for (const t of order.slice(0, 8)) {
					// the pair becomes one stack at t
					pl.objects.splice(pl.objects.indexOf(gone), 1);
					blocked[base + gc0] &= ~OCCUPIED; monsterAt.delete(gc0);
					blocked[base + kc0] &= ~OCCUPIED; monsterAt.delete(kc0);
					const ox = keep.x, oy = keep.y, on = keep.instanceName;
					keep.x = t % W; keep.y = (t / W) | 0; keep.instanceName = `${keep.type}_${keep.x}_${keep.y}_${l}`;
					footprintBlock(d.monsterTpl, keep.x, keep.y, l, W, H, blocked);
					monsterAt.add(t);
					ring.clear(); for (const c of monsterAt) addRing(c);
					trial.length = 0;
					let good = true;
					for (const q of deps) {
						const a = appOf.get(q);
						if (!a.some(c => ring.has(c) && (isFree(c) || monsterAt.has(c))) || (DEAR.test(q.type, q) && !monsterBeside(q))) { good = false; break; }
						for (const c of a.filter(c => isFree(c) && !ring.has(c))) if (!block(c, q)) { good = false; break; }
						if (!good) break;
					}
					if (good) { merged = true; did++; out.pairs++; break; }
					// back as it was
					undoTrial();
					blocked[base + t] &= ~OCCUPIED; monsterAt.delete(t);
					keep.x = ox; keep.y = oy; keep.instanceName = on;
					blocked[base + kc0] |= OCCUPIED; monsterAt.add(kc0);
					pl.objects.push(gone);
					blocked[base + gc0] |= OCCUPIED; monsterAt.add(gc0);
					ring.clear(); for (const c of monsterAt) addRing(c);
				}
				if (merged) break;
			}
		}
		if (!did) break;
	}
	// Phase 5, the guard unit (the lead, 2026-10-08: close the gap on monsters, blockers and loot; the engine's stacks stand 4 or more tiles apart, p10 of the
	// nearest-stack distance 4, ours 2). A stack still within 2 tiles of another moves, with the pickups that depend on it, to a clean site: a free tile of its
	// zone at least 4 tiles from every other stack, the pickups on free tiles beside it (inside its ring), every other open side of theirs closed with blockers.
	// A stack something else depends on (a bank, a dwelling, a mine, a building) stays; the other of the pair is tried. Rolled back when the site does not hold.
	out.spread = 0;
	const w5 = out.why5 = {};
	const bump5 = k => { w5[k] = (w5[k] || 0) + 1; };
	const SPACE = 4, REACH = 24;
	const cheb = (ax, ay, bx, by) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));
	const othersBeside = (q, m) => visitableCells(q.template, q.x, q.y).some(([fx, fy]) => monsOf().some(n => n !== m && cheb(n.x, n.y, fx, fy) <= 1));
	const unitDeps = m => {
		const rc = ringCount(), lost = new Set();
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const n = at(m.x + dx, m.y + dy); if (n >= 0 && rc.get(n) === 1) lost.add(n); }
		const deps = [];
		for (const [q, a] of appOf) {
			const byRing = a.some(c => lost.has(c) && (isFree(c) || monsterAt.has(c)));
			if (!byRing && !(leansOn(q, m) && !othersBeside(q, m))) continue;
			if (!PICKUP.test(q.type) || q.__walled || !q.template.mask) return null;
			deps.push(q);
		}
		return deps;
	};
	const putStack = (m, c) => {
		const old = m.y * W + m.x;
		blocked[base + old] &= ~OCCUPIED; monsterAt.delete(old);
		m.x = c % W; m.y = (c / W) | 0; m.instanceName = `${m.type}_${m.x}_${m.y}_${l}`;
		footprintBlock(d.monsterTpl, m.x, m.y, l, W, H, blocked);
		monsterAt.add(c);
		ring.clear(); for (const k of monsterAt) addRing(k);
	};
	// how shut a tile is: its eight neighbours that are rock, water or taken
	const shut = c => { let n = 0; const x = c % W, y = (c / W) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; const k = at(x + dx, y + dy); if (k < 0 || !land(k) || (blocked[base + k] & OCCUPIED)) n++; } return n; };
	for (let round = 0; round < 3; round++) {
		let did = 0;
		const crowdedNow = m => monsOf().some(n => n !== m && cheb(n.x, n.y, m.x, m.y) <= 2);
		const cands = monsOf().filter(m => !(blocked[base + m.y * W + m.x] & RESERVED) && crowdedNow(m));
		const info = new Map();
		for (const m of cands) info.set(m, unitDeps(m));
		cands.sort((a, b) => ((info.get(a) || [1, 2, 3, 4, 5]).length - (info.get(b) || [1, 2, 3, 4, 5]).length) || (strengthOf(a) - strengthOf(b)));
		for (const m of cands) {
			if (!pl.objects.includes(m) || !crowdedNow(m)) continue;
			const deps = unitDeps(m);
			if (!deps) { bump5('something else depends on it'); continue; }
			if (deps.length > 4) { bump5('more than 4 piles'); continue; }
			const mz = zone[m.y * W + m.x], ox = m.x, oy = m.y, oc = oy * W + ox;
			// the sites: free tiles of the zone, at least SPACE from every other stack, no road, door or approach, and closed ground first
			const others = monsOf().filter(n => n !== m);
			const sites = [];
			for (let dy = -REACH; dy <= REACH; dy++) for (let dx = -REACH; dx <= REACH; dx++) {
				const c = at(ox + dx, oy + dy);
				if (c < 0 || c === oc || zone[c] !== mz || !guardOk(c, m) || (blocked[base + c] & APPROACH) || (owners.get(c) || []).length) continue;
				const x = c % W, y = (c / W) | 0;
				if (others.some(n => cheb(n.x, n.y, x, y) < SPACE)) continue;
				sites.push([c, shut(c) * 2 - Math.hypot(dx, dy) * 0.15]);
			}
			sites.sort((a, b) => b[1] - a[1]);
			if (!sites.length) { bump5('no site'); continue; }
			let moved = false;
			for (const [g] of sites.slice(0, 14)) {
				if (!simple(g)) { bump5('site would cut'); continue; }
				putStack(m, g);
				trial.length = 0;
				const moves = [];
				let good = true;
				for (const q of deps) {
					let placed = false;
					const gx = g % W, gy = (g / W) | 0;
					const cs = [];
					for (let ey = -1; ey <= 1; ey++) for (let ex = -1; ex <= 1; ex++) if (ex || ey) cs.push([gx + ex, gy + ey]);
					cs.sort(() => rng() - 0.5);
					for (const [tx, ty] of cs) {
						const cells = moveCells(q, tx, ty);
						if (cells.some(c => c < 0 || !isFree(c) || (blocked[base + c] & (RESERVED | APPROACH)) || roads.has(c) || zone[c] !== mz || (owners.get(c) || []).some(o2 => o2 !== q))) continue;
						const mark = trial.length;
						const old = relocate(q, tx, ty);
						let fine = appOf.get(q).some(c => ring.has(c) && (isFree(c) || monsterAt.has(c))) && (!DEAR.test(q.type, q) || monsterBeside(q));
						if (fine) for (const c of appOf.get(q).filter(c => isFree(c) && !ring.has(c))) if (!block(c, q)) { fine = false; break; }
						if (fine) { moves.push({ q, old }); placed = true; break; }
						for (const { e, c } of trial.splice(mark).reverse()) { pl.objects.splice(pl.objects.indexOf(e), 1); blocked[base + c] &= ~OCCUPIED; out.closed--; }
						unrelocate(q, old);
					}
					if (!placed) { good = false; bump5('no room beside the stack'); break; }
				}
				if (good) { moved = true; did++; out.spread++; out.moved += moves.length; bump5('moved'); break; }
				for (const { q, old } of moves.reverse()) unrelocate(q, old);
				undoTrial();
				putStack(m, oc);
			}
			if (!moved) bump5('no site held');
		}
		if (!did) break;
	}
	if (process.env.VMAPGEN_THIN_TRACE) console.error("[spread] moved " + out.spread + " " + JSON.stringify(w5));
	if (process.env.VMAPGEN_THIN_TRACE) {
		const all = monsOf(), rc = ringCount(), hist = {};
		for (const m of all) {
			if (!all.some(n => n !== m && Math.max(Math.abs(n.x - m.x), Math.abs(n.y - m.y)) <= 2)) continue;
			const lost = new Set();
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const n = at(m.x + dx, m.y + dy); if (n >= 0 && rc.get(n) === 1) lost.add(n); }
			const kinds = new Set();
			for (const [q, a] of appOf) if (a.some(c => lost.has(c) && (isFree(c) || monsterAt.has(c)))) kinds.add(KIND.test(q.type) ? (/^creatureGenerator/.test(q.type) ? 'dwelling' : 'dear') : PICKUP.test(q.type) ? 'cheap' : q.type.replace(/:.*/, ''));
			const key = [...kinds].sort().join('+') || 'none';
			hist[key] = (hist[key] || 0) + 1;
		}
		console.error('[thintrace] crowded stacks by what depends on them: ' + JSON.stringify(hist));
	}
	}
	// every dear object has a monster on or beside it, prisons of 90000 and more among them (they are no kind of this pass)
	if (!goldOnly) for (const o of pl.objects.slice()) if ((o.l || 0) === l && o.template && o.template.mask && DEAR.test(o.type, o)) besideFix(o);
	// Last: no entrance tile of high loot stays open to a flyer (Opus Reviewer, 2026-10-09: tiles on open ground outside every ring, 7.6% of high
	// loot on 0cf6cf0's four seeds, most of them pockets a walker reaches only through a guard's ring, where a wall could shut the loot off): a
	// monster goes on a free tile within 1 of the open tile, so its ring takes it; off the roads first, a tile clear of other stacks first
	out.flyerShut = 0;
	{
		const HIGH = /^(randomArtifact|artifact|spellScroll|pandoraBox)/;
		// gold mines only while their guards are on (Guards at mines, Mine guard weight above 0), as guardDearLoot's gold pass
		const goldOn = Number(p.guardMines) !== 0 && !(Number.isFinite(Number(p.mineGuardWeight)) && Number(p.mineGuardWeight) <= 0);
		const pickC = new Set();
		for (const q of pl.objects) if ((q.l || 0) === l && q.template && q.template.mask && PICKUP.test(q.type))
			for (const [fx, fy] of blockingCells(q.template, q.x, q.y)) { const c = at(fx, fy); if (c >= 0) pickC.add(c); }
		const openT = () => {
			const list = [];
			for (const [o, a] of appOf) {
				// and a gold mine's: a corner entrance beside a door whose front tile holds a pile stayed outside every ring (7 of K's 18 maps, MapGen Dev 12:58)
				if ((o.l || 0) !== l || !((!goldOnly && HIGH.test(o.type)) || (goldOn && o.type === 'mine' && o.subtype === 'goldMine'))) continue;
				// a pile before a gold mine is a way in too (a hero takes it and walks in)
				const gm = goldOn && o.type === 'mine' && o.subtype === 'goldMine';
				for (const t of a) if ((isFree(t) || (gm && pickC.has(t))) && (gm || !pickC.has(t)) && !ring.has(t)) list.push([o, t]);
			}
			return list;
		};
		// walls where a wall may stand
		out.flyerWalled = 0;
		trial.length = 0;
		if (!goldOnly) for (const [o, t] of openT()) if (isFree(t) && !ring.has(t) && block(t, o)) out.flyerWalled++;
		trial.length = 0;
		// a guard where none may: the tile whose ring takes the most open tiles, clear of other stacks
		for (let round = 0; round < 400; round++) {
			const open = openT();
			if (!open.length) break;
			const [o, t] = open[0], tx = t % W, ty = (t / W) | 0;
			let best = -1, bs = -Infinity;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const c = at(tx + dx, ty + dy), x = tx + dx, y = ty + dy;
				// a gold mine's rim tile may take its guard (the mine's door on the outermost row or column has no other tile for it)
				if (c < 0 || ((x < 1 || y < 1 || x >= W - 1 || y >= H - 1) && !(o.subtype === 'goldMine' && o.type === 'mine')) || !isFree(c) || pickC.has(c)) continue;
				if (zone[c] !== zone[o.y * W + o.x] || crowdAt(c) || roadBlock(c, o)) continue;
				const takes = open.filter(([, u]) => Math.max(Math.abs(u % W - x), Math.abs(((u / W) | 0) - y)) <= 1).length;
				const sc = takes * 2 - (roads.has(c) ? 3 : (blocked[base + c] & RESERVED) ? 1 : 0);
				if (sc > bs) { bs = sc; best = c; }
			}
			// a gold mine is guarded whatever (the engine guards all of them): a tile within 2 of another stack when no clear one is left
			if (best < 0 && goldOn && o.type === 'mine' && o.subtype === 'goldMine')
				for (let dy = -1; dy <= 1 && best < 0; dy++) for (let dx = -1; dx <= 1; dx++) {
					const c = at(tx + dx, ty + dy), x = tx + dx, y = ty + dy;
					if (c < 0 || !isFree(c) || pickC.has(c) || roadBlock(c, o) || zone[c] !== zone[o.y * W + o.x]) continue;
					best = c; break;
				}
			if (best < 0 && process.env.VMAPGEN_GOLD_TRACE && ((o.type === 'mine' && o.subtype === 'goldMine') || DEAR_TYPE.test(o.type))) { const why = []; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const c = at(tx + dx, ty + dy), x = tx + dx, y = ty + dy; const r = c < 0 || x < 1 || y < 1 || x >= W - 1 || y >= H - 1 ? 'edge' : !isFree(c) ? (land(c) ? 'occupied' : 'water/rock') : pickC.has(c) ? 'pile' : byStartRoad(c) ? 'startroad' : zone[c] !== zone[o.y * W + o.x] ? 'zone' : crowdAt(c) ? 'crowd' : 'ok'; why.push(`(${x},${y}) ${r}`); } console.error(`[goldtrace] mine (${o.x},${o.y}) open tile (${tx},${ty}) pile ${pickC.has(t)}: ` + why.join('; ')); }
			// a pile on the mine's only way in, no tile beside it for a guard: the pile goes and the guard stands on its tile (the way in is a fight
			// then; a start's own gold mine beside its town, 72x72 four players seed 1: a pile on the door, the road and the walls round it)
			if (best < 0 && process.env.VMAPGEN_GOLD_TRACE && o.type === 'mine' && o.subtype === 'goldMine') console.error(`[goldpile] mine (${o.x},${o.y}) tile ${tx},${ty}: pick ${pickC.has(t)} free ${isFree(t)} crowd ${crowdAt(t)} startroad ${byStartRoad(t)} zone ${zone[t] === zone[o.y * W + o.x]}`);
			if (best < 0 && goldOn && o.type === 'mine' && o.subtype === 'goldMine' && pickC.has(t) && !crowdAt(t) && !roadBlock(t, o) && zone[t] === zone[o.y * W + o.x]) {
				const pile = pl.objects.find(q => (q.l || 0) === l && q.template && q.template.mask && PICKUP.test(q.type)
					&& blockingCells(q.template, q.x, q.y).length === 1 && blockingCells(q.template, q.x, q.y).some(([fx, fy]) => at(fx, fy) === t));
				if (pile) {
					pl.objects.splice(pl.objects.indexOf(pile), 1);
					pickC.delete(t);
					blocked[base + t] &= ~OCCUPIED;
					best = t;
					out.goldPileTaken = (out.goldPileTaken || 0) + 1;
				}
			}
			// no tile clear of other stacks: the open tile stays (counted), the next one is tried
			if (best < 0) { out.flyerLeft = (out.flyerLeft || 0) + 1; appOf.set(o, appOf.get(o).filter(u => u !== t)); continue; }
			post(best, o);
			out.flyerShut++;
		}
	}
	if (process.env.VMAPGEN_GOLD_TRACE) for (const [o, a] of appOf) {
		if ((o.l || 0) !== l || o.type !== 'mine' || o.subtype !== 'goldMine') continue;
		const open = a.filter(t => isFree(t) && !ring.has(t));
		console.error(`[goldend] mine (${o.x},${o.y}) approach ${a.length} tiles ${a.map(t => (t % W) + ',' + ((t / W) | 0) + (isFree(t) ? '' : 'x') + (ring.has(t) ? 'r' : '')).join(' ')}; open ${open.length}`);
	}
	return out;
}

/**
 * A Pandora's box is guarded as the engine's are (K, 2026-10-06: "a lot of pandora boxes aren't guarded as well as they are in vcmi
 * templates"; mapsight guards on the 80-map grid: ours 13k median against the engine's 21k, quartiles 6k to 37k against 9k to 52k). The
 * strongest concrete guard within a tile of a box is raised to a floor drawn lognormal (median 9k, sigma 1) when it stands under it; a guard
 * already above it stays. With ours as they were (median 13k, quartiles 5k and 37k) the result is 10k, 21k and 46k in a simulation, the engine's 9k, 21k and 52k;
 * a floor of the engine's own median overshot (29k on the grid). Returns { raised, boxes }.
 */
function raisePandoraGuards(pl, l, W, H, p, d) {
	const out = { raised: 0, boxes: 0 };
	const values = require('./creature_values.json');
	const { rng } = d;
	const MON = /^(monster|randomMonster)/;
	const guards = pl.objects.filter(o => (o.l || 0) === l && MON.test(o.type) && o.guardCreature && values[o.guardCreature] && o.options && o.options.amount > 0);
	if (!guards.length) return out;
	for (const o of pl.objects) {
		if ((o.l || 0) !== l || o.type !== 'pandoraBox') continue;
		out.boxes++;
		let best = null, bs = 0;
		for (const m of guards) {
			if (Math.max(Math.abs(m.x - o.x), Math.abs(m.y - o.y)) > 1) continue;
			const s = m.options.amount * values[m.guardCreature].aiValue;
			if (s > bs) { bs = s; best = m; }
		}
		if (!best) continue;
		const z = Math.sqrt(-2 * Math.log(Math.max(1e-9, rng()))) * Math.cos(2 * Math.PI * rng());
		// the Stack size lever scales the guards, and the strength asked for with them
		const target = Math.min(120000, 9000 * Math.exp(1.0 * z)) * (Number.isFinite(p && p.stackScale) ? p.stackScale : 1);
		if (bs >= target) continue;
		const v = values[best.guardCreature].aiValue;
		best.options = { ...best.options, amount: Math.ceil(target / v) };
		out.raised++;
	}
	return out;
}

module.exports = { closeApproaches, raisePandoraGuards };
