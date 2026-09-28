/**
 * cavefit.js - carve the underground into shapes the terrain art can draw
 * (queue item 26).
 *
 * The underground is carved as a mask (plan.js carveUnderground), and from
 * then on its rock is frozen: the planner checks connectivity against it and
 * the smoothing pass must not move it. The carve leaves rock one cell thick
 * in places and tunnels one cell wide, and the engine's rock patterns have no
 * sprite for either. Measured with the fixed pattern matcher: our two-level
 * maps had 29 to 359 cave cells with no pattern, the corpus's 32 two-level
 * maps none (the engine's own draw operation reshapes such rock).
 *
 * So the mask is repaired right after carving, before anything reads it,
 * one flip at a time, keeping a flip only when it lowers the count of cells
 * with no sprite, under two rules that keep the carve's meaning:
 *   - rock opens only where every open cell around it belongs to the same
 *     zone as the rock cell, so no repair joins two zones (a new link
 *     nobody guards)
 *   - open ground closes only where its open neighbours stay one piece
 *     around it, so no repair cuts a path
 */
'use strict';

const RING = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];

function zoneSafeToOpen(open, zone, W, H, c) {
	const x = c % W, y = (c / W) | 0, z = zone[c];
	for (const [dx, dy] of RING) {
		const nx = x + dx, ny = y + dy;
		if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
		const n = ny * W + nx;
		if (open[n] && zone[n] !== z) return false;
	}
	return true;
}

/** The open cells around c form one 8-connected piece, so closing c cannot
 * cut a path that ran through it (heroes move 8-way). */
function safeToClose(open, W, H, c) {
	const x = c % W, y = (c / W) | 0;
	const idx = [];
	RING.forEach(([dx, dy], i) => {
		const nx = x + dx, ny = y + dy;
		if (nx >= 0 && ny >= 0 && nx < W && ny < H && open[ny * W + nx]) idx.push(i);
	});
	if (idx.length <= 1) return true;
	const parent = idx.map((_, k) => k);
	const find = a => { while (parent[a] !== a) a = parent[a] = parent[parent[a]]; return a; };
	for (let a = 0; a < idx.length; a++)
		for (let b = a + 1; b < idx.length; b++) {
			const [ax, ay] = RING[idx[a]], [bx, by] = RING[idx[b]];
			if (Math.max(Math.abs(ax - bx), Math.abs(ay - by)) <= 1) parent[find(a)] = find(b);
		}
	const roots = new Set(idx.map((_, k) => find(k)));
	return roots.size === 1;
}

/**
 * Repair `open` (1 = carved, 0 = rock) in place. `checker` is a
 * maskcheck.js checker with rock as its wet terrain; `keep` flags cells that
 * never close (a doorway's). Returns { before, after, opened, closed }.
 */
function fitCave(open, zone, W, H, checker, maxRounds = 12, keep = null) {
	const N = W * H;
	const rock = new Uint8Array(N);
	for (let c = 0; c < N; c++) rock[c] = open[c] ? 0 : 1;
	const count = a => a.reduce((s, v) => s + v, 0);
	const before = count(checker.full(rock, W, H));
	let opened = 0, closed = 0;
	for (let round = 0; round < maxRounds; round++) {
		const bad = checker.full(rock, W, H);
		if (!count(bad)) break;
		let improved = 0;
		for (let c = 0; c < N; c++) {
			if (!bad[c]) continue;
			const x = c % W, y = (c / W) | 0;
			let best = null;
			for (const [dx, dy] of [[0, 0], ...RING]) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const d = ny * W + nx;
				const opening = !!rock[d];
				if (opening ? !zoneSafeToOpen(open, zone, W, H, d) : (keep && keep[d]) || !safeToClose(open, W, H, d)) continue;
				const was = checker.around(rock, W, H, nx, ny, 2);
				rock[d] ^= 1;
				const now = checker.around(rock, W, H, nx, ny, 2);
				rock[d] ^= 1;
				const gain = was - now;
				// the largest gain wins; on a tie opening is preferred, since it
				// cannot cut anything
				if (gain > 0 && (!best || gain > best.gain || (gain === best.gain && opening && !best.opening)))
					best = { d, gain, opening };
			}
			if (!best) continue;
			rock[best.d] ^= 1;
			open[best.d] = rock[best.d] ? 0 : 1;
			if (best.opening) opened++; else closed++;
			improved++;
		}
		if (!improved) break;
	}
	return { before, after: count(checker.full(rock, W, H)), opened, closed };
}

module.exports = { fitCave, zoneSafeToOpen, safeToClose };
