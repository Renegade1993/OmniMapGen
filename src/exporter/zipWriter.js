/**
 * zipWriter.js - minimal ZIP writer (deflate) for .vmap archives.
 * No dependencies: local headers + central directory + EOCD, zlib deflate.
 */
'use strict';

const zlib = require('zlib');

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c;
	}
	return t;
})();

function crc32(buf) {
	let c = 0xFFFFFFFF;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
	return (c ^ 0xFFFFFFFF) >>> 0;
}

/**
 * entries: [{name: string, data: Buffer|string}]
 * Returns the archive Buffer.
 */
function writeZip(entries) {
	const chunks = [];
	const central = [];
	let offset = 0;

	for (const e of entries) {
		const name = Buffer.from(e.name, 'utf8');
		const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
		const comp = zlib.deflateRawSync(raw, { level: 9 });
		const crc = crc32(raw);

		const lh = Buffer.alloc(30);
		lh.writeUInt32LE(0x04034b50, 0);
		lh.writeUInt16LE(20, 4);          // version needed
		lh.writeUInt16LE(0, 6);           // flags
		lh.writeUInt16LE(8, 8);           // method: deflate
		lh.writeUInt16LE(0, 10);          // mod time
		lh.writeUInt16LE(0, 12);          // mod date
		lh.writeUInt32LE(crc, 14);
		lh.writeUInt32LE(comp.length, 18);
		lh.writeUInt32LE(raw.length, 22);
		lh.writeUInt16LE(name.length, 26);
		lh.writeUInt16LE(0, 28);          // extra len
		chunks.push(lh, name, comp);

		const ch = Buffer.alloc(46);
		ch.writeUInt32LE(0x02014b50, 0);
		ch.writeUInt16LE(20, 4);          // version made by
		ch.writeUInt16LE(20, 6);          // version needed
		ch.writeUInt16LE(0, 8);
		ch.writeUInt16LE(8, 10);
		ch.writeUInt16LE(0, 12);
		ch.writeUInt16LE(0, 14);
		ch.writeUInt32LE(crc, 16);
		ch.writeUInt32LE(comp.length, 20);
		ch.writeUInt32LE(raw.length, 24);
		ch.writeUInt16LE(name.length, 28);
		// extra/comment/disk/attrs
		ch.writeUInt32LE(offset, 42);
		central.push(Buffer.concat([ch, name]));

		offset += 30 + name.length + comp.length;
	}

	const cdOffset = offset;
	const cd = Buffer.concat(central);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(cd.length, 12);
	eocd.writeUInt32LE(cdOffset, 16);

	return Buffer.concat([...chunks, cd, eocd]);
}

module.exports = { writeZip };
