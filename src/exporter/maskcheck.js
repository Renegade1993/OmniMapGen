/**
 * maskcheck.js - which cells of a two-terrain mask have no sprite.
 *
 * Water on the surface and rock underground are both laid down as masks
 * before the planner runs, and the engine's view patterns can only draw some
 * shapes of them (a one-cell spur, a one-cell notch or a pinched diagonal has
 * no sprite; the engine's own draw operation reshapes those). This renders a
 * mask as one "wet" terrain (water or rock) against each of a few land
 * terrains through the same pattern matcher the map export uses, and reports
 * the cells that fit no pattern.
 *
 *   full(mask, W, H)             Uint8Array, 1 where a cell fits no pattern
 *   around(mask, W, H, x, y, r)  how many cells within r of (x, y) fit none
 *
 * `around` renders a window two cells wider than it counts, which is exactly
 * the reach of the matcher (a cell reads its 8 neighbours, and a pattern rule
 * that names another pattern re-reads the neighbour's 8), so its count equals
 * what a full render would say for those cells.
 */
'use strict';

const { assignTerrainViews } = require('./terrainView');

function makeMaskChecker(patterns, wet, lands) {
	const flat = () => 0.5;
	const full = (mask, W, H) => {
		const out = new Uint8Array(W * H);
		for (const land of lands) {
			const r = assignTerrainViews(W, H, (x, y) => (mask[y * W + x] ? wet : land), patterns, flat);
			for (let c = 0; c < W * H; c++) if (r.unmatchedCells[c]) out[c] = 1;
		}
		return out;
	};
	const around = (mask, W, H, x, y, r) => {
		const m = 2;
		const x0 = Math.max(0, x - r - m), y0 = Math.max(0, y - r - m);
		const x1 = Math.min(W - 1, x + r + m), y1 = Math.min(H - 1, y + r + m);
		const w = x1 - x0 + 1, h = y1 - y0 + 1;
		// a window edge that is not the map edge would read as off-map; keep
		// the counted cells two away from any such edge
		const cx0 = x0 === 0 ? 0 : m, cy0 = y0 === 0 ? 0 : m;
		const cx1 = x1 === W - 1 ? w - 1 : w - 1 - m, cy1 = y1 === H - 1 ? h - 1 : h - 1 - m;
		let bad = 0;
		const hit = new Uint8Array(w * h);
		for (const land of lands) {
			const res = assignTerrainViews(w, h,
				(ix, iy) => (mask[(y0 + iy) * W + x0 + ix] ? wet : land), patterns, flat);
			for (let iy = cy0; iy <= cy1; iy++)
				for (let ix = cx0; ix <= cx1; ix++) {
					const k = iy * w + ix;
					if (res.unmatchedCells[k] && !hit[k]) { hit[k] = 1; bad++; }
				}
		}
		return bad;
	};
	return { full, around };
}

module.exports = { makeMaskChecker };
