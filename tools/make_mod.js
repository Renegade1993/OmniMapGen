/**
 * make_mod.js - package OmniMapGen as a VCMI mod.
 *
 * The generator reaches players as a mod like any other: the launcher
 * downloads the zip, installs it into the user's Mods folder and enables it,
 * and a VCMI client with the map generator framework (DMB) shows the MapGen
 * tab for as long as the mod is enabled. The mod carries everything the tab
 * needs: its layout (the eight page files), its texts, and the generator with
 * the Node runtime it runs on. mod.json's "mapGenerator" names the program the
 * tab starts, relative to the mod's own folder; mod/mod.json is its only copy.
 *
 *   node tools/make_mod.js --node-zip <node-vX-win-x64.zip> --node-sums <SHASUMS256.txt> [--out dist]
 *
 * The Node runtime is the official Windows build, checked against nodejs.org's
 * SHASUMS256.txt before node.exe and its LICENSE are taken out of the zip; a
 * mismatch stops the build. Writes <out>/omnimapgen/ (the mod folder, for a
 * local install) and <out>/omnimapgen.zip (the release asset), and prints the
 * zip's size and SHA-256 for the mod catalog.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const MOD_ID = 'omnimapgen';

// The texts the client's map generator framework owns (the lobby button, the
// template picker, the generate states); the mod brings every other one.
const FRAMEWORK_KEYS = new Set([
	'vcmi.lobby.mapGen.hover', 'vcmi.lobby.mapGen.help',
	'vcmi.mapGen.generate.hover', 'vcmi.mapGen.generate.running', 'vcmi.mapGen.generate.failed',
	'vcmi.mapGen.generate.notConfigured',
	'vcmi.mapGen.template.none', 'vcmi.mapGen.template.hover', 'vcmi.mapGen.template.choose',
]);

function args(argv) {
	const o = {};
	for (let i = 0; i < argv.length; i += 2) o[argv[i].replace(/^--/, '')] = argv[i + 1];
	return o;
}

function walk(dir) {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
		e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

/** The entries of a zip (central directory), and a reader for one of them. */
function openZip(buf) {
	const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	if (eocd < 0) throw new Error('not a zip archive');
	const count = buf.readUInt16LE(eocd + 10);
	let off = buf.readUInt32LE(eocd + 16);
	const entries = new Map();
	for (let i = 0; i < count; i++) {
		const method = buf.readUInt16LE(off + 10);
		const csize = buf.readUInt32LE(off + 20);
		const nl = buf.readUInt16LE(off + 28), xl = buf.readUInt16LE(off + 30), cl = buf.readUInt16LE(off + 32);
		const lh = buf.readUInt32LE(off + 42);
		const name = buf.subarray(off + 46, off + 46 + nl).toString('utf8');
		entries.set(name, { method, csize, lh });
		off += 46 + nl + xl + cl;
	}
	const read = name => {
		const e = entries.get(name);
		if (!e) throw new Error(`${name} is not in the archive`);
		const ds = e.lh + 30 + buf.readUInt16LE(e.lh + 26) + buf.readUInt16LE(e.lh + 28);
		const data = buf.subarray(ds, ds + e.csize);
		if (e.method === 0) return Buffer.from(data);
		if (e.method === 8) return zlib.inflateRawSync(data);
		throw new Error(`${name}: compression method ${e.method} not supported`);
	};
	return { names: [...entries.keys()], read };
}

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

/** A deflate zip of [{name, data}], every entry stamped with `when` (a Date). */
function writeZip(entries, when) {
	const dosTime = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
	const dosDate = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
	const chunks = [], central = [];
	let offset = 0;
	for (const e of entries) {
		const name = Buffer.from(e.name, 'utf8');
		const raw = e.data;
		const comp = zlib.deflateRawSync(raw, { level: 9 });
		const crc = crc32(raw);
		const lh = Buffer.alloc(30);
		lh.writeUInt32LE(0x04034b50, 0);
		lh.writeUInt16LE(20, 4);
		lh.writeUInt16LE(0x0800, 6);          // names are UTF-8
		lh.writeUInt16LE(8, 8);
		lh.writeUInt16LE(dosTime, 10);
		lh.writeUInt16LE(dosDate, 12);
		lh.writeUInt32LE(crc, 14);
		lh.writeUInt32LE(comp.length, 18);
		lh.writeUInt32LE(raw.length, 22);
		lh.writeUInt16LE(name.length, 26);
		lh.writeUInt16LE(0, 28);
		chunks.push(lh, name, comp);
		const ch = Buffer.alloc(46);
		ch.writeUInt32LE(0x02014b50, 0);
		ch.writeUInt16LE(20, 4);
		ch.writeUInt16LE(20, 6);
		ch.writeUInt16LE(0x0800, 8);
		ch.writeUInt16LE(8, 10);
		ch.writeUInt16LE(dosTime, 12);
		ch.writeUInt16LE(dosDate, 14);
		ch.writeUInt32LE(crc, 16);
		ch.writeUInt32LE(comp.length, 20);
		ch.writeUInt32LE(raw.length, 24);
		ch.writeUInt16LE(name.length, 28);
		ch.writeUInt32LE(offset, 42);
		central.push(Buffer.concat([ch, name]));
		offset += 30 + name.length + comp.length;
	}
	const cd = Buffer.concat(central);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(cd.length, 12);
	eocd.writeUInt32LE(offset, 16);
	return Buffer.concat([...chunks, cd, eocd]);
}

function main() {
	const opt = args(process.argv.slice(2));
	if (!opt['node-zip'] || !opt['node-sums']) {
		console.error('usage: node tools/make_mod.js --node-zip <node-vX-win-x64.zip> --node-sums <SHASUMS256.txt> [--out dist]');
		process.exit(1);
	}
	const out = path.resolve(opt.out || path.join(ROOT, 'dist'));
	const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

	// the Node runtime, only as nodejs.org published it
	const nodeZip = fs.readFileSync(opt['node-zip']);
	const zipName = path.basename(opt['node-zip']);
	const sums = fs.readFileSync(opt['node-sums'], 'utf8').split(/\r?\n/)
		.map(l => l.trim().split(/\s+/)).filter(p => p.length === 2 && p[1] === zipName);
	if (sums.length !== 1) throw new Error(`${zipName}: no single entry in ${opt['node-sums']}`);
	const got = crypto.createHash('sha256').update(nodeZip).digest('hex');
	if (got !== sums[0][0]) throw new Error(`${zipName}: SHA-256 ${got} does not match SHASUMS256.txt's ${sums[0][0]}`);
	const nodeDir = zipName.replace(/\.zip$/i, '');
	const node = openZip(nodeZip);
	const nodeExe = node.read(`${nodeDir}/node.exe`);
	const nodeLicense = node.read(`${nodeDir}/LICENSE`);

	const files = [];
	const add = (name, data) => files.push({ name: `${MOD_ID}/${name}`, data: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8') });

	// mod/mod.json is the one copy: the mod catalog reads it from the
	// repository, and the release carries it unchanged
	const modJson = fs.readFileSync(path.join(ROOT, 'mod', 'mod.json'));
	const manifest = JSON.parse(modJson.toString('utf8'));
	if (manifest.version !== pkg.version)
		throw new Error(`mod/mod.json says ${manifest.version}, package.json ${pkg.version}: bump both together`);
	if (!manifest.mapGenerator || !manifest.mapGenerator.command)
		throw new Error('mod/mod.json declares no mapGenerator command');
	add('mod.json', modJson);

	// the tab: its layout and its texts
	const widgets = path.join(ROOT, 'ui', 'vcmi', 'config', 'widgets', 'mapGen');
	for (const f of fs.readdirSync(widgets).filter(f => f.endsWith('.json')).sort())
		add(`Content/config/widgets/mapGen/${f}`, fs.readFileSync(path.join(widgets, f)));
	const strings = JSON.parse(fs.readFileSync(path.join(ROOT, 'ui', 'vcmi', 'strings.json'), 'utf8'));
	const own = Object.fromEntries(Object.entries(strings).filter(([k]) => !FRAMEWORK_KEYS.has(k)));
	add('Content/config/omnimapgen/english.json', JSON.stringify(own, null, '\t') + '\n');

	// the generator and the runtime it runs on
	add('generator/generate.cmd', '@"%~dp0node\\node.exe" "%~dp0src\\main\\generate-cli.js" %*\r\n');
	add('generator/node/node.exe', nodeExe);
	add('generator/node/LICENSE', nodeLicense);
	for (const f of walk(path.join(ROOT, 'src')).sort())
		add(`generator/src/${path.relative(path.join(ROOT, 'src'), f).split(path.sep).join('/')}`, fs.readFileSync(f));
	add('generator/package.json', fs.readFileSync(path.join(ROOT, 'package.json')));
	add('LICENSE', fs.readFileSync(path.join(ROOT, 'LICENSE')));
	add('README.md', fs.readFileSync(path.join(ROOT, 'README.md')));

	// the mod folder, for a local install, and the release zip
	const folder = path.join(out, MOD_ID);
	fs.rmSync(folder, { recursive: true, force: true });
	for (const f of files) {
		const p = path.join(out, ...f.name.split('/'));
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, f.data);
	}
	const zip = writeZip(files, new Date());
	const zipPath = path.join(out, `${MOD_ID}.zip`);
	fs.writeFileSync(zipPath, zip);
	const sha = crypto.createHash('sha256').update(zip).digest('hex');
	console.log(`${MOD_ID} ${pkg.version}: ${files.length} files, ${Object.keys(own).length} texts, Node ${nodeDir}`);
	console.log(`${folder}`);
	console.log(`${zipPath}: ${zip.length} bytes (${(zip.length / 1048576).toFixed(1)} MB), sha256 ${sha}`);
}

main();
