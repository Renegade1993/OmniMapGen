/**
 * mod-templates.test.js - templates a mod ships are read like core ones.
 *
 * The MapGen tab offers every template the engine knows, and the engine reads
 * the ones a mod lists under "templates" in its mod.json (HotA's templates
 * submod ships 17, packed in content.zip). The generator used to read only
 * core's rmg folder and its own bundled copies, so choosing "[HotA] Kerberos"
 * failed with "template not found" (2026-09-25). A throwaway install with one
 * zipped and one loose mod template, and a manifest with comments the way
 * HotA's is written, pins that they are listed and load, and that a mod the
 * user has switched off stays out.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeZip } = require('../src/exporter/zipWriter');
const { testTmp } = require('./_vcmi');

const TEMPLATE = name => JSON.stringify({ [name]: {
	minSize: 's', maxSize: 'xh+u', players: '2',
	zones: {
		1: { type: 'playerStart', size: 1, owner: 1, playerTowns: { castles: 1 } },
		2: { type: 'playerStart', size: 1, owner: 2, playerTowns: { castles: 1 } },
	},
	connections: [{ a: '1', b: '2', guard: 1000 }],
} });

function makeInstall() {
	const root = fs.mkdtempSync(path.join(testTmp(), 'vmapgen-modtpl-'));
	const install = path.join(root, 'install');
	fs.mkdirSync(path.join(install, 'config', 'widgets', 'mapGen'), { recursive: true });
	const user = path.join(root, 'user');
	const mods = path.join(user, 'Mods');
	// zipped, manifest with a comment and a trailing comma (as HotA's is)
	fs.mkdirSync(path.join(mods, 'zipped'), { recursive: true });
	fs.writeFileSync(path.join(mods, 'zipped', 'mod.json'),
		'{\n\t"name" : "Zipped",\n\t"modType" : "Templates",\n\t"templates" : [\n'
		+ '\t\t"config/zipped.json",\n\t//\t"config/skipped.json",\n\t],\n}\n');
	fs.writeFileSync(path.join(mods, 'zipped', 'content.zip'),
		writeZip([{ name: 'config/zipped.json', data: TEMPLATE('[Test] Zipped') }]));
	// loose, under Content/
	fs.mkdirSync(path.join(mods, 'loose', 'Content', 'config'), { recursive: true });
	fs.writeFileSync(path.join(mods, 'loose', 'mod.json'),
		JSON.stringify({ name: 'Loose', modType: 'Templates', templates: ['config/loose.json'] }));
	fs.writeFileSync(path.join(mods, 'loose', 'Content', 'config', 'loose.json'), TEMPLATE('[Test] Loose'));
	// installed but switched off
	fs.mkdirSync(path.join(mods, 'off', 'Content', 'config'), { recursive: true });
	fs.writeFileSync(path.join(mods, 'off', 'mod.json'),
		JSON.stringify({ name: 'Off', modType: 'Templates', templates: ['config/off.json'] }));
	fs.writeFileSync(path.join(mods, 'off', 'Content', 'config', 'off.json'), TEMPLATE('[Test] Off'));
	fs.mkdirSync(path.join(user, 'config'), { recursive: true });
	fs.writeFileSync(path.join(user, 'config', 'modSettings.json'), JSON.stringify({
		activePreset: 'default', presets: { default: { mods: ['zipped', 'loose'], settings: {} } } }));
	return { install, user };
}

test('templates from active mods are listed and load, zipped or loose; a switched-off mod stays out', () => {
	const { install, user } = makeInstall();
	const saved = { root: process.env.VCMI_ROOT, user: process.env.VCMI_USER_DIR };
	process.env.VCMI_ROOT = install;
	process.env.VCMI_USER_DIR = user;
	const modPath = require.resolve('../src/rmg/template');
	delete require.cache[modPath];   // its template index is built once per process
	try {
		const { listTemplates, loadTemplate } = require('../src/rmg/template');
		const names = listTemplates();
		assert.ok(names.includes('[Test] Zipped'), 'zipped mod template listed');
		assert.ok(names.includes('[Test] Loose'), 'loose mod template listed');
		assert.ok(!names.includes('[Test] Off'), 'a switched-off mod contributes nothing');
		for (const name of ['[Test] Zipped', '[Test] Loose']) {
			const t = loadTemplate(name);
			assert.strictEqual(t.name, name);
			assert.deepStrictEqual(Object.keys(t.raw.zones), ['1', '2']);
		}
	} finally {
		delete require.cache[modPath];
		if (saved.root === undefined) delete process.env.VCMI_ROOT; else process.env.VCMI_ROOT = saved.root;
		if (saved.user === undefined) delete process.env.VCMI_USER_DIR; else process.env.VCMI_USER_DIR = saved.user;
	}
});

// The approved-templates list (K, 2026-10-02: "ONLY THOSE THAT HAVE BEEN APPROVED GO IN"): a module's
// approved-templates.json decides which templates are offered, mod-shipped ones included; an empty list offers none.
function withApproved(content, run) {
	const { install, user } = makeInstall();
	const file = path.join(install, 'approved-templates.json');
	if (content !== null) fs.writeFileSync(file, JSON.stringify(content));
	const saved = { root: process.env.VCMI_ROOT, user: process.env.VCMI_USER_DIR, ap: process.env.VMAPGEN_APPROVED_TEMPLATES };
	process.env.VCMI_ROOT = install;
	process.env.VCMI_USER_DIR = user;
	process.env.VMAPGEN_APPROVED_TEMPLATES = content === null ? 'off' : file;
	const modPath = require.resolve('../src/rmg/template');
	delete require.cache[modPath];
	try {
		run(require('../src/rmg/template'));
	} finally {
		delete require.cache[modPath];
		for (const [k, v] of [['VCMI_ROOT', saved.root], ['VCMI_USER_DIR', saved.user], ['VMAPGEN_APPROVED_TEMPLATES', saved.ap]])
			if (v === undefined) delete process.env[k]; else process.env[k] = v;
	}
}

test('approved templates: an empty list offers no template, and a template that is not found cannot be loaded', () => {
	withApproved({ approved: {} }, ({ listTemplates, loadTemplate }) => {
		assert.deepStrictEqual(listTemplates(), []);
		assert.throws(() => loadTemplate('[Test] Loose'));
	});
});

test('approved templates: a listed template appears (any case, with its date), an unlisted mod template stays hidden', () => {
	withApproved({ approved: { '[test] loose': '2026-10-02' } }, ({ listTemplates, loadTemplate }) => {
		assert.deepStrictEqual(listTemplates(), ['[Test] Loose']);
		assert.strictEqual(loadTemplate('[Test] Loose').name, '[Test] Loose');
		assert.throws(() => loadTemplate('[Test] Zipped'), 'an unlisted zipped mod template is hidden');
	});
});

test('approved templates: the list may be an array of {name, date}, and no list file offers every template', () => {
	withApproved({ approved: [{ name: '[Test] Zipped', date: '2026-10-02' }] }, ({ listTemplates }) => {
		assert.deepStrictEqual(listTemplates(), ['[Test] Zipped']);
	});
	withApproved(null, ({ listTemplates }) => {
		assert.ok(listTemplates().includes('[Test] Loose') && listTemplates().includes('[Test] Zipped'));
	});
});
