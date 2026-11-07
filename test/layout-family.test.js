'use strict';
/**
 * Layout family (biomes.js familyConnections, knob layoutFamily): on a free layout Tree links its biomes by a spanning tree and Sparse mesh by
 * the tree and a few loops, over the cut's borders, so ensureConnected opens nothing; Mixed is the old draw. With Biome connections at 0,
 * Tree has one link fewer than biomes and Sparse mesh at least one more than Tree; at the default Biome connections (0.6) Tree opens a quarter
 * of 0.6 of its other borders on top, and Mixed is the old draw. 48x48, four players, one level, seeds 1 and 2. Opus Map Vision 2026-10-20 (roster\DESIGN-MapVision-LayoutFamily.md).
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { testTmp, genEnv } = require('./_vcmi');
const { spawnSync } = require('child_process');
const sight = require('../tools/mapsight/lib/sight');

const gen = (seed, family, conn) => {
	const out = path.join(fs.mkdtempSync(path.join(testTmp(), 'lf-')), 'm.vmap');
	const args = [path.join(__dirname, '../src/main/generate-cli.js'), '--w', '48', '--h', '48', '--players', '4', '--seed', String(seed),
		'--underground', '0', '--bio.layoutFamily', String(family), '--out', out];
	if (conn !== undefined) args.push('--bio.interconnectivity', String(conn));
	const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 300000, windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, (r.stderr || '').slice(-600));
	const M = sight.load(out);
	const zones = new Set();
	for (let y = 0; y < M.H; y++) for (let x = 0; x < M.W; x++) { const z = M.zoneAt(0, x, y); if (z !== undefined && z !== null && z >= 0) zones.add(z); }
	const m = /Layout family [^:]+: (\d+) link\(s\) over (\d+) border/.exec(r.stderr || '');
	const forced = /level 0: opened (\d+) extra biome border/.exec(r.stderr || '');
	fs.rmSync(path.dirname(out), { recursive: true, force: true });
	return { links: m ? +m[1] : null, borders: m ? +m[2] : null, zones: zones.size, forced: forced ? +forced[1] : 0, stderr: r.stderr };
};

for (const seed of [1, 2]) {
	test(`48x48 four players seed ${seed}: Tree is a spanning tree and Sparse mesh adds loops, with Biome connections 0`, { timeout: 900000 }, () => {
		const t = gen(seed, 1, 0), s = gen(seed, 2, 0);
		assert.ok(t.links !== null && s.links !== null, 'the generator logs the family');
		assert.strictEqual(t.forced, 0, 'Tree leaves ensureConnected nothing to open');
		assert.strictEqual(s.forced, 0, 'Sparse mesh leaves ensureConnected nothing to open');
		assert.strictEqual(t.links, t.zones - 1, `Tree: ${t.links} links over ${t.zones} biomes`);
		assert.ok(s.links > t.links, `Sparse mesh ${s.links} links, Tree ${t.links}`);
	});
	test(`48x48 four players seed ${seed}: at the default Biome connections (0.6) Tree opens a quarter of 0.6 of the other borders on top, and Mixed is the old draw`, { timeout: 900000 }, () => {
		const t = gen(seed, 1), mixed = gen(seed, 0);
		assert.ok(!/Layout family/.test(mixed.stderr), 'Mixed logs no family: the old draw');
		assert.strictEqual(t.forced, 0, 'Tree leaves ensureConnected nothing to open');
		const want = (t.zones - 1) + Math.round(0.6 * 0.25 * (t.borders - (t.zones - 1)));
		assert.strictEqual(t.links, want, `Tree ${t.links} links over ${t.zones} biomes and ${t.borders} borders`);
	});
}

// on a template map the template's links stand: the generator says the family is ignored and makes the same map, and the lobby greys the
// control with its reason (knobs.js ignoredOnTemplate; the lead, 2026-10-20)
test("Coldshadow's Fantasy 36x36 two players: Layout family is ignored by the template, said in the log, the same map, and greyed in the lobby", { timeout: 900000 }, () => {
	const { readVmap } = require('../src/preview/render');
	const run = family => {
		const out = path.join(fs.mkdtempSync(path.join(testTmp(), 'lft-')), 'm.vmap');
		const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--template', "Coldshadow's Fantasy", '--w', '36', '--h', '36',
			'--players', '2', '--seed', '3', '--bio.layoutFamily', String(family), '--out', out], { encoding: 'utf8', timeout: 300000, windowsHide: true, env: genEnv() });
		assert.strictEqual(r.status, 0, (r.stderr || '').slice(-600));
		const objects = JSON.stringify(readVmap(out).objects);
		fs.rmSync(path.dirname(out), { recursive: true, force: true });
		return { objects, stderr: r.stderr };
	};
	const tree = run(1), mixed = run(0);
	assert.ok(/Layout family is ignored by this template/.test(tree.stderr), 'the log says the family is ignored');
	assert.ok(!/Layout family is ignored/.test(mixed.stderr), 'nothing said at Mixed');
	assert.strictEqual(tree.objects, mixed.objects, 'the same map');
	const knob = require('../src/biome/knobs').KNOBS.find(k => k.key === 'layoutFamily');
	assert.ok(knob && typeof knob.ignoredOnTemplate === 'string' && knob.ignoredOnTemplate.length > 0, 'the lobby has the reason to show');
});

// Hub and Pairs (step 2): a link between two zones that share no border is a portal pair handed back to plan.js, and ensureConnected
// counts it as joined, so it opens no border behind it
test('Hub on a made-up cut: starts that do not touch the hub get portal pairs, walk out over land, and ensureConnected opens nothing', () => {
	const { familyConnections, ensureConnected } = require('../src/biome/biomes');
	const rng = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(7);
	// 2026-11-07 (the suite's debt; broken by 760c0c7 on 0.3.27): the start-exit pass turns a portal link between biomes joined by a walk under SHORTCUT tiles, at least
	// 24, into a land link (K, 2026-11-02, the game he and Meg abandoned: a monolith pair that only moves a hero round where he can already walk). On the cut of 10 by 10
	// every walk is shorter than that, so no pair survived. The made-up cut is ten times as wide (100 by 100), where a portal is a shortcut again.
	const seeds = [{ x: 0, y: 0, player: 1 }, { x: 100, y: 0, player: 2 }, { x: 50, y: 50 }, { x: 50, y: 0 }];
	const edge = (a, b, n) => ({ a, b, borderCells: new Array(n).fill(0) });
	const edges = [edge(0, 3, 6), edge(1, 3, 5), edge(2, 3, 9)];
	const p = { interconnectivity: 0, interconnectPortal: 0 }, pairs = [];
	const out = familyConnections(3, edges, 4, p, rng, { seeds, W: 100, H: 100, pairs });
	assert.deepStrictEqual(pairs, [[0, 2], [1, 2]], 'both starts linked to the hub (zone 2, nearest the middle) by portal pairs');
	assert.ok(/^open/.test(out.get(3)) && /^open/.test(out.get(1 * 100000 + 3)), 'each start walks out over land');
	assert.strictEqual(ensureConnected(edges, new Map(out), 4, p, rng, pairs), 0, 'the pairs count as joined');
	// since 760c0c7 every start also has a land road to the middle (the hub's biome 2 by way of biome 3), so without the pairs ensureConnected needs no border either; the
	// pairs are the shortcut a portal is meant to be (the walk is far over the SHORTCUT length)
	assert.strictEqual(out.get(200003), 'openRoad', 'the start-exit pass opened the hub\'s border with biome 3 as a road');
	assert.strictEqual(ensureConnected(edges, new Map(out), 4, p, rng, []), 0, 'the land road already joins the hub, with or without the pairs');
});

test('Pairs on a made-up cut: the nearest starts paired, a pair with no shared border a portal pair, no other two starts meet', () => {
	const { familyConnections } = require('../src/biome/biomes');
	const rng = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(3);
	// ten times the cut it was (the start-exit pass keeps a portal pair only where the walk is at least SHORTCUT tiles; see the Hub test above)
	const seeds = [{ x: 0, y: 0, player: 1 }, { x: 10, y: 0, player: 2 }, { x: 100, y: 100, player: 3 }, { x: 110, y: 100, player: 4 }, { x: 50, y: 50 }];
	const edge = (a, b, n) => ({ a, b, borderCells: new Array(n).fill(0) });
	const edges = [edge(0, 4, 5), edge(1, 4, 5), edge(2, 4, 5), edge(3, 4, 5), edge(0, 2, 40)];
	const pairs = [];
	const out = familyConnections(4, edges, 5, { interconnectivity: 1, interconnectPortal: 0 }, rng, { seeds, W: 120, H: 120, pairs });
	assert.deepStrictEqual(pairs, [[0, 1], [2, 3]]);
	assert.strictEqual(out.get(2), 'blocked', 'the widest border, between starts of two pairs, stays shut even at Biome connections 1');
	for (const s of [0, 1, 2, 3]) assert.ok(/^open/.test(out.get(s * 100000 + 4)), `start ${s} walks out to zone 4`);
});

// the generator end to end: the trace's borders and the layout links give the zone graph
const traced = (seed, family, players = 4, size = 48) => {
	const out = path.join(fs.mkdtempSync(path.join(testTmp(), 'lfh-')), 'm.vmap');
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--w', String(size), '--h', String(size), '--players', String(players),
		'--seed', String(seed), '--underground', '0', '--bio.layoutFamily', String(family), '--out', out],
		{ encoding: 'utf8', timeout: 300000, windowsHide: true, env: { ...genEnv(), VMAPGEN_OPENINGS_TRACE: '1' } });
	assert.strictEqual(r.status, 0, (r.stderr || '').slice(-600));
	fs.rmSync(path.dirname(out), { recursive: true, force: true });
	const seeds = [], links = [];
	for (const m of r.stderr.matchAll(/\[zones\] 0: zone (\d+) seed \((\d+),(\d+)\)( player)?/g)) seeds[+m[1]] = { x: +m[2], y: +m[3], player: !!m[4] };
	for (const m of r.stderr.matchAll(/\[zones\] 0: border (\d+)-(\d+) \d+ cells: (\w+)/g)) if (m[3] !== 'blocked') links.push([+m[1], +m[2]]);
	for (const m of r.stderr.matchAll(/level 0: layout link (\d+)-(\d+) has no shared border/g)) links.push([+m[1], +m[2]]);
	return { seeds, links, stderr: r.stderr, size, forced: /level 0: opened \d+ extra biome/.test(r.stderr), gave: /level 0: gave \d+ start zone/.test(r.stderr) };
};
const linked = (links, a, b) => links.some(([u, v]) => (u === a && v === b) || (u === b && v === a));
for (const seed of [1, 2]) {
	test(`48x48 four players seed ${seed}: Hub links every start to the biome nearest the middle and no two starts to each other`, { timeout: 900000 }, () => {
		const t = traced(seed, 3);
		const starts = t.seeds.map((s, i) => (s && s.player ? i : -1)).filter(i => i >= 0);
		const d = i => (t.seeds[i].x - t.size / 2) ** 2 + (t.seeds[i].y - t.size / 2) ** 2;
		const hub = t.seeds.map((s, i) => i).filter(i => t.seeds[i] && !t.seeds[i].player).sort((a, b) => d(a) - d(b))[0];
		assert.ok(starts.length === 4 && hub !== undefined, t.stderr.slice(-400));
		for (const s of starts) assert.ok(linked(t.links, s, hub), `start ${s} linked to the hub ${hub}`);
		assert.ok(!t.forced, 'ensureConnected opens nothing');
		assert.ok(!t.gave, 'every start walks out over land without plan.js opening one');
		for (const a of starts) for (const b of starts) if (a < b) assert.ok(!linked(t.links, a, b), `starts ${a} and ${b} meet directly`);
	});
	test(`48x48 four players seed ${seed}: Pairs links the starts two by two, nearest first, and no others to each other`, { timeout: 900000 }, () => {
		const t = traced(seed, 4);
		const starts = t.seeds.map((s, i) => (s && s.player ? i : -1)).filter(i => i >= 0);
		const d = (a, b) => (t.seeds[a].x - t.seeds[b].x) ** 2 + (t.seeds[a].y - t.seeds[b].y) ** 2;
		const cand = [];
		for (const a of starts) for (const b of starts) if (a < b) cand.push([a, b, d(a, b)]);
		cand.sort((u, v) => u[2] - v[2] || u[0] - v[0] || u[1] - v[1]);
		const paired = new Set(), want = [];
		for (const [a, b] of cand) if (!paired.has(a) && !paired.has(b)) { paired.add(a); paired.add(b); want.push([a, b]); }
		for (const [a, b] of want) assert.ok(linked(t.links, a, b), `pair ${a}-${b} linked`);
		for (const [a, b] of cand) if (!want.some(([u, v]) => u === a && v === b)) assert.ok(!linked(t.links, a, b), `starts ${a} and ${b} of two pairs meet`);
		assert.ok(!t.forced && !t.gave, 'nothing opened behind the family');
	});
}

// Ring and Chain (step 3) over a made-up cut of nine square biomes, the middle one inner: the eight on the rim in a circle, the middle
// hanging off it by one link; Chain the same circle less one link, neither of whose biomes is a start
test('Ring and Chain on a made-up cut: the rim biomes in a circle, Chain one link short and not at a start, the inner biome hung by one link', () => {
	const { familyConnections, biomeEdges } = require('../src/biome/biomes');
	const zone = new Int32Array(81);
	for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) zone[y * 9 + x] = 3 * Math.floor(y / 3) + Math.floor(x / 3);
	const edges = biomeEdges(zone, 9, 9, 9);
	const seeds = Array.from({ length: 9 }, (_, i) => ({ x: 3 * (i % 3) + 1, y: 3 * Math.floor(i / 3) + 1, player: i === 0 || i === 8 ? 1 : 0 }));
	const rim = [0, 1, 2, 5, 8, 7, 6, 3];
	const open = (out, a, b) => /^open/.test(out.get(Math.min(a, b) * 100000 + Math.max(a, b)) || '');
	for (const family of [5, 6]) for (const s of [1, 2, 3]) {
		const rng = (v => () => (v = (v * 16807) % 2147483647) / 2147483647)(s);
		const pairs = [];
		const out = familyConnections(family, edges, 9, { interconnectivity: 0, interconnectPortal: 0 }, rng, { seeds, W: 9, H: 9, zone, pairs });
		const ring = rim.map((z, k) => open(out, z, rim[(k + 1) % 8]));
		const missing = ring.map((o, k) => (o ? -1 : k)).filter(k => k >= 0);
		assert.deepStrictEqual(pairs, []);
		assert.strictEqual(missing.length, family === 5 ? 0 : 1, `family ${family} seed ${s}: rim links ${ring}`);
		if (family === 6) for (const z of [rim[missing[0]], rim[(missing[0] + 1) % 8]]) assert.ok(!seeds[z].player, `Chain left out a link at start ${z}`);
		// 2026-11-07 (the suite's debt; 760c0c7): the start-exit pass gives every start a land road to the middle (K, 2026-11-02: "it seems like there is only one way in and
		// out of each start"), so the Ring's inner biome still hangs by one link, and the Chain, whose gap cuts a start from the hanging link, may take one more road in for
		// that start: at most one link a start, and every start reaches the inner biome by land without passing the other start's biome.
		const into = [0, 1, 2, 3, 5, 6, 7, 8].filter(z => open(out, z, 4));
		assert.ok(family === 5 ? into.length === 1 : into.length >= 1 && into.length <= 2, `family ${family} seed ${s}: the inner biome has ${into.length} links`);
		const land = (a, b) => open(out, a, b);
		for (const st of [0, 8]) {
			const other = st === 0 ? 8 : 0, seen = new Set([st]), q = [st];
			for (let h = 0; h < q.length; h++) for (let z = 0; z < 9; z++) if (z !== other && !seen.has(z) && land(q[h], z)) { seen.add(z); q.push(z); }
			assert.ok(seen.has(4), `family ${family} seed ${s}: start ${st} reaches the inner biome by land`);
		}
	}
});

for (const family of [5, 6])
	test(`48x48 four players seed 1: ${family === 5 ? 'Ring links every rim biome to the next round the edge' : 'Chain leaves out exactly one of the ring links'}`, { timeout: 900000 }, () => {
		const t = traced(1, family);
		const out = path.join(fs.mkdtempSync(path.join(testTmp(), 'lfr-')), 'm.vmap');
		const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--w', '48', '--h', '48', '--players', '4', '--seed', '1',
			'--underground', '0', '--bio.layoutFamily', String(family), '--out', out], { encoding: 'utf8', timeout: 300000, windowsHide: true, env: genEnv() });
		assert.strictEqual(r.status, 0);
		const M = sight.load(out);
		fs.rmSync(path.dirname(out), { recursive: true, force: true });
		const rim = [], seen = new Set();
		const at = (x, y) => { const z = M.zoneAt(0, x, y); if (z !== undefined && z !== null && z >= 0 && !seen.has(z)) { seen.add(z); rim.push(z); } };
		for (let x = 0; x < 48; x++) at(x, 0); for (let y = 1; y < 48; y++) at(47, y); for (let x = 46; x >= 0; x--) at(x, 47); for (let y = 46; y >= 1; y--) at(0, y);
		const missing = rim.filter((z, k) => !linked(t.links, z, rim[(k + 1) % rim.length])).length;
		assert.ok(rim.length >= 3, `rim ${rim}`);
		assert.strictEqual(missing, family === 5 ? 0 : 1, `rim ${rim}, links ${JSON.stringify(t.links)}`);
		assert.ok(!t.forced && !t.gave, 'nothing opened behind the family');
	});

test('Random is one of the six families, drawn from the seed: the same map as the family it names', { timeout: 900000 }, () => {
	const names = ['Mixed', 'Tree', 'Sparse mesh', 'Hub', 'Pairs', 'Ring', 'Chain'], seen = new Set();
	for (const seed of [1, 2, 3]) {
		const r = gen(seed, 7);
		const m = /Layout family ([A-Za-z ]+) \(Random\)/.exec(r.stderr || '');
		assert.ok(m && names.indexOf(m[1]) >= 1, `seed ${seed}: the log names the family`);
		seen.add(m[1]);
		const run = family => {
			const out = path.join(fs.mkdtempSync(path.join(testTmp(), 'lfq-')), 'm.vmap');
			const q = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--w', '48', '--h', '48', '--players', '4', '--seed', String(seed),
				'--underground', '0', '--bio.layoutFamily', String(family), '--out', out], { encoding: 'utf8', timeout: 300000, windowsHide: true, env: genEnv() });
			assert.strictEqual(q.status, 0);
			const objects = JSON.stringify(require('../src/preview/render').readVmap(out).objects);
			fs.rmSync(path.dirname(out), { recursive: true, force: true });
			return objects;
		};
		assert.strictEqual(run(7), run(names.indexOf(m[1])), `seed ${seed}: Random's map is ${m[1]}'s`);
	}
	assert.ok(seen.size > 1, 'three seeds name more than one family');
});
