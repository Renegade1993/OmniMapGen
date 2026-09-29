/**
 * waterfill.js - boats, shipyards and what lies on the water (queue item
 * 25d, water phase W2).
 *
 * Modelled on the engine's WaterProxy (lib/rmg/modificators/WaterProxy.cpp):
 * a water body under 25 cells gets nothing (line 168); a zone on the shore
 * that holds a town gets a shipyard, any other zone a boat (lines 184-213),
 * and no land object crowds the boarding spot. Templates come from the game's
 * own object table (water_templates.json, tools/extract_h3_templates.js).
 *
 * Two passes. Harbours go in right after the towns (placeHarbours), so every
 * later pass routes around them and their boarding cells stay free. Water
 * treasure and scenery go in last (fillWater), on water only, where a boat
 * launched from a harbour can sail, after the passes that prune objects they
 * judge unreachable over land.
 *
 * waterAccess: 0 no harbours, 1 shipyards at player starts only, 2 shipyards
 * in every town zone (the engine's rule; default), 3 also a boat in every
 * other zone on the shore. waterTreasure multiplies the treasure rates.
 */
'use strict';

const { OCCUPIED, RESERVED, blockingCells, visitableCells, allowedDirs,
	footprintFits, footprintBlock, reserveCell, makeConnectivityGuard } = require('./content');
const WT = require('./water_templates.json').templates;

const BOAT_SUBTYPES = ['boatNecropolis', 'boatCastle', 'boatFortress'];
const SCENERY_TYPE = { 125: 'kelp', 147: 'rock', 161: 'reef' };
const identity = t => {
	if (t.kind === 'boat') return ['boat', BOAT_SUBTYPES[t.subid] || 'boatCastle'];
	if (t.kind === 'waterScenery') return [SCENERY_TYPE[t.id], 'object'];
	if (['shipyard', 'whirlpool', 'oceanBottle', 'sirens'].includes(t.kind)) return [t.kind, 'object'];
	return [t.kind, t.kind];
};
const templatesOf = kind => WT.filter(t => t.kind === kind);

// per 1000 cells of sailable water; waterTreasure scales the treasure and
// waterBuildings the sites a boat visits. The corpus has no water to measure,
// so these follow the engine's water zones in spirit: a scatter of pickups, a
// few one-visit sites, rare banks. Sirens and whirlpools are the engine's own
// water objects (its water zone draws them into its treasure piles); a
// whirlpool throws a ship to another, so they go down in pairs.
const TREASURE_RATES = [
	['flotsam', 2.2], ['seaChest', 1.8], ['shipwreckSurvivor', 0.6],
	['derelictShip', 0.35], ['shipwreck', 0.35],
];
const BUILDING_RATES = [
	['buoy', 0.6], ['mermaids', 0.4], ['sirens', 0.3], ['whirlpool', 0.3],
];
const SCENERY_RATE = { kelp: 5, blocking: 4 };
const MIN_BODY = 25;

function waterBodies(water, W, H) {
	const id = new Int32Array(W * H).fill(-1);
	const bodies = [];
	for (let c0 = 0; c0 < W * H; c0++) {
		if (!water[c0] || id[c0] >= 0) continue;
		const k = bodies.length, q = [c0];
		id[c0] = k;
		for (let h = 0; h < q.length; h++) {
			const c = q[h], x = c % W, y = (c / W) | 0;
			for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const d = ny * W + nx;
				if (water[d] && id[d] < 0) { id[d] = k; q.push(d); }
			}
		}
		bodies.push({ cells: q, size: q.length });
	}
	return { id, bodies };
}

const inMask = (tpl, x, y, W, H) => {
	const h = tpl.mask.length;
	for (let r = 0; r < h; r++) {
		const w = tpl.mask[r].length;
		for (let i = 0; i < w; i++) {
			const cx = x - (w - 1 - i), cy = y - (h - 1 - r);
			if (cx < 0 || cy < 0 || cx >= W || cy >= H) return false;
		}
	}
	return true;
};

// the shipyard's launch tiles, in the engine's order (CGShipyard::getOutOffsets)
const LAUNCH = [[-2, 0], [2, 0], [-2, 1], [2, 1], [-1, 1], [1, 1], [0, 1],
	[-2, -1], [2, -1], [-1, -1], [1, -1], [0, -1]];

/**
 * ctx: { W, H, l, water, zone, classes, blocked, rng, p, objects, towns,
 *        playerStarts, objectEntry, reachable }
 * Places shipyards and boats; returns harbours [{ body, cell }] (the water
 * cell a boat stands on or a shipyard launches onto) for fillWater.
 */
function placeHarbours(ctx) {
	const { W, H, l, water, zone, blocked, rng, p, objects, towns, playerStarts, objectEntry } = ctx;
	// an island map without harbours strands every player, so it gets at
	// least the start shipyards whatever the setting says
	const access = Math.max(ctx.islands ? 1 : 0,
		Math.round(Number.isFinite(p.waterAccess) ? p.waterAccess : 2));
	if (!water || access <= 0) return [];
	const base = l * W * H;
	const { id, bodies } = waterBodies(water, W, H);
	const startZones = new Set(playerStarts.map(s => zone[s.y * W + s.x]));
	const townZones = new Set(towns.filter(t => t.l === l).map(t => zone[t.y * W + t.x]));
	// ctx.keepClear: the doorways' guard cells. A harbour's approach or a boat's
	// boarding cell reserved on one left the doorway's guard no room, and two
	// zones open to each other: on water maps of September 27th's sweep, 36x36
	// and 72x72 (lens t65, and this afternoon's code with the same water)
	const keep = ctx.keepClear || new Set();
	const free = c => !(blocked[base + c] & (OCCUPIED | RESERVED)) && !keep.has(c);
	const near = (c, list, r) => list.some(s => Math.max(Math.abs(s.x - c % W), Math.abs(s.y - ((c / W) | 0))) <= r);
	const shipyards = templatesOf('shipyard'), boats = templatesOf('boat');
	const harbours = [];
	const used = new Set();                          // water cells promised to a harbour
	const boatUsed = [];
	const onShore = new Set();                       // zones with land on a body big enough for a harbour
	const sqDist = (c, t) => (c % W - t.x) ** 2 + (((c / W) | 0) - t.y) ** 2;
	// A crossroads island the sea left apart (ctx.hubCells, water.js): a harbour goes where the
	// players can walk to and never on the island, where it would lead nowhere
	const hubCells = ctx.hubCells || [];
	const landPiece = new Int32Array(hubCells.length ? W * H : 0).fill(-1);
	if (hubCells.length) {
		let k = 0;
		for (let c0 = 0; c0 < W * H; c0++) {
			if (water[c0] || landPiece[c0] >= 0) continue;
			const q = [c0];
			landPiece[c0] = k;
			for (let h = 0; h < q.length; h++) {
				const c = q[h], x = c % W, y = (c / W) | 0;
				for (const [u, v] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]])
					if (u >= 0 && v >= 0 && u < W && v < H && !water[v * W + u] && landPiece[v * W + u] < 0) { landPiece[v * W + u] = k; q.push(v * W + u); }
			}
			k++;
		}
	}
	const hubPiece = new Set(hubCells.map(c => landPiece[c]));
	const ashore = c => !hubCells.length || !hubPiece.has(landPiece[c]);

	const tryShipyard = (b, z, toward = null) => {
		const tpl = shipyards[0].template;
		// anchors: the three blocked cells sit on this zone's shore land
		const cand = [];
		for (const c of bodies[b].cells) {
			const x = c % W, y = (c / W) | 0;
			for (let dy = -2; dy <= 2; dy++)
				for (let dx = -3; dx <= 3; dx++) {
					const ax = x + dx, ay = y + dy;
					if (ax < 0 || ay < 0 || ax >= W || ay >= H) continue;
					cand.push(ay * W + ax);
				}
		}
		const seen = new Set();
		const order = cand.filter(c => !seen.has(c) && seen.add(c));
		if (toward) order.sort((p, q) => sqDist(p, toward) - sqDist(q, toward) || p - q);
		else for (let i = order.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; [order[i], order[j]] = [order[j], order[i]]; }
		for (const a of order) {
			const ax = a % W, ay = (a / W) | 0;
			if (!inMask(tpl, ax, ay, W, H) || !footprintFits(tpl, ax, ay, l, W, H, blocked)) continue;
			const own = blockingCells(tpl, ax, ay).map(([u, v]) => v * W + u);
			if (own.some(c => water[c] || zone[c] !== z || keep.has(c) || !ashore(c))) continue;
			if (near(a, playerStarts, 4)) continue;
			// a hero walks up to it from the row below
			const [vx, vy] = visitableCells(tpl, ax, ay)[0];
			const approach = allowedDirs(tpl).map(([dx, dy]) => [vx + dx, vy + dy])
				.filter(([u, v]) => u >= 0 && v >= 0 && u < W && v < H)
				.map(([u, v]) => v * W + u).filter(c => !own.includes(c) && !water[c] && free(c));
			if (!approach.length) continue;
			// the tile it launches onto: the engine takes the first free water
			// tile in its offset order, which has to be this body's
			let launch = -1;
			for (const [dx, dy] of LAUNCH) {
				const u = vx + dx, v = vy + dy;
				if (u < 0 || v < 0 || u >= W || v >= H) continue;
				const c = v * W + u;
				if (!water[c]) continue;
				launch = c;
				break;
			}
			if (launch < 0 || id[launch] !== b || used.has(launch)) continue;
			// and a hero can step from land into that boat
			const lx = launch % W, ly = (launch / W) | 0;
			let boarding = -1;
			for (let dy = -1; dy <= 1 && boarding < 0; dy++)
				for (let dx = -1; dx <= 1 && boarding < 0; dx++) {
					const u = lx + dx, v = ly + dy;
					if (u < 0 || v < 0 || u >= W || v >= H || (!dx && !dy)) continue;
					const c = v * W + u;
					if (!water[c] && free(c) && !own.includes(c)) boarding = c;
				}
			if (boarding < 0) continue;
			const [type, subtype] = identity(shipyards[0]);
			objects.push(objectEntry(type, ax, ay, l, tpl, subtype));
			footprintBlock(tpl, ax, ay, l, W, H, blocked);
			for (const c of approach) reserveCell(blocked, l, W, H, c);
			reserveCell(blocked, l, W, H, boarding);
			used.add(launch);
			harbours.push({ body: b, cell: launch, kind: 'shipyard', zone: z,
				boarding: [...approach, boarding] });
			return true;
		}
		return false;
	};

	const tryBoat = (b, z, landOk = d => zone[d] === z, relaxed = false, toward = null) => {
		const tplEntry = boats[(rng() * boats.length) | 0];
		const tpl = tplEntry.template;
		const shore = [];
		for (const c of bodies[b].cells) {
			const x = c % W, y = (c / W) | 0;
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					const u = x + dx, v = y + dy;
					if (u < 0 || v < 0 || u >= W || v >= H) continue;
					const d = v * W + u;
					if (!water[d] && landOk(d) && free(d) && ashore(d)) shore.push([d, c]);
				}
		}
		if (toward) shore.sort((p, q) => sqDist(p[0], toward) - sqDist(q[0], toward) || p[0] - q[0] || p[1] - q[1]);
		else for (let i = shore.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; [shore[i], shore[j]] = [shore[j], shore[i]]; }
		for (const [land, w] of shore) {
			if (used.has(w) || (!relaxed && near(land, playerStarts, 4))) continue;
			if (!relaxed && boatUsed.some(q => Math.max(Math.abs(q % W - w % W), Math.abs(((q / W) | 0) - ((w / W) | 0))) < 6)) continue;
			// the boat's visitable tile is the middle of its bottom row
			const ax = w % W + 1, ay = (w / W) | 0;
			if (!inMask(tpl, ax, ay, W, H)) continue;
			const [vx, vy] = visitableCells(tpl, ax, ay)[0];
			if (vy * W + vx !== w) continue;
			const [type, subtype] = identity(tplEntry);
			objects.push(objectEntry(type, ax, ay, l, tpl, subtype));
			reserveCell(blocked, l, W, H, land);
			used.add(w);
			boatUsed.push(w);
			// a hero boards from any open land beside the boat
			const boarding = [];
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					const u = w % W + dx, v = ((w / W) | 0) + dy;
					if ((dx || dy) && u >= 0 && v >= 0 && u < W && v < H && !water[v * W + u]) boarding.push(v * W + u);
				}
			harbours.push({ body: b, cell: w, kind: 'boat', zone: z, boarding });
			return true;
		}
		return false;
	};

	bodies.forEach((body, b) => {
		if (body.size < MIN_BODY) return;
		const shoreZones = new Set();
		for (const c of body.cells) {
			const x = c % W, y = (c / W) | 0;
			for (const [u, v] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]])
				if (u >= 0 && v >= 0 && u < W && v < H && !water[v * W + u]) shoreZones.add(zone[v * W + u]);
		}
		shoreZones.forEach(z => onShore.add(z));
		for (const z of [...shoreZones].sort((a, c) => a - c)) {
			const start = startZones.has(z), town = start || townZones.has(z);
			const wantYard = town && (start || access >= 2);
			const wantBoat = access >= 3 || (start && access >= 1);
			// on an island map a start also gets a boat waiting on its shore:
			// buying one at a shipyard is not something every AI can do
			if (wantYard && tryShipyard(b, z) && !(ctx.islands && start)) continue;
			if (wantBoat || wantYard) tryBoat(b, z);
		}
	});
	// "Every biome" (access 3): a zone that touches no water of its own sails from the nearest shore of
	// a zone beside it. K, 2026-09-29, Jebus Cross with a Mediterranean sea held inside the crossroads
	// zone: the four player biomes touched no water and got nothing, and the one shipyard on a shore of
	// hundreds of cells read as "no harbours anywhere".
	if (access >= 3) {
		const adj = new Map();
		const landZones = new Set();
		for (let c = 0; c < W * H; c++) {
			if (water[c]) continue;
			const za = zone[c];
			landZones.add(za);
			for (const d of [(c % W) + 1 < W ? c + 1 : -1, c + W < W * H ? c + W : -1]) {
				if (d < 0 || water[d] || zone[d] === za) continue;
				const zb = zone[d];
				if (!adj.has(za)) adj.set(za, new Set());
				if (!adj.has(zb)) adj.set(zb, new Set());
				adj.get(za).add(zb);
				adj.get(zb).add(za);
			}
		}
		// where a zone's harbour is wanted: its starts, else the middle of its land
		const anchorOf = z => {
			let sx = 0, sy = 0, n = 0;
			for (const s of playerStarts) if (zone[s.y * W + s.x] === z) { sx += s.x; sy += s.y; n++; }
			if (!n)
				for (let c = 0; c < W * H; c++)
					if (!water[c] && zone[c] === z) { sx += c % W; sy += (c / W) | 0; n++; }
			return n ? { x: sx / n, y: sy / n } : null;
		};
		for (const z of [...landZones].sort((a, c) => a - c)) {
			if (onShore.has(z)) continue;
			const start = startZones.has(z), town = start || townZones.has(z);
			const wantYard = town && (start || access >= 2);
			const wantBoat = access >= 3 || (start && access >= 1);
			const anchor = anchorOf(z);
			if (!anchor || !(wantYard || wantBoat)) continue;
			// the shore nearest to it among the zones that share a border with it
			let best = null;
			for (const zz of adj.get(z) || []) {
				if (!onShore.has(zz)) continue;
				bodies.forEach((body, b) => {
					if (body.size < MIN_BODY) return;
					for (const c of body.cells) {
						const x = c % W, y = (c / W) | 0;
						for (const [u, v] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
							if (u < 0 || v < 0 || u >= W || v >= H) continue;
							const d = v * W + u;
							if (water[d] || zone[d] !== zz || !ashore(d)) continue;
							const dd = (u - anchor.x) ** 2 + (v - anchor.y) ** 2;
							if (!best || dd < best.dd || (dd === best.dd && (zz < best.zz || (zz === best.zz && b < best.b))))
								best = { b, zz, dd };
						}
					}
				});
			}
			if (!best) continue;
			const first = harbours.length;
			const yard = wantYard && tryShipyard(best.b, best.zz, anchor);
			if (!(yard && !(ctx.islands && start)) && (wantBoat || wantYard)) tryBoat(best.b, best.zz, undefined, false, anchor);
			for (let k = first; k < harbours.length; k++) harbours[k].serves = z;
		}
	}
	if (ctx.islands) {
		// Every start's island must have a boat waiting on it: a shipyard
		// alone strands any AI that cannot buy one. A start whose island got
		// none above (its zone missed the shore, or the shore was taken) gets
		// one on any shore of that island; with none, the map cannot be played.
		const island = new Int32Array(W * H).fill(-1);
		let k = 0;
		for (let c0 = 0; c0 < W * H; c0++) {
			if (water[c0] || island[c0] >= 0) continue;
			const q = [c0];
			island[c0] = k;
			for (let h = 0; h < q.length; h++) {
				const c = q[h], x = c % W, y = (c / W) | 0;
				for (const [u, v] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]])
					if (u >= 0 && v >= 0 && u < W && v < H && !water[v * W + u] && island[v * W + u] < 0) { island[v * W + u] = k; q.push(v * W + u); }
			}
			k++;
		}
		// the islands each body's shore touches: a harbour on a lake inside
		// an island leads nowhere
		const touches = bodies.map(() => new Set());
		for (let c = 0; c < W * H; c++) {
			if (!water[c]) continue;
			const x = c % W, y = (c / W) | 0;
			for (const [u, v] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]])
				if (u >= 0 && v >= 0 && u < W && v < H && !water[v * W + u]) touches[id[c]].add(island[v * W + u]);
		}
		const outward = b => bodies[b].size >= MIN_BODY && touches[b].size >= 2;
		for (const s of playerStarts) {
			const home = island[s.y * W + s.x];
			if (home < 0 || harbours.some(h => h.kind === 'boat' && outward(h.body)
				&& h.boarding.some(c => island[c] === home))) continue;
			let ok = false;
			for (let b = 0; b < bodies.length && !ok; b++)
				if (outward(b) && touches[b].has(home)) ok = tryBoat(b, zone[s.y * W + s.x], d => island[d] === home, true);
			if (!ok) throw new Error('An island start has no shore a boat can use; lower the amount of water or pick another water layout.');
		}
	}
	if (hubCells.length) {
		// The crossroads island is reached by boat: some harbour on ground the players walk to has
		// to sail water that touches it. With none, one boat goes on any shore of that ground; with
		// no room for that either, the caller bridges the island as it was before (generate.js).
		const touchesHub = new Set();
		for (let c = 0; c < W * H; c++) {
			if (!water[c]) continue;
			const x = c % W, y = (c / W) | 0;
			for (const [u, v] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]])
				if (u >= 0 && v >= 0 && u < W && v < H && !water[v * W + u] && hubPiece.has(landPiece[v * W + u])) touchesHub.add(id[c]);
		}
		if (!harbours.some(h => touchesHub.has(h.body) && h.boarding.some(ashore))) {
			let ok = false;
			for (const b of [...touchesHub].sort((a, c) => a - c))
				if (bodies[b].size >= MIN_BODY && !ok) ok = tryBoat(b, zone[hubCells[0]], ashore, true);
			if (!ok) throw new Error('The crossroads island has no shore a boat can sail from; the island is bridged instead.');
		}
	}
	const served = harbours.filter(h => h.serves !== undefined).length;
	if (harbours.length)
		console.error(`[gen] level ${l}: water harbours: `
			+ `${harbours.filter(h => h.kind === 'shipyard').length} shipyard(s), `
			+ `${harbours.filter(h => h.kind === 'boat').length} boat(s)`
			+ (served ? `, ${served} of them for zones off the shore` : ''));
	return harbours;
}

/**
 * Treasure and scenery on the water a harbour's boat can reach. Runs last.
 * ctx: { W, H, l, water, harbours, rng, p, objects, objectEntry }
 */
function fillWater(ctx) {
	const { W, H, l, water, harbours, rng, p, objects, objectEntry } = ctx;
	if (!water || !harbours || !harbours.length) return 0;
	const mult = Number.isFinite(p.waterTreasure) ? p.waterTreasure : 1;
	const bmult = Number.isFinite(p.waterBuildings) ? p.waterBuildings : 1;
	// the water layer: land and everything already on the water is taken
	const wb = new Uint8Array(W * H);
	for (let c = 0; c < W * H; c++) if (!water[c]) wb[c] = OCCUPIED;
	for (const o of objects) {
		if ((o.l || 0) !== l || !o.template || !o.template.mask) continue;
		for (const [x, y] of blockingCells(o.template, o.x, o.y))
			if (x >= 0 && y >= 0 && x < W && y < H) wb[y * W + x] |= OCCUPIED;
	}
	// keep every harbour's tile and the water around it open for the boat
	for (const h of harbours) {
		const x = h.cell % W, y = (h.cell / W) | 0;
		for (let dy = -1; dy <= 1; dy++)
			for (let dx = -1; dx <= 1; dx++) {
				const u = x + dx, v = y + dy;
				if (u >= 0 && v >= 0 && u < W && v < H) wb[v * W + u] |= RESERVED;
			}
	}
	const { id, bodies } = waterBodies(water, W, H);
	let placed = 0;
	const whirlpools = [];
	for (const b of [...new Set(harbours.map(h => h.body))].sort((a, c) => a - c)) {
		const seed = harbours.find(h => h.body === b).cell;
		// what a boat can reach, kept in one piece as things are placed
		const guard = makeConnectivityGuard(wb, 0, W, H, 0, seed);
		const cells = bodies[b].cells.slice();
		for (let i = cells.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; [cells[i], cells[j]] = [cells[j], cells[i]]; }
		const area = bodies[b].size / 1000;
		const wanted = [];
		for (const [kind, rate] of TREASURE_RATES) {
			const n = area * rate * mult;
			const k = Math.floor(n) + (rng() < n - Math.floor(n) ? 1 : 0);
			for (let i = 0; i < k; i++) wanted.push(kind);
		}
		for (const [kind, rate] of BUILDING_RATES) {
			const n = area * rate * bmult;
			let k = Math.floor(n) + (rng() < n - Math.floor(n) ? 1 : 0);
			// a lone whirlpool leads nowhere: an odd count takes its partner
			if (kind === 'whirlpool') k += k % 2;
			for (let i = 0; i < k; i++) wanted.push(kind);
		}
		const kelp = Math.round(area * SCENERY_RATE.kelp), rocks = Math.round(area * SCENERY_RATE.blocking);
		for (let i = 0; i < kelp; i++) wanted.push('kelp');
		for (let i = 0; i < rocks; i++) wanted.push('blocking');
		let cursor = 0;
		const sceneryOf = kind => templatesOf('waterScenery').filter(t =>
			kind === 'kelp' ? t.id === 125 : t.id !== 125);
		for (const kind of wanted) {
			const pool = kind === 'kelp' || kind === 'blocking' ? sceneryOf(kind) : templatesOf(kind);
			if (!pool.length) continue;
			const entry = pool[(rng() * pool.length) | 0];
			const tpl = entry.template;
			for (let tries = 0; tries < cells.length; tries++) {
				const c = cells[(cursor + tries) % cells.length];
				const x = c % W, y = (c / W) | 0;
				if (!inMask(tpl, x, y, W, H)) continue;
				// every masked cell on this water body (scenery art over land
				// would read as a rock on the beach)
				let onWater = true;
				for (let r = 0; r < tpl.mask.length && onWater; r++)
					for (let i = 0; i < tpl.mask[r].length; i++) {
						const u = x - (tpl.mask[r].length - 1 - i), v = y - (tpl.mask.length - 1 - r);
						if (!water[v * W + u] || id[v * W + u] !== b) { onWater = false; break; }
					}
				if (!onWater || !footprintFits(tpl, x, y, 0, W, H, wb)) continue;
				const walls = blockingCells(tpl, x, y).map(([u, v]) => v * W + u);
				// kelp blocks nothing, so footprintFits waves it through anywhere:
				// keep its art off cells another object or a harbour uses
				if (!walls.length) {
					let clear = true;
					for (let r = 0; r < tpl.mask.length && clear; r++)
						for (let i = 0; i < tpl.mask[r].length; i++) {
							const u = x - (tpl.mask[r].length - 1 - i), v = y - (tpl.mask.length - 1 - r);
							if (wb[v * W + u] & (OCCUPIED | RESERVED)) { clear = false; break; }
						}
					if (!clear) continue;
				}
				if (walls.length && !guard.accepts(walls)) continue;
				// a visit needs open water beside it that a boat can reach
				const vis = visitableCells(tpl, x, y);
				if (vis.length) {
					let ok = false;
					for (const [vx, vy] of vis)
						for (const [dx, dy] of allowedDirs(tpl)) {
							const u = vx + dx, v = vy + dy;
							if (u < 0 || v < 0 || u >= W || v >= H) continue;
							const n = v * W + u;
							if (!walls.includes(n) && !(wb[n] & OCCUPIED) && guard.reachable[n]) { ok = true; break; }
						}
					if (!ok) continue;
				}
				const [type, subtype] = identity(entry);
				objects.push(objectEntry(type, x, y, l, tpl, subtype));
				if (type === 'whirlpool') whirlpools.push(objects[objects.length - 1]);
				footprintBlock(tpl, x, y, 0, W, H, wb);
				if (walls.length) guard.refresh();
				else
					for (let r = 0; r < tpl.mask.length; r++)
						for (let i = 0; i < tpl.mask[r].length; i++)
							wb[(y - (tpl.mask.length - 1 - r)) * W + x - (tpl.mask[r].length - 1 - i)] |= RESERVED;
				// pickups keep a cell of open water around them
				if (vis.length)
					for (const [vx, vy] of vis)
						for (let dy = -1; dy <= 1; dy++)
							for (let dx = -1; dx <= 1; dx++) {
								const u = vx + dx, v = vy + dy;
								if (u >= 0 && v >= 0 && u < W && v < H) wb[v * W + u] |= RESERVED;
							}
				placed++;
				cursor = (cursor + tries + 1) % cells.length;
				break;
			}
		}
	}
	// whirlpools throw a ship to one another, any body of water to any other:
	// one whose partner found no room would lead nowhere, so it goes too
	if (whirlpools.length % 2) {
		objects.splice(objects.indexOf(whirlpools.pop()), 1);
		placed--;
	}
	if (placed) console.error(`[gen] level ${l}: ${placed} object(s) on the water`);
	return placed;
}

/**
 * Island maps (water W3): one link per harbour, from its boarding ground to
 * every land cell beside the water it sails (a landing). The links feed
 * followLinks and sweepStranded, which then treat a boat the way they treat
 * a portal pair. Each link is [boarding, shore, true (one way), kind].
 */
function sailLinksFor(harbours, water, W, H) {
	if (!harbours || !harbours.length) return [];
	const { id } = waterBodies(water, W, H);
	const shoreOf = new Map();
	for (let c = 0; c < W * H; c++) {
		if (water[c]) continue;
		const x = c % W, y = (c / W) | 0, seen = new Set();
		for (let dy = -1; dy <= 1; dy++)
			for (let dx = -1; dx <= 1; dx++) {
				const u = x + dx, v = y + dy;
				if ((!dx && !dy) || u < 0 || v < 0 || u >= W || v >= H || !water[v * W + u]) continue;
				const b = id[v * W + u];
				if (seen.has(b)) continue;
				seen.add(b);
				if (!shoreOf.has(b)) shoreOf.set(b, []);
				shoreOf.get(b).push(c);
			}
	}
	return harbours.map(h => [h.boarding, shoreOf.get(h.body) || [], true, h.kind]);
}

module.exports = { placeHarbours, fillWater, waterBodies, sailLinksFor, MIN_BODY };
