/**
 * picked-heroes.test.js - no prison holds a hero a human picked in the lobby (--heroes red=core:gird,tan=core:solmyr; DMB Dev and the
 * lead, 2026-10-14). On K's first try of seed 693382086 the guest's pick Solmyr stood in a prison (25,29) and the host's Gird in another
 * (24,90); the game drops a pick that a hero on the map already is, and the guest got a random hero.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { makePrisonHeroPool } = require('../src/biome/economy');
const { xorshift } = require('../src/wfc/solver');

test('the prison pool leaves out the picked heroes, and is otherwise the same pool in the same order', () => {
	const all = makePrisonHeroPool(6, xorshift(693382086));
	const picked = new Set([all[all.length - 1], all[3]].map(h => h.toLowerCase()));
	const kept = makePrisonHeroPool(6, xorshift(693382086), picked);
	assert.deepStrictEqual(kept, all.filter(h => !picked.has(h.toLowerCase())));
	assert.ok(!kept.some(h => picked.has(h.toLowerCase())));
});

test('the case of a picked hero does not matter', () => {
	const all = makePrisonHeroPool(2, xorshift(5));
	const kept = makePrisonHeroPool(2, xorshift(5), new Set([all[0].toUpperCase().toLowerCase()]));
	assert.strictEqual(kept.length, all.length - 1);
});

test('the command line knows --heroes and refuses a pair that is not colour=hero', () => {
	const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'main', 'generate-cli.js'), '--heroes', 'nocolour=core:solmyr', '--w', '36', '--h', '36'],
		{ encoding: 'utf8', timeout: 60000, windowsHide: true });
	const said = (r.stdout || '') + (r.stderr || '');
	assert.match(said, /--heroes: "nocolour=core:solmyr" is not colour=hero/);
	assert.doesNotMatch(said, /unknown option|not an option/i);
});
