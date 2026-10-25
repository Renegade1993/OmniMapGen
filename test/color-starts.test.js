'use strict';
// Which colour starts where (K, 2026-10-18: "We should always randomize per-color start positions"): src/rmg/colorStarts.js and the CLI that uses it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { colorsToStarts, seatHumansOnPlayerStarts } = require('../src/rmg/colorStarts');
const { genEnv, testTmp } = require('./_vcmi');

const COLORS = ['red', 'blue', 'tan', 'green', 'orange', 'purple', 'teal', 'pink'];

test('same seed gives the same assignment, and it is a permutation of the colours', () => {
	for (const n of [2, 3, 4, 8]) {
		const colors = COLORS.slice(0, n);
		const a = colorsToStarts(colors, null, undefined, '7');
		assert.deepStrictEqual(a, colorsToStarts(colors, null, undefined, '7'));
		assert.deepStrictEqual(a.slice().sort(), colors.slice().sort());
	}
});

test('different seeds give different assignments, and every colour starts in every start over a sample', () => {
	const colors = COLORS.slice(0, 4);
	const seen = colors.map(() => new Set());
	const orders = new Set();
	for (let seed = 1; seed <= 200; seed++) {
		const a = colorsToStarts(colors, null, undefined, String(seed));
		orders.add(a.join());
		a.forEach((c, k) => seen[k].add(c));
	}
	assert.ok(orders.size >= 20, `${orders.size} different orders of 24 over 200 seeds`);
	for (const s of seen) assert.strictEqual(s.size, 4, 'a start was never taken by some colour');
});

test('the observer keeps its place and the others shuffle around it', () => {
	const colors = COLORS.slice(0, 5);
	const first = new Set();
	for (let seed = 1; seed <= 60; seed++) {
		const a = colorsToStarts(colors, 'red', undefined, String(seed));
		assert.strictEqual(a[0], 'red');
		assert.deepStrictEqual(a.slice().sort(), colors.slice().sort());
		first.add(a[1]);
	}
	assert.ok(first.size > 1);
});

test('teams keep the starts they shared; teams of one size trade their sets', () => {
	const colors = COLORS.slice(0, 4);
	const teams = [['red', 'tan'], ['blue', 'green']];   // the CLI's Teams lever at 2: colours dealt in turn, starts 0,2 and 1,3
	const sets = new Set();
	for (let seed = 1; seed <= 100; seed++) {
		const a = colorsToStarts(colors, null, teams, String(seed));
		const slotsOf = t => t.map(c => a.indexOf(c)).sort((x, y) => x - y).join();
		const r = slotsOf(teams[0]), b = slotsOf(teams[1]);
		assert.ok((r === '0,2' && b === '1,3') || (r === '1,3' && b === '0,2'), `${a} splits a team's starts`);
		sets.add(r);
	}
	assert.strictEqual(sets.size, 2, 'the two teams never traded their starts');
});

test('a colour in no team is a team of one; teams of different sizes do not mix their starts', () => {
	const colors = COLORS.slice(0, 5);
	const teams = [['red', 'blue', 'tan']];   // green and orange are on their own
	for (let seed = 1; seed <= 100; seed++) {
		const a = colorsToStarts(colors, null, teams, String(seed));
		assert.deepStrictEqual(['red', 'blue', 'tan'].map(c => a.indexOf(c)).sort(), [0, 1, 2]);
		assert.deepStrictEqual(['green', 'orange'].map(c => a.indexOf(c)).sort(), [3, 4]);
	}
});

test('a single contestant, or none, is left as it is', () => {
	assert.deepStrictEqual(colorsToStarts(['red'], null, undefined, '1'), ['red']);
	assert.deepStrictEqual(colorsToStarts(['red', 'blue'], 'blue', undefined, '1'), ['red', 'blue']);
});

function run(extra) {
	const out = path.join(testTmp(), `vmapgen_colors_${extra.join('_').replace(/[^a-z0-9]+/gi, '')}.vmap`);
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--out', out, '--declaremods', '0',
		'--w', '36', '--h', '36', '--players', '4', '--factions', 'random,random,random,random', ...extra],
	{ encoding: 'utf8', timeout: 120000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, (r.stderr || '').slice(-600));
	const m = /start colours \(start 1 first\): ([a-z, ]+)/.exec(r.stdout);
	assert.ok(m, 'no start colours line in the log');
	const sidecar = JSON.parse(fs.readFileSync(out + '.zones.json', 'utf8'));
	assert.ok(sidecar.rolled.some(x => x === 'start colours ' + m[1]), 'the sidecar does not record the start colours');
	return { colors: m[1].split(', '), out };
}

test('the generator seats the colours as logged: the town on start 1 (the top left corner) belongs to the first colour', { timeout: 290000 }, () => {
	const sight = require('../tools/mapsight/lib/sight');
	const lists = new Set();
	for (const seed of ['1', '2', '3']) {
		const { colors, out } = run(['--seed', seed]);
		lists.add(colors.join());
		const M = sight.load(out);
		const towns = M.objs.filter(o => o.options && o.options.owner && /own/i.test(o.type));
		const topLeft = towns.find(o => o.x === 4 && o.y === 4);
		assert.ok(topLeft, 'no player town in the top left corner');
		assert.strictEqual(topLeft.options.owner, colors[0]);
		assert.strictEqual(towns.length, 4);
	}
	assert.ok(lists.size >= 2, 'three seeds gave one assignment');
});

test('a template map seats the colours by its start zones', { timeout: 290000 }, () => {
	const sight = require('../tools/mapsight/lib/sight');
	const tpl = ['--template', "Coldshadow's Fantasy", '--accommodate', 'size,players,humans,underground'];
	const a = run(['--seed', '1', ...tpl]), b = run(['--seed', '2', ...tpl]);
	assert.notDeepStrictEqual(a.colors, b.colors);
	const owners = o => new Set(sight.load(o).objs.filter(x => x.options && x.options.owner && /own/i.test(x.type)).map(x => x.options.owner));
	assert.deepStrictEqual([...owners(a.out)].sort(), COLORS.slice(0, 4).sort());
});

// Coldshadow's Fantasy names owners 1 and 5 playerStart and the other six cpuStart; the Reviewer's point 1 (2026-10-18): a person must never be seated in a computer's zone
const TYPES = ['playerStart', 'cpuStart', 'cpuStart', 'cpuStart', 'playerStart', 'cpuStart', 'cpuStart', 'cpuStart'];
function seated(colors, humans, teams, seed, observerIndex) {
	const order = colorsToStarts(colors, observerIndex >= 0 ? colors[observerIndex] : null, teams, seed);
	const players = order.map(c => ({ color: c, canPlay: humans.includes(c) ? 'PlayerOrAI' : 'AIOnly', factions: ['core:' + c], chosenFaction: undefined, townPos: { x: order.indexOf(c) } }));
	seatHumansOnPlayerStarts(players, i => TYPES[i], teams, observerIndex);
	return players;
}

test('a lone human, or two, always stands in a playerStart zone when the template has one free', () => {
	const colors = COLORS.slice(0, 8);
	for (let seed = 1; seed <= 100; seed++) {
		for (const humans of [['blue'], ['tan', 'orange']]) {
			const players = seated(colors, humans, undefined, String(seed), -1);
			players.forEach((p, i) => { if (humans.includes(p.color)) assert.strictEqual(TYPES[i], 'playerStart', `seed ${seed}: ${p.color} is in start ${i}`); });
			assert.deepStrictEqual(players.map(p => p.color).sort(), colors.slice().sort());
			players.forEach((p, i) => assert.strictEqual(p.townPos.x, i, 'a start kept its place'));
			players.forEach(p => assert.deepStrictEqual(p.factions, ['core:' + p.color], 'a colour kept its own pick'));
		}
	}
});

test('humans past the playerStart zones overflow onto computer zones, and with no seats nothing is traded', () => {
	const colors = COLORS.slice(0, 8);
	const three = seated(colors, ['red', 'blue', 'tan'], undefined, '4', -1);
	assert.strictEqual(three.filter((p, i) => p.canPlay !== 'AIOnly' && TYPES[i] === 'playerStart').length, 2);
	const noSeats = colors.map((c, i) => ({ color: c, townPos: { x: i } }));
	assert.deepStrictEqual(seatHumansOnPlayerStarts(noSeats, i => TYPES[i], undefined, -1), []);
});

test('a human is traded only inside its team', () => {
	const colors = COLORS.slice(0, 4);
	const types = ['playerStart', 'cpuStart', 'playerStart', 'cpuStart'];
	const teams = [['red', 'tan'], ['blue', 'green']];
	for (let seed = 1; seed <= 100; seed++) {
		const order = colorsToStarts(colors, null, teams, String(seed));
		const players = order.map((c, i) => ({ color: c, canPlay: c === 'blue' ? 'PlayerOrAI' : 'AIOnly', townPos: { x: i } }));
		const before = players.map(p => p.color);
		seatHumansOnPlayerStarts(players, i => types[i], teams, -1);
		const slotsOf = t => t.map(c => players.findIndex(p => p.color === c)).sort().join();
		assert.strictEqual(slotsOf(teams[0]), [before.indexOf('red'), before.indexOf('tan')].sort().join(), 'a team lost a start');
	}
});
