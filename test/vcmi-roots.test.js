/**
 * vcmi-roots.test.js - the generator never guesses where VCMI lives.
 *
 * locateVcmiRoots used to walk a fixed list of common install and Documents
 * folders whenever VCMI_ROOT was unset, and on the dev machine the first of
 * them was the owner's own, off-limits install (2026-09-25). These pin the
 * fix: with nothing named, nothing is found and no folder is even looked at;
 * a named folder comes back exactly as named; a named install without the
 * MapGen tab is refused and never swapped for another; the CLI stops when no
 * install is named; and no source file can carry an install path of its own.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { locateVcmiRoots, isMapGenInstall } = require('../src/parser/modCrawler');
const { testTmp } = require('./_vcmi');

// set or clear environment variables for the length of fn, then restore them
function withEnv(vars, fn) {
	const saved = {};
	for (const [k, v] of Object.entries(vars)) {
		saved[k] = process.env[k];
		if (v === undefined) delete process.env[k]; else process.env[k] = v;
	}
	try { return fn(); }
	finally {
		for (const [k, v] of Object.entries(saved))
			if (v === undefined) delete process.env[k]; else process.env[k] = v;
	}
}

function tmpInstall(withMapGen) {
	const dir = fs.mkdtempSync(path.join(testTmp(), 'vmapgen-roots-'));
	fs.mkdirSync(path.join(dir, 'config', 'widgets', withMapGen ? 'mapGen' : 'lobby'), { recursive: true });
	return dir;
}

test('nothing named: nothing found, and no folder is even looked at', () => {
	const looked = [];
	const { statSync, existsSync } = fs;
	fs.statSync = (p, ...rest) => { looked.push(String(p)); return statSync(p, ...rest); };
	fs.existsSync = p => { looked.push(String(p)); return existsSync(p); };
	try {
		const roots = withEnv({ VCMI_ROOT: undefined, VCMI_USER_DIR: undefined }, () => locateVcmiRoots());
		assert.deepStrictEqual(roots, { installDir: null, userDir: null });
	} finally {
		fs.statSync = statSync;
		fs.existsSync = existsSync;
	}
	assert.deepStrictEqual(looked, []);
});

test('a named install and user folder come back exactly as named', () => {
	const install = tmpInstall(true);
	const user = fs.mkdtempSync(path.join(testTmp(), 'vmapgen-user-'));
	assert.deepStrictEqual(
		withEnv({ VCMI_ROOT: install, VCMI_USER_DIR: user }, () => locateVcmiRoots()),
		{ installDir: install, userDir: user });
	// explicit arguments win over the environment
	const other = tmpInstall(true);
	assert.strictEqual(
		withEnv({ VCMI_ROOT: install }, () => locateVcmiRoots({ installDir: other })).installDir, other);
	assert.ok(isMapGenInstall(install));
});

test('an install whose mod schema has the map generator framework counts, without the tab configs', () => {
	// once the MapGen tab became a mod, the client keeps only the framework:
	// its mod schema knows "mapGenerator", and the tab's configs come with the mod
	const framework = fs.mkdtempSync(path.join(testTmp(), 'vmapgen-framework-'));
	fs.mkdirSync(path.join(framework, 'config', 'schemas'), { recursive: true });
	fs.writeFileSync(path.join(framework, 'config', 'schemas', 'mod.json'),
		JSON.stringify({ properties: { name: {}, mapGenerator: { type: 'object' } } }));
	assert.ok(isMapGenInstall(framework));
	const stock = fs.mkdtempSync(path.join(testTmp(), 'vmapgen-stockschema-'));
	fs.mkdirSync(path.join(stock, 'config', 'schemas'), { recursive: true });
	fs.writeFileSync(path.join(stock, 'config', 'schemas', 'mod.json'), JSON.stringify({ properties: { name: {} } }));
	assert.ok(!isMapGenInstall(stock));
	fs.rmSync(framework, { recursive: true, force: true });
	fs.rmSync(stock, { recursive: true, force: true });
});

test('a named install without the MapGen tab is refused, never swapped for another', () => {
	const stock = tmpInstall(false);
	assert.throws(() => withEnv({ VCMI_ROOT: stock, VCMI_USER_DIR: undefined }, () => locateVcmiRoots()),
		/MapGen tab/);
	assert.throws(() => locateVcmiRoots({ installDir: path.join(stock, 'missing') }), /not a folder/);
	assert.throws(() => withEnv({ VCMI_ROOT: undefined },
		() => locateVcmiRoots({ userDir: path.join(stock, 'missing') })), /not a folder/);
});

test('generate-cli stops when no install is named', () => {
	const { spawnSync } = require('child_process');
	const env = { ...process.env };
	delete env.VCMI_ROOT;
	delete env.VCMI_USER_DIR;
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'),
		'--w', '36', '--h', '36', '--out', path.join(testTmp(), 'vmapgen_roots_none.vmap')],
	{ encoding: 'utf8', timeout: 60000, cwd: path.join(__dirname, '..'), windowsHide: true, env });
	assert.notStrictEqual(r.status, 0);
	assert.match(r.stderr, /no VCMI install named/);
});

test('no source file names an install folder of its own', () => {
	// string literals in code only; comments may describe the history
	const root = path.join(__dirname, '..', 'src');
	const hits = [];
	const scan = file => {
		const code = fs.readFileSync(file, 'utf8')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/(^|[^:\\])\/\/.*$/gm, '$1');
		for (const m of code.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g))
			if (/^[A-Za-z]:[\\/]|My Games|Program Files|HoMM 3 Complete/i.test(m[2]))
				hits.push(`${path.relative(root, file)}: ${m[2]}`);
	};
	const walk = dir => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.name.endsWith('.js') && e.name !== 'bundle.js') scan(p);
		}
	};
	walk(root);
	assert.deepStrictEqual(hits, []);
});
