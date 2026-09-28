/**
 * make_mod.js - package OmniMapGen as a VCMI mod.
 *
 * The generator reaches players as a mod like any other: the launcher
 * downloads the zip, installs it into the user's Mods folder and enables it,
 * and a VCMI client with the map generator framework (DMB) shows the MapGen
 * tab for as long as the mod is enabled. The mod carries everything the tab
 * needs: its layout (the eight page files), its texts, and the generator with
 * the Node runtime it runs on. mod.json's "mapGenerator" names the program the
 * tab starts, relative to the mod's own folder. mod/ is the skeleton as the
 * repository keeps it (mod.json, the tab files, the templates, generate.cmd);
 * this adds the generator's src and the Node runtime.
 *
 *   node tools/make_mod.js [--install [<user folder>]] [--trust-unlisted] [--out dist] [--pager] [--classic] [--atbegin]
 *                          [--node-zip <node-vX-win-x64.zip> --node-sums <SHASUMS256.txt>]
 *
 * --pager builds the tab on DMB's "pages" widget (gen_vcmi_ui.js --pager)
 * and names DMB's addon API level 2 in mod.json ("dmb": { "api": 2 }), into
 * dist-pager unless --out says otherwise. No DMB release carries level 2 yet,
 * and the DMB releases before it cannot refuse the mod, so that build stays
 * off the catalog and out of anyone's DMB until one does.
 *
 * --atbegin (implies --pager; with --classic too) has the game make the map
 * when the host presses Begin, from the tab's settings and every player's
 * town, as stock's random map is made: mapGenerator "atBegin", DMB's addon API
 * level 3, the mode named "Omni Map Gen" (K's name), and no Generate button
 * (gen_vcmi_ui.js --atbegin). Into dist-atbegin or dist-classic-atbegin, off
 * the catalog until a DMB release carries level 3.
 *
 * The Node runtime is the official Windows build (NODE_VERSION), checked
 * against nodejs.org's SHASUMS256.txt before node.exe and its LICENSE are taken
 * out of the zip; a mismatch stops the build. Without --node-zip it comes from
 * <out>/node-cache, downloaded from nodejs.org the first time. Writes
 * <out>/omnimapgen/ (the mod folder) and <out>/omnimapgen.zip (the release
 * asset), and prints the zip's size and SHA-256 and the codeSha256 the mod
 * catalog pins.
 *
 * --install puts the built mod straight into a user folder's Mods and enables
 * it in the active preset of its config/modSettings.json, as the launcher does
 * for a mod it installs: a developer's build is ready at the next start. With
 * no folder named, DMB's own (Documents\My Games\Dead Man's Boots). DMB runs a mod's code
 * only when its catalog pins that code; a build of your own is pinned by no
 * catalog, and --trust-unlisted sets DMB's developer switch for that
 * (settings.json "mods": { "allowUnlistedCode": true }).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const MOD_ID = 'omnimapgen';
// the runtime DMB's contract names (official win-x64 build, checked by hash)
const NODE_VERSION = 'v24.21.0';

// The mod brings every text of the tab, the nine the client's framework also
// has (the lobby button, the template picker, the generate states) among them:
// a mod's translation replaces base's wording, so these say OmniMapGen's own
// things (the free layout's calibration) where the client says generic ones.

// --name value pairs; a flag followed by another flag (or by nothing) is true
function args(argv) {
	const o = {};
	for (let i = 0; i < argv.length; i++) {
		const name = argv[i].replace(/^--/, '');
		if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) o[name] = argv[++i];
		else o[name] = true;
	}
	return o;
}

// VCMI writes // comments into its JSON files: drop each // and the rest of
// its line, unless it stands inside a string
function stripComments(text) {
	return text.replace(/^((?:[^"\n/]|"(?:[^"\\\n]|\\.)*"|\/(?!\/))*)\/\/.*$/gm, '$1');
}

/** The Node runtime's zip and nodejs.org's SHASUMS256.txt, fetched once into <out>/node-cache. */
async function nodeRuntime(out) {
	const cache = path.join(out, 'node-cache');
	const zip = path.join(cache, `node-${NODE_VERSION}-win-x64.zip`);
	const sums = path.join(cache, `node-${NODE_VERSION}-SHASUMS256.txt`);
	fs.mkdirSync(cache, { recursive: true });
	for (const [file, url] of [[sums, `https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`],
		[zip, `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-win-x64.zip`]]) {
		if (fs.existsSync(file)) continue;
		console.log(`downloading ${url}`);
		const res = await fetch(url);
		if (!res.ok) throw new Error(`${url}: ${res.status}`);
		fs.writeFileSync(`${file}.part`, Buffer.from(await res.arrayBuffer()));
		fs.renameSync(`${file}.part`, file);
	}
	return { zip, sums };
}

/** DMB's user folder: Documents\My Games\Dead Man's Boots, Documents as Windows has it (it may be moved). */
function dmbUserDir() {
	const { spawnSync } = require('child_process');
	const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
		"[Environment]::GetFolderPath('MyDocuments')"], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
	const docs = (r.stdout || '').trim();
	if (r.status !== 0 || !docs) throw new Error('could not find the Documents folder: name the user folder, --install <folder>');
	return path.join(docs, 'My Games', "Dead Man's Boots");
}

/** Read, change and write back one of VCMI's JSON files (comments and all are rewritten plain). */
function editVcmiJson(file, change) {
	const data = fs.existsSync(file) ? JSON.parse(stripComments(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))) : {};
	if (change(data) !== false) fs.writeFileSync(file, JSON.stringify(data, null, '\t') + '\n');
}

/** The built mod into <userDir>\Mods, enabled in the active preset; the code switch on request. */
function install(folder, userDir, codeSha, trustUnlisted) {
	const target = path.join(userDir, 'Mods', MOD_ID);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.rmSync(target, { recursive: true, force: true });
	fs.cpSync(folder, target, { recursive: true });
	console.log(`installed ${target}`);
	const modSettings = path.join(userDir, 'config', 'modSettings.json');
	if (!fs.existsSync(modSettings)) {
		console.log(`  ${modSettings} does not exist yet: start the game once, then run this again (or enable ${MOD_ID} in the launcher)`);
	} else {
		editVcmiJson(modSettings, s => {
			const preset = s.presets && s.presets[s.activePreset];
			if (!preset) throw new Error(`${modSettings}: no active preset`);
			preset.mods = preset.mods || [];
			if (preset.mods.includes(MOD_ID)) { console.log(`  enabled already (preset ${s.activePreset})`); return false; }
			preset.mods.push(MOD_ID);
			console.log(`  enabled in preset ${s.activePreset}`);
		});
	}
	// will DMB run this build's code? Only if its catalog pins it, or with the developer switch
	const pinsFile = path.join(userDir, 'cache', 'downloads', 'dmbCodePins.json');
	let pinned = false;
	try {
		const pin = JSON.parse(fs.readFileSync(pinsFile, 'utf8'))[MOD_ID];
		pinned = [].concat(pin || []).some(p => String(p).toLowerCase() === codeSha);
	} catch (e) { /* no catalog downloaded yet */ }
	const settingsFile = path.join(userDir, 'config', 'settings.json');
	if (pinned) console.log('  DMB\'s mod catalog pins this code: it runs as installed');
	else if (trustUnlisted) {
		editVcmiJson(settingsFile, s => { s.mods = s.mods || {}; s.mods.allowUnlistedCode = true; });
		console.log(`  no catalog pins this build: DMB's developer switch set (${settingsFile}, mods.allowUnlistedCode)`);
	} else console.log('  no catalog pins this build\'s code, so DMB will refuse to run it: add --trust-unlisted to set '
		+ 'DMB\'s developer switch (settings.json "mods": { "allowUnlistedCode": true })');
	console.log('  start (or restart) the game to load it');
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

async function main() {
	const opt = args(process.argv.slice(2));
	if (!opt['node-zip'] !== !opt['node-sums'] || opt.out === true) {
		console.error('usage: node tools/make_mod.js [--install [<user folder>]] [--trust-unlisted] [--out dist] [--pager] [--classic] [--atbegin]\n'
			+ '                          [--node-zip <node-vX-win-x64.zip> --node-sums <SHASUMS256.txt>]');
		process.exit(1);
	}
	// --classic: the pages in stock Heroes III's Random Map Setup look (gen_vcmi_ui.js --classic)
	const classic = !!opt.classic;
	const atBegin = !!opt.atbegin;
	const pager = !!opt.pager || classic || atBegin;
	// dist, dist-pager, dist-classic, dist-atbegin, dist-classic-atbegin
	const out = path.resolve(opt.out || path.join(ROOT, (classic ? 'dist-classic' : pager && !atBegin ? 'dist-pager' : 'dist')
		+ (atBegin ? '-atbegin' : '')));
	// the pages widget's tab, staged beside the build (never over mod/Content)
	const pagerStage = path.join(out, 'pager-content');
	if (pager)
		require('child_process').execFileSync(process.execPath,
			[path.join(ROOT, 'tools', 'gen_vcmi_ui.js'), 'build', '--pager', ...(classic ? ['--classic'] : []),
				...(atBegin ? ['--atbegin'] : []), '--out', pagerStage],
			{ stdio: 'inherit', windowsHide: true });
	const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

	// the Node runtime, only as nodejs.org published it
	const runtime = opt['node-zip'] ? { zip: opt['node-zip'], sums: opt['node-sums'] } : await nodeRuntime(out);
	const nodeZip = fs.readFileSync(runtime.zip);
	// the name nodejs.org gives the zip, which SHASUMS256.txt lists
	const zipName = opt['node-zip'] ? path.basename(runtime.zip) : `node-${NODE_VERSION}-win-x64.zip`;
	const sums = fs.readFileSync(runtime.sums, 'utf8').split(/\r?\n/)
		.map(l => l.trim().split(/\s+/)).filter(p => p.length === 2 && p[1] === zipName);
	if (sums.length !== 1) throw new Error(`${zipName}: no single entry in ${runtime.sums}`);
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
	let modJson = fs.readFileSync(path.join(ROOT, 'mod', 'mod.json'));
	if (pager) modJson = Buffer.from(buildModJson(modJson.toString('utf8'), { pager, atBegin, classic }), 'utf8');
	const manifest = JSON.parse(modJson.toString('utf8'));
	if (manifest.version !== pkg.version)
		throw new Error(`mod/mod.json says ${manifest.version}, package.json ${pkg.version}: bump both together`);
	if (!manifest.mapGenerator || !manifest.mapGenerator.command)
		throw new Error('mod/mod.json declares no mapGenerator command');
	add('mod.json', modJson);

	// the mod skeleton as the repository keeps it (mod/: the tab's layout and
	// texts from tools/gen_vcmi_ui.js, the templates, generate.cmd), batch
	// files with the line endings cmd.exe reads
	const skeleton = path.join(ROOT, 'mod');
	// with --pager the tab's layout and texts come from the stage instead
	const staged = rel => pager && (rel.startsWith('Content/config/widgets/mapGen/')
		|| rel === 'Content/config/omnimapgen/english.json');
	for (const f of walk(skeleton).sort()) {
		const rel = path.relative(skeleton, f).split(path.sep).join('/');
		if (rel === 'mod.json' || staged(rel)) continue;
		const data = fs.readFileSync(f);
		add(rel, /\.cmd$/i.test(rel) ? data.toString('utf8').replace(/\r?\n/g, '\r\n') : data);
	}
	if (pager)
		for (const f of walk(pagerStage).sort())
			add(`Content/${path.relative(pagerStage, f).split(path.sep).join('/')}`, fs.readFileSync(f));
	const texts = Object.keys(JSON.parse(fs.readFileSync(path.join(skeleton, 'Content', 'config', 'omnimapgen', 'english.json'), 'utf8'))).length;

	// the generator and the runtime it runs on
	add('generator/node/node.exe', nodeExe);
	add('generator/node/LICENSE', nodeLicense);
	for (const f of walk(path.join(ROOT, 'src')).sort())
		add(`generator/src/${path.relative(path.join(ROOT, 'src'), f).split(path.sep).join('/')}`, fs.readFileSync(f));
	// generator/ holds exactly what runs, as DMB's mod packer lays it out
	// (generate.cmd, src, LICENSE, node): the client hashes that folder before
	// every run against the catalog's pin, so both packers must agree on it
	add('generator/LICENSE', fs.readFileSync(path.join(ROOT, 'LICENSE')));
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
	// the catalog's codeSha256, computed the way DMB's client checks it
	// (AddonCode::folderHash): a line "<hex>  <path>\n" for every file under
	// generator/, in the byte order of the paths, then the SHA-256 of the text.
	// In the order of the paths: sorting the whole lines orders them by hash
	// and gives a different value, which 0.2.0's notes first printed.
	const codeLines = files.filter(f => f.name.startsWith(`${MOD_ID}/generator/`))
		.map(f => ({ rel: f.name.slice(`${MOD_ID}/generator/`.length), hex: crypto.createHash('sha256').update(f.data).digest('hex') }))
		.sort((a, b) => Buffer.compare(Buffer.from(a.rel), Buffer.from(b.rel)))
		.map(f => `${f.hex}  ${f.rel}\n`);
	const codeSha = crypto.createHash('sha256').update(codeLines.join('')).digest('hex');
	console.log(`${MOD_ID} ${pkg.version}: ${files.length} files, ${texts} texts, Node ${nodeDir}`);
	console.log(`${folder}`);
	console.log(`${zipPath}: ${zip.length} bytes (${(zip.length / 1048576).toFixed(1)} MB), sha256 ${sha}`);
	console.log(`codeSha256 (generator/, ${codeLines.length} files): ${codeSha}`);
	if (opt.install) install(folder, opt.install === true ? dmbUserDir() : path.resolve(opt.install), codeSha, !!opt['trust-unlisted']);
}

/**
 * mod/mod.json as a build carries it, edited in the file's own text so the
 * rest of its layout stays as the repository keeps it: unchanged for the
 * released layout; with pages, DMB's addon API level named (2, or 3 at
 * Begin); at Begin, the generator run when the host presses Begin, under K's
 * name for the mode.
 */
function buildModJson(text, { pager, atBegin, classic = false }) {
	if (!pager) return text;
	if (!/\n\t"mapGenerator" :/.test(text)) throw new Error('mod/mod.json: no "mapGenerator" line to put "dmb" before');
	text = text.replace(/\n\t"mapGenerator" :/, `\n\t"dmb" : { "api" : ${atBegin ? 3 : 2} },\n\t"mapGenerator" :`);
	// the stock look draws with the VCMI Extras mod's lobby art: without it the
	// page loses its background, size row and checkboxes (DMB Dev, 2026-09-27),
	// so the launcher asks for Extras with it until K decides where that art
	// comes from
	if (classic) text = text.replace(/\n\t"dmb" :/, '\n\t"depends" : [ "vcmi-extras" ],\n\t"dmb" :');
	if (atBegin) {
		if (!/\n\t\t"name" : "[^"]*",/.test(text)) throw new Error('mod/mod.json: no mapGenerator "name" line');
		// "arguments": the options beyond the Generate set DMB may send at Begin;
		// the CLI refuses an option it does not know, so DMB sends --humanColors
		// (the seated humans' colours, K's B2) only to a generator that names it
		text = text.replace(/\n\t\t"name" : "[^"]*",/,
			'\n\t\t"name" : "Omni Map Gen",\n\t\t"atBegin" : true,\n\t\t"arguments" : [ "humanColors" ],');
	}
	return text;
}

module.exports = { buildModJson };

if (require.main === module) main().catch(e => { console.error(`make_mod: ${e.message}`); process.exit(1); });
