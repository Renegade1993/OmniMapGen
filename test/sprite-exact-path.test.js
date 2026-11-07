// pictures.js spriteOf: an animation named by a folder path is read from exactly that path (the game's file system), not from the first file of the same bare name in any mod
// folder. Found 2026-11-07 from DMB Dev's real-client picture of K's map pR_s2110553840: deathvalley/map/Flayer.def is 64x64 with margins 0, and the search by bare name returned
// the 450x400 battle def of the same name, which made a "seven tiles off" figure of a stack that stands on its own tile. 463 of the 4,961 sprite paths of K's mods answered with
// another file's picture.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { testTmp } = require('./_vcmi');
const pics = require('../src/biome/pictures');

// a DEF with one 8-bit frame: fullW x fullH in a box w x h at (left, top), every pixel palette index 9 (opaque)
function def(fullW, fullH, w, h, left, top) {
	const frame = 32 + w * h, head = 16 + 768 + 16 + 13 + 4;
	const buf = Buffer.alloc(head + frame);
	buf.writeUInt32LE(0x43, 0); buf.writeUInt32LE(fullW, 4); buf.writeUInt32LE(fullH, 8); buf.writeUInt32LE(1, 12);
	const p = 16 + 768;
	buf.writeUInt32LE(0, p); buf.writeUInt32LE(1, p + 4);
	buf.writeUInt32LE(head, p + 16 + 13);
	const o = head;
	buf.writeUInt32LE(frame, o); buf.writeUInt32LE(0, o + 4); buf.writeInt32LE(fullW, o + 8); buf.writeInt32LE(fullH, o + 12);
	buf.writeInt32LE(w, o + 16); buf.writeInt32LE(h, o + 20); buf.writeInt32LE(left, o + 24); buf.writeInt32LE(top, o + 28);
	buf.fill(9, o + 32);
	return buf;
}

function userDir() {
	const root = fs.mkdtempSync(path.join(testTmp(), 'sprites-'));
	const put = (mod, rel, buf) => { const f = path.join(root, 'Mods', mod, 'Content', 'Sprites', ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); };
	put('death-valley-town', 'deathvalley/battle/Flayer.def', def(450, 400, 64, 81, 170, 188));
	put('death-valley-town', 'deathvalley/map/Flayer.def', def(64, 64, 64, 64, 0, 0));
	put('other-mod', 'misc/Thing.def', def(32, 32, 32, 32, 0, 0));
	return root;
}

test('a path animation is the file at that path, whatever else shares its bare name', () => {
	const root = userDir();
	try {
		const map = pics.spriteOf('deathvalley/map/Flayer', [root]), battle = pics.spriteOf('deathvalley/battle/Flayer', [root]);
		assert.deepStrictEqual([map.fullW, map.fullH, map.left, map.top], [64, 64, 0, 0], 'the map def, 64x64 with margins 0');
		assert.deepStrictEqual([battle.fullW, battle.fullH], [450, 400], 'the battle def is its own picture (the cache does not key by bare name)');
		assert.deepStrictEqual(pics.origin(10, 10, map), [11 * 32 - 64, 11 * 32 - 64], 'the feet land on the anchor tile');
		// a different case and a trailing .def name the same file
		assert.strictEqual(pics.spriteOf('DeathValley\\Map\\FLAYER.def', [root]), map);
		// a path with no file at it still falls back to the bare name, as before
		const fb = pics.spriteOf('elsewhere/Thing', [root]);
		assert.ok(fb && fb.fullW === 32, 'the bare-name search answers for a path with no file of its own');
		// the switch
		const was = process.env.VMAPGEN_SPRITE_EXACT;
		process.env.VMAPGEN_SPRITE_EXACT = '0';
		try {
			const root2 = userDir();
			const old = pics.spriteOf('deathvalley/map/Flayer', [root2]);
			assert.ok(old, 'with the switch off a sprite is still found');
			fs.rmSync(root2, { recursive: true, force: true });
		} finally { if (was === undefined) delete process.env.VMAPGEN_SPRITE_EXACT; else process.env.VMAPGEN_SPRITE_EXACT = was; }
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a bare name is read as before', () => {
	const root = userDir();
	try {
		const s = pics.spriteOf('Thing', [root]);
		assert.ok(s && s.fullW === 32);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// the game's file system: the active mods in load order, the later mod wins, and in one mod the loose Content folder over its content.zip ([Content.zip, Content/], the later loader wins)
function stored(files) {   // a zip of stored (method 0) entries: { 'sprites/x.def': Buffer }
	const parts = [], cd = [];
	let off = 0;
	for (const [name, data] of Object.entries(files)) {
		const nb = Buffer.from(name), h = Buffer.alloc(30);
		h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nb.length, 26);
		parts.push(h, nb, data);
		const c = Buffer.alloc(46);
		c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(off, 42);
		cd.push(c, nb);
		off += 30 + nb.length + data.length;
	}
	const cdBuf = Buffer.concat(cd), e = Buffer.alloc(22);
	e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Object.keys(files).length, 8); e.writeUInt16LE(Object.keys(files).length, 10); e.writeUInt32LE(cdBuf.length, 12); e.writeUInt32LE(off, 16);
	return Buffer.concat([...parts, cdBuf, e]);
}

test('the later mod wins, a mod\'s loose file beats its own zip, and a path twelve folders deep is found', () => {
	const root = fs.mkdtempSync(path.join(testTmp(), 'sprites-order-'));
	try {
		const mod = (id, depends, files, zip) => {
			const dir = path.join(root, 'Mods', id);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify({ name: id, description: id, version: '1.0', modType: 'Content', depends }));
			for (const [rel, buf] of Object.entries(files)) { const f = path.join(dir, 'Content', 'Sprites', ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); }
			if (zip) fs.writeFileSync(path.join(dir, 'Content.zip'), stored(zip));
		};
		const deep = 'a/b/c/d/e/f/g/h/i/j/k/Deep';
		mod('early', [], { 'x/Thing.def': def(32, 32, 32, 32, 0, 0), [deep + '.def']: def(48, 48, 48, 48, 0, 0) });
		mod('late', ['early'], { 'x/Thing.def': def(64, 64, 64, 64, 0, 0) });
		mod('zipped', ['early'], { 'y/Both.def': def(40, 40, 40, 40, 0, 0) }, { 'sprites/y/both.def': def(80, 80, 80, 80, 0, 0), 'sprites/y/onlyzip.def': def(56, 56, 56, 56, 0, 0), 'sprites/y/onlyzip2.def': def(57, 57, 57, 57, 0, 0) });
		assert.strictEqual(pics.spriteOf('x/Thing', [root]).fullW, 64, 'the later mod\'s copy');
		assert.strictEqual(pics.spriteOf('y/Both', [root]).fullW, 40, 'the loose file of a mod over its zip');
		assert.strictEqual(pics.spriteOf('y/OnlyZip', [root]).fullW, 56, 'a file only in the zip');
		assert.strictEqual(pics.spriteOf(deep, [root]).fullW, 48, 'a path twelve folders deep');
		const was = process.env.VMAPGEN_SPRITE_ZIPS;
		process.env.VMAPGEN_SPRITE_ZIPS = '0';
		try { assert.strictEqual(pics.spriteOf('y/OnlyZip2', [root]), null, 'VMAPGEN_SPRITE_ZIPS=0 reads loose files only (a name not read before: the cache is per name)'); } finally { if (was === undefined) delete process.env.VMAPGEN_SPRITE_ZIPS; else process.env.VMAPGEN_SPRITE_ZIPS = was; }
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});
