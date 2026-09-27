/**
 * mod-activation.test.js - which mods a preset turns on, as the engine decides.
 *
 * ModsPresetState::getActiveMods takes the preset's root mods and each submod
 * whose own flag (settings[root]["a.b"], flat) is true. A submod the preset
 * does not list is on unless its mod.json says keepDisabled
 * (ModManager::addNewModsToPreset); a "Compatibility" submod is tried even
 * when switched off; and a submod depends on its parent and top parent
 * (ModDescription.cpp:58-63), so a switched-off parent takes its children with
 * it. Our predicate used to take the first flag whose key prefixed the
 * submod's path and to treat every unlisted submod as on (2026-09-26, checked
 * against a real mod preset).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadActivationState, resolveLoadOrder, crawlMods } = require('../src/parser/modCrawler');
const { testTmp } = require('./_vcmi');

test('a preset turns mods on the way the engine does', () => {
	const user = fs.mkdtempSync(path.join(testTmp(), 'vmapgen-preset-'));
	fs.mkdirSync(path.join(user, 'config'));
	fs.writeFileSync(path.join(user, 'config', 'modSettings.json'), JSON.stringify({
		activeMods: null, activePreset: 'mine',
		presets: { mine: { mods: ['big', 'town'], settings: {
			big: { balance: true, 'balance.objects': false, 'balance.objects.rmgban': true,
				'balance.skills': true, music: false, patch: false },
		} } },
	}));
	const isActive = loadActivationState(user);
	const mods = new Map([
		['big'], ['town'], ['other'],
		['big.balance'], ['big.balance.objects'], ['big.balance.objects.rmgban'], ['big.balance.skills'],
		['big.music'],
		// not in the preset: on by default, unless keepDisabled
		['big.extras'], ['big.legacy', { keepDisabled: true }],
		// switched off, but a compatibility patch: tried anyway, and loaded only
		// when what it patches is there
		['big.patch', { modType: 'Compatibility', depends: ['town'] }],
		['town.wog', { modType: 'Compatibility', keepDisabled: true, depends: ['wake-of-gods'] }],
	].map(([id, extra]) => [id, { __id: id, name: id, ...extra }]));
	const on = new Set(resolveLoadOrder(mods, isActive).map(m => m.__id));
	const want = ['big', 'town', 'big.balance', 'big.balance.skills', 'big.extras', 'big.patch'];
	assert.deepStrictEqual([...on].sort(), want.sort());
	// the parent chain: its own flag says yes, its parent says no
	assert.strictEqual(isActive('big.balance.objects.rmgban', mods.get('big.balance.objects.rmgban')), true);
	assert.ok(!on.has('big.balance.objects.rmgban'), 'a switched-off parent takes its children');
	assert.ok(!on.has('big.legacy'), 'keepDisabled and unlisted: off');
	assert.ok(!on.has('town.wog'), 'a compatibility patch for a mod that is not there');
	fs.rmSync(user, { recursive: true, force: true });
});

test('submods nested at any depth are crawled, and each loads after its parent and top parent', () => {
	// VCMI walks MODS/<id>/MODS/... to any depth (ModsState::ModsState); HotA
	// keeps its RMG ban list at hota/mods/gameBalance/mods/objects/mods/rmgBan,
	// which a one-level crawl never saw (2026-09-26). A submod depends on its
	// parent and top parent (ModDescription.cpp:58-63), for ordering too: here
	// the leaf's own dependency sorts first, and without those edges it would
	// load before the mods it patches.
	const install = fs.mkdtempSync(path.join(testTmp(), 'vmapgen-nested-'));
	const put = (rel, manifest) => {
		fs.mkdirSync(path.join(install, 'Mods', ...rel), { recursive: true });
		fs.writeFileSync(path.join(install, 'Mods', ...rel, 'mod.json'), JSON.stringify(manifest));
	};
	put(['big'], { name: 'Big', depends: ['zzz'] });
	put(['big', 'mods', 'balance'], { name: 'Balance' });
	put(['big', 'mods', 'balance', 'mods', 'objects'], { name: 'Objects' });
	put(['big', 'mods', 'balance', 'mods', 'objects', 'mods', 'rmgBan'], { name: 'Ban', depends: ['aaa'] });
	put(['aaa'], { name: 'A' });
	put(['zzz'], { name: 'Z' });
	const mods = crawlMods({ installDir: install, userDir: null });
	for (const id of ['big', 'big.balance', 'big.balance.objects', 'big.balance.objects.rmgban'])
		assert.ok(mods.has(id), id);
	assert.strictEqual(mods.get('big.balance.objects.rmgban').__parent, 'big.balance.objects');
	const order = resolveLoadOrder(mods, null).map(m => m.__id);
	const at = id => order.indexOf(id);
	assert.ok(at('big.balance.objects.rmgban') > at('big.balance.objects'), 'after its parent');
	assert.ok(at('big.balance.objects.rmgban') > at('big'), 'after its top parent');
	assert.ok(at('big.balance.objects') > at('big.balance') && at('big.balance') > at('big'));
	fs.rmSync(install, { recursive: true, force: true });
});
