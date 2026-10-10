'use strict';
/**
 * profiles.js - the probability arrays the new generator draws from, learned from maps (Phase 2 of
 * VCMIMapGen\! LLM Files\Generation-Paradigm-Brainstorm-2026-10-02.md).
 *
 *   node tools/geometry/profiles.js --a FILE... [--b FILE...] [--out FILE.json] [--label-a engine --label-b ours]
 *
 * Over every map of a set, per level kind (surface, underground):
 *   road profile   for each object class, how many lie per tile at each distance off the nearest road (0 to 14 tiles,
 *                  Chebyshev) and at each fifth of the way along that road's edge: the array swept along a road
 *   joint profile  for each kind of road node (an end at a town, at a gate or monolith, at a doorway guard; a T or X
 *                  joint), objects per tile at each distance from it (0 to 8)
 *   edge shape     per edge kind (what its two ends touch): length, straightness, mean straight run, stair share
 *   zone fill      per zone type from the sidecar (playerStart, cpuStart, treasure, junction): objects per open tile
 *                  by class, scenery cover, open share
 * Classes: town, guard, high, low, dwelling, bank, mine, gate, monolith, building (other visitable), scenery (each
 * tile it covers). With --b, prints set A beside set B (engine beside ours) for the rows that differ most.
 * Densities are per tile of the ring, so they hold at any map size: this is how the profiles scale.
 */
const fs = require('fs');
const path = require('path');
const sight = require('../mapsight/lib/sight');
const { capture } = require('./capture');

const N8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const CLASSES = ['town', 'guard', 'high', 'low', 'dwelling', 'bank', 'mine', 'gate', 'monolith', 'building', 'scenery'];
const DMAX = 14, TBINS = 5, JMAX = 8;
const classOf = o => (o.cls === 'monster' ? 'guard' : o.cls === 'other' ? (o.visitable ? 'building' : 'scenery') : o.cls);
const nodeKind = n => (n.kind !== 'end' ? n.kind : n.touches.includes('town') ? 'end@town'
	: n.touches.includes('gate') || n.touches.includes('monolith') ? 'end@link' : n.touches.includes('guard') ? 'end@guard' : 'end@other');

function blank() {
	const z = () => new Array(CLASSES.length).fill(0);
	return {
		road: { obj: Array.from({ length: (DMAX + 1) * TBINS }, z), tiles: new Array((DMAX + 1) * TBINS).fill(0) },
		joint: {}, edges: {}, zones: {}, maps: 0,
	};
}

function addMap(S, file) {
	const M = sight.load(file), G = capture(file), W = M.W, H = M.H, N = W * H;
	for (const L of G.data) {
		const key = L.level === 0 ? 'surface' : 'underground';
		const P = S[key] || (S[key] = blank());
		P.maps++;
		const base = L.level * N;
		// object classes on the tiles they stand on (scenery on every tile it covers)
		const at = Array.from({ length: N }, () => null);
		const mark = (c, k) => { if (!at[c]) at[c] = []; at[c].push(k); };
		for (const o of M.objs) {
			if (o.l !== L.level) continue;
			const k = CLASSES.indexOf(classOf(o));
			if (k < 0) continue;
			if (classOf(o) === 'scenery') { for (const [x, y] of o.cells) if (M.inb(x, y)) mark(y * W + x, k); }
			else mark(o.at[1] * W + o.at[0], k);
		}
		const ground = c => M.ground(base + c);
		// distance from the road, and the place along its edge of the nearest road tile
		const dist = new Int16Array(N).fill(-1), along = new Int8Array(N).fill(0), q = [];
		L.roads.edges.forEach(e => e.line.forEach(([x, y], i) => { const c = y * W + x; if (dist[c] < 0) { dist[c] = 0; along[c] = Math.min(TBINS - 1, Math.floor(TBINS * i / Math.max(1, e.line.length))); q.push(c); } }));
		for (let h = 0; h < q.length; h++) {
			const c = q[h];
			if (dist[c] >= DMAX) continue;
			const x = c % W, y = (c / W) | 0;
			for (const [dx, dy] of N8) { if (!M.inb(x + dx, y + dy)) continue; const m = (y + dy) * W + x + dx; if (dist[m] < 0) { dist[m] = dist[c] + 1; along[m] = along[c]; q.push(m); } }
		}
		for (let c = 0; c < N; c++) {
			if (dist[c] < 0 || !ground(c)) continue;
			const b = dist[c] * TBINS + along[c];
			P.road.tiles[b]++;
			if (at[c]) for (const k of at[c]) P.road.obj[b][k]++;
		}
		// joints and ends
		for (const n of L.roads.nodes) {
			const nk = nodeKind(n);
			const J = P.joint[nk] || (P.joint[nk] = { count: 0, obj: Array.from({ length: JMAX + 1 }, () => new Array(CLASSES.length).fill(0)), tiles: new Array(JMAX + 1).fill(0) });
			J.count++;
			for (let dy = -JMAX; dy <= JMAX; dy++) for (let dx = -JMAX; dx <= JMAX; dx++) {
				const x = n.x + dx, y = n.y + dy;
				if (!M.inb(x, y) || !ground(y * W + x)) continue;
				const d = Math.max(Math.abs(dx), Math.abs(dy));
				J.tiles[d]++;
				if (at[y * W + x]) for (const k of at[y * W + x]) J.obj[d][k]++;
			}
		}
		// edge shapes by what their ends touch
		for (const e of L.roads.edges) {
			const a = e.a >= 0 ? nodeKind(L.roads.nodes[e.a]) : 'loop', b = e.b >= 0 ? nodeKind(L.roads.nodes[e.b]) : 'loop';
			const ek = [a, b].sort().join(' - ');
			const E = P.edges[ek] || (P.edges[ek] = { length: [], straight: [], meanRun: [], stairShare: [] });
			for (const f of ['length', 'straight', 'meanRun', 'stairShare']) E[f].push(e[f]);
		}
		// zone fill by zone type
		const zinfo = M.zones && M.zones.zones;
		const zt = new Map();
		for (let c = 0; c < N; c++) {
			const z = M.zoneAt(L.level, c % W, (c / W) | 0);
			if (z === undefined || z === null || z < 0) continue;
			const type = (zinfo && zinfo.get(z) && zinfo.get(z).type) || '?';
			const Z = P.zones[type] || (P.zones[type] = { tiles: 0, open: 0, ground: 0, obj: new Array(CLASSES.length).fill(0) });
			Z.tiles++;
			if (ground(c)) { Z.ground++; if (!M.blocked[base + c]) Z.open++; }
			if (at[c]) for (const k of at[c]) Z.obj[k]++;
		}
	}
}

const med = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
const f3 = v => (v === null || v === undefined ? '-' : Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(3));

function finish(S) {
	const out = {};
	for (const [lk, P] of Object.entries(S)) {
		const road = {};
		CLASSES.forEach((cl, k) => {
			road[cl] = [];
			for (let d = 0; d <= DMAX; d++) { const row = []; for (let t = 0; t < TBINS; t++) { const b = d * TBINS + t; row.push(P.road.tiles[b] ? P.road.obj[b][k] / P.road.tiles[b] : 0); } road[cl].push(row); }
		});
		const joint = {};
		for (const [nk, J] of Object.entries(P.joint)) {
			joint[nk] = { perMap: J.count / P.maps, density: {} };
			CLASSES.forEach((cl, k) => { joint[nk].density[cl] = J.tiles.map((t, d) => (t ? J.obj[d][k] / t : 0)); });
		}
		const edges = {};
		for (const [ek, E] of Object.entries(P.edges)) edges[ek] = { perMap: E.length.length / P.maps, length: med(E.length), straight: med(E.straight), meanRun: med(E.meanRun), stairShare: med(E.stairShare) };
		const zones = {};
		for (const [zk, Z] of Object.entries(P.zones)) { zones[zk] = { openShare: Z.ground ? Z.open / Z.ground : 0, groundShare: Z.ground / Z.tiles, perOpenTile: {} }; CLASSES.forEach((cl, k) => { zones[zk].perOpenTile[cl] = Z.open ? Z.obj[k] / (cl === 'scenery' ? Z.ground : Z.open) : 0; }); }
		out[lk] = { maps: P.maps, classes: CLASSES, dmax: DMAX, tbins: TBINS, road, joint, edges, zones };
	}
	return out;
}

function report(A, B, la, lb) {
	const lines = [];
	for (const lk of Object.keys(A)) {
		const a = A[lk], b = B && B[lk];
		lines.push(`== ${lk} (${la} ${a.maps} maps${b ? `, ${lb} ${b.maps}` : ''})`);
		lines.push('  objects per tile by distance off the road (all along it), 0..8:');
		for (const cl of CLASSES) {
			const row = p => p.road[cl].slice(0, 9).map(r => r.reduce((s, v) => s + v, 0) / r.length);
			lines.push(`    ${cl.padEnd(9)} ${la.padEnd(6)} ${row(a).map(f3).join(' ')}`);
			if (b) lines.push(`    ${''.padEnd(9)} ${lb.padEnd(6)} ${row(b).map(f3).join(' ')}`);
		}
		lines.push('  road nodes per map, and what is near them (high, guard, scenery per tile at 0..4):');
		for (const nk of new Set([...Object.keys(a.joint), ...Object.keys(b ? b.joint : {})])) {
			const s = p => (p && p.joint[nk] ? `${f3(p.joint[nk].perMap)} | high ${p.joint[nk].density.high.slice(0, 5).map(f3).join(' ')} | guard ${p.joint[nk].density.guard.slice(0, 5).map(f3).join(' ')}` : '-');
			lines.push(`    ${nk.padEnd(10)} ${la.padEnd(6)} ${s(a)}`);
			if (b) lines.push(`    ${''.padEnd(10)} ${lb.padEnd(6)} ${s(b)}`);
		}
		lines.push('  road edges by kind: per map, length, straightness, mean run, stair share:');
		for (const ek of new Set([...Object.keys(a.edges), ...Object.keys(b ? b.edges : {})])) {
			const s = p => (p && p.edges[ek] ? [p.edges[ek].perMap, p.edges[ek].length, p.edges[ek].straight, p.edges[ek].meanRun, p.edges[ek].stairShare].map(f3).join(' ') : '-');
			lines.push(`    ${ek.padEnd(22)} ${la.padEnd(6)} ${s(a)}`);
			if (b) lines.push(`    ${''.padEnd(22)} ${lb.padEnd(6)} ${s(b)}`);
		}
		lines.push('  zone fill by zone type: open share of ground; per open tile high, low, guard, dwelling; scenery cover:');
		for (const zk of new Set([...Object.keys(a.zones), ...Object.keys(b ? b.zones : {})])) {
			const s = p => (p && p.zones[zk] ? [p.zones[zk].openShare, ...['high', 'low', 'guard', 'dwelling', 'scenery'].map(c => p.zones[zk].perOpenTile[c])].map(f3).join(' ') : '-');
			lines.push(`    ${zk.padEnd(12)} ${la.padEnd(6)} ${s(a)}`);
			if (b) lines.push(`    ${''.padEnd(12)} ${lb.padEnd(6)} ${s(b)}`);
		}
	}
	return lines.join('\n');
}

function list(args, name) { const out = []; args.forEach((a, i) => { if (a === name) for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) out.push(args[j]); }); return out; }
function opt(args, name, d) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d; }

if (require.main === module) {
	const args = process.argv.slice(2);
	const fa = list(args, '--a'), fb = list(args, '--b');
	const la = opt(args, '--label-a', 'A'), lb = opt(args, '--label-b', 'B');
	const SA = {}, SB = {};
	for (const f of fa) addMap(SA, f);
	for (const f of fb) addMap(SB, f);
	const A = finish(SA), B = fb.length ? finish(SB) : null;
	const out = opt(args, '--out', null);
	if (out) fs.writeFileSync(out, JSON.stringify({ [la]: A, ...(B ? { [lb]: B } : {}) }));
	console.log(report(A, B, la, lb));
}

module.exports = { addMap, finish, report, CLASSES };
