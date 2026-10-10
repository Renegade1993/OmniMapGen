/**
 * island_stats.js - how island-like a map's surface is, and how alike its two halves are.
 *   node tools/harness/island_stats.js <vmap>...        one line a map: land masses, the sizes, symmetry
 * Land is any tile that is not water or rock-wall on level 0. Symmetry: the share of land tiles whose mirror image
 * (left-right, top-bottom, 180-degree turn, diagonal) is land too, the best of the four; a map with two equal halves
 * scores near 1, an unrelated pair of halves near the land share itself.
 */
'use strict';
const { readVmap, parseTileCode } = require('../../src/preview/render');

function stats(file) {
	const { levels } = readVmap(file);
	const rows = levels[0].rows, H = rows.length, W = rows[0].length;
	const land = new Uint8Array(W * H);
	let n = 0;
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const t = parseTileCode(rows[y][x]).terr; if (t !== 'wt' && t !== 'rc') { land[y * W + x] = 1; n++; } }
	const comp = new Int32Array(W * H).fill(-1), sizes = [];
	for (let s = 0; s < W * H; s++) {
		if (!land[s] || comp[s] >= 0) continue;
		let c = 0; const q = [s]; comp[s] = sizes.length;
		for (let h = 0; h < q.length; h++) {
			const i = q[h], x = i % W, y = (i / W) | 0; c++;
			for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
				const u = x + dx, v = y + dy;
				if (u < 0 || v < 0 || u >= W || v >= H) continue;
				const j = v * W + u;
				if (land[j] && comp[j] < 0) { comp[j] = sizes.length; q.push(j); }
			}
		}
		sizes.push(c);
	}
	sizes.sort((a, b) => b - a);
	const big = sizes.filter(s => s >= 0.01 * n);
	const sym = f => { let m = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (land[y * W + x]) { const [u, v] = f(x, y); if (u >= 0 && v >= 0 && u < W && v < H && land[v * W + u]) m++; } return m / Math.max(1, n); };
	const S = [sym((x, y) => [W - 1 - x, y]), sym((x, y) => [x, H - 1 - y]), sym((x, y) => [W - 1 - x, H - 1 - y]), W === H ? sym((x, y) => [y, x]) : 0];
	return { W, H, landShare: n / (W * H), masses: big.length, sizes: big, symmetry: Math.max(...S) };
}
if (require.main === module)
	for (const f of process.argv.slice(2)) {
		const s = stats(f);
		console.log(`${require('path').basename(f)}  land ${(100 * s.landShare).toFixed(0)}%  masses ${s.masses}  sizes ${s.sizes.slice(0, 12).join(',')}  biggest/smallest ${(s.sizes[0] / Math.max(1, s.sizes[s.sizes.length - 1])).toFixed(1)}  symmetry ${s.symmetry.toFixed(2)}`);
	}
module.exports = { stats };
