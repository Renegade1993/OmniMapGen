/**
 * creature_extents.js - how far each core creature's map sprite reaches beyond its own tile (K, 2026-10-04: "multi-grid creatures
 * improperly placed clipping onto loot"). A map object is drawn with its sprite's bottom-right corner on its anchor tile's, so a
 * wide or tall sprite covers tiles to the left and above. Read from the .def header and first frame in the sprite archives:
 * the visible box (frame margins and size inside the sprite's full size), in tiles beyond the anchor, left and up.
 *   node tools/harness/creature_extents.js [--json out.json]     one line per creature (from OBJECTS.TXT object 54), then the counts
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { h3MonsterTemplates, findResource } = require('../../src/parser/h3data');
const SPRITE_LODS = ['H3ab_spr.lod', 'h3abp_sp.lod', 'H3sprite.lod'];

function defBox(buf) {
	if (!buf || buf.length < 16 + 768) return null;
	const blocks = buf.readUInt32LE(12);
	let p = 16 + 768;
	// the first block's header: id, entries, two unknowns, then 13-byte names, then the offsets
	if (!blocks) return null;
	const entries = buf.readUInt32LE(p + 4);
	p += 16 + entries * 13;
	const off = buf.readUInt32LE(p);
	if (off + 32 > buf.length) return null;
	const fullW = buf.readInt32LE(off + 8), fullH = buf.readInt32LE(off + 12);
	const w = buf.readInt32LE(off + 16), h = buf.readInt32LE(off + 20);
	const left = buf.readInt32LE(off + 24), top = buf.readInt32LE(off + 28);
	return { fullW, fullH, w, h, left, top };
}

/** Tiles the visible sprite covers beyond the anchor tile: { left, up } (the sprite's bottom-right is the anchor's). */
function extent(box) {
	const x0 = 32 - box.fullW + box.left, y0 = 32 - box.fullH + box.top;
	return { left: Math.max(0, Math.ceil(-x0 / 32)), up: Math.max(0, Math.ceil(-y0 / 32)) };
}

function creatureExtents(roots) {
	const out = new Map();
	for (const [idx, tpl] of h3MonsterTemplates(roots)) {
		const name = String(tpl.animation || '').replace(/\.def$/i, '') + '.def';
		const box = defBox(findResource(roots, 'Sprites', SPRITE_LODS, name));
		if (box) out.set(idx, { animation: tpl.animation, ...box, ...extent(box) });
	}
	return out;
}

module.exports = { defBox, extent, creatureExtents };

if (require.main === module) {
	const roots = [process.env.H3_USER_DIR || path.join(process.env.USERPROFILE || '', "Documents", "My Games", "Dead Man's Boots"), process.env.H3_INSTALL_DIR || null];
	const ex = creatureExtents(roots);
	const tally = {};
	for (const [i, e] of [...ex].sort((a, b) => a[0] - b[0])) {
		console.log(`${i}\t${e.animation}\tsprite ${e.fullW}x${e.fullH}\tvisible ${e.w}x${e.h} at ${e.left},${e.top}\tleft ${e.left === undefined ? '' : e.left}`.replace(/\tleft .*/, '') + `\tcovers ${e.left} left, ${e.up} up`);
		const k = `${e.left} left ${e.up} up`; tally[k] = (tally[k] || 0) + 1;
	}
	console.log(`${ex.size} creatures`, JSON.stringify(tally));
	const j = process.argv.indexOf('--json');
	if (j > 0) fs.writeFileSync(process.argv[j + 1], JSON.stringify([...ex], null, 1));
}
