'use strict';
/**
 * caverock.js - small scenery hugging a cave wall becomes part of the wall.
 *
 * The engine turns blocked cave ground into rock terrain and covers only what is left beside it with obstacles
 * (RockPlacer, ObstaclePlacer). Ours left that ground as scenery: Coldshadow's Fantasy's underground carried about 950
 * obstacle pieces averaging 2.2 tiles (300 of one tile) against the engine's 520 averaging 3.4 (125 of one tile), and
 * the tunnels read as cluttered (2026-10-02). After the last placement, every scenery piece of three tiles or fewer
 * whose every tile touches the rock becomes rock: its object goes, its tiles stay blocked, and the open mask closes
 * there. A piece is turned only when the rock's terrain art fits no worse around it (the cave checker, as cavefit.js
 * repairs the carve). VMAPGEN_CAVE_ROCK_SCENERY=0 leaves the scenery.
 */

const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function sceneryToRock(plan, W, H, l, isScenery, blockingCells, checker) {
	const open = plan.openMask;
	if (!open || !checker || process.env.VMAPGEN_CAVE_ROCK_SCENERY === '0') return 0;
	const N = W * H;
	const rock = new Uint8Array(N);
	for (let c = 0; c < N; c++) rock[c] = open[c] ? 0 : 1;
	// The pass does not depend on the order of plan.objects: a piece qualifies by touching the wall as it stood before the
	// pass (not a piece turned before it), and the pieces are tried in the order of their first tile, since the art test
	// reads the rock as it grows and so one piece's turn can decide the next one's.
	const wall = rock.slice();
	const touches = c => { const x = c % W, y = (c / W) | 0; return N4.some(([dx, dy]) => { const nx = x + dx, ny = y + dy; return nx >= 0 && ny >= 0 && nx < W && ny < H && wall[ny * W + nx]; }); };
	const tries = [];
	for (const o of plan.objects) {
		if ((o.l || 0) !== l || !isScenery(o)) continue;
		const cells = blockingCells(o.template, o.x, o.y).filter(([x, y]) => x >= 0 && y >= 0 && x < W && y < H).map(([x, y]) => y * W + x);
		if (!cells.length || cells.length > 3 || !cells.every(c => open[c] && touches(c))) continue;
		tries.push({ o, cells, first: Math.min(...cells) });
	}
	tries.sort((a, b) => a.first - b.first);
	const gone = new Set();
	for (const { o, cells } of tries) {
		let was = 0, now = 0;
		for (const c of cells) was += checker.around(rock, W, H, c % W, (c / W) | 0, 2);
		for (const c of cells) rock[c] = 1;
		for (const c of cells) now += checker.around(rock, W, H, c % W, (c / W) | 0, 2);
		if (now > was) { for (const c of cells) rock[c] = 0; continue; }
		for (const c of cells) open[c] = 0;
		gone.add(o);
	}
	plan.objects = plan.objects.filter(o => !gone.has(o));
	return gone.size;
}

module.exports = { sceneryToRock };
