/**
 * render.js - draw a .vmap to a PNG without any UI. Reads the archive the
 * same way the engine's JSON reader sees it: per-level terrain codes plus
 * the object list. All levels are drawn side by side on one sheet.
 *
 * Tile code anatomy (vmapWriter.js): "<2ch terrain><view digits><flip>"
 * then optionally a road "<2ch><dir digits><flip>" then a river the same
 * way. The preview only needs the terrain id and whether a road/river
 * segment follows.
 */
'use strict';

const fs = require('fs');
const zlib = require('zlib');
const { encodePng } = require('./png');
const { terrainColor, objectStyle, townOwnerColor, parseTileCode }
	= require('./palette');

function readVmap(file) {
	const buf = fs.readFileSync(file);
	const eocd = buf.lastIndexOf(Buffer.from('PK\x05\x06'));
	const count = buf.readUInt16LE(eocd + 10);
	let off = buf.readUInt32LE(eocd + 16);
	const entries = {};
	for (let i = 0; i < count; i++) {
		const nl = buf.readUInt16LE(off + 28);
		const name = buf.slice(off + 46, off + 46 + nl).toString();
		const csize = buf.readUInt32LE(off + 18);
		const method = buf.readUInt16LE(off + 10);
		const lh = buf.readUInt32LE(off + 42);
		const ds = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
		let data = buf.slice(ds, ds + csize);
		if (method === 8) data = zlib.inflateRawSync(data);
		entries[name] = data;
		off += 46 + nl + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32);
	}
	// corpus .vmap JSON carries // comments - strip whole-line comments the
	// same way unzip_vmap.js does before parsing
	const strip = s => s.toString('utf8').replace(/^\s*\/\/.*$/gm, '');
	const objects = JSON.parse(strip(entries['objects.json']));
	const levels = [];
	for (const name of Object.keys(entries)) {
		const m = name.match(/^(.+)_terrain\.json$/);
		if (!m) continue;
		levels.push({ name: m[1], rows: JSON.parse(strip(entries[name])) });
	}
	levels.sort((a, b) => (a.name === 'surface' ? -1 : b.name === 'surface' ? 1 : 0));
	const header = entries['header.json'] ? JSON.parse(strip(entries['header.json'])) : null;
	return { objects, levels, header };
}

/** Draw one level into an RGBA buffer, `scale` pixels per cell. */
function drawLevel(level, objects, scale) {
	const rows = level.rows;
	const H = rows.length, W = rows[0] ? rows[0].length : 0;
	const Wp = W * scale, Hp = H * scale;
	const img = Buffer.alloc(Wp * Hp * 4);
	const px = (x, y, [r, g, b]) => {
		const i = (y * Wp + x) * 4;
		img[i] = r; img[i + 1] = g; img[i + 2] = b; img[i + 3] = 255;
	};
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const t = parseTileCode(rows[y][x]);
			let c = terrainColor(t.terr);
			// road darkens toward a worn track; river draws its own blue
			if (t.road) c = [c[0] * 0.62 + 60 | 0, c[1] * 0.58 + 44 | 0,
				c[2] * 0.55 + 30 | 0];
			if (t.river) c = [40, 90, 210];
			for (let dy = 0; dy < scale; dy++)
				for (let dx = 0; dx < scale; dx++) px(x * scale + dx, y * scale + dy, c);
		}
	// objects sit on their anchor cell; a ring around towns/gates/grails makes
	// them readable at 2px/cell
	const li = level.name === 'underground' ? 1 : 0;
	for (const o of objects) {
		if (o.l !== li) continue;
		const st = objectStyle(o);
		const owner = o.type === 'randomTown' ? townOwnerColor(o) : null;
		const cx = o.x * scale + (scale >> 1), cy = o.y * scale + (scale >> 1);
		const s = st.size * scale + (scale > 1 ? 0 : 1);
		for (let dy = -s; dy <= s; dy++)
			for (let dx = -s; dx <= s; dx++) {
				const X = cx + dx, Y = cy + dy;
				if (X < 0 || Y < 0 || X >= Wp || Y >= Hp) continue;
				const edge = Math.max(Math.abs(dx), Math.abs(dy)) === s;
				px(X, Y, edge && st.ring ? [20, 20, 20]
					: (owner || st.color));
			}
	}
	return { w: Wp, h: Hp, img };
}

/**
 * Render every level of a .vmap side by side (surface left, underground
 * right) on a dark gutter. Returns PNG bytes.
 */
function renderVmap(file, { scale = 2 } = {}) {
	const { objects, levels } = readVmap(file);
	const drawn = levels.map(lv => drawLevel(lv, objects, scale));
	const gap = 8 * scale;
	const W = drawn.reduce((s, d) => s + d.w, 0) + gap * (drawn.length - 1);
	const H = Math.max(...drawn.map(d => d.h));
	const sheet = Buffer.alloc(W * H * 4);
	for (let i = 3; i < sheet.length; i += 4) sheet[i] = 255; // opaque black
	let xoff = 0;
	for (const d of drawn) {
		for (let y = 0; y < d.h; y++)
			d.img.copy(sheet, (y * W + xoff) * 4, y * d.w * 4, (y + 1) * d.w * 4);
		xoff += d.w + gap;
	}
	return encodePng(W, H, sheet);
}

module.exports = { renderVmap, readVmap, parseTileCode, drawLevel };
