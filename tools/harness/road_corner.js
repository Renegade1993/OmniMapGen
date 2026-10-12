// road_corner.js: diagonal-only road steps (two road tiles touching at a corner with neither shared side tile a road): VCMI draws each end as a
// dead end, so the road shows a gap there. node tools/harness/road_corner.js MAP...
const sight = require('../mapsight/lib/sight');
for (const f of process.argv.slice(2)) {
	const M = sight.load(f), W = M.W, H = M.H;
	const has = (l, x, y) => x >= 0 && y >= 0 && x < W && y < H && M.road[M.idx(l, x, y)];
	let tiles = 0, steps = 0; const list = [];
	for (let l = 0; l < M.NL; l++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
		if (!has(l, x, y)) continue; tiles++;
		for (const [dx, dy] of [[1, 1], [1, -1]]) if (has(l, x + dx, y + dy) && !has(l, x + dx, y) && !has(l, x, y + dy)) { steps++; list.push(`L${l} (${x},${y})-(${x + dx},${y + dy})`); }
	}
	console.log(`${f.split(/[\/]/).pop()}: road tiles ${tiles}, diagonal-only steps ${steps}`);
	if (process.env.LIST) console.log('  ' + list.join('  '));
}
