'use strict';
/**
 * splinecave.js - an underground level carved as a network of curved tunnels.
 *
 * K, 2026-10-01, on our Coldshadow's Fantasy underground (a round open chamber per zone, loot scattered over the
 * middle): "I TOLD THE MAPGEN TO USE SPLINES FROM THE BEGINNING" and "make the map look like this" (the engine's map,
 * a branching web of tunnels with rock between). The engine's underground is about half open (Coldshadow's Fantasy
 * 144x144: 0.49 to 0.55 of the level), the same share as ours was; the difference is shape: its floor runs in bands
 * that reach every part of a zone, ours sat in one disc a zone.
 *
 * Each zone gets nodes: its start (a chamber), the zone's side of every doorway, the gate sites held for it, and
 * waypoints spread over the zone a tunnel spacing apart. The nodes are joined by a spanning tree (the shortest links
 * first) and a few extra links that make loops, and every link is a cubic Bezier curve bent sideways at random, carved
 * at a width that swells and narrows along it. Tunnels stay inside their zone and never open beside another zone's
 * ground (zoneLineSafe), except through the doorway. The result does not depend on the template: a free layout's
 * biomes get the same network, joined across the borders the layout opens.
 *
 * Levers (p): caveSpacing, tiles between waypoints (default 9); caveWidth, the tunnel's mean width (default 4.6);
 * caveLoops, the share of nodes given an extra link (default 0.2).
 */

function carveSplines(W, H, zone, seeds, edges, connections, p, rng, doors, helpers) {
	const { doorCells, zoneLineSafe } = helpers;
	const open = new Uint8Array(W * H);
	// the tunnels' centre lines, for the roads to ride (roadplan.js), and the tunnel ends (waypoints with one link),
	// where the fill puts dwellings as the engine's stand at the end of a spur (content.js)
	const spine = new Uint8Array(W * H);
	const leaves = [];
	const Z = seeds.length;
	const spacing = Math.max(5, Number(p.caveSpacing) || 12);
	const width = Math.max(2, Number(p.caveWidth) || 6);
	const loops = Math.max(0, Math.min(1, p.caveLoops == null ? 0.35 : Number(p.caveLoops)));
	const num = (k, d) => (process.env['VMAPGEN_' + k] !== undefined ? Number(process.env['VMAPGEN_' + k]) : d);
	// tuning levers (env for the measuring loop; defaults fitted to the engine's Coldshadow's Fantasy underground)
	const VARY_LO = num('CAVE_VARY_LO', 0.45), VARY_HI = num('CAVE_VARY_HI', 1.4), SWELL = num('CAVE_SWELL', 0.18);
	const PINCH = num('CAVE_PINCH', 0.3), CLEARING = num('CAVE_CLEARING', 0.6);
	const CLEAR_LO = num('CAVE_CLEAR_LO', 3), CLEAR_HI = num('CAVE_CLEAR_HI', 4.5);
	const INLET = num('CAVE_INLET', 0.04), BEND = num('CAVE_BEND', 0.14);
	const SPUR_AREA = num('CAVE_SPUR_AREA', 180), SPUR_MIN = num('CAVE_SPUR_MIN', 4), SPUR_MAX = num('CAVE_SPUR_MAX', 8);
	// each zone's own tunnel width (p.caveZoneScale, from its type, plan.js): the engine's underground is rock but where
	// its objects and paths stand, so a zone's floor follows what it holds (Coldshadow's Fantasy, engine with K's mods:
	// start zones 0.48 of their tiles open, treasure 0.42, junctions 0.25; ours were 0.29, 0.34, 0.34, and an underground
	// start's loot packed into its tunnels, K, 2026-10-03: "the bottom right corners are still getting stacked")
	const zs = z => (p.caveZoneScale && z >= 0 && p.caveZoneScale[z] > 0 ? p.caveZoneScale[z] : 1);
	const doorCell = doors ? new Uint8Array(W * H) : null;
	if (doors) for (const o of doors) if (o.kind !== 'portal' && o.hole.length) for (const c of doorCells(o, zone, W, H)) doorCell[c] = 1;
	// a one-tile mouth round each doorway, on both sides, where the tunnels may meet beside the other zone's floor:
	// without it the second zone's tunnel stopped a tile short of the doorway, refused beside the first zone's floor
	// (Coldshadow's Fantasy seed 4, 2026-10-02: zones 8 and 16 cut off below, their towns dropped)
	if (doors) {
		const mouth = [];
		for (let c = 0; c < W * H; c++) {
			if (!doorCell[c]) continue;
			const x = c % W, y = (c / W) | 0;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const nx = x + dx, ny = y + dy;
				if (nx < 1 || ny < 1 || nx >= W - 1 || ny >= H - 1) continue;
				mouth.push(ny * W + nx);
			}
		}
		for (const c of mouth) doorCell[c] = 1;
	}

	const cellsOf = Array.from({ length: Z }, () => []);
	for (let c = 0; c < W * H; c++) if (zone[c] >= 0 && zone[c] < Z) cellsOf[zone[c]].push(c);
	// a cell this far inside its zone (every cell within r tiles is the zone's)
	const inside = (c, r) => {
		const x = c % W, y = (c / W) | 0, z = zone[c];
		if (x < r + 1 || y < r + 1 || x >= W - r - 1 || y >= H - r - 1) return false;
		for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (zone[c + dy * W + dx] !== z) return false;
		return true;
	};
	const cut = (x, y, r, z) => {
		const r2 = r * r, R = Math.ceil(r);
		for (let yy = Math.max(1, Math.floor(y - R)); yy <= Math.min(H - 2, Math.ceil(y + R)); yy++)
			for (let xx = Math.max(1, Math.floor(x - R)); xx <= Math.min(W - 2, Math.ceil(x + R)); xx++) {
				if ((xx - x) ** 2 + (yy - y) ** 2 > r2) continue;
				const c = yy * W + xx;
				if (open[c]) continue;
				if (z >= 0 && zone[c] !== z) continue;
				if (doors && !zoneLineSafe(open, zone, W, H, c, doorCell)) continue;
				open[c] = 1;
			}
	};
	// a smooth random wobble along a curve: the sum of two sines of random phase
	const wobble = () => { const a = rng() * 6.28, b = rng() * 6.28, f = 0.6 + rng() * 0.8, g = 1.7 + rng() * 1.2; return t => 0.6 * Math.sin(a + f * t) + 0.4 * Math.sin(b + g * t); };
	const curve = (A, B, z) => {
		const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy);
		if (len < 0.5) { cut(A.x, A.y, width * zs(z) / 2, z); return; }
		const px = -dy / len, py = dx / len;
		const o1 = (rng() * 2 - 1) * BEND * len, o2 = (rng() * 2 - 1) * BEND * len;
		const P1 = { x: A.x + dx / 3 + px * o1, y: A.y + dy / 3 + py * o1 };
		const P2 = { x: A.x + 2 * dx / 3 + px * o2, y: A.y + 2 * dy / 3 + py * o2 };
		const w = wobble();
		// each tunnel its own width, swelling and narrowing along it, some pinched to a squeeze: the engine's passages
		// run from 1 to 9 tiles wide (Coldshadow's Fantasy, mapsight shape: p10 1, p50 5, p90 7 to 9)
		const lw = width * zs(z) * (VARY_LO + rng() * (VARY_HI - VARY_LO));
		const pinch = rng() < PINCH ? { at: 0.2 + rng() * 0.6, half: 0.06 + rng() * 0.08 } : null;
		const steps = Math.ceil(len * 2.5) + 2;
		for (let s = 0; s <= steps; s++) {
			const t = s / steps, u = 1 - t;
			const x = u * u * u * A.x + 3 * u * u * t * P1.x + 3 * u * t * t * P2.x + t * t * t * B.x;
			const y = u * u * u * A.y + 3 * u * u * t * P1.y + 3 * u * t * t * P2.y + t * t * t * B.y;
			let r = lw / 2 + SWELL * lw * w(t * len / 6);
			const sc = Math.round(y) * W + Math.round(x);
			if (sc >= 0 && sc < W * H && (z < 0 || zone[sc] === z)) spine[sc] = 1;
			if (pinch && Math.abs(t - pinch.at) < pinch.half) r = Math.min(r, 0.8);
			cut(x, y, Math.max(0.6, r), z);
		}
	};

	const zoneNodes = Array.from({ length: Z }, () => []);
	for (let z = 0; z < Z; z++) {
		const cells = cellsOf[z];
		if (!cells.length) continue;
		const nodes = zoneNodes[z];
		const sd = seeds[z];
		if (sd && sd.player && zone[sd.y * W + sd.x] === z) nodes.push({ x: sd.x, y: sd.y, r: 5 });
		if (doors) for (const o of doors) {
			if (o.kind === 'portal' || !o.hole.length || (o.a !== z && o.b !== z)) continue;
			const own = doorCells(o, zone, W, H).filter(c => zone[c] === z);
			if (!own.length) continue;
			const mx = own.reduce((a, c) => a + c % W, 0) / own.length, my = own.reduce((a, c) => a + ((c / W) | 0), 0) / own.length;
			nodes.push({ x: Math.round(mx), y: Math.round(my), r: 0, door: true });
		}
		for (const s of p.gateSitesAbove || []) if (zone[s.y * W + s.x] === z) nodes.push({ x: s.x, y: s.y, r: 2.6 });
		// waypoints over the zone, a spacing apart, two tiles in from its edge
		const order = cells.slice();
		for (let i = order.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; [order[i], order[j]] = [order[j], order[i]]; }
		for (const c of order) {
			const x = c % W, y = (c / W) | 0;
			if (!inside(c, 2)) continue;
			if (nodes.some(n => (n.x - x) ** 2 + (n.y - y) ** 2 < spacing * spacing)) continue;
			// open ground along the tunnels: some waypoints open into a clearing (K, 2026-10-01: "we also need some open
			// biomes along the tunnels")
			nodes.push({ x, y, r: rng() < CLEARING ? (CLEAR_LO + rng() * (CLEAR_HI - CLEAR_LO)) * Math.sqrt(zs(z)) : 0 });
		}
		if (!nodes.length) { const c = cells[(cells.length / 2) | 0]; nodes.push({ x: c % W, y: (c / W) | 0, r: 2 }); }
		// Hub (VMAPGEN_CAVE_HUB=1): the engine's underground zone is rock but for the paths it lays from each link end to
		// the zone's centre, curved (ConnectionsPlacer, replaceWithCurvedPath), and the paths its objects join them by
		// (RockPlacer keeps only those open). Its junction zones read as a Y or an X with the road along the arms; ours,
		// a spanning tree with loops, as rings round rock islands (mapsight zonesheet, Coldshadow seed 1, 2026-10-02).
		// With the hub, a node at the zone's open centre takes a spoke from every doorway, gate site and start, the
		// waypoints hang off the nearest node already joined, and the loops fall to a third.
		const hub = process.env.VMAPGEN_CAVE_HUB === '1';
		let anchorsJoined = 0;
		const links = [];
		const inTree = new Uint8Array(nodes.length + 1);
		if (hub) {
			let sx = 0, sy = 0;
			for (const c of cells) { sx += c % W; sy += (c / W) | 0; }
			let hc = cells[0], hd = Infinity;
			for (const c of cells) {
				if (!inside(c, 3)) continue;
				const d = (c % W - sx / cells.length) ** 2 + (((c / W) | 0) - sy / cells.length) ** 2;
				if (d < hd) { hd = d; hc = c; }
			}
			nodes.push({ x: hc % W, y: (hc / W) | 0, r: 2.5, hubNode: true });
			const h = nodes.length - 1;
			inTree[h] = 1;
			nodes.forEach((n, i) => { if (i !== h && (n.door || n.r === 2.6 || n.r === 5)) { links.push([h, i]); inTree[i] = 1; anchorsJoined++; } });
		} else inTree[0] = 1;
		// spanning tree, shortest links first (Prim), then loops
		for (let k = hub ? anchorsJoined + 1 : 1; k < nodes.length; k++) {
			let best = null, bd = Infinity;
			for (let i = 0; i < nodes.length; i++) if (inTree[i])
				for (let j = 0; j < nodes.length; j++) if (!inTree[j]) {
					const d = (nodes[i].x - nodes[j].x) ** 2 + (nodes[i].y - nodes[j].y) ** 2;
					if (d < bd) { bd = d; best = [i, j]; }
				}
			if (!best) break;
			inTree[best[1]] = 1;
			links.push(best);
		}
		for (let i = 0; i < nodes.length; i++) {
			if (rng() >= (hub ? loops / 3 : loops)) continue;
			const near = nodes.map((n, j) => [j, (n.x - nodes[i].x) ** 2 + (n.y - nodes[i].y) ** 2]).filter(([j]) => j !== i).sort((a, b) => a[1] - b[1]);
			const pick = near.find(([j, d]) => d < (2.2 * spacing) ** 2 && !links.some(([a, b]) => (a === i && b === j) || (a === j && b === i)));
			if (pick) links.push([i, pick[0]]);
		}
		for (const n of nodes) if (n.r > 0) cut(n.x, n.y, n.r, z);
		for (const [i, j] of links) curve(nodes[i], nodes[j], z);
		const deg = new Array(nodes.length).fill(0);
		for (const [i, j] of links) { deg[i]++; deg[j]++; }
		nodes.forEach((n, i) => { if (deg[i] === 1 && !n.door && n.r < 5) leaves.push(n.y * W + n.x); });
		// Spurs: short dead-end branches off the tunnels into the rock, each ending in a small pocket, where the engine's
		// dwellings stand (half of them at a spur's end; ours 0.23 with only the tree's own ends, 2026-10-02). One per
		// SPUR_AREA tiles of the zone. Off by default (VMAPGEN_CAVE_SPURS=1 on): tried 2026-10-02, the walls came out too ragged
		// (0.44 against the engine's 0.32 to 0.38).
		const want = process.env.VMAPGEN_CAVE_SPURS === '1' ? Math.floor(cells.length / SPUR_AREA) : 0;
		for (let k = 0, tries = 0; k < want && tries < want * 30; tries++) {
			const from = cells[(rng() * cells.length) | 0];
			if (!open[from]) continue;
			const ang = rng() * 6.283, len = SPUR_MIN + rng() * (SPUR_MAX - SPUR_MIN);
			const A = { x: from % W, y: (from / W) | 0 }, B = { x: Math.round(A.x + Math.cos(ang) * len), y: Math.round(A.y + Math.sin(ang) * len) };
			if (B.x < 3 || B.y < 3 || B.x >= W - 3 || B.y >= H - 3) continue;
			const bc = B.y * W + B.x;
			if (zone[bc] !== z || open[bc] || !inside(bc, 2)) continue;
			// the end in rock, with no open ground within 3 of it yet (a real dead end, not a short cut)
			let clear = true;
			for (let dy = -3; dy <= 3 && clear; dy++) for (let dx = -3; dx <= 3; dx++) if (open[bc + dy * W + dx]) { clear = false; break; }
			if (!clear) continue;
			// a narrow tunnel to it, then a small pocket
			const steps = Math.ceil(len * 2.5) + 2;
			for (let s2 = 0; s2 <= steps; s2++) {
				const tt = s2 / steps;
				cut(A.x + (B.x - A.x) * tt, A.y + (B.y - A.y) * tt, 1.1, z);
			}
			cut(B.x, B.y, 1.8 + rng() * 0.8, z);
			leaves.push(bc);
			k++;
		}
		for (const n of nodes) if (n.door) cut(n.x, n.y, 1, z);
	}
	// Inlets: short fingers of floor pushed into the walls, a tile or two wide, as the engine's cave walls have them
	// (its narrowest passages are 1 tile, ours were 3 without these). Each wall cell beside the floor may start one.
	if (INLET > 0) {
		const starts = [];
		for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) {
			const c = y * W + x;
			if (open[c]) continue;
			for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (open[c - dy * W - dx]) { starts.push([c, dx, dy]); break; }
		}
		for (const [c0, dx, dy] of starts) {
			if (rng() >= INLET) continue;
			const n = 1 + ((rng() * 3) | 0);
			let x = c0 % W, y = (c0 / W) | 0;
			for (let k = 0; k < n; k++) {
				if (x < 2 || y < 2 || x >= W - 2 || y >= H - 2) break;
				const c = y * W + x;
				if (zone[c] !== zone[c0] || (doors && !zoneLineSafe(open, zone, W, H, c, doorCell))) break;
				open[c] = 1;
				x += dx; y += dy;
				if (rng() < 0.3) { if (dx) y += rng() < 0.5 ? 1 : -1; else x += rng() < 0.5 ? 1 : -1; }
			}
		}
	}
	// the doorways themselves
	if (doors) for (const o of doors) if (o.kind !== 'portal' && o.hole.length) for (const c of doorCells(o, zone, W, H)) open[c] = 1;
	// a free layout (no doorways): each open border joins the nearest nodes of its two biomes, a curve across it
	if (!doors)
		for (const e of edges || []) {
			if (connections && connections.get(e.a * 100000 + e.b) === 'blocked') continue;
			const A = zoneNodes[e.a], B = zoneNodes[e.b];
			if (!A.length || !B.length) continue;
			let best = null, bd = Infinity;
			for (const a of A) for (const b of B) { const d = (a.x - b.x) ** 2 + (a.y - b.y) ** 2; if (d < bd) { bd = d; best = [a, b]; } }
			curve(best[0], best[1], -1);
		}
	open.tunnelsFailed = 0;
	for (let c = 0; c < W * H; c++) if (!open[c]) spine[c] = 0;
	open.spine = spine;
	open.leaves = leaves.filter(c => open[c]);
	return open;
}

module.exports = { carveSplines };
