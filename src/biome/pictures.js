'use strict';
/**
 * pictures.js - what the game draws where: an object's first sprite frame from the game's archives or a mod's Sprites folder, decoded to its
 * opaque pixels (palette indices 0 to 7 are transparency, shadow and the selection outline) and placed as the game places it (the frame's
 * bottom-right on the anchor tile), and the order the game draws two objects in (CMap::compareObjectBlitOrder). declip.js declipPictures
 * judges a pickup hidden by these pixels; tools/harness/overlap_scan.js counts and pictures the cases. 2026-10-18.
 */
const fs = require('fs');
const path = require('path');
const { findResource } = require('../parser/h3data');
const LODS = ['H3ab_spr.lod', 'h3abp_sp.lod', 'H3sprite.lod', 'HotA.lod'];

// the loose .def files under every mod's Sprites folder, by lowercase file name
const modDefsByDir = new Map();
// a mod's id from the folder that holds its Content: .../Mods/hota/Mods/bulwark -> 'hota.bulwark' (modCrawler.js gives submods the same ids)
const modIdOf = dir => dir.replace(/\\/g, '/').split(/\/mods\//i).slice(1).map(q => q.split('/')[0].toLowerCase()).join('.');
function modIndex(userDir) {
	const mods = userDir ? path.join(userDir, 'Mods') : null;
	if (modDefsByDir.has(mods)) return modDefsByDir.get(mods);
	const out = new Map();
	// out.exact: every file at a path under a mod's Content/Sprites folder ('deathvalley/map/flayer', a bare name for a file at the Sprites root), the way the game's file system names it,
	// as { file, mod } in the order found
	const exact = new Map();
	const walk = (d, depth) => {
		let list = [];
		try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
		for (const e of list) {
			const p = path.join(d, e.name);
			if (e.isDirectory() && depth < 16) walk(p, depth + 1);
			else if (/\.def$/i.test(e.name)) {
				if (!out.has(e.name.toLowerCase())) out.set(e.name.toLowerCase(), p);
				const lp = p.replace(/\\/g, '/'), at = lp.toLowerCase().lastIndexOf('/content/sprites/');
				if (at >= 0) {
					const key = lp.slice(at + 17).toLowerCase().replace(/\.def$/, '');
					if (!exact.has(key)) exact.set(key, []);
					exact.get(key).push({ file: p, mod: modIdOf(lp.slice(0, at)) });
				}
			}
		}
	};
	if (mods && fs.existsSync(mods)) walk(mods, 0);
	out.exact = exact;
	modDefsByDir.set(mods, out);
	return out;
}

// The active mods in load order, lowest first, as the generator resolves them (modCrawler.js): Map(mod id -> position), or null when the roots hold no readable mods. The roots are the
// user folder first (its config/modSettings.json says which mods are active) and the install, as spriteRoots() gives them.
const orderCache = new Map();
function modOrder(roots) {
	const rs = roots.filter(Boolean), key = rs.join('|');
	if (orderCache.has(key)) return orderCache.get(key);
	let order = null;
	try {
		const mc = require('../parser/modCrawler');
		const userDir = rs.find(r => fs.existsSync(path.join(r, 'config', 'modSettings.json'))) || rs[0];
		const mods = mc.crawlMods({ userDir, installDir: rs.find(r => r !== userDir) });
		order = new Map(mc.resolveLoadOrder(mods, mc.loadActivationState(userDir)).map((m, i) => [m.__id, i]));
		if (!order.size) order = null;
	} catch (e) { order = null; }
	orderCache.set(key, order);
	return order;
}
// the copy the client reads among candidates { mod, zipped, ... }: only active mods, the later mod, and in one mod its loose file over its zip (the file system is [Content.zip, Content/], the
// later loader wins; CModHandler.cpp genDefaultFS); null when no active mod has one
function pickCopy(cands, roots) {
	if (!cands.length) return null;
	const order = cands.length > 1 || process.env.VMAPGEN_SPRITE_ACTIVE !== '0' ? modOrder(roots) : null;
	let best = null, bi = -1;
	for (const c of cands) {
		if (order && !order.has(c.mod)) continue;
		const rank = (order ? order.get(c.mod) : 0) * 2 + (c.zipped ? 0 : 1);
		if (rank > bi) { bi = rank; best = c; }
	}
	return best;
}

/** The first frame of a DEF: its full size, its box inside it, its palette indices, and the palette. Null when it cannot be read. */
function decodeDef(buf) {
	if (!buf || buf.length < 16 + 768) return null;
	if (!buf.readUInt32LE(12)) return null;
	let p = 16 + 768;
	const entries = buf.readUInt32LE(p + 4);
	p += 16 + entries * 13;
	if (p + 4 > buf.length) return null;
	const off = buf.readUInt32LE(p);
	if (off + 32 > buf.length) return null;
	const fmt = buf.readUInt32LE(off + 4);
	const fullW = buf.readInt32LE(off + 8), fullH = buf.readInt32LE(off + 12);
	const w = buf.readInt32LE(off + 16), h = buf.readInt32LE(off + 20);
	const left = buf.readInt32LE(off + 24), top = buf.readInt32LE(off + 28);
	if (w <= 0 || h <= 0 || w > 2048 || h > 2048) return null;
	const d = off + 32, px = new Uint8Array(w * h);
	const put = (i, v) => { if (i >= 0 && i < px.length) px[i] = v; };
	try {
		if (fmt === 0) for (let i = 0; i < w * h; i++) px[i] = buf[d + i];
		else if (fmt === 1) {
			for (let y = 0; y < h; y++) {
				let q = d + buf.readUInt32LE(d + 4 * y), x = 0;
				while (x < w) {
					const code = buf[q], len = buf[q + 1] + 1; q += 2;
					for (let k = 0; k < len && x < w; k++, x++) put(y * w + x, code === 0xff ? buf[q + k] : code);
					if (code === 0xff) q += len;
				}
			}
		} else if (fmt === 2 || fmt === 3) {
			for (let y = 0; y < h; y++) {
				let x = 0, q = fmt === 2 ? d + buf.readUInt16LE(d + 2 * y) : 0;
				while (x < w) {
					if (fmt === 3 && x % 32 === 0) q = d + buf.readUInt16LE(d + 2 * (y * Math.ceil(w / 32) + x / 32));
					const b = buf[q++], code = b >> 5, len = (b & 31) + 1;
					for (let k = 0; k < len && x < w; k++, x++) put(y * w + x, code === 7 ? buf[q + k] : code);
					if (code === 7) q += len;
				}
			}
		} else return null;
	} catch (e) { return null; }
	return { fullW, fullH, w, h, left, top, px, pal: buf.subarray(16, 16 + 768) };
}

/** roots: [userDir, installDir] (either may be missing). The decoded first frame of an animation, cached; null when it is not found. */
const cache = new Map();
function spriteOf(animation, roots) {
	const base = String(animation || '').replace(/\\/g, '/').split('/').pop().replace(/\.def$/i, '').toLowerCase();
	if (!base) return null;
	// the cache key is the whole path for a path animation: two defs of one bare name in different folders are two pictures
	const full = String(animation).replace(/\\/g, '/').replace(/\.def$/i, '').toLowerCase();
	const hasFolder = full.includes('/');
	const key = roots.filter(Boolean).join('|') + '|' + (hasFolder ? full + '|path' : base);
	if (cache.has(key)) return cache.get(key);
	let buf = null;
	// A sprite is the file the game's file system gives the path: the active mods in load order (a mod's Content/Sprites/<path>.def, or the same path in its content.zip; the later mod
	// wins, in one mod the loose file over its zip), then the base game's archives. A path ('deathvalley/map/Flayer') names one file; the bare file name 'Flayer.def' also names the
	// battle def (450x400) in another folder of the same mod, which the search by bare name found first: 463 of the 4,961 sprite paths of K's mods answered with another file's picture
	// (the Flayer and Bone Hook 'seven tiles off' of the guard figure census, the cathedral map creatures, the Death Valley towns, scenery of the plateau, terrace and highland sets), and
	// a bare name read the original archive's picture where a mod overrides it (HotA's patch of AVMcrsn0, the crystal cavern). What no mod and no archive holds still falls through to the
	// old search by bare name. VMAPGEN_SPRITE_EXACT=0 keeps the old order only; VMAPGEN_SPRITE_ZIPS=0 reads loose files only.
	if (process.env.VMAPGEN_SPRITE_EXACT !== '0') {
		const cands = [];
		for (const r of roots.filter(Boolean)) {
			for (const c of modIndex(r).exact.get(full) || []) cands.push({ ...c, zipped: false });
			if (process.env.VMAPGEN_SPRITE_ZIPS !== '0') for (const c of zipIndex(r).full.get('sprites/' + full + '.def') || []) cands.push({ ...c, zipped: true });
		}
		const pick = pickCopy(cands, roots);
		if (pick) {
			let s = null;
			try { s = decodeDef(pick.zipped ? readZipEntry(pick) : fs.readFileSync(pick.file)); } catch (e) { s = null; }
			if (s) { cache.set(key, s); return s; }
		}
	}
	// an animation named by a path ('hota/dungeon/adventureMap/creatures/AvWMino') is a mod's file: the game never reads it from the original
	// archives, which contain a different picture under the same bare name (the H3 minotaur, drawn a tile right of the HotA one). A user folder
	// with the game's Data gave the archive's picture first (K's own folder; the kenv copy has no Data). Mods first for a path.
	const modFirst = hasFolder;
	const fromMods = () => { for (const r of roots.filter(Boolean)) { const f = modIndex(r).get(base + '.def'); if (f) return fs.readFileSync(f); } return null; };
	if (modFirst) buf = fromMods();
	if (!buf) try { buf = findResource(roots.filter(Boolean), 'Sprites', LODS, base + '.def'); } catch (e) { buf = null; }
	if (!buf && !modFirst) buf = fromMods();
	// a mod that ships its sprites in a content.zip (HotA Bulwark, Pavilion, Preserve: 44 of the 310 creatures, and their art) is read there too; VMAPGEN_SPRITE_ZIPS=0 reads loose files only, as 0.3.30 did
	const s = buf ? decodeDef(buf) : (process.env.VMAPGEN_SPRITE_ZIPS === '0' ? null : spriteOfInZip(animation, roots));
	cache.set(key, s);
	return s;
}

// The .def files inside every mod's content.zip, by lowercase entry name: Map('sprites/<path>.def' -> [{ zip, csize, method, lhoff, mod }]). Only the zip's
// central directory is read (the last bytes of the file), never the archive, so indexing the 70 zips of an install takes a moment.
const zipDefsByDir = new Map();
function zipIndex(userDir) {
	const mods = userDir ? path.join(userDir, 'Mods') : null;
	if (zipDefsByDir.has(mods)) return zipDefsByDir.get(mods);
	const out = new Map(), base = new Map();
	const readTail = file => {
		let fd;
		try {
			const mod = modIdOf(path.dirname(file));
			fd = fs.openSync(file, 'r');
			const size = fs.fstatSync(fd).size, n = Math.min(size, 65557), tail = Buffer.alloc(n);
			fs.readSync(fd, tail, 0, n, size - n);
			let eocd = -1;
			for (let i = n - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
			if (eocd < 0) return;
			const count = tail.readUInt16LE(eocd + 10), cdSize = tail.readUInt32LE(eocd + 12), cdOff = tail.readUInt32LE(eocd + 16);
			const cd = Buffer.alloc(cdSize);
			fs.readSync(fd, cd, 0, cdSize, cdOff);
			let off = 0;
			for (let i = 0; i < count && off + 46 <= cdSize; i++) {
				const nl = cd.readUInt16LE(off + 28), xl = cd.readUInt16LE(off + 30), cl = cd.readUInt16LE(off + 32);
				const name = cd.toString('utf8', off + 46, off + 46 + nl).toLowerCase();
				if (name.endsWith('.def')) {
					const e = { zip: file, method: cd.readUInt16LE(off + 10), csize: cd.readUInt32LE(off + 20), lhoff: cd.readUInt32LE(off + 42), mod };
					if (!out.has(name)) out.set(name, []);
					out.get(name).push(e);
					const b = name.slice(name.lastIndexOf('/') + 1);
					if (!base.has(b)) base.set(b, e);
				}
				off += 46 + nl + xl + cl;
			}
		} catch (e) { /* an unreadable zip adds nothing */ } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (e) { /* closed */ } }
	};
	const walk = (d, depth) => {
		let list = [];
		try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
		for (const e of list) {
			const p = path.join(d, e.name);
			if (e.isDirectory() && depth < 16) walk(p, depth + 1);
			else if (/^content\.zip$/i.test(e.name)) readTail(p);
		}
	};
	if (mods && fs.existsSync(mods)) walk(mods, 0);
	const idx = { full: out, base };
	zipDefsByDir.set(mods, idx);
	return idx;
}

// the bytes of one zipped file (an entry of zipIndex)
function readZipEntry(e) {
	const fd = fs.openSync(e.zip, 'r');
	try {
		const head = Buffer.alloc(30);
		fs.readSync(fd, head, 0, 30, e.lhoff);
		const start = e.lhoff + 30 + head.readUInt16LE(26) + head.readUInt16LE(28), raw = Buffer.alloc(e.csize);
		fs.readSync(fd, raw, 0, e.csize, start);
		return e.method === 8 ? require('zlib').inflateRawSync(raw) : raw;
	} finally { fs.closeSync(fd); }
}

/** An animation's first frame from a mod's content.zip ('creatures/AVWSHAMN' is entry 'sprites/creatures/avwshamn.def'), or null. spriteOf reads zips itself (unless
 * VMAPGEN_SPRITE_ZIPS=0); this one reads them whatever that says, for the figure test (guardCreatures.js figureTest). */
const zipSprites = new Map();
function spriteOfInZip(animation, roots, exactOnly = false) {
	const name = 'sprites/' + String(animation || '').replace(/\\/g, '/').replace(/\.def$/i, '').toLowerCase() + '.def';
	const key = roots.filter(Boolean).join('|') + '|' + name + (exactOnly ? '|x' : '');
	if (zipSprites.has(key)) return zipSprites.get(key);
	let s = null;
	const cands = [];
	for (const r of roots.filter(Boolean)) for (const c of zipIndex(r).full.get(name) || []) cands.push({ ...c, zipped: true });
	const pick = pickCopy(cands, roots);
	let e = pick;
	// a bare name no mod holds at the Sprites root takes the first zipped file of that name, as spriteOf takes the first loose one
	if (!e && !exactOnly && !name.slice('sprites/'.length).includes('/')) for (const r of roots.filter(Boolean)) { e = zipIndex(r).base.get(name.slice(name.lastIndexOf('/') + 1)); if (e) break; }
	if (e) { try { s = decodeDef(readZipEntry(e)); } catch (err) { s = null; } }
	zipSprites.set(key, s);
	return s;
}

/** Where a sprite's box starts in map pixels for an object anchored at (x, y). */
const origin = (x, y, s) => [(x + 1) * 32 - s.fullW + s.left, (y + 1) * 32 - s.fullH + s.top];

/** An object's opaque pixels in map pixel space by tile: Map('tx,ty' -> Uint32Array(32), one bit per pixel of each of the tile's rows). */
function coverage(x, y, s) {
	const cov = new Map();
	const [X0, Y0] = origin(x, y, s);
	for (let j = 0; j < s.h; j++) for (let i = 0; i < s.w; i++) {
		if (s.px[j * s.w + i] <= 7) continue;
		const X = X0 + i, Y = Y0 + j;
		if (X < 0 || Y < 0) continue;
		const k = (X >> 5) + ',' + (Y >> 5);
		let rows = cov.get(k);
		if (!rows) { rows = new Uint32Array(32); cov.set(k, rows); }
		rows[Y & 31] |= (1 << (X & 31)) >>> 0;
	}
	return cov;
}
const pop = v => { v = v - ((v >>> 1) & 0x55555555); v = (v & 0x33333333) + ((v >>> 2) & 0x33333333); return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };

/**
 * CMap::compareObjectBlitOrder: whether a is drawn before b. a, b: { x, y, z (draw priority, 0 none), k (file order), hero, cells (Set of
 * 'x,y' blocked tiles) }. An object with a draw priority goes under every object without one; then the object with a blocked tile right below a
 * blocked tile of the other is drawn on top of it; then the lower anchor row; then a hero; then the file order.
 */
function drawnBefore(a, b) {
	if (a.z || b.z) return a.z !== b.z ? a.z > b.z : a.k < b.k;
	let aOverB = 0, bOverA = 0;
	for (const c of a.cells) { const [x, y] = c.split(',').map(Number); if (b.cells.has(x + ',' + (y + 1))) bOverA++; }
	for (const c of b.cells) { const [x, y] = c.split(',').map(Number); if (a.cells.has(x + ',' + (y + 1))) aOverB++; }
	if (aOverB !== bOverA) return aOverB < bOverA;
	if (a.y !== b.y) return a.y < b.y;
	if (a.hero !== b.hero) return !!b.hero;
	return a.k < b.k;
}

/** Where sprites are read: the generator's user folder and install, and VMAPGEN_SPRITE_ROOT, a folder holding the game's Data for a run whose
 * install has none (the suite's test install: setting its user folder would load that folder's mods into every test). */
const spriteRoots = () => [process.env.VCMI_USER_DIR, process.env.VCMI_ROOT, process.env.VMAPGEN_SPRITE_ROOT].filter(Boolean);

module.exports = { decodeDef, spriteOf, spriteOfInZip, coverage, origin, pop, drawnBefore, spriteRoots, modIndex, zipIndex, modOrder, pickCopy };
