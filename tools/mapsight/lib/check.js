'use strict';
/**
 * check.js - the hard checks: what must be zero on a map before anyone is shown it, whatever any score says.
 * K, 2026-10-01, after a map that scored 85.8% had broken roads and bubble caves: the suite flagged the roads and
 * nobody looked. The engine's own maps of 72 tiles and up pass every check here.
 *
 *   mapsight check FILE...        one line a map, PASS or FAIL with what failed; exit code 1 if any map fails
 *
 * Checks:
 *   road ends     a road that stops at nothing, beside an object it does not serve, or a tile or two short of another
 *                 road (sight.roadEnds; the engine: none on maps wider than 72)
 *   starts        a player town with no open ground at its gate
 *   sealed        a town, mine or dwelling no hero can reach from any start, even fighting through every guard and
 *                 taking every monolith and gate (K, 2026-10-03: a start zone's second town and its sawmill shut in a
 *                 five-tile pocket on his medium Coldshadow; every check above passed it). A walk that reaches a
 *                 shipyard or a boat sails: water opens and the walk runs again (islands maps read as sealed before)
 *   empty zones   a zone of the template with under 1 object a hero visits per 100 of its tiles (K's 72x72 seed
 *                 1805021841, 2026-10-03, "huge step backwards": 19 of 21 zones empty after a sweep dropped 362 objects;
 *                 the engine's zones carry 5 or more per 100 tiles)
 *   split zones   a zone whose open land falls into walkable pieces, the largest under 70% of it and more than 40 tiles
 *                 elsewhere: a part a hero reaches only by monolith or not at all (K's 36x36 s641954708, 2026-10-04: "top
 *                 right biome is half untraversable"; portals are not walking)
 *   own town      a town in a start's own zone that the start reaches only by fighting a guard (the same map: the
 *                 zone's second town lay past a treasure guard whose ring covered the only corridor; the engine never
 *                 guards the way between a start and the other town of its zone)
 * Reported, not failed: open ground (the share of land a hero can stand on, and the lowest zone's), terrain art (a visitable object whose art may not belong on its ground). The table behind it
 * flags the engine's own maps too (mines on swamp, mystical gardens on dirt: 2 to 10 a map on Coldshadow's Fantasy),
 * so it is a note until the table is fixed.
 */
const sight = require('./sight');

function checkMap(file) {
	const A = sight.analyse(file);
	const fails = [], notes = [];
	const bad = A.roadEnds.filter(e => e.kind !== 'proper');
	if (bad.length) fails.push(`road ends ${bad.length} (${bad.slice(0, 4).map(e => `${e.kind} (${e.at.join(',')}${e.l ? ',L' + e.l : ''})`).join(' ')}${bad.length > 4 ? ' ...' : ''})`);
	const shut = A.starts.filter(s => !s.regions || !s.regions.length);
	if (shut.length) fails.push(`starts shut ${shut.length}`);
	const sealed = sealedObjects(A.M);
	if (sealed.length) fails.push(`sealed ${sealed.length} (${sealed.slice(0, 4).map(o => `${o.cls} ${o.type}${o.subtype ? ':' + o.subtype : ''} (${o.at.join(',')}${o.l ? ',L' + o.l : ''})`).join(' ')}${sealed.length > 4 ? ' ...' : ''})`);
	const empty = emptyZones(A.M);
	if (empty.length) fails.push(`empty zones ${empty.length} (${empty.slice(0, 6).map(e => `${e.zone}${e.l ? ',L' + e.l : ''}: ${e.n}/${e.tiles}`).join(' ')})`);
	const split = splitZones(A.M);
	if (split.length) fails.push(`split zones ${split.length} (${split.slice(0, 5).map(e => `${e.zone}${e.l ? ',L' + e.l : ''}: ${e.main}/${e.open}`).join(' ')})`);
	const own = ownTownsBehindGuards(A);
	if (own.length) fails.push(`own town behind a guard ${own.length} (${own.slice(0, 4).map(o => `${o.who} to (${o.at.join(',')}${o.l ? ',L' + o.l : ''})`).join(' ')})`);
	const off = teleportsOffRoad(A.M);
	if (off.length) fails.push(`teleport off road ${off.length} (${off.slice(0, 4).map(o => `${o.type} (${o.at.join(',')}${o.l ? ',L' + o.l : ''})`).join(' ')}${off.length > 4 ? ' ...' : ''})`);
	const art = (A.terrain && A.terrain.bad ? A.terrain.bad : []).filter(b => b.o.type !== 'subterraneanGate');
	if (art.length) notes.push(`terrain art ${art.length}, a note only`);
	const clip = creaturesOver(A.M);
	const og = openGround(A.M);
	if (og.land) notes.push(`open ground ${(100 * og.share).toFixed(0)}%${og.zones.length ? `, lowest zone ${og.zones[0].zone} ${(100 * og.zones[0].share).toFixed(0)}%` : ''} (engine 36 to 144: 34-62%, lowest zones 8-47%), a note only`);
	if (clip.bank + clip.dwelling) notes.push(`creature sprite over a bank ${clip.bank}, a dwelling ${clip.dwelling} (engine 144: banks 45-68, dwellings 7-22), a note only`);
	return { file, fails, notes };
}

/**
 * Share of land a hero can stand on (not scenery, not an object; water and rock are not land), whole map and per zone
 * of 40 land tiles or more, lowest first. The engine's own maps at the size they were made (2026-10-04, Coldshadow's
 * Fantasy at 144 and 25-zone templates down to 36): 34-44% one level at 72 and 108, 51-62% two levels at 36 and 72,
 * 56-58% at 144; lowest zones 8-47%. K's "top right biome is half untraversable" was a 33% zone on a 43% map.
 */
function openGround(M) {
	let land = 0, open = 0;
	const z = new Map();
	for (let l = 0; l < M.NL; l++) for (let y = 0; y < M.H; y++) for (let x = 0; x < M.W; x++) {
		const i = M.idx(l, x, y);
		if (!M.ground(i) && !M.blocked[i]) continue;
		const t = M.terr[i];
		if (t === 'wa' || t === 'ro' || t === 'rc') continue;
		const o = M.ground(i) && !M.blocked[i];
		land++; if (o) open++;
		const k = `${l ? 'u' : ''}${M.zoneAt(l, x, y)}`;
		const e = z.get(k) || [0, 0]; e[0]++; if (o) e[1]++; z.set(k, e);
	}
	const zones = [...z].filter(([, e]) => e[0] >= 40).map(([zone, e]) => ({ zone, share: e[1] / e[0] })).sort((a, b) => a.share - b.share);
	return { land, share: land ? open / land : 0, zones };
}

/**
 * Monsters whose 64x64 sprite covers a bank or a dwelling: a monster at (x,y) is drawn over (x-1,y), (x,y-1) and
 * (x-1,y-1) (MapGen Dev's tools/harness/monster_clip.js rule). Loot is left out: the engine's own guards stand over
 * their loot far more often than ours (390-430 a 144 map against our 199-243).
 */
function creaturesOver(M) {
	const at = new Map();
	for (const o of M.objs) {
		const m = o.template && o.template.mask;
		if (!m || !o.template.animation || !/^(bank|dwelling)$/.test(o.cls)) continue;
		for (let i = 0; i < m.length; i++) for (let j = 0; j < m[i].length; j++) {
			if (m[i][j] === ' ' || m[i][j] === '0') continue;
			at.set(`${o.l}|${o.x - (m[i].length - 1 - j)}|${o.y - (m.length - 1 - i)}`, o);
		}
	}
	const n = { bank: 0, dwelling: 0 };
	for (const o of M.objs) {
		if (o.cls !== 'monster') continue;
		const hit = new Set();
		for (const [dx, dy] of [[-1, 0], [0, -1], [-1, -1]]) { const p = at.get(`${o.l}|${o.x + dx}|${o.y + dy}`); if (p) hit.add(p); }
		for (const p of hit) n[p.cls]++;
	}
	return n;
}

/**
 * Towns, mines and dwellings that no walk from any start reaches. The walk crosses open ground, pickups and guards
 * (a hero fights through), never another object or rock; touching a monolith or subterranean gate jumps to every
 * other one of its kind (generous: a pair is not resolved, so this only ever misses a seal, never invents one).
 */
function sealedObjects(M) {
	const { W, H, NL, objs, idx, inb } = M;
	const N = NL * W * H;
	const passable = new Uint8Array(N);
	for (let i = 0; i < N; i++) passable[i] = M.ground(i) && !M.blocked[i] ? 1 : 0;
	for (const o of objs) if (o.cls === 'monster') for (const [x, y] of o.cells) passable[idx(o.l, x, y)] = 1;
	const portalKey = o => /^monolith|^subterraneanGate|^whirlpool/.test(o.type) ? (o.type === 'subterraneanGate' ? 'gate' : o.type.replace(/(Entrance|Exit)$/, '') + ':' + (o.subtype || '')) : null;
	const byKey = new Map();
	for (const o of objs) { const k = portalKey(o); if (k) (byKey.get(k) || byKey.set(k, []).get(k)).push(o); }
	const touch = new Map();
	for (const o of objs) for (const [ex, ey] of o.entr) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
		if (!inb(ex + dx, ey + dy)) continue;
		const i = idx(o.l, ex + dx, ey + dy);
		(touch.get(i) || touch.set(i, []).get(i)).push(o);
	}
	const starts = objs.filter(o => o.cls === 'town' && o.options && o.options.owner);
	if (!starts.length) return [];
	let seen, sail = false;
	for (let pass = 0; pass < 2; pass++) {
		seen = new Uint8Array(N);
		const q = [], usedKey = new Set();
		let boat = false;
		const push = i => { if (!seen[i] && passable[i]) { seen[i] = 1; q.push(i); } };
		for (const t of starts) for (const [x, y] of t.entr) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (inb(x + dx, y + dy)) push(idx(t.l, x + dx, y + dy));
		for (let h = 0; h < q.length; h++) {
			const i = q[h], l = Math.floor(i / (W * H)), r = i % (W * H), x = r % W, y = (r / W) | 0;
			for (const o of touch.get(i) || []) {
				if (/^(shipyard|boat)$/.test(o.type)) boat = true;
				const k = portalKey(o);
				if (!k || usedKey.has(k)) continue;
				usedKey.add(k);
				for (const p of byKey.get(k)) for (const [ex, ey] of p.entr) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (inb(ex + dx, ey + dy)) push(idx(p.l, ex + dx, ey + dy));
			}
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && inb(x + dx, y + dy)) push(idx(l, x + dx, y + dy));
		}
		// a boat or shipyard reached: the hero sails, so open water joins the walk, and the walk runs once more
		if (!boat || sail) break;
		sail = true;
		for (let i = 0; i < N; i++) if ((M.terr[i] === 'wt' || M.terr[i] === 'wa') && !M.blocked[i]) passable[i] = 1;
	}
	return objs.filter(o => (o.cls === 'town' || o.cls === 'mine' || o.cls === 'dwelling') && o.visitable
		&& !o.entr.some(([ex, ey]) => { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (inb(ex + dx, ey + dy) && seen[idx(o.l, ex + dx, ey + dy)]) return true; return false; }));
}

/** Template zones with under 1 visitable object, pickup or guard per 100 of their tiles (zones of 50 tiles or more). */
/**
 * Subterranean gates and monoliths with no road on or beside their visiting tile while the free ground they open onto
 * holds road (K, 2026-10-04: "portals and subterranean gates are still being missed by roads"; the engine runs the road
 * onto the visiting tile). One behind a guard ring with no road on its side is not counted.
 */
function teleportsOffRoad(M) {
	if (!M.road) return [];
	const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
	const out = [];
	for (const o of M.objs) {
		if (!/^(subterraneanGate|monolith)/i.test(o.type) || !o.visitable) continue;
		const [ox, oy] = o.at, l = o.l;
		let near = false;
		for (const [dx, dy] of [[0, 0], ...N8]) if (M.inb(ox + dx, oy + dy) && M.road[M.idx(l, ox + dx, oy + dy)]) { near = true; break; }
		if (near) continue;
		// a walk over free floor (a guard's tile walks; water, rock and objects do not) up to 60 steps: reaching a road
		// means the road could have been run onto the visiting tile (MapGen Dev's gateroad.js rule)
		const seen = new Set([M.idx(l, ox, oy)]);
		let ring = [[ox, oy]], hit = false;
		for (let d = 0; d < 60 && ring.length && !hit; d++) {
			const next = [];
			for (const [x, y] of ring) for (const [dx, dy] of N8) {
				const nx = x + dx, ny = y + dy;
				if (!M.inb(nx, ny)) continue;
				const t = M.idx(l, nx, ny);
				if (seen.has(t) || !M.ground(t) || M.blocked[t]) continue;
				seen.add(t);
				if (M.road[t]) { hit = true; break; }
				next.push([nx, ny]);
			}
			ring = next;
		}
		if (hit) out.push(o);
	}
	return out;
}

function emptyZones(M) {
	if (!M.zoneAt) return [];
	const tiles = new Map(), n = new Map();
	const key = (l, z) => l * 1000 + z;
	for (let l = 0; l < M.NL; l++) for (let y = 0; y < M.H; y++) for (let x = 0; x < M.W; x++) {
		const z = M.zoneAt(l, x, y);
		if (z === undefined || z === null || z < 0 || !M.ground(M.idx(l, x, y))) continue;
		tiles.set(key(l, z), (tiles.get(key(l, z)) || 0) + 1);
	}
	for (const o of M.objs) {
		if (!(o.visitable || o.pickup || o.cls === 'monster')) continue;
		const z = M.zoneAt(o.l, o.at[0], o.at[1]);
		if (z === undefined || z === null || z < 0) continue;
		n.set(key(o.l, z), (n.get(key(o.l, z)) || 0) + 1);
	}
	const out = [];
	for (const [k, t] of tiles) {
		const c = n.get(k) || 0;
		if (t >= 50 && c * 100 < t) out.push({ zone: k % 1000, l: Math.floor(k / 1000), n: c, tiles: t });
	}
	return out.sort((a, b) => a.l - b.l || a.zone - b.zone);
}

/**
 * Zones of 100 open tiles or more whose largest walkable piece (guards and pickups walk) holds under 70% of the open land.
 * On a map with a boat or a shipyard, pieces of a zone whose shores touch the same sea count as one: a hero sails between
 * them (lead, 2026-10-05: an islands layout cuts zones into islands by design, and every islands map failed on it).
 */
function splitZones(M) {
	if (!M.zoneAt) return [];
	const W = M.W, H = M.H, out = [];
	const mon = new Set();
	for (const o of M.objs) if (o.cls === 'monster') for (const [x, y] of o.cells) mon.add(o.l * W * H + y * W + x);
	const sail = M.objs.some(o => /^(boat|shipyard)$/.test(o.type));
	for (let l = 0; l < M.NL; l++) {
		const pass = (x, y) => { const i = M.idx(l, x, y); return M.ground(i) && (!M.blocked[i] || mon.has(l * W * H + y * W + x)); };
		// seas: open water, 8-connected
		const sea = new Int32Array(W * H).fill(-1);
		if (sail) {
			const wet = c => { const i = M.idx(l, c % W, (c / W) | 0); return (M.terr[i] === 'wt' || M.terr[i] === 'wa') && !M.blocked[i]; };
			let ns = 0;
			for (let c0 = 0; c0 < W * H; c0++) {
				if (sea[c0] >= 0 || !wet(c0)) continue;
				const q = [c0]; sea[c0] = ns;
				while (q.length) {
					const k = q.pop(), kx = k % W, ky = (k / W) | 0;
					for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
						const u = kx + dx, v = ky + dy;
						if (u < 0 || v < 0 || u >= W || v >= H || sea[v * W + u] >= 0 || !wet(v * W + u)) continue;
						sea[v * W + u] = ns; q.push(v * W + u);
					}
				}
				ns++;
			}
		}
		const comp = new Int32Array(W * H).fill(-1);
		const byZone = new Map();
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			const c = y * W + x;
			if (comp[c] >= 0 || !pass(x, y)) continue;
			const z = M.zoneAt(l, x, y);
			if (z === undefined || z === null || z < 0) continue;
			let n = 0;
			const q = [c], seas = new Set();
			comp[c] = 1;
			while (q.length) {
				const k = q.pop(), kx = k % W, ky = (k / W) | 0;
				n++;
				for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
					const u = kx + dx, v = ky + dy;
					if (u < 0 || v < 0 || u >= W || v >= H) continue;
					if (sea[v * W + u] >= 0) seas.add(sea[v * W + u]);
					if (comp[v * W + u] >= 0 || !pass(u, v) || M.zoneAt(l, u, v) !== z) continue;
					comp[v * W + u] = 1;
					q.push(v * W + u);
				}
			}
			if (!byZone.has(z)) byZone.set(z, []);
			byZone.get(z).push({ n, seas });
		}
		for (const [z, pieces] of byZone) {
			// pieces sharing a sea join
			const parent = pieces.map((_, i) => i), find = a => { while (parent[a] !== a) a = parent[a] = parent[parent[a]]; return a; };
			for (let a = 0; a < pieces.length; a++) for (let b = a + 1; b < pieces.length; b++)
				if ([...pieces[a].seas].some(s => pieces[b].seas.has(s))) parent[find(a)] = find(b);
			const sum = new Map();
			pieces.forEach((p, i) => sum.set(find(i), (sum.get(find(i)) || 0) + p.n));
			const open = pieces.reduce((a, p) => a + p.n, 0), main = Math.max(...sum.values());
			if (open >= 100 && main < 0.7 * open && open - main > 40) out.push({ zone: z, l, main, open });
		}
	}
	return out.sort((a, b) => a.l - b.l || a.zone - b.zone);
}

/** Towns in a start's own zone that share no guard-free region with the start's gate. */
function ownTownsBehindGuards(A) {
	const M = A.M, out = [];
	if (!M.zoneAt) return out;
	const towns = M.objs.filter(o => o.cls === 'town');
	for (const s of A.starts) {
		if (s.zone === undefined || s.zone === null || !s.regions || !s.regions.length) continue;
		const mine = new Set(s.regions);
		for (const t of towns) {
			if (t.l !== s.l || (t.at[0] === s.at[0] && t.at[1] === s.at[1])) continue;
			if (M.zoneAt(t.l, t.at[0], t.at[1]) !== s.zone) continue;
			if (!M.regionsOf(t).some(r => mine.has(r))) out.push({ who: s.colour, at: t.at, l: t.l });
		}
	}
	return out;
}

function main(args) {
	const files = args.filter(a => !a.startsWith('--'));
	let failed = 0;
	for (const f of files) {
		const r = checkMap(f);
		if (r.fails.length) failed++;
		const name = f.split('/').pop().split(String.fromCharCode(92)).pop();
		console.log(`${r.fails.length ? 'FAIL' : 'PASS'} ${name}${r.fails.length ? ': ' + r.fails.join('; ') : ''}${r.notes.length ? '  [' + r.notes.join('; ') + ']' : ''}`);
	}
	console.log(`${files.length - failed} of ${files.length} pass`);
	if (failed) process.exitCode = 1;
}

module.exports = { main, checkMap, sealedObjects, ownTownsBehindGuards, emptyZones, splitZones, teleportsOffRoad, openGround, creaturesOver };
