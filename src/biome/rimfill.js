/**
 * rimfill.js - post-object blocking just inside a zone's rim and along the
 * map edge, grown as lobes (queue item 21).
 *
 * Engine zones are open basins inside a thick rim. Over the 71-map corpus
 * (.tmp/opus/rim_profile.js, surface) the blocked share of floor is 85% two
 * cells in from a zone line, 61% three in and 49% four to five in; the outer
 * rows of the map run 66 / 68 / 61 / 52%. Two engine passes make it:
 *   - Zone::fractalize (Zone.cpp:267-423) blocks every tile more than about
 *     six from the zone's own free paths. Those paths rarely come near a zone
 *     line, and its path nodes keep 3 tiles off the map edge.
 *   - ObstaclePlacer (ObstaclePlacer.cpp:75-110) then blocks every leftover
 *     POSSIBLE tile whose blocked neighbours, the map edge counting as
 *     blocked, form one group, and repeats until nothing changes.
 * So the rim thickens into lobes where the paths are far and stays thin where
 * one comes near. After the rim band (boundaries.js addRimBand) ours ran
 * 68 / 44 / 39% on the zone rows and 43 / 47 / 48 / 49% on the edge rows.
 *
 * This pass runs on the finished level, after the content fill and the
 * roads, so it takes nothing from the fill's budget. Farthest first from the
 * ground the engine would keep free (corridors, doorways, roads, objects' ways
 * in), it lays whole obstacle pieces from the zone's own sets against the
 * scenery already there, so what it adds is lobes. Rules per piece:
 *   - the engine's: the scenery around it is one group (it grows one mass
 *     and never joins two). Objects do not count as mass: the engine grows
 *     BLOCKED tiles, and an object's tiles are USED;
 *   - the open ground around it stays one group, so it splits nothing;
 *   - it leaves no new one-cell sliver (content.js sliverCount), so the open
 *     side stays two wide. A full port of the engine pass without this cut
 *     roomy to 54-59 (SID-20260924-d3a91f);
 *   - doorways, roads and town forecourts stay open, and no object loses its
 *     last way in.
 * A lone cell goes in only where it fills a notch between two scenery faces.
 * Each row stops at its corpus share; the retile then re-covers everything.
 *
 * Tried first and dropped (72x72, one-cell decor per 1k floor, corpus 8.3):
 * one cell at a time, closest row first, 8 -> 15; the same growing runs along
 * the row, 14; two-deep dominoes, 15; farthest-first lobes of single cells,
 * 21, then 17 once objects stopped counting as mass. Cells added one by one
 * leave ragged edges the retile can only cover with one- and two-cell pieces.
 * Whole pieces: 8.8.
 *
 * VMAPGEN_RIMFILL=off turns it off; VMAPGEN_RIMFILL_TRACE=1 reports per row.
 */
'use strict';

const { OCCUPIED, RESERVED, APPROACH, blockingCells, sliverCount,
	visitableCells, allowedDirs } = require('./content');
const { singleTemplate } = require('./decor');
const { zoneTemplates, sizeGroups } = require('./retile');
const { rimLobeScale } = require('./biomes');

const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const TRACE = !!process.env.VMAPGEN_RIMFILL_TRACE;
// the 8-ring in cyclic order: consecutive entries are 4-adjacent
const RING = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];

/** Distance in 4-steps to the nearest cell with a 4-neighbour in another zone. */
function zoneLineDistance(zone, W, H) {
	const N = W * H;
	const d = new Int32Array(N).fill(-1);
	const q = [];
	for (let c = 0; c < N; c++) {
		const x = c % W, y = (c / W) | 0;
		for (const [dx, dy] of DIRS4) {
			const nx = x + dx, ny = y + dy;
			if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
			if (zone[ny * W + nx] !== zone[c]) { d[c] = 0; q.push(c); break; }
		}
	}
	for (let h = 0; h < q.length; h++) {
		const c = q[h], x = c % W, y = (c / W) | 0;
		for (const [dx, dy] of DIRS4) {
			const nx = x + dx, ny = y + dy;
			if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
			const n = ny * W + nx;
			if (d[n] < 0) { d[n] = d[c] + 1; q.push(n); }
		}
	}
	return d;
}

/**
 * The engine's test, for a whole piece: the scenery around it is one
 * 4-connected group (it grows one mass), and the open ground around it is one
 * 8-connected group (it splits nothing). Ring cells are keyed on a grid padded
 * by one so off-map neighbours take part, as blocked.
 */
function pieceGrowsOneMass(cells, W, H, isScen, isB) {
	const P = W + 2;
	const inSet = new Set(cells);
	const scen = new Set(), free = new Set();
	for (const c of cells) {
		const x = c % W, y = (c / W) | 0;
		for (const [dx, dy] of RING) {
			const nx = x + dx, ny = y + dy;
			if (nx >= 0 && ny >= 0 && nx < W && ny < H && inSet.has(ny * W + nx)) continue;
			const k = (ny + 1) * P + (nx + 1);
			if (isScen(nx, ny)) scen.add(k);
			else if (!isB(nx, ny)) free.add(k);
		}
	}
	const oneGroup = (set, dirs) => {
		if (set.size <= 1) return true;
		const first = set.values().next().value;
		const seen = new Set([first]), st = [first];
		while (st.length) {
			const k = st.pop(), x = k % P, y = (k / P) | 0;
			for (const [dx, dy] of dirs) {
				const n = (y + dy) * P + (x + dx);
				if (set.has(n) && !seen.has(n)) { seen.add(n); st.push(n); }
			}
		}
		return seen.size === set.size;
	};
	return scen.size > 0 && oneGroup(scen, DIRS4) && oneGroup(free, RING);
}

function shuffle(a, rng) {
	for (let i = a.length - 1; i > 0; i--) {
		const j = (rng() * (i + 1)) | 0;
		const t = a[i]; a[i] = a[j]; a[j] = t;
	}
	return a;
}

/**
 * Grow rim lobes on one finished surface level. Returns the number of cells
 * blocked; new scenery objects are pushed onto plan.objects.
 */
function fillRimRows(plan, W, H, l, blocked, rng, objectEntry, isScenery) {
	if (process.env.VMAPGEN_RIMFILL === 'off' || !plan.zone || !plan.biomeTerrain) return 0;
	if (rimLobeScale(plan.p) <= 0) return 0;
	const N = W * H, base = l * N;
	const zone = plan.zone;
	// Scenery cells. The engine's pass grows BLOCKED tiles only; an object's
	// tiles are USED, a different state, so ground beside a mine does not
	// erode. Counting objects as mass put 60% of the added one-cell pieces
	// against a functional object (72x72: one-cell decor 8 -> 21 per 1k).
	const scen = new Uint8Array(N);
	for (const o of plan.objects)
		if ((o.l || 0) === l && isScenery(o))
			for (const [x, y] of blockingCells(o.template, o.x, o.y))
				if (x >= 0 && y >= 0 && x < W && y < H) scen[y * W + x] = 1;
	const isScen = (x, y) => x < 0 || y < 0 || x >= W || y >= H || !!scen[y * W + x];
	const dz = zoneLineDistance(zone, W, H);
	const edgeD = c => { const x = c % W, y = (c / W) | 0; return Math.min(x, y, W - 1 - x, H - 1 - y); };

	// Held open whatever the shares say: doorways and the passages out of the
	// band, roads, and a town's forecourt (the 5x5 apron planLevel reserves in
	// front of each gate, and a little more).
	const keep = new Uint8Array(N);
	for (const c of plan.roadCells || []) keep[c] = 1;
	for (const o of plan.openings || []) {
		for (const c of o.hole || []) keep[c] = 1;
		for (const c of o.inner || []) keep[c] = 1;
	}
	if (plan.rim && plan.rim.passage)
		for (let c = 0; c < N; c++) if (plan.rim.passage[c]) keep[c] = 1;
	for (const t of plan.towns || []) {
		if ((t.l || 0) !== l) continue;
		for (const [gx, gy] of t.gates || [])
			for (let dy = -3; dy <= 3; dy++)
				for (let dx = -3; dx <= 3; dx++) {
					const x = gx + dx, y = gy + dy;
					if (x >= 0 && y >= 0 && x < W && y < H) keep[y * W + x] = 1;
				}
	}

	// Every object's ways in. RESERVED and APPROACH did their job during the
	// fill; the engine's pass blocks such ground too and only a hero's way in
	// has to survive, so an approach cell may go while every object it serves
	// keeps another one open.
	const owners = new Map(), open = [];
	plan.objects.forEach((o, i) => {
		if ((o.l || 0) !== l || !o.template || !o.template.mask) return;
		const own = new Set(blockingCells(o.template, o.x, o.y).map(([a, b]) => b * W + a));
		const cells = new Set();
		for (const [vx, vy] of visitableCells(o.template, o.x, o.y))
			for (const [dx, dy] of allowedDirs(o.template)) {
				const nx = vx + dx, ny = vy + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const c = ny * W + nx;
				if (own.has(c) || (blocked[base + c] & OCCUPIED)) continue;
				cells.add(c);
			}
		open[i] = cells.size;
		for (const c of cells) {
			if (!owners.has(c)) owners.set(c, []);
			owners.get(c).push(i);
		}
	});

	// Distance from the ground the engine keeps FREE: our corridors and
	// aprons (RESERVED), objects' ways in (APPROACH), roads and doorways.
	// Chebyshev steps, through blocking as the engine's distanceSqr is.
	const cd = new Int32Array(N).fill(-1);
	const q = [];
	for (let c = 0; c < N; c++) {
		const f = blocked[base + c];
		if (!(f & OCCUPIED) && ((f & (RESERVED | APPROACH)) || keep[c])) { cd[c] = 0; q.push(c); }
	}
	for (let h = 0; h < q.length; h++) {
		const c = q[h], x = c % W, y = (c / W) | 0;
		for (const [dx, dy] of RING) {
			const nx = x + dx, ny = y + dy;
			if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
			const n = ny * W + nx;
			if (cd[n] < 0) { cd[n] = cd[c] + 1; q.push(n); }
		}
	}

	// [label, corpus blocked share of floor, membership]
	const rows = [
		['zone 2', 0.85, c => dz[c] === 2],
		['zone 3', 0.61, c => dz[c] === 3],
		['zone 4-5', 0.49, c => dz[c] === 4 || dz[c] === 5],
		['edge 0', 0.66, c => edgeD(c) === 0],
		['edge 1', 0.68, c => edgeD(c) === 1],
		['edge 2', 0.61, c => edgeD(c) === 2],
		['edge 3', 0.52, c => edgeD(c) === 3],
	];
	const floor = rows.map(() => 0), have = rows.map(() => 0);
	const rowsOf = new Array(N);
	const cand = [];
	for (let c = 0; c < N; c++) {
		const m = [];
		rows.forEach(([, , at], i) => { if (at(c)) m.push(i); });
		if (!m.length) continue;
		rowsOf[c] = m;
		for (const i of m) {
			floor[i]++;
			if (blocked[base + c] & OCCUPIED) have[i]++;
		}
		if (!(blocked[base + c] & OCCUPIED) && !keep[c]) cand.push(c);
	}
	// borderSolidity scales the lobes: full corpus shares at 1, nothing added
	// at 0.5 (the band alone) and below
	const t = rimLobeScale(plan.p);
	const target = rows.map(([, share], i) => t >= 1 ? Math.round(share * floor[i])
		: Math.round(have[i] + t * Math.max(0, share * floor[i] - have[i])));
	const startHave = have.slice();
	const isB = (x, y) => x < 0 || y < 0 || x >= W || y >= H
		|| !!(blocked[base + y * W + x] & OCCUPIED);
	const why = { full: 0, approach: 0, groups: 0, sliver: 0, art: 0 };

	// Whole pieces from the zone's own obstacle sets, the way the retile draws
	// them: cells added one at a time left ragged edges the retile could only
	// cover with one- and two-cell pieces, whatever order they went in.
	const groupCache = new Map();
	const groupsFor = z => {
		if (!groupCache.has(z))
			groupCache.set(z, sizeGroups(zoneTemplates(plan.biomeTerrain[z], rng))
				.filter(([size]) => size >= 2 && size <= 12));
		return groupCache.get(z);
	};
	const cellOK = (k, z) => !(blocked[base + k] & OCCUPIED) && !keep[k] && rowsOf[k] && zone[k] === z;
	const lawful = cells => {
		const lose = new Map();
		for (const k of cells)
			for (const i of owners.get(k) || []) lose.set(i, (lose.get(i) || 0) + 1);
		for (const [i, n] of lose) if (open[i] - n < 1) { why.approach++; return false; }
		if (!pieceGrowsOneMass(cells, W, H, isScen, isB)) { why.groups++; return false; }
		if (sliverCount(cells, blocked, l, W, H) > 0) { why.sliver++; return false; }
		return true;
	};
	// The largest piece covering c that fits, a few draws per size; a lone
	// cell only where it fills a notch (two scenery faces), never as a spur.
	const pieceAt = c => {
		const x = c % W, y = (c / W) | 0, z = zone[c];
		for (const [, temps] of groupsFor(z)) {
			let tries = 0;
			for (const e of shuffle(temps.slice(), rng)) {
				if (tries > 12) break;
				for (const [odx, ody] of e.offs) {
					const ax = x - odx, ay = y - ody;
					if (ax < 0 || ay < 0 || ax >= W || ay >= H) continue;
					tries++;
					const cells = [];
					let ok = true;
					for (const [dx, dy] of e.offs) {
						const px = ax + dx, py = ay + dy;
						if (px < 0 || py < 0 || px >= W || py >= H || !cellOK(py * W + px, z)) { ok = false; break; }
						cells.push(py * W + px);
					}
					if (ok && lawful(cells))
						return { cells, ax, ay, type: e.type, tpl: { animation: e.animation, mask: e.mask } };
				}
			}
		}
		let faces = 0;
		for (const [dx, dy] of DIRS4) if (isScen(x + dx, y + dy)) faces++;
		if (faces < 2 || !lawful([c])) return null;
		const s = singleTemplate(plan.biomeTerrain[z], rng);
		if (!s) { why.art++; return null; }
		const [[bx, by]] = blockingCells(s.tpl, 0, 0);
		const ax = x - bx, ay = y - by;
		// art may hang off the top or left edge; the anchor may not leave the map
		if (ax >= W || ay >= H) { why.art++; return null; }
		return { cells: [c], ax, ay, type: s.type, tpl: s.tpl };
	};

	// farthest from the free ground first; a random order among equals
	shuffle(cand, rng);
	cand.sort((a, b) => cd[b] - cd[a]);
	let total = 0;
	// the engine repeats until nothing changes: a cell refused because its
	// neighbour was still open can qualify once that neighbour fills
	for (let sweep = 0; sweep < 8; sweep++) {
		let placed = 0;
		for (const c of cand) {
			if (blocked[base + c] & OCCUPIED) continue;
			if (rowsOf[c].some(i => have[i] >= target[i])) { why.full++; continue; }
			if ((owners.get(c) || []).some(i => open[i] < 2)) { why.approach++; continue; }
			const piece = pieceAt(c);
			if (!piece) continue;
			for (const k of piece.cells) {
				blocked[base + k] |= OCCUPIED;
				scen[k] = 1;
				for (const i of owners.get(k) || []) open[i]--;
				for (const i of rowsOf[k]) have[i]++;
			}
			plan.objects.push(objectEntry(piece.type, piece.ax, piece.ay, l, piece.tpl, 'object'));
			placed++;
			total += piece.cells.length;
		}
		if (!placed) break;
	}
	if (TRACE) {
		console.error('[rimfill] ' + rows.map(([name], i) =>
			`${name} ${Math.round(100 * startHave[i] / (floor[i] || 1))}->`
			+ `${Math.round(100 * have[i] / (floor[i] || 1))}% (target ${Math.round(100 * target[i] / (floor[i] || 1))})`).join(', '));
		console.error(`[rimfill] refusals (all sweeps): ${JSON.stringify(why)}`);
	}
	return total;
}

module.exports = { fillRimRows, zoneLineDistance, pieceGrowsOneMass };
