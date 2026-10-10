'use strict';
/**
 * lootgrid.js - where on the map the loot lands: K, 2026-10-03, "the bottom right corners are still getting stacked to
 * the gills with loot". Each level cut into an N x N grid of blocks; per block, pickups and treasure (sight classes
 * high, low) per 100 open tiles, averaged over the maps given; ours against the engine's, block by block. A pass that
 * walks the map in index order and dumps what is left at the end shows as a hot bottom-right block.
 *
 *   node tools/geometry/lootgrid.js [--n 4] --engine E... --ours O...
 */
const sight = require('../mapsight/lib/sight');

function grid(files, N) {
	let acc = null, levels = 0;
	for (const f of files) {
		const M = sight.load(f);
		levels = Math.max(levels, M.NL);
		if (!acc) acc = Array.from({ length: 2 }, () => Array.from({ length: N * N }, () => ({ open: 0, loot: 0 })));
		const bx = x => Math.min(N - 1, Math.floor(x * N / M.W)), by = y => Math.min(N - 1, Math.floor(y * N / M.H));
		for (let l = 0; l < M.NL; l++) for (let y = 0; y < M.H; y++) for (let x = 0; x < M.W; x++) {
			const i = M.idx(l, x, y);
			if (M.ground(i) && !M.blocked[i]) acc[l][by(y) * N + bx(x)].open++;
		}
		for (const o of M.objs) if (o.cls === 'high' || o.cls === 'low') acc[o.l][by(o.at[1]) * N + bx(o.at[0])].loot++;
	}
	return { acc, levels };
}

function main(a) {
	const opt = n => { const out = []; const i = a.indexOf(n); if (i >= 0) for (let j = i + 1; j < a.length && !a[j].startsWith('--'); j++) out.push(a[j]); return out; };
	const N = Number(opt('--n')[0] || 4);
	const E = grid(opt('--engine'), N), O = grid(opt('--ours'), N);
	for (let l = 0; l < Math.max(E.levels, O.levels); l++) {
		console.log(`L${l}: loot per 100 open tiles, engine / ours (! ours over 1.5x the engine's block, ? under 0.67x)`);
		for (let r = 0; r < N; r++) {
			const cells = [];
			for (let c = 0; c < N; c++) {
				const e = E.acc && E.acc[l][r * N + c], o = O.acc && O.acc[l][r * N + c];
				const ev = e && e.open ? 100 * e.loot / e.open : 0, ov = o && o.open ? 100 * o.loot / o.open : 0;
				const flag = ev && ov > 1.5 * ev ? '!' : ev && ov < 0.67 * ev ? '?' : ' ';
				cells.push(`${ev.toFixed(1).padStart(5)}/${ov.toFixed(1).padEnd(5)}${flag}`);
			}
			console.log('   ' + cells.join(' '));
		}
	}
}

if (require.main === module) main(process.argv.slice(2));
