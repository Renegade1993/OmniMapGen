'use strict';
/**
 * piecesizes.js - scenery pieces by their blocked tiles, per level, per 1000 open tiles: how much of the scenery is
 * single tiles and pairs against big pieces. The engine's underground on Coldshadow carries about half our pieces
 * (template_report, 2026-10-03); this says which sizes the extra ones are, and whether they stand alone on open floor
 * (no other blocked tile touching) or against a mass.
 *
 *   node tools/geometry/piecesizes.js MAP...
 */
const sight = require('../mapsight/lib/sight');
for (const f of process.argv.slice(2)) {
	const M = sight.load(f);
	const out = [];
	for (let l = 0; l < M.NL; l++) {
		let open = 0;
		for (let y = 0; y < M.H; y++) for (let x = 0; x < M.W; x++) { const i = M.idx(l, x, y); if (M.ground(i) && !M.blocked[i]) open++; }
		const bins = { 1: 0, 2: 0, '3-4': 0, '5-8': 0, '9+': 0 };
		let alone = 0, pieces = 0;
		for (const o of M.objs) {
			if (o.l !== l || o.visitable || o.cls === 'monster' || o.pickup) continue;
			const n = o.cells.length;
			if (!n) continue;
			pieces++;
			bins[n === 1 ? 1 : n === 2 ? 2 : n <= 4 ? '3-4' : n <= 8 ? '5-8' : '9+']++;
			const own = new Set(o.cells.map(([x, y]) => y * M.W + x));
			let touches = false;
			for (const [x, y] of o.cells) for (let dy = -1; dy <= 1 && !touches; dy++) for (let dx = -1; dx <= 1; dx++) {
				const u = x + dx, v = y + dy;
				if (!M.inb(u, v) || own.has(v * M.W + u)) continue;
				const i = M.idx(l, u, v);
				if (M.blocked[i] || !M.ground(i)) { touches = true; break; }
			}
			if (!touches) alone++;
		}
		const k = 1000 / Math.max(1, open);
		out.push(`L${l} pieces ${(pieces * k).toFixed(0)}/1k open: ` + Object.entries(bins).map(([b, v]) => `${b}:${(v * k).toFixed(1)}`).join(' ') + ` | alone on open floor ${(alone * k).toFixed(1)}`);
	}
	console.log(`${f.split(/[\\/]/).pop().slice(-26).padEnd(27)} ${out.join(' || ')}`);
}
