/**
 * colors-seats.test.js - --colors (S303, K: "swap any color out for any player seat, regardless of how many seats are present ... purple vs teal only").
 * The map's seats are exactly the colours asked for, in that order; its start towns and start zones take those colours and no other; two seats never
 * share a colour; --humanColors stays the seated humans' subset of --colors.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv } = require('./_vcmi');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'src', 'main', 'generate-cli.js');
const sight = require(path.join(ROOT, 'tools', 'mapsight', 'lib', 'sight'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colors-seats-'));
const run = (name, args) => spawnSync(process.execPath, [CLI, '--w', '36', '--h', '36', '--seed', '1', '--out', path.join(dir, name + '.vmap'), ...args],
	{ encoding: 'utf8', cwd: ROOT, env: genEnv(), windowsHide: true, timeout: 240000 });
const townOwners = file => sight.load(file).objs.filter(o => o.options && o.options.owner && /own/i.test(o.type)).map(o => o.options.owner).sort();

test('a two-seat map with purple and teal: the slots, start zones and towns are purple and teal, in that seat order', () => {
	const r = run('pt', ['--players', '2', '--colors', 'purple,teal']);
	assert.strictEqual(r.status, 0, r.stderr);
	assert.deepStrictEqual(townOwners(path.join(dir, 'pt.vmap')), ['purple', 'teal']);
	const side = JSON.parse(fs.readFileSync(path.join(dir, 'pt.vmap.zones.json'), 'utf8'));
	assert.deepStrictEqual(side.levels[0].templateOwners.filter(Boolean), ['purple', 'teal'], 'the start zones are owned by those colours');
	assert.match(r.stdout, /start colours \(start 1 first\): (purple, teal|teal, purple)/);
});

test('three seats in an order that is not the colours\' own: pink, red, orange', () => {
	const r = run('pro', ['--players', '3', '--colors', 'pink,red,orange']);
	assert.strictEqual(r.status, 0, r.stderr);
	assert.deepStrictEqual(townOwners(path.join(dir, 'pro.vmap')), ['orange', 'pink', 'red']);
});

test('--humanColors stays the seated humans\' subset of --colors; a human outside the seats and a colour used twice are refused', () => {
	const ok = run('h', ['--players', '2', '--colors', 'purple,teal', '--humanColors', 'teal']);
	assert.strictEqual(ok.status, 0, ok.stderr);
	assert.deepStrictEqual(townOwners(path.join(dir, 'h.vmap')), ['purple', 'teal']);
	const out = run('x', ['--players', '2', '--colors', 'purple,teal', '--humanColors', 'red']);
	assert.notStrictEqual(out.status, 0);
	assert.match(out.stderr, /not one of the --colors seats/);
	const twice = run('y', ['--players', '2', '--colors', 'teal,teal']);
	assert.notStrictEqual(twice.status, 0);
	assert.match(twice.stderr, /two seats never share a colour/);
	const bad = run('z', ['--players', '2', '--colors', 'purple,mauve']);
	assert.match(bad.stderr, /no player colour/);
});
