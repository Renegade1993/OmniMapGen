'use strict';
/**
 * overlap_scan.js - where one object's art is drawn over another's (K, 2026-10-18: "crawling grids around instances of the shield and finding
 * cases where the art could be overlapped"; the blocker drawn over the Shield of the Jotunns). Each object's first sprite frame is read from
 * the game's archives or a mod's Sprites folder and decoded to its opaque pixels (palette indices 0 to 7 are transparency, shadow and the
 * selection outline); the sprite stands with its bottom-right on the object's anchor tile, as the game draws it. An object drawn later (a
 * lower anchor row, or the same row further right) lies on top. Every pickup or visitable object whose opaque pixels another object covers is
 * reported with the pixel count. A sprite the scanner cannot find or decode (a mod's PNG animation) is counted and listed, never guessed.
 *   node tools/harness/overlap_scan.js MAP|DIR ... [--min 48] [--json out.json]
 * --engine-prio gives an object written without a draw priority the one the engine writes for its art (OBJECTS.TXT column 8, a mod
 * template's zIndex): what the map would show with the generator writing it.
 * --crop-at L,X,Y pictures only the object standing at (X,Y) on level L, however little of it is hidden.
 * Roots: VCMI_ROOT (the game's Data) and VCMI_USER_DIR (its Mods).
 */
const fs = require('fs');
const path = require('path');
const { findResource } = require('../../src/parser/h3data');
const { decodeDef, spriteOf, coverage: coverAt, pop } = require('../../src/biome/pictures');
const coverage = (o, s) => coverAt(o.x, o.y, s);
const sight = require('../mapsight/lib/sight');

// A picture of one case, twice the game's size: on the left the tiles round the object as the game draws them (flat terrain colours, every
// sprite in the engine's order, shadows darkened), on the right the same with the object drawn last, so what is hidden shows; a red frame
// marks the object's own tile.
function crop(file, M, l, placed, before, a, out) {
	const { encodePng } = require('../../src/preview/png');
	const { terrainColor } = require('../../src/preview/palette');
	const pa = placed.get(a);
	const tx0 = Math.max(0, Math.floor(pa.X0 / 32) - 2), ty0 = Math.max(0, Math.floor(pa.Y0 / 32) - 2);
	const tx1 = Math.min(M.W - 1, a.x + 2), ty1 = Math.min(M.H - 1, a.y + 2);
	const w = (tx1 - tx0 + 1) * 32, h = (ty1 - ty0 + 1) * 32, S = 2, gap = 8;
	const W2 = (2 * w + gap) * S, H2 = h * S;
	const img = Buffer.alloc(W2 * H2 * 4, 255);
	const plot = (side, X, Y, r, g, b) => {
		if (X < 0 || Y < 0 || X >= w || Y >= h) return;
		for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) {
			const p = (((Y * S + dy) * W2) + (side * (w + gap) + X) * S + dx) * 4;
			img[p] = r; img[p + 1] = g; img[p + 2] = b; img[p + 3] = 255;
		}
	};
	const shade = (side, X, Y) => {
		if (X < 0 || Y < 0 || X >= w || Y >= h) return;
		for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) {
			const p = (((Y * S + dy) * W2) + (side * (w + gap) + X) * S + dx) * 4;
			img[p] >>= 1; img[p + 1] >>= 1; img[p + 2] >>= 1;
		}
	};
	const near = [...placed.keys()].filter(o => {
		const q = placed.get(o);
		return q.X0 < (tx1 + 1) * 32 && q.X0 + q.s.w > tx0 * 32 && q.Y0 < (ty1 + 1) * 32 && q.Y0 + q.s.h > ty0 * 32;
	}).sort((p, q) => (before(p, q) ? -1 : before(q, p) ? 1 : 0));
	for (let side = 0; side < 2; side++) {
		for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
			const [r, g, b] = terrainColor(M.terr[M.idx(l, tx, ty)]);
			for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) plot(side, (tx - tx0) * 32 + x, (ty - ty0) * 32 + y, r, g, b);
		}
		const order = side ? [...near.filter(o => o !== a), a] : near;
		for (const o of order) {
			const { s, X0, Y0 } = placed.get(o);
			for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
				const v = s.px[y * s.w + x], X = X0 + x - tx0 * 32, Y = Y0 + y - ty0 * 32;
				if (v === 0 || v === 5 || v === 6 || v === 7) continue;
				if (v <= 4) { shade(side, X, Y); continue; }
				plot(side, X, Y, s.pal[v * 3], s.pal[v * 3 + 1], s.pal[v * 3 + 2]);
			}
		}
		const [ax, ay] = a.at;
		for (let k = 0; k < 32; k++) for (const [X, Y] of [[k, 0], [k, 31], [0, k], [31, k]])
			plot(side, (ax - tx0) * 32 + X, (ay - ty0) * 32 + Y, 230, 30, 30);
	}
	fs.writeFileSync(out, encodePng(W2, H2, img));
}

function scan(file, opts = {}) {
	const roots = [process.env.VCMI_ROOT || null, process.env.VCMI_USER_DIR || null, process.env.VMAPGEN_SPRITE_ROOT || null];
	const M = sight.load(file);
	const min = opts.min || 48;
	const items = [], missing = new Map();
	for (let l = 0; l < M.NL; l++) {
		const objs = M.objs.filter(o => (o.l || 0) === l && o.template && o.template.animation);
		const cov = new Map(), placed = new Map();
		for (const o of objs) {
			const s = spriteOf(o.template.animation, roots);
			if (!s) { missing.set(o.template.animation, (missing.get(o.template.animation) || 0) + 1); continue; }
			cov.set(o, coverage(o, s));
			placed.set(o, { s, X0: (o.x + 1) * 32 - s.fullW + s.left, Y0: (o.y + 1) * 32 - s.fullH + s.top });
		}
		// by tile, the objects that draw there
		const byTile = new Map();
		for (const [o, c] of cov) for (const k of c.keys()) { if (!byTile.has(k)) byTile.set(k, []); byTile.get(k).push(o); }
		// CMap::compareObjectBlitOrder, whether a is drawn before b: an object with a draw priority (zIndex) under every object without one;
		// then the object with a blocked tile right below a blocked tile of the other on top of it; then the lower anchor row; then a hero;
		// then the order in the file
		const blk = new Map(objs.map(o => [o, new Set(o.cells.map(([x, y]) => x + ',' + y))]));
		const z = o => (o.template.zIndex || (opts.prio && opts.prio(o.template.animation)) || 0);
		const before = (a, b) => {
			const za = z(a), zb = z(b);
			if (za || zb) return za !== zb ? za > zb : a.k < b.k;
			let aOverB = 0, bOverA = 0;
			for (const [x, y] of a.cells) if (blk.get(b).has(x + ',' + (y + 1))) bOverA++;
			for (const [x, y] of b.cells) if (blk.get(a).has(x + ',' + (y + 1))) aOverB++;
			if (aOverB !== bOverA) return aOverB < bOverA;
			if (a.y !== b.y) return a.y < b.y;
			if ((a.type === 'hero') !== (b.type === 'hero')) return b.type === 'hero';
			return a.k < b.k;
		};
		const later = (a, b) => before(a, b);
		for (const a of cov.keys()) {
			if (!(a.cls === 'low' || a.cls === 'high' || a.visitable)) continue;
			// per object on top, the pixels it covers; the total counts a pixel two objects cover once
			const ca = cov.get(a), hit = new Map();
			let total = 0;
			for (const [k, rows] of ca) {
				const union = new Uint32Array(32);
				for (const b of byTile.get(k) || []) {
					if (b === a || !later(a, b)) continue;
					const rb = cov.get(b).get(k);
					let n = 0;
					for (let i = 0; i < 32; i++) { n += pop((rows[i] & rb[i]) >>> 0); union[i] |= rb[i]; }
					if (n) hit.set(b, (hit.get(b) || 0) + n);
				}
				for (let i = 0; i < 32; i++) total += pop((rows[i] & union[i]) >>> 0);
			}
			const wanted = opts.cropAt && opts.cropAt === `${l},${a.at[0]},${a.at[1]}`;
			if (total < min && !wanted) continue;
			const own = [...ca.values()].reduce((t, r) => t + r.reduce((u, v) => u + pop(v), 0), 0);
			items.push({ l, a: `${a.type}:${a.subtype}`, at: a.at, anchor: [a.x, a.y], cls: a.cls, pixels: total, share: own ? total / own : 0,
				by: [...hit].sort((p, q) => q[1] - p[1]).slice(0, 3).map(([b, n]) => `${b.type}:${b.subtype} (${b.x},${b.y}) ${n}px`) });
			const it = items[items.length - 1];
			if (opts.crops && (wanted || (!opts.cropAt && (a.cls === 'low' || a.cls === 'high') && it.share >= 0.5))) {
				it.crop = path.join(opts.crops, `${path.basename(file, '.vmap')}_L${l}_${a.at[0]}_${a.at[1]}_${a.type}.png`);
				crop(file, M, l, placed, before, a, it.crop);
			}
		}
	}
	items.sort((p, q) => q.pixels - p.pixels);
	const pickups = M.objs.filter(o => o.cls === 'low' || o.cls === 'high').length;
	return { file, pickups, items, missing: [...missing].sort((p, q) => q[1] - p[1]) };
}

// the engine's draw priority for an animation: OBJECTS.TXT column 8 times 100, or a mod template's zIndex (lowercase animation -> zIndex)
function enginePrio() {
	const roots = [process.env.VCMI_ROOT || null, process.env.VCMI_USER_DIR || null];
	const out = new Map();
	const text = findResource(roots, 'Data', ['H3ab_bmp.lod', 'h3abp_bm.lod', 'H3bitmap.lod', 'H3pbitma.lod'], 'OBJECTS.TXT');
	if (text) for (const line of text.toString('latin1').split(/\r?\n/).slice(1)) {
		const c = line.trim().split(' ');
		if (c.length >= 9 && parseInt(c[8], 10) > 0) out.set(c[0].replace(/\.def$/i, '').toLowerCase(), parseInt(c[8], 10) * 100);
	}
	const mods = process.env.VCMI_USER_DIR ? path.join(process.env.VCMI_USER_DIR, 'Mods') : null;
	const walk = (d, depth) => {
		let list = [];
		try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
		for (const e of list) {
			const p = path.join(d, e.name);
			if (e.isDirectory() && depth < 9) walk(p, depth + 1);
			else if (/\.json$/i.test(e.name)) {
				const t = fs.readFileSync(p, 'utf8');
				if (!t.includes('zIndex')) continue;
				const re = /"animation"\s*:\s*"([^"]+)"[^{}]*?"zIndex"\s*:\s*(\d+)|"zIndex"\s*:\s*(\d+)[^{}]*?"animation"\s*:\s*"([^"]+)"/g;
				let m;
				while ((m = re.exec(t))) { const a = (m[1] || m[4]).replace(/\\/g, '/').toLowerCase(), zi = Number(m[2] || m[3]); if (zi > 0) out.set(a, zi); }
			}
		}
	};
	if (mods && fs.existsSync(mods)) walk(mods, 0);
	return a => { const k = String(a || '').replace(/\\/g, '/').toLowerCase(); return out.get(k) || out.get(k.split('/').pop()) || 0; };
}

module.exports = { scan, decodeDef, spriteOf, enginePrio };

if (require.main === module) {
	const args = process.argv.slice(2), files = [];
	const min = args.includes('--min') ? Number(args[args.indexOf('--min') + 1]) : 48;
	const prio = args.includes('--engine-prio') ? enginePrio() : null;
	const crops = args.includes('--crops') ? args[args.indexOf('--crops') + 1] : null;
	const cropAt = args.includes('--crop-at') ? args[args.indexOf('--crop-at') + 1] : null;
	if (crops) fs.mkdirSync(crops, { recursive: true });
	const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
	args.forEach((a, i) => {
		if (a.startsWith('--') || ['--min', '--json', '--crops', '--crop-at'].includes(args[i - 1])) return;
		if (fs.existsSync(a) && fs.statSync(a).isDirectory()) fs.readdirSync(a).filter(f => f.endsWith('.vmap')).sort().forEach(f => files.push(path.join(a, f)));
		else files.push(a);
	});
	const all = [];
	for (const f of files) {
		const r = scan(f, { min, prio, crops, cropAt });
		all.push(r);
		const pickups = r.items.filter(x => x.cls === 'low' || x.cls === 'high');
		const hid = (k, q) => r.items.filter(x => k(x) && x.share >= q).length, pk = x => x.cls === 'low' || x.cls === 'high', any = () => true;
		r.counts = { pickupsHalf: hid(pk, 0.5), pickupsQuarter: hid(pk, 0.25), visitHalf: hid(any, 0.5), pickups: r.pickups };
		console.log(`  hidden half or more: ${r.counts.pickupsHalf} pickups, ${r.counts.visitHalf} visitable objects; a quarter or more: ${r.counts.pickupsQuarter} pickups (of ${r.pickups})`);
		console.log(`${path.basename(f)}: ${r.items.length} objects drawn over by ${min}px or more (${pickups.length} pickups); sprites not found ${r.missing.reduce((t, m) => t + m[1], 0)} (${r.missing.length} kinds)`);
		for (const x of r.items.slice(0, 6)) console.log(`  L${x.l} ${x.a} at (${x.at}) ${x.pixels}px (${(100 * x.share).toFixed(0)}% of it) under ${x.by.join('; ')}`);
	}
	if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(all, null, 1));
}
