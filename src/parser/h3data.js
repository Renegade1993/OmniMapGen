/**
 * h3data.js - the Heroes III data the engine reads for core content, read the
 * same way: OBJECTS.TXT from the data archives and an animation's .msk size
 * from the sprite archives, mounted in config/filesystem.json's order (a later
 * source overrides an earlier one, and a loose file in Data/ or Sprites/ wins).
 *
 * Used for core monster templates: a core creature with no graphics.map in
 * its config keeps the H3 templates OBJECTS.TXT gives object 54 with its
 * creature index as subtype (CCreatureHandler.cpp:667-687), converted the way
 * ObjectTemplate::readTxt, readMsk and writeJson convert them.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// config/filesystem.json, "DATA/" and "SPRITES/", in mount order
const DATA_LODS = ['H3ab_bmp.lod', 'h3abp_bm.lod', 'H3bitmap.lod', 'H3pbitma.lod'];
const SPRITE_LODS = ['H3ab_spr.lod', 'h3abp_sp.lod', 'H3sprite.lod'];

const lodCache = new Map();

/** Entries of a LOD archive: upper-case name -> {off, size, csize}. */
function lodIndex(file) {
	if (lodCache.has(file)) return lodCache.get(file);
	let idx = null;
	try {
		const fd = fs.openSync(file, 'r');
		try {
			const head = Buffer.alloc(12);
			fs.readSync(fd, head, 0, 12, 0);
			if (head.toString('latin1', 0, 3) === 'LOD') {
				const count = head.readUInt32LE(8);
				const table = Buffer.alloc(count * 32);
				fs.readSync(fd, table, 0, table.length, 92);
				const entries = new Map();
				for (let i = 0; i < count; i++) {
					const e = i * 32;
					const name = table.toString('latin1', e, e + 16).replace(/\0.*$/s, '').toUpperCase();
					entries.set(name, { off: table.readUInt32LE(e + 16), size: table.readUInt32LE(e + 20),
						csize: table.readUInt32LE(e + 28) });
				}
				idx = { file, entries };
			}
		} finally { fs.closeSync(fd); }
	} catch { idx = null; }
	lodCache.set(file, idx);
	return idx;
}

function lodRead(idx, name) {
	const e = idx.entries.get(name.toUpperCase());
	if (!e) return null;
	const buf = Buffer.alloc(e.csize || e.size);
	const fd = fs.openSync(idx.file, 'r');
	try { fs.readSync(fd, buf, 0, buf.length, e.off); } finally { fs.closeSync(fd); }
	return e.csize ? zlib.inflateSync(buf) : buf;
}

/** A file in dir whose name matches, ignoring case (VCMI's lookup is case-blind). */
function findIn(dir, name) {
	try {
		const want = name.toLowerCase();
		const hit = fs.readdirSync(dir).find(n => n.toLowerCase() === want);
		return hit ? path.join(dir, hit) : null;
	} catch { return null; }
}

/**
 * A resource from one mount point: the loose folder first (mounted last, so it
 * wins), then the archives from last to first. roots are the folders holding
 * Data/ and Sprites/ (the user folder, then the install).
 */
function findResource(roots, looseDirName, lods, name) {
	for (const root of roots) {
		if (!root) continue;
		const loose = findIn(path.join(root, looseDirName), name);
		if (loose) return fs.readFileSync(loose);
		for (const lod of [...lods].reverse()) {
			const file = findIn(path.join(root, 'Data'), lod);
			if (!file) continue;
			const idx = lodIndex(file);
			if (!idx) continue;
			const buf = lodRead(idx, name);
			if (buf) return buf;
		}
	}
	return null;
}

const tileChar = t => (t.blocked ? (t.visitable ? 'A' : 'B') : 'V');

/**
 * The H3 templates OBJECTS.TXT gives one object class: subtype -> template
 * {animation, mask, visitableFrom}, the first line of a subtype being its
 * default, as the engine would write it into a map. Creatures, heroes,
 * artifacts and resources (the file's own type column, 2 to 5) are visitable
 * from every side, the top included; the rest from the front and the sides
 * (ObjectTemplate::readTxt, isOnVisitableFromTopList). fromTop settles it for
 * a class that is always one of those whatever a row's type column says.
 * Returns an empty map when the data is not found.
 */
function h3ObjectTemplates(roots, classId, fromTop = null) {
	const out = new Map();
	const text = findResource(roots, 'Data', DATA_LODS, 'OBJECTS.TXT');
	if (!text) return out;
	const lines = text.toString('latin1').split(/\r?\n/);
	const total = parseInt(lines[0], 10) || 0;
	const mskCache = new Map();
	for (let i = 1; i <= total && i < lines.length; i++) {
		const s = lines[i].trim().split(' ');
		if (s.length < 9) continue;
		const id = parseInt(s[5], 10), subid = parseInt(s[6], 10), type = parseInt(s[7], 10);
		if (id !== classId || out.has(subid)) continue;
		const anim = s[0].replace(/\.def$/i, '');
		const block = s[1], visit = s[2];
		// ObjectTemplate::readTxt: an 8x6 grid in file order, then readMsk
		// trims it to the sprite's own size
		let size = mskCache.get(anim);
		if (size === undefined) {
			const msk = findResource(roots, 'Sprites', SPRITE_LODS, `${anim}.MSK`);
			size = msk && msk.length >= 2 ? [msk[0], msk[1]] : [8, 6];
			mskCache.set(anim, size);
		}
		const [w, h] = size;
		const tile = (r, c) => ({ blocked: block[r * 8 + c] === '0', visitable: visit[r * 8 + c] === '1' });
		// ObjectTemplate::writeJson: row i is usedTiles[h-1-i], column j is [w-1-j]
		const mask = [];
		for (let r = 0; r < h; r++) {
			let line = '';
			for (let c = 0; c < w; c++) line += tileChar(tile(h - 1 - r, w - 1 - c));
			mask.push(line);
		}
		const top = fromTop !== null ? fromTop : type >= 2 && type <= 5;
		out.set(subid, { animation: anim, mask,
			visitableFrom: top ? ['+++', '+-+', '+++'] : ['---', '+-+', '+++'] });
	}
	return out;
}

// OBJECTS.TXT's terrain order (ObjectTemplate::readTxt: column 5, read right to
// left), by the identifiers the engine gives them
const H3_TERRAINS = ['dirt', 'sand', 'grass', 'snow', 'swamp', 'rough', 'subterra', 'lava', 'water'];

/**
 * Where each OBJECTS.TXT row may stand, as ObjectTemplate::readTxt reads it:
 * `${class}.${subtype}` -> [{ anyLand, terrains }] per row. A row allowing all
 * eight land terrains and not water is any land (canBePlacedAt then takes a
 * mod's land terrains too); any other stands only on the terrains it names.
 * Empty when the data is not found.
 */
function h3TerrainRows(roots) {
	const out = new Map();
	const text = findResource(roots, 'Data', DATA_LODS, 'OBJECTS.TXT');
	if (!text) return out;
	const lines = text.toString('latin1').split(/\r?\n/);
	const total = parseInt(lines[0], 10) || 0;
	for (let i = 1; i <= total && i < lines.length; i++) {
		const s = lines[i].trim().split(' ');
		if (s.length < 9 || s[4].length !== 9) continue;
		const terrains = H3_TERRAINS.filter((_, k) => s[4][8 - k] === '1');
		const anyLand = terrains.length >= 8 && !terrains.includes('water');
		const key = `${parseInt(s[5], 10)}.${parseInt(s[6], 10)}`;
		if (!out.has(key)) out.set(key, []);
		out.get(key).push({ anyLand, terrains });
	}
	return out;
}

/** The H3 monster templates from OBJECTS.TXT (object 54): creature index -> template. */
function h3MonsterTemplates(roots) {
	return h3ObjectTemplates(roots, 54, true);
}

/** The H3 artifact templates from OBJECTS.TXT (object 5): artifact number -> template. */
function h3ArtifactTemplates(roots) {
	return h3ObjectTemplates(roots, 5, true);
}

/**
 * H3's own creature traits from CRTRAITS.TXT: creature index -> {aiValue,
 * growth}, the two figures the engine prices a dwelling by in a treasure pile
 * (TreasurePlacer::addDwellings: AI value x growth). Core's creature configs
 * leave both out; VCMI reads them from here. Row i (after two header rows) is
 * the creature with index i. Empty when the data is not found.
 */
function h3CreatureTraits(roots) {
	const out = new Map();
	const text = findResource(roots, 'Data', DATA_LODS, 'CRTRAITS.TXT');
	if (!text) return out;
	const lines = text.toString('latin1').split(/\r?\n/).slice(2);
	lines.forEach((line, i) => {
		const f = line.split('\t');
		if (f.length < 12 || !f[0]) return;
		const aiValue = parseInt(f[10], 10), growth = parseInt(f[11], 10);
		if (aiValue > 0 && growth > 0) out.set(i, { aiValue, growth });
	});
	return out;
}

module.exports = { h3ObjectTemplates, h3MonsterTemplates, h3ArtifactTemplates, h3CreatureTraits, h3TerrainRows,
	lodIndex, lodRead, findResource };
