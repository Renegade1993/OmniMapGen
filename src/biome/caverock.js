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
	let turned = 0;
	const keep = [];
	for (const o of plan.objects) {
		if ((o.l || 0) !== l || !isScenery(o)) { keep.push(o); continue; }
		const cells = blockingCells(o.template, o.x, o.y).filter(([x, y]) => x >= 0 && y >= 0 && x < W && y < H).map(([x, y]) => y * W + x);
		const touches = c => { const x = c % W, y = (c / W) | 0; return N4.some(([dx, dy]) => { const nx = x + dx, ny = y + dy; return nx >= 0 && ny >= 0 && nx < W && ny < H && rock[ny * W + nx]; }); };
		if (!cells.length || cells.length > 3 || !cells.every(c => open[c] && touches(c))) { keep.push(o); continue; }
		let was = 0, now = 0;
		for (const c of cells) was += checker.around(rock, W, H, c % W, (c / W) | 0, 2);
		for (const c of cells) rock[c] = 1;
		for (const c of cells) now += checker.around(rock, W, H, c % W, (c / W) | 0, 2);
		if (now > was) { for (const c of cells) rock[c] = 0; keep.push(o); continue; }
		for (const c of cells) open[c] = 0;
		turned++;
	}
	plan.objects = keep;
	return turned;
}

module.exports = { sceneryToRock };
