/**
 * extra-starts.test.js - a template stretched past its player count gives each extra player a start zone of their own (K,
 * 2026-10-01: "it should not make players share biomes ... extra start zones yes"). Jebus Cross has four starts; at eight players
 * three players stood in each of two zones.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const { addStartZones } = require('../src/rmg/template');
const { readVmap } = require('../src/preview/render');

const jebus = () => ({
	players: '2-4', zones: {
		1: { type: 'playerStart', size: 30, owner: 1, playerTowns: { castles: 1 }, mines: { wood: 4 } },
		2: { type: 'playerStart', size: 30, owner: 2, minesLikeZone: 1 },
		3: { type: 'playerStart', size: 30, owner: 3, minesLikeZone: 1 },
		4: { type: 'playerStart', size: 30, owner: 4, minesLikeZone: 1 },
		5: { type: 'treasure', size: 40 },
	},
	connections: [1, 2, 3, 4].map(a => ({ a: String(a), b: '5', guard: 45000 })),
});

test('addStartZones clones a start for each missing player, linked as its source is', () => {
	const r = addStartZones(jebus(), { players: 6 });
	const ids = Object.keys(r.raw.zones).map(Number);
	assert.deepStrictEqual(ids.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
	assert.strictEqual(r.raw.zones['6'].owner, 5);
	assert.strictEqual(r.raw.zones['7'].owner, 6);
	assert.strictEqual(r.raw.zones['6'].size, 30);
	assert.strictEqual(r.raw.zones['6'].playerTowns.castles, 1);
	assert.strictEqual(r.raw.zones['7'].minesLikeZone, 1);
	const to5 = r.raw.connections.filter(c => c.b === '5').map(c => c.a);
	assert.ok(to5.includes('6') && to5.includes('7'), 'each clone joins the centre');
	assert.strictEqual(r.raw.connections.find(c => c.a === '6').guard, 45000);
	assert.ok(r.notes.length === 1);
});

test('addStartZones leaves a template alone when its starts cover the players', () => {
	const raw = jebus();
	assert.strictEqual(addStartZones(raw, { players: 4 }).raw, raw);
	assert.strictEqual(addStartZones(raw, { players: 2 }).raw, raw);
});

test('eight players on Jebus Cross: every player\'s town in a zone of their own', { timeout: 280000 }, () => {
	const out = path.join(testTmp(), 'vmapgen_extra_starts.vmap');
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--out', out, '--declaremods', '0',
		'--template', 'Jebus Cross', '--w', '144', '--h', '144', '--players', '8', '--seed', '1',
		'--factions', 'random,random,random,random,random,random,random,random', '--accommodate', 'size,players,humans,underground'],
	{ encoding: 'utf8', timeout: 270000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	assert.match(r.stderr, /4 start zone\(s\) added/);
	const side = JSON.parse(fs.readFileSync(out + '.zones.json', 'utf8'));
	const { objects } = readVmap(out);
	fs.rmSync(out, { force: true });
	fs.rmSync(out + '.zones.json', { force: true });
	const W = 144, zoneOf = {};
	for (const o of (Array.isArray(objects) ? objects : Object.values(objects))) {
		const owner = o && /^(town|randomTown)$/.test(o.type) && o.options && o.options.owner;
		if (!owner) continue;
		const z = side.levels[o.l || 0].zone[o.y * W + o.x];
		assert.ok(!(z in zoneOf), `${owner} and ${zoneOf[z]} share zone ${z}`);
		zoneOf[z] = owner;
	}
	assert.strictEqual(Object.keys(zoneOf).length, 8);
});
