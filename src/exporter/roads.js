/**
 * roads.js - pick the road segment art for each roaded tile.
 *
 * A road tile code is `<shortId><dir><flip>`, and `dir` is not a direction in
 * the compass sense: it is an index into the road tileset, choosing which
 * segment is drawn (straight, corner, T-junction, crossroads, dead end). The
 * generator used to write `1` for every tile with no flip, so a road came out
 * as the same corner piece repeated along its length.
 *
 * This is VCMI's own algorithm, transcribed from
 * lib/mapping/CDrawRoadsOperation.cpp: ten patterns tried in order against the
 * eight neighbours, each pattern allowed to flip horizontally and/or
 * vertically, first match wins, and the segment index drawn from the matched
 * pattern's range. Cells off the map count as having no road, exactly as
 * `isInTheMap(pos) && tileHasSomething(pos)` does there.
 *
 * The pattern grid is row major with index 4 as the tile itself:
 *   0 1 2      '+' neighbour must carry a road
 *   3 4 5      '-' neighbour must not
 *   6 7 8      '?' either
 */
'use strict';

const NONE = 0, HORIZONTAL = 1, VERTICAL = 2, BOTH = 3;

// {data, road:[lo,hi], river:[lo,hi], hFlip, vFlip} in the engine's order;
// order decides ties. A river mapping of [-1,-1] means the pattern does not
// apply to rivers at all, which canApplyPattern checks for.
const PATTERNS = [
	// single tile, the fall-back
	{ data: ['-', '-', '-', '-', '+', '-', '-', '-', '-'], road: [14, 14], river: [9, 9], hFlip: false, vFlip: false },
	// straight with angle
	{ data: ['?', '-', '+', '-', '+', '+', '+', '+', '?'], road: [2, 5], river: [-1, -1], hFlip: true, vFlip: true },
	// turn
	{ data: ['?', '-', '?', '-', '+', '+', '?', '+', '?'], road: [0, 1], river: [0, 3], hFlip: true, vFlip: true },
	// dead end, horizontal
	{ data: ['?', '-', '?', '-', '+', '+', '?', '-', '?'], road: [15, 15], river: [11, 12], hFlip: true, vFlip: false },
	// dead end, vertical
	{ data: ['?', '-', '?', '-', '+', '-', '?', '+', '?'], road: [14, 14], river: [9, 10], hFlip: false, vFlip: true },
	// T-cross, horizontal
	{ data: ['?', '+', '?', '-', '+', '+', '?', '+', '?'], road: [6, 7], river: [7, 8], hFlip: true, vFlip: false },
	// T-cross, vertical
	{ data: ['?', '-', '?', '+', '+', '+', '?', '+', '?'], road: [8, 9], river: [5, 6], hFlip: false, vFlip: true },
	// straight, horizontal
	{ data: ['?', '-', '?', '+', '+', '+', '?', '-', '?'], road: [12, 13], river: [11, 12], hFlip: false, vFlip: false },
	// straight, vertical
	{ data: ['?', '+', '?', '-', '+', '-', '?', '+', '?'], road: [10, 11], river: [9, 10], hFlip: false, vFlip: false },
	// X-cross
	{ data: ['?', '+', '?', '+', '+', '+', '?', '+', '?'], road: [16, 16], river: [4, 4], hFlip: false, vFlip: false },
];

function flipPattern(data, flip) {
	const d = data.slice();
	if (flip === HORIZONTAL || flip === BOTH)
		for (let i = 0; i < 3; i++) { const y = i * 3; const t = d[y]; d[y] = d[y + 2]; d[y + 2] = t; }
	if (flip === VERTICAL || flip === BOTH)
		for (let i = 0; i < 3; i++) { const t = d[i]; d[i] = d[i + 6]; d[i + 6] = t; }
	return d;
}

/**
 * roadCells: Set of cell indices carrying a road. rng: () => [0,1).
 * Returns Map(cell -> {dir, flip}); flip indexes FLIP_CODES.
 */
function solveRoadTiles(roadCells, W, H, rng) {
	return solveLineTiles(roadCells, W, H, rng, 'road');
}

/**
 * The same matcher for rivers. Rivers use the same ten patterns with their own
 * frame ranges, and a pattern whose river range is [-1,-1] does not apply,
 * which is `CDrawRiversOperation::canApplyPattern`.
 */
function solveRiverTiles(riverCells, W, H, rng) {
	return solveLineTiles(riverCells, W, H, rng, 'river');
}

function solveLineTiles(roadCells, W, H, rng, key) {
	const has = (x, y) => x >= 0 && y >= 0 && x < W && y < H && roadCells.has(y * W + x);
	const out = new Map();
	for (const cell of roadCells) {
		const x = cell % W, y = (cell / W) | 0;
		let chosen = null;
		for (const pattern of PATTERNS) {
			if (pattern[key][0] < 0) continue;   // not applicable to this kind
			for (let flip = 0; flip < 4 && !chosen; flip++) {
				if (flip === BOTH && !(pattern.hFlip && pattern.vFlip)) continue;
				if (flip === HORIZONTAL && !pattern.hFlip) continue;
				if (flip === VERTICAL && !pattern.vFlip) continue;
				const d = flipPattern(pattern.data, flip);
				let ok = true;
				for (let i = 0; i < 9 && ok; i++) {
					if (i === 4) continue;
					const rule = d[i];
					if (rule === '?') continue;
					const there = has(x + (i % 3) - 1, y + ((i / 3) | 0) - 1);
					if (rule === '+' ? !there : there) ok = false;
				}
				if (ok) {
					const [lo, hi] = pattern[key];
					chosen = { dir: lo + ((rng() * (hi - lo + 1)) | 0), flip };
				}
			}
			if (chosen) break;
		}
		// every cell matches at worst the fall-back, but never emit a code the
		// reader would reject if a future pattern edit breaks that assumption
		out.set(cell, chosen || { dir: PATTERNS[0][key][0], flip: NONE });
	}
	return out;
}

module.exports = { solveRoadTiles, solveRiverTiles, PATTERNS };
