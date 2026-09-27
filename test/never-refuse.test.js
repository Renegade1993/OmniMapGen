/**
 * never-refuse.test.js - K's rule (2026-09-27): "IT SHOULD ALWAYS ACCOMMODATE
 * THE PLAYER'S WISHES....IF THE PLAYER GETS SOMETHING WEIRD AND THE
 * PARAMETERS ALL BEHAVED REASONABLY, THAT'S ON THEM." A template runs at any
 * size, level count and player count (K had "template Jebus Cross cannot run:
 * map size 36x36x1 outside template range L..XL" on screen); --strict 1 keeps
 * the old refusal for tools that want it. And the map leaves each player's
 * faction to the lobby unless a pick was passed (--factions), where K found
 * it "PREDETERMINED".
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const { readVmap } = require('../src/preview/render');

const CLI = path.join(__dirname, '../src/main/generate-cli.js');
const run = (out, ...args) => spawnSync(process.execPath, [CLI, ...args, '--seed', '27', '--out', out],
	{ encoding: 'utf8', timeout: 200000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });

test('Jebus Cross at 36x36 with 2 players: made, every accommodation logged', { timeout: 240000 }, () => {
	const out = path.join(testTmp(), 'never-refuse-jebus36.vmap');
	const r = run(out, '--template', 'Jebus Cross', '--w', '36', '--h', '36', '--players', '2');
	assert.strictEqual(r.status, 0, r.stderr.slice(-800));
	assert.match(r.stderr, /template accommodation: map size 36x36x1 outside template range/);
	const { header, objects } = readVmap(out);
	const colors = Object.keys(header.players);
	assert.deepStrictEqual(colors, ['red', 'blue']);
	for (const c of colors)
		assert.strictEqual(objects.filter(o => o.type === 'randomTown' && o.options && o.options.owner === c).length, 1,
			`${c} has its start town`);
});

test('--strict 1 keeps the refusal for tools that want a template inside its ranges', { timeout: 240000 }, () => {
	const out = path.join(testTmp(), 'never-refuse-strict.vmap');
	const r = run(out, '--template', 'Jebus Cross', '--w', '36', '--h', '36', '--players', '2', '--strict', '1');
	assert.notStrictEqual(r.status, 0);
	assert.match(r.stderr, /cannot run/);
});

test('factions: open to the lobby without a pick, pinned with one', { timeout: 480000 }, () => {
	const open = path.join(testTmp(), 'never-refuse-open.vmap');
	let r = run(open, '--w', '36', '--h', '36', '--players', '2');
	assert.strictEqual(r.status, 0, r.stderr.slice(-800));
	for (const [c, p] of Object.entries(readVmap(open).header.players))
		assert.ok(p.allowedFactions.anyOf.length > 1, `${c} may pick in the lobby (${p.allowedFactions.anyOf.length} faction(s))`);
	const picked = path.join(testTmp(), 'never-refuse-picked.vmap');
	r = run(picked, '--w', '36', '--h', '36', '--players', '2', '--factions', 'rampart,random');
	assert.strictEqual(r.status, 0, r.stderr.slice(-800));
	const players = readVmap(picked).header.players;
	assert.deepStrictEqual(players.red.allowedFactions.anyOf, ['core:rampart'], 'a pick is pinned');
	assert.strictEqual(players.blue.allowedFactions.anyOf.length, 1, 'Random is rolled and pinned, as the engine does at Begin');
});
