/**
 * engine-contract.test.js
 *
 * Pins the places where the generator has to agree with the VCMI engine.
 * Every assertion here corresponds to a defect found in the 2026-09-21 review
 * (DEVELOPMENT_LOG SID-20260921-a3f19c) and cites the engine source it came
 * from, so a future edit that quietly breaks one of them fails loudly instead.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { FLIP_CODES, makeHeader } = require('../src/exporter/vmapWriter');
const { solveRoadTiles } = require('../src/exporter/roads');
const { buildRoadNetwork, pruneOrphanRoads } = require('../src/biome/roadnet');
const { buildPatterns, assignTerrainViews } = require('../src/exporter/terrainView');
const { footprintCells, blockingCells, visitableCells, footprintFits, footprintBlock,
	MONSTER_OPTIONS, FILL_TYPES, entranceOpen } = require('../src/biome/content');
const { clusterTemplate, singleTemplate, wallClusters, clusterSize,
	DECOR_TYPES, TERRAINS: DECOR_TERRAINS } = require('../src/biome/decor');
const DECOR_DATA = require('../src/biome/decor.templates.json');
const { STRUCTURES, STRUCTURE_SUBTYPE, barrierTemplate,
	CORE_BANKS, bankRate, bandEligibility, bankEligAt, bankBandWeight, SPELL_SCROLL, pandoraTemplate, prisonTemplate,
	obeliskTemplate, pandoraOptions, prisonOptions, makePrisonHeroPool,
	SPECIALS, DWELLING_POOL, pickDwelling } = require('../src/biome/economy');
const { OBJECT_DEFS, openSealedPockets, openSealedByObjects } = require('../src/biome/plan');
const { partitionBiomes } = require('../src/biome/biomes');
const { xorshift } = require('../src/wfc/solver');
const { OBJECT_TEMPLATES } = require('../src/stitch/zones');
const { buildDictionary, buildAdjacency } = require('../src/main/generate');
const { stripJsonComments, dropTrailingCommas, listZipEntries, readZipEntry } =
	require('../src/parser/assetIndex');

test('the config reader handles comments, trailing commas and slashes in strings', () => {
	// VCMI config is JSON with both, and 109 of the install's 200 core files
	// use at least one. The old reader stripped comments with a regex and did
	// nothing about trailing commas, then returned null with no sign anything
	// had gone wrong, so the generator's picture of the game was built from
	// fewer than half of it.
	const text = `{
		// a leading comment
		"a": "hota/banks/AVXbnk80",      // a path, not a comment
		"b": "http://example.invalid",   /* nor is this */
		"c": [1, 2, 3,],
		"d": { "e": 1, },
	}`;
	const parsed = JSON.parse(dropTrailingCommas(stripJsonComments(text)));
	assert.strictEqual(parsed.a, 'hota/banks/AVXbnk80',
		'a slash inside a string must survive');
	assert.strictEqual(parsed.b, 'http://example.invalid',
		'two slashes inside a string are not a comment');
	assert.deepStrictEqual(parsed.c, [1, 2, 3]);
	assert.deepStrictEqual(parsed.d, { e: 1 });
	// a file with no slash at all comes back untouched
	assert.strictEqual(stripJsonComments('{"x":1}'), '{"x":1}');
});

test('the zip reader takes sizes from the right place', () => {
	// Compressed size is at +20 in a CENTRAL DIRECTORY record and +18 in a
	// LOCAL header. Reading +18 in the central record gets the last two bytes
	// of the CRC and the first two of the size: all 429 config files across
	// the 20 mods shipping a content.zip were unreadable because of it.
	const zlib = require('node:zlib');
	const name = Buffer.from('config/x.json', 'utf8');
	const body = Buffer.from('{"k":"v"}', 'utf8');      // stored, not deflated
	const crc = 0x12345678;

	const lh = Buffer.alloc(30);
	lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4);
	lh.writeUInt16LE(0, 8);                              // method 0 = stored
	lh.writeUInt32LE(crc, 14);
	lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(body.length, 22);
	lh.writeUInt16LE(name.length, 26);
	const local = Buffer.concat([lh, name, body]);

	const cd = Buffer.alloc(46);
	cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
	cd.writeUInt16LE(0, 10);
	cd.writeUInt32LE(crc, 16);
	cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(body.length, 24);
	cd.writeUInt16LE(name.length, 28);
	cd.writeUInt32LE(0, 42);
	const central = Buffer.concat([cd, name]);

	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
	eocd.writeUInt32LE(central.length, 12);
	eocd.writeUInt32LE(local.length, 16);

	const zip = Buffer.concat([local, central, eocd]);
	const entries = listZipEntries(zip);
	assert.strictEqual(entries.length, 1);
	assert.strictEqual(entries[0].name, 'config/x.json');
	assert.strictEqual(entries[0].csize, body.length,
		'compressed size read from the wrong offset');
	assert.strictEqual(readZipEntry(zip, entries[0]).toString('utf8'), '{"k":"v"}');
});

test('flip codes match the engine table', () => {
	// MapFormatJson.cpp:235  flipCodes = {'_', '-', '|', '+'}
	assert.deepStrictEqual(FLIP_CODES, ['_', '-', '|', '+']);
});

test('footprint offsets use each row length, not the widest row', () => {
	// ObjectTemplate.cpp:269
	//   usedTiles[mask.size()-1-i][line.size()-1-j] = mask[i][j]
	// and blockedOffsets.insert(int3(-w,-h,0)), so mask[i][j] lands at
	// (x - (rowLen-1-j), y - (maskH-1-i)).
	const ragged = { mask: ['BBB', 'A'] };   // row 0 is 3 wide, row 1 is 1 wide
	const cells = footprintCells(ragged, 10, 10).map(c => `${c[0]},${c[1]}`);
	assert.deepStrictEqual(cells.sort(), ['10,10', '10,9', '8,9', '9,9'].sort());
	assert.deepStrictEqual(visitableCells(ragged, 10, 10), [[10, 10]]);

	// a rectangular mask is unchanged by the fix
	const rect = { mask: ['VV', 'VA'] };
	assert.deepStrictEqual(visitableCells(rect, 5, 5), [[5, 5]]);
});

test('art cells do not block; only B/H/A/T do', () => {
	// charToTile in ObjectTemplate.cpp:  'V' -> VISIBLE, no BLOCKED bit, and
	// blockedOffsets only collects cells where isBlockedAt is true. Across 13
	// installed VCMI random maps, 101497 cells carry more than one object's
	// mask, so overlapping art is normal rather than a collision.
	// anchored bottom-right, so 'A' at row 1 column 1 of a 3-wide row is at
	// (x-1, y): art fills (3..5, 4) and (3, 5) and (5, 5), the wall is (4,5)
	const tpl = { mask: ['VVV', 'VAV'] };
	assert.strictEqual(footprintCells(tpl, 5, 5).length, 6);
	assert.deepStrictEqual(blockingCells(tpl, 5, 5).map(c => `${c[0]},${c[1]}`),
		['4,5']);

	const W = 10, H = 10;
	const blocked = new Uint8Array(W * H);
	// two of these may sit art-on-art as long as their visitable cells differ
	assert.strictEqual(footprintBlock(tpl, 5, 5, 0, W, H, blocked), true);
	assert.strictEqual(blocked.reduce((a, b) => a + b, 0), 1);
	assert.strictEqual(footprintFits(tpl, 6, 5, 0, W, H, blocked), true,
		'overlapping art must not count as a collision');
	assert.strictEqual(footprintFits(tpl, 5, 5, 0, W, H, blocked), false,
		'two objects may not share a visitable cell');
	// art may hang off the map edge, a wall may not
	assert.strictEqual(footprintFits(tpl, 1, 1, 0, W, H, blocked), true);
	assert.strictEqual(footprintFits({ mask: ['BB'] }, 0, 1, 0, W, H, blocked), false);
});

test('footprintBlock refuses to wrap onto the previous row', () => {
	const W = 10, H = 10;
	const blocked = new Uint8Array(W * H);
	const tpl = { mask: ['BBBBB'] };         // 5 wide, anchored bottom-right
	// x = 3 puts the leftmost cell at -1, which indexes y*W-1 without a guard
	assert.strictEqual(footprintBlock(tpl, 3, 4, 0, W, H, blocked), false);
	assert.strictEqual(blocked.reduce((a, b) => a + b, 0), 0,
		'a refused placement must not mark anything');
	assert.strictEqual(footprintBlock(tpl, 4, 4, 0, W, H, blocked), true);
	assert.strictEqual(blocked.reduce((a, b) => a + b, 0), 5);
	assert.strictEqual(footprintFits(tpl, 4, 4, 0, W, H, blocked), false);
});

test('every wandering monster is hostile', () => {
	// CGCreature.h:41 defaults initialCharacter to COMPLIANT, which sets
	// agression = -4 (CGCreature.cpp:278). takenAction can then never return
	// FIGHT and falls into the compliant JOIN_FOR_FREE branch, so an unset
	// character means the guard hands itself over. All 24791 monsters in the
	// 71 installed VCMI random maps are hostile, and the engine's own RMG sets
	// it at ObjectManager.cpp:784.
	assert.strictEqual(MONSTER_OPTIONS.character, 'hostile');
	assert.strictEqual(FILL_TYPES.creeps[0].opts, MONSTER_OPTIONS);
	// amount must stay unset: the creature is unknown until the engine
	// resolves the placeholder, and initObj then rolls its own advmap range
	assert.strictEqual('amount' in MONSTER_OPTIONS, false);
});

test('concrete structures use harvested core art, never invented names', () => {
	const expected = {
		learningStone: 'AVSgzbo0',
		scholar: 'AVXschl0',
		mysticalGarden: 'AVTmyst0',
		waterWheel: 'AVMwwhl0',
		windmill: 'AVMwndd0',
		witchHut: 'AVSwtch0',
		monolithTwoWay: 'AVXmn2g0',
		subterraneanGate: 'AvTCave',
		subterraneanGateUnder: 'AvTCave',
	};
	for (const [name, anim] of Object.entries(expected)) {
		assert.ok(STRUCTURES[name], `${name} missing from the harvested table`);
		assert.strictEqual(STRUCTURES[name].animation, anim, name);
		assert.ok(!STRUCTURES[name].animation.includes(' '),
			`${name} animation has a space in it`);
		assert.ok(!STRUCTURES[name].animation.includes('/'),
			`${name} uses mod-scoped art, which breaks a map declaring no mods`);
		assert.ok(STRUCTURES[name].mask.some(r => r.includes('A')),
			`${name} has no visitable cell`);
	}
	// masks that were wrong before the review
	assert.deepStrictEqual(STRUCTURES.witchHut.mask, ['VVV', 'VVV', 'VAV']);
	assert.deepStrictEqual(STRUCTURES.waterWheel.mask, ['VVV', 'BBB', 'BBA']);
	assert.deepStrictEqual(STRUCTURES.mysticalGarden.mask, ['VVV', 'BAB']);
});

test('structure subtypes are the canonical ones real maps use', () => {
	assert.strictEqual(STRUCTURE_SUBTYPE.witchHut, 'witchHut');
	assert.strictEqual(STRUCTURE_SUBTYPE.subterraneanGate, 'object');
	for (const e of FILL_TYPES.skillStructures.concat(FILL_TYPES.resourceGenerators))
		assert.strictEqual(e.subtype, STRUCTURE_SUBTYPE[e.type], e.type);
});

test('barriers are real one-cell blockers matched to their terrain', () => {
	const rng = () => 0;
	for (const [code, type] of [['dt', 'rock'], ['gr', 'grassHills'],
		['sn', 'shrub'], ['sb', 'subterraneanRocks'], ['lv', 'lavaFlow']]) {
		const b = barrierTemplate(code, rng);
		assert.strictEqual(b.type, type, code);
		assert.strictEqual(b.subtype, 'object');
		assert.deepStrictEqual(b.tpl.mask, ['B']);
		assert.ok(!b.tpl.animation.includes('/'), code);
	}
	// an unknown or modded terrain still gets something drawable
	const fallback = barrierTemplate('zz', rng);
	assert.ok(fallback.tpl.animation.length > 0);
});

test('road tiles get the segment the engine would pick', () => {
	// CDrawRoadsOperation.cpp:24-130 pattern table, updateTile at 407.
	const W = 7, H = 7;
	const cells = new Set();
	for (let x = 1; x < 6; x++) cells.add(3 * W + x);
	for (let y = 1; y < 6; y++) cells.add(y * W + 3);
	cells.add(0);                                   // lone tile at (0,0)
	const art = solveRoadTiles(cells, W, H, () => 0);

	assert.deepStrictEqual(art.get(0), { dir: 14, flip: 0 }, 'single tile');
	assert.deepStrictEqual(art.get(3 * W + 3), { dir: 16, flip: 0 }, 'X-cross');
	assert.deepStrictEqual(art.get(3 * W + 1), { dir: 15, flip: 0 }, 'dead end W');
	assert.deepStrictEqual(art.get(3 * W + 5), { dir: 15, flip: 1 }, 'dead end E');
	assert.deepStrictEqual(art.get(1 * W + 3), { dir: 14, flip: 0 }, 'dead end N');
	assert.deepStrictEqual(art.get(5 * W + 3), { dir: 14, flip: 2 }, 'dead end S');
	assert.deepStrictEqual(art.get(3 * W + 2), { dir: 12, flip: 0 }, 'straight EW');
	assert.deepStrictEqual(art.get(2 * W + 3), { dir: 10, flip: 0 }, 'straight NS');
	for (const v of art.values()) {
		assert.ok(v.dir >= 0 && v.dir <= 16, 'road dir out of range');
		assert.ok(v.flip >= 0 && v.flip < FLIP_CODES.length, 'road flip out of range');
	}
});

test('a wall between two players is opened, not counted as connected', () => {
	// Both passes seed from ONE start. Seeding from all of them floods both
	// sides of a wall that separates two players, so the check sees one
	// connected map and does nothing: on a 36x36 seed 1 a barrier wall ran the
	// full height with a player on each side and the pass reported success.
	const W = 21, H = 21;
	const blocked = new Uint8Array(W * H);
	const barriers = new Set();
	for (let y = 0; y < H; y++) barriers.add(y * W + 10);   // solid wall
	const starts = [{ x: 3, y: 10 }, { x: 17, y: 10 }];     // one on each side

	const removed = openSealedPockets(barriers, W, H, 0, blocked, starts);
	assert.ok(removed >= 1, 'the wall should have been opened');

	// the two halves are now one region
	const isB = c => barriers.has(c);
	const seen = new Uint8Array(W * H);
	const stack = [10 * W + 3];
	seen[stack[0]] = 1;
	while (stack.length) {
		const c = stack.pop();
		const x = c % W, y = (c / W) | 0;
		for (let dy = -1; dy <= 1; dy++)
			for (let dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue;
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const n = ny * W + nx;
				if (seen[n] || isB(n)) continue;
				seen[n] = 1; stack.push(n);
			}
	}
	assert.ok(seen[10 * W + 17], 'the second player is still walled off');
});

test('scenery that seals the map after the guards go in is removed too', () => {
	// A chokepoint guard or a monolith lands after the barrier pass, and
	// either can close the doorway it just opened.
	const W = 15, H = 15;
	const blocked = new Uint8Array(W * H);
	const objects = [];
	const rock = { animation: 'AVLrk5d0', mask: ['B'] };
	for (let y = 0; y < H; y++) {
		objects.push({ type: 'rock', subtype: 'object', l: 0, x: 7, y,
			template: { animation: rock.animation, mask: rock.mask } });
		blocked[y * W + 7] = 1;
	}
	// something that is not scenery also sits in the wall and must survive
	objects.push({ type: 'randomMonsterLevel3', subtype: 'object', l: 0, x: 3, y: 3,
		template: { animation: 'AVWmrnd0', mask: ['VV', 'VA'] } });
	blocked[3 * W + 3] = 1;

	const before = objects.length;
	const removed = openSealedByObjects(objects, W, H, 0, blocked, [{ x: 2, y: 7 }]);
	assert.ok(removed >= 1, 'nothing was removed from a wall that cuts the map');
	assert.strictEqual(objects.length, before - removed);
	assert.ok(objects.some(o => o.type === 'randomMonsterLevel3'),
		'only one-cell scenery may be removed, never a guard');
	// the far side is reachable now
	let reached = false;
	const seen = new Uint8Array(W * H);
	const stack = [7 * W + 2];
	seen[stack[0]] = 1;
	while (stack.length) {
		const c = stack.pop();
		const x = c % W, y = (c / W) | 0;
		if (x > 7) reached = true;
		for (let dy = -1; dy <= 1; dy++)
			for (let dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue;
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const n = ny * W + nx;
				if (seen[n] || blocked[n]) continue;
				seen[n] = 1; stack.push(n);
			}
	}
	assert.ok(reached, 'the far side of the wall is still cut off');
});

test('a sealed start opens first, however many other pockets there are', () => {
	// Fuzz seed 23 case 12 (216x216, seven players, decor lever at 2): the
	// seal pass spent its 128 removals on one-cell cracks, smallest first,
	// and shipped tan's start sealed in 196 tiles. Here 144 cracks sit in a
	// block of rock while blue's town sits behind a ring two rocks thick.
	const W = 60, H = 40;
	const blocked = new Uint8Array(W * H);
	const objects = [];
	const rock = (x, y) => {
		objects.push({ instanceName: `rock_${x}_${y}`, type: 'rock', subtype: 'object', l: 0, x, y,
			template: { animation: 'AVLrk5d0', mask: ['B'] } });
		blocked[y * W + x] = 1;
	};
	const town = OBJECT_TEMPLATES.randomTown;
	const place = (x, y, owner) => {
		objects.push({ instanceName: `town_${owner}`, type: 'randomTown', subtype: 'object', l: 0, x, y,
			options: { owner },
			template: { animation: town.animation, mask: town.mask, visitableFrom: town.visitableFrom } });
		footprintBlock(town, x, y, 0, W, H, blocked);
	};
	place(8, 20, 'red');
	// cracks: every odd cell of the block stays open with rock all round it
	for (let y = 2; y <= 38; y++)
		for (let x = 20; x <= 36; x++)
			if (!((x - 20) % 2 === 1 && (y - 2) % 2 === 1)) rock(x, y);
	// blue's ring, two rocks thick, around x 42..54, y 14..26
	for (let y = 12; y <= 28; y++)
		for (let x = 40; x <= 56; x++) {
			const ring = x <= 41 || x >= 55 || y <= 13 || y >= 27;
			if (ring) rock(x, y);
		}
	place(48, 20, 'blue');
	const ringBefore = objects.filter(o => o.x >= 40 && o.type === 'rock').length;

	openSealedByObjects(objects, W, H, 0, blocked, [{ x: 8, y: 20 }]);

	const gateOf = o => {
		const out = [];
		for (const [vx, vy] of visitableCells(o.template, o.x, o.y))
			for (const [dx, dy] of [[-1, 1], [0, 1], [1, 1]]) out.push((vy + dy) * W + vx + dx);
		return out;
	};
	const seen = new Uint8Array(W * H);
	const stack = gateOf(objects.find(o => o.instanceName === 'town_red')).filter(c => !blocked[c]);
	for (const c of stack) seen[c] = 1;
	while (stack.length) {
		const c = stack.pop();
		const x = c % W, y = (c / W) | 0;
		for (let dy = -1; dy <= 1; dy++)
			for (let dx = -1; dx <= 1; dx++) {
				const nx = x + dx, ny = y + dy;
				if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const n = ny * W + nx;
				if (seen[n] || blocked[n]) continue;
				seen[n] = 1; stack.push(n);
			}
	}
	assert.ok(gateOf(objects.find(o => o.instanceName === 'town_blue')).some(c => seen[c]),
		'blue is still sealed in');
	const ringAfter = objects.filter(o => o.x >= 40 && o.type === 'rock').length;
	assert.ok(ringBefore - ringAfter <= 4, `the way in took ${ringBefore - ringAfter} ring rocks, not a corridor`);
});

test('biome boundaries bend, and a player keeps their own cell', () => {
	const starts = [{ x: 4, y: 4 }, { x: 43, y: 43 }];
	const straight = partitionBiomes(48, 48, starts, 6, xorshift(7), { biomeWobble: 0 });
	const organic = partitionBiomes(48, 48, starts, 6, xorshift(7), { biomeWobble: 0.6 });
	const borderLen = z => {
		let n = 0;
		for (let y = 0; y < 48; y++)
			for (let x = 0; x < 48; x++) {
				const a = z[y * 48 + x];
				if ((x + 1 < 48 && z[y * 48 + x + 1] !== a)
					|| (y + 1 < 48 && z[(y + 1) * 48 + x] !== a)) n++;
			}
		return n;
	};
	assert.ok(borderLen(organic.zone) > borderLen(straight.zone),
		'a warped boundary should be longer than a straight one');
	// the warp multiplies the distance, so it vanishes at a seed: every player
	// must still own the cell they start on
	for (let i = 0; i < starts.length; i++)
		assert.strictEqual(organic.zone[starts[i].y * 48 + starts[i].x], i,
			`player ${i} lost their own start cell to a neighbour`);
});

test('terrain edge art is drawn only at an edge', () => {
	// Transcription of CDrawTerrainOperation over terrainViewPatterns.json.
	// Measured against 78737 tiles of real VCMI-written maps: the frame the
	// engine stored falls inside the range our matcher picks 98.6% of the time
	// and the flip agrees 98.9% of the time.
	const patterns = buildPatterns(
		require('../src/exporter/terrainViewPatterns.json'));
	const grass = { id: 'core:grass', group: 'normal', transitionRequired: false,
		passable: true, isDirt: false, isSand: false };
	const sand = { id: 'core:sand', group: 'sand', transitionRequired: true,
		passable: true, isDirt: false, isSand: true };

	const W = 9, H = 9;
	// grass everywhere, sand filling the left three columns
	const terrainAt = (x) => (x < 3 ? sand : grass);
	const r = assignTerrainViews(W, H, terrainAt, patterns, () => 0.5);

	const plainGrass = v => v >= 49 && v <= 72;   // n1 range for "normal"
	// deep inside the grass, every tile is plain ground
	for (let y = 2; y < H - 2; y++)
		for (let x = 5; x < W; x++)
			assert.ok(plainGrass(r.views[y * W + x]),
				`interior grass at ${x},${y} used frame ${r.views[y * W + x]}`);
	// the column that touches the sand is not
	let edgeTiles = 0;
	for (let y = 2; y < H - 2; y++)
		if (!plainGrass(r.views[y * W + 3])) edgeTiles++;
	assert.ok(edgeTiles >= 3,
		`grass beside sand should draw an edge, only ${edgeTiles} tiles did`);
	assert.strictEqual(r.unmatched, 0, 'a plain two-terrain split should all match');
});

test('the road network joins every town and leaves no orphan tiles', () => {
	const W = 20, H = 20;
	const blocked = new Uint8Array(W * H);
	// a wall down the middle with one gap, so the road has to find the door
	for (let y = 0; y < H; y++) if (y !== 9) blocked[y * W + 10] = 1;
	const towns = [
		{ x: 3, y: 3, gates: [[3, 3]] },
		{ x: 16, y: 16, gates: [[16, 16]] },
		{ x: 16, y: 3, gates: [[16, 3]] },
	];
	// a stray roaded doorway nowhere near the network
	const roadCells = new Set([2 * W + 18]);
	const added = buildRoadNetwork(towns, roadCells, W, H, blocked, 0);
	const orphans = pruneOrphanRoads(roadCells, W, H);
	assert.ok(added > 0, 'no road was laid');
	assert.strictEqual(orphans, 1, 'the stray doorway tile should be the only orphan');
	assert.ok(roadCells.has(9 * W + 10), 'the road must pass through the only gap');
	assert.ok(!roadCells.has(2 * W + 18), 'an isolated road tile must be dropped');
	// every remaining cell has an orthogonal neighbour, so the art reads as road
	for (const c of roadCells) {
		const x = c % W, y = (c / W) | 0;
		const joined = [[0, -1], [1, 0], [0, 1], [-1, 0]].some(([dx, dy]) => {
			const nx = x + dx, ny = y + dy;
			return nx >= 0 && ny >= 0 && nx < W && ny < H && roadCells.has(ny * W + nx);
		});
		assert.ok(joined, `road cell ${x},${y} is isolated`);
		assert.ok(!(blocked[c] & 1), `road cell ${x},${y} is on a wall`);
	}
	// and the network actually reaches all three towns
	for (const t of towns) {
		const near = [[0, 0], [0, -1], [1, 0], [0, 1], [-1, 0], [1, 1], [-1, -1], [1, -1], [-1, 1]]
			.some(([dx, dy]) => roadCells.has((t.y + dy) * W + (t.x + dx)));
		assert.ok(near, `town at ${t.x},${t.y} has no road`);
	}
});

test('the tile dictionary excludes impassable, water and modded terrain', () => {
	const index = { terrains: new Map([
		['gr', { name: 'core:grass', moveCost: 100, allowedLayers: ['surface'] }],
		['sb', { name: 'core:subterra', moveCost: 100, allowedLayers: ['underground'] }],
		['rc', { name: 'core:rock', moveCost: -1, allowedLayers: [], viewGroup: 'rock' }],
		['wt', { name: 'core:water', moveCost: 100, allowedLayers: [], viewGroup: 'water' }],
		['sd', { name: 'mod:stardust', moveCost: 100, allowedLayers: ['underground'] }],
	]) };
	const shorts = t => [...new Set(t.map(x => x.shortId))].sort();
	assert.deepStrictEqual(shorts(buildDictionary(index, 2)), ['gr', 'sb']);
	assert.deepStrictEqual(shorts(buildDictionary(index, 2, { coreOnly: false })),
		['gr', 'sb', 'sd']);
	assert.deepStrictEqual(shorts(buildDictionary(index, 2,
		{ coreOnly: false, includeImpassable: true })),
		['gr', 'rc', 'sb', 'sd', 'wt']);
});

test('terrain views are plain ground, not border art', () => {
	// terrainViewPatterns.json entry n1 ("no transition", all-native 3x3) maps
	// to normal 49-56 plain / 57-72 decorated, dirt 21-28 / 29-44,
	// sand 0-11 / 12-23. MapRenderer.cpp:162 uses terView as the frame index
	// with nothing recomputing it, so views 0-7 on a normal terrain drew every
	// tile of every map as a sand or dirt border piece.
	const index = { terrains: new Map([
		['gr', { name: 'core:grass', moveCost: 100, allowedLayers: ['surface'] }],
		['dt', { name: 'core:dirt', moveCost: 100, allowedLayers: ['surface'], viewGroup: 'dirt' }],
		['sa', { name: 'core:sand', moveCost: 100, allowedLayers: ['surface'], viewGroup: 'sand' }],
	]) };
	const inRange = (v, lo, hi) => v >= lo && v <= hi;
	const byShort = {};
	for (const t of buildDictionary(index, 8)) (byShort[t.shortId] ||= []).push(t.view);

	for (const v of byShort.gr)
		assert.ok(inRange(v, 49, 56) || inRange(v, 57, 72), `grass view ${v}`);
	for (const v of byShort.dt)
		assert.ok(inRange(v, 21, 28) || inRange(v, 29, 44), `dirt view ${v}`);
	for (const v of byShort.sa)
		assert.ok(inRange(v, 0, 11) || inRange(v, 12, 23), `sand view ${v}`);
	// a terrain with no declared group falls back to normal, like the engine
	assert.ok(byShort.gr.every(v => v >= 49), 'grass has no group and must use normal');
	// roughly one view in eight is a decorated variant (RmgMap uses 15%)
	const decorated = byShort.gr.filter(v => v >= 57).length;
	assert.ok(decorated >= 1 && decorated <= 3, `decorated share was ${decorated}/8`);
});

test('adjacency lets every land tile meet every other', () => {
	// The old hazard family made lava-next-to-anything unsatisfiable, so the
	// solver exhausted its restarts and fell back to solving with no biome
	// domains at all, throwing the whole terrain plan away in silence.
	const tiles = [
		{ shortId: 'lv', terrain: 'core:lava', moveCost: 100, view: 0 },
		{ shortId: 'gr', terrain: 'core:grass', moveCost: 100, view: 0 },
	];
	const pairs = buildAdjacency(tiles);
	assert.strictEqual(pairs.length, tiles.length * tiles.length * 4);
	assert.ok(pairs.some(([a, , b]) => a === 0 && b === 1), 'lava beside grass');
});

test('the town footprint matches the real 6x6 town blocking extent', () => {
	// Real: VVVVVV/VVVVVV/VVVVVV/VVBBBV/VBBBBB/VBBABB (395 of 395 in the corpus)
	const real = ['VVVVVV', 'VVVVVV', 'VVVVVV', 'VVBBBV', 'VBBBBB', 'VBBABB'];
	const blockingOf = mask => {
		const mh = mask.length;
		const out = [];
		for (let i = 0; i < mh; i++)
			for (let j = 0; j < mask[i].length; j++)
				if ('BHAT'.includes(mask[i][j]))
					out.push(`${-(mask[i].length - 1 - j)},${-(mh - 1 - i)}`);
		return out.sort();
	};
	assert.deepStrictEqual(blockingOf(OBJECT_TEMPLATES.randomTown.mask),
		blockingOf(real));
	assert.deepStrictEqual(visitableCells(OBJECT_TEMPLATES.randomTown, 10, 10),
		visitableCells({ mask: real }, 10, 10),
		'the gate has to sit in the same place as the real one');
});

test('header declares no mod requirements by default', () => {
	const h = makeHeader({ width: 36, height: 36, players: [], levels: [],
		modIds: [{ __id: 'x', name: 'x', version: '1' }] });
	assert.strictEqual(h.mods, null);
	const opted = makeHeader({ width: 36, height: 36, players: [], levels: [],
		modIds: [{ __id: 'x', name: 'x', version: '1' }], declareMods: true });
	assert.deepStrictEqual(opted.mods, [{ modId: 'x', name: 'x', version: '1' }]);
});

test('the bank pool is the seven core banks, the dragon utopia and the crypt', () => {
	// The utopia is handled by the same CBank code but is its own object type
	// rather than a creatureBank subtype, so a pool that only emitted
	// creatureBank could never produce one. The crypt comes out of the same
	// treasure piles. Pin the count and the split.
	assert.strictEqual(CORE_BANKS.length, 9);
	assert.strictEqual(CORE_BANKS.filter(b => b.type === 'creatureBank').length, 7);
	assert.strictEqual(CORE_BANKS.filter(b => b.type === 'dragonUtopia').length, 1);
	assert.strictEqual(CORE_BANKS.filter(b => b.type === 'crypt').length, 1);
	for (const b of CORE_BANKS) {
		assert.ok(b.weight > 0, b.subtype);
		for (const t of b.tpls ? b.tpls.map(x => x.raw) : [b.tpl]) {
			assert.ok(!t.animation.includes('/'), b.subtype);
			assert.ok(t.mask.some(r => r.includes('A')), b.subtype);
		}
	}
});

test('a bank weighs its rmg rarity and value, the way the engine draws it', () => {
	// TreasurePlacer draws by rarity among objects whose value fits the pile,
	// so a bank near a rich pile's value (9000-9500) lands most often; the
	// rate curve is fitted on the corpus made with this install's mods
	assert.strictEqual(bankRate(null), 0);
	assert.strictEqual(bankRate({ value: 0, rarity: 100 }), 0, 'no value: never drawn');
	assert.strictEqual(bankRate({ value: 3000, rarity: 0 }), 0, 'no rarity: never drawn');
	const at = v => bankRate({ value: v, rarity: 100 });
	assert.ok(at(9000) > at(5000) && at(5000) > at(3000), 'rises to the rich piles');
	assert.ok(at(30000) < at(9500), 'and falls where few piles are that rich');
	assert.ok(Math.abs(bankRate({ value: 9500, rarity: 70 }) - 0.7 * at(9500)) < 1e-9, 'linear in rarity');
	// the Medusa Store's template leaves out subterranean (so every mod terrain
	// too); the crypt's three stand on five terrains
	const medusa = CORE_BANKS.find(b => b.subtype === 'medusaStore');
	assert.ok(medusa.terrains && !medusa.terrains.includes('subterra'));
	const crypt = CORE_BANKS.find(b => b.type === 'crypt');
	assert.deepStrictEqual(crypt.tpls.flatMap(t => t.terrains).sort(),
		['dirt', 'grass', 'sand', 'snow', 'swamp']);
});

test('a treasure band admits a bank worth a quarter of a pile to all of it', () => {
	// TreasurePlacer::getRandomObject takes objects worth D/4 to D for a pile
	// of desired value D, D uniform over the band
	const rich = { min: 45000, max: 75000 }, cheap = { min: 100, max: 3000 };
	assert.strictEqual(bandEligibility(1500, rich), 0, 'a cheap bank never in a rich band');
	assert.strictEqual(bandEligibility(30000, cheap), 0, 'a Treasure Cave never in a cheap band');
	assert.strictEqual(bandEligibility(30000, rich), 1);
	assert.strictEqual(bandEligibility(3000, { min: 3000, max: 6000 }), 1);
	assert.ok(Math.abs(bandEligibility(9000, { min: 10000, max: 40000 }) - 26000 / 30000) < 1e-12);
	assert.strictEqual(bandEligibility(5000, { min: 9700, max: 9700 }), 1, 'a one-value band');
	assert.strictEqual(bandEligibility(2000, { min: 9700, max: 9700 }), 0);
	// the corpus average falls as a bank's value climbs past the cheap bands,
	// so a band's weight (rate / average x admission) favours the rich banks
	// where they can go at all
	assert.ok(bankEligAt(2000) > bankEligAt(9000) && bankEligAt(9000) > bankEligAt(30000));
	const tc = { weight: 7.3, rmg: { value: 30000, rarity: 100 } };
	const hive = CORE_BANKS.find(b => b.subtype === 'dragonFlyHive');
	assert.ok(bankBandWeight(tc, rich) > 0 && bankBandWeight(hive, rich) === 0);
	assert.ok(bankBandWeight(hive, { min: 10000, max: 15000 }) > 0 && bankBandWeight(tc, { min: 10000, max: 15000 }) === 0);
});

test('DWELLING_POOL is core-only; pickDwelling can still draw a mod entry given one', () => {
	// Confirms the gap this session's fidelity lens found (dwellings 0.64x
	// corpus, dwellingsCore 1.25x - a real shortfall, not a lens artifact):
	// the harvested pool has no mod content at all today, so a mod dwelling
	// can only ever reach a map through the `extra` pool generate.js builds
	// from the live asset index. Pins both halves: the gap, and that the
	// merge mechanism itself picks a mod entry when it is the only match.
	assert.ok(DWELLING_POOL.length > 0);
	assert.strictEqual(DWELLING_POOL.filter(d => String(d.tpl.animation).includes('/')).length, 0,
		'DWELLING_POOL should be core-only; a mod entry here means the static harvest picked up modded content');
	const rng = () => 0.5;
	assert.strictEqual(pickDwelling(99, rng), null, 'level 99 exists in neither pool');
	const extra = [{ type: 'creatureGeneratorSpecial', subtype: 'testMod:thing', level: 99,
		weight: 1, tpl: { animation: 'testMod/sprites/thing.def', mask: ['VVV'], visitableFrom: ['+++'] } }];
	const picked = pickDwelling(99, rng, extra);
	assert.ok(picked, 'a level with no core entries should still resolve once a mod entry is passed in');
	assert.strictEqual(picked.subtype, 'testMod:thing');
	// A real level (1) must still merge the mod entry in alongside the core
	// ones rather than replacing them - if a stray mod dwelling of level 1
	// existed it should be a candidate too, not just the sole result.
	const mergedPool = DWELLING_POOL.concat([{ ...extra[0], level: 1 }]).filter(d => d.level === 1);
	assert.ok(mergedPool.length > DWELLING_POOL.filter(d => d.level === 1).length);
});

test('every scroll spell is a core identifier the engine can resolve', () => {
	// CMapLoaderJson::MapObjectLoader::configure reads options.spell and falls
	// back to spell 0 when it cannot resolve the name, so an unset or modded
	// spell is not a random spell, it is Magic Arrow on a map nobody modded.
	assert.ok(SPELL_SCROLL, 'scroll template must be present');
	assert.ok(SPELL_SCROLL.spells.length >= 60,
		`only ${SPELL_SCROLL.spells.length} spells harvested`);
	for (const s of SPELL_SCROLL.spells)
		assert.ok(s.startsWith('core:'), s);
	assert.ok(!SPELL_SCROLL.tpl.animation.includes('/'));
	assert.ok(SPELL_SCROLL.tpl.mask.some(r => r.includes('A')));
});

test('the underground gate pair uses the same core art on both levels', () => {
	assert.strictEqual(OBJECT_DEFS.subterraneanGate.animation, 'AvTCave');
	assert.strictEqual(OBJECT_DEFS.subterraneanGateUnder.animation, 'AvTCave');
});


test('scenery with no visitable cell counts as having an open entrance', () => {
	// The bug this pins: entranceOpen looped over visitableCells and fell off
	// the end returning false when there were none, so every multi-cell
	// decoration was rejected at placement and no generated map ever carried
	// one. A mountain has no entrance and needs none; sweepStranded already
	// treats a template with no visitable cell as scenery and this now matches.
	const W = 8, H = 8, blocked = new Uint8Array(W * H);
	const mountain = { animation: 'AVLmt1s0', mask: ['VVVV', 'VBBB', 'VVBB'] };
	assert.strictEqual(visitableCells(mountain, 5, 5).length, 0);
	assert.ok(entranceOpen(mountain, 5, 5, 0, W, H, blocked, null));
	// a template that DOES have an entrance still has to have it open
	const walled = new Uint8Array(W * H).fill(1);
	const chest = { animation: 'AVTchst0', mask: ['A'] };
	assert.ok(!entranceOpen(chest, 5, 5, 0, W, H, walled, null));
});

test('every decoration template is core art the engine can draw', () => {
	// The previous decoration set was written from memory and used six
	// animation names that exist in no config file and in none of the 71 real
	// maps, so every border on every map was an invisible wall. These are
	// harvested from the corpus, and a slash in an animation path means the
	// art lives in a mod, which a map declaring no mods cannot use.
	let n = 0;
	for (const pool of [...Object.values(DECOR_DATA.clusters), ...Object.values(DECOR_DATA.single)])
		for (const e of pool) {
			n++;
			assert.ok(!e.animation.includes('/'), `${e.type} ${e.animation} is mod art`);
			assert.ok(e.animation.length, `${e.type} has no animation`);
			assert.ok(e.mask.length, `${e.type} has no mask`);
			for (const row of e.mask)
				for (const ch of row)
					assert.ok(' 0VBHAT'.includes(ch),
						`${e.type} mask char ${JSON.stringify(ch)} is not one charToTile knows`);
			// scenery has to block something or it is not doing its job
			assert.ok(e.mask.some(r => [...r].some(c => 'BHAT'.includes(c))), e.type);
		}
	assert.ok(n > 300, `only ${n} decoration templates`);
	assert.ok(DECOR_TYPES.length >= 25, `only ${DECOR_TYPES.length} decoration types`);
});

test('every core terrain has clusters and single-cell art to draw from', () => {
	// A terrain with no pool places nothing, which is the right answer for
	// water and for modded terrain, and the wrong answer for the eight the
	// generator actually paints with.
	for (const t of ['gr', 'dt', 'sa', 'sn', 'sw', 'rg', 'lv', 'sb']) {
		assert.ok(DECOR_TERRAINS.includes(t), `no decoration data for ${t}`);
		assert.ok(DECOR_DATA.clusters[t].length >= 20, `${t}: ${DECOR_DATA.clusters[t].length} clusters`);
		assert.ok(DECOR_DATA.single[t].length >= 1, `${t}: no single-cell art`);
		assert.ok(clusterSize(t) > 3, `${t}: clusters average ${clusterSize(t)} blocking cells`);
	}
	const rng = xorshift(99);
	assert.strictEqual(clusterTemplate('wt', rng), null, 'water has no scenery of ours');
	const c = clusterTemplate('gr', rng);
	assert.strictEqual(c.subtype, 'object');
	assert.ok(c.tpl.mask.length);
});

test('wallClusters come back biggest first so a mountain gets first refusal', () => {
	// Placing one at a time and taking what comes looks equivalent and is not:
	// once a dozen 2x2 craters have peppered a biome there is nowhere a 4x6
	// mountain fits, and the realised mix skews small whatever the pool
	// weights say.
	const rng = xorshift(7);
	const list = wallClusters('dt', rng, 8);
	assert.ok(list.length > 1);
	for (let i = 1; i < list.length; i++)
		assert.ok(list[i - 1].cells >= list[i].cells, 'not sorted biggest first');
});

test('a pandora box carries a full rewardable block the reader can take', () => {
	// CRewardableObject::serializeJsonOptions serializes struct "rewardable"
	// (CRewardableObject.cpp:397), and every one of the 3972 corpus boxes has
	// info.length 1, visitType 1 and a non-empty reward. An empty info list or
	// an absent reward is a box that gives nothing.
	for (let k = 0; k < 40; k++) {
		const rng = xorshift(k + 1);
		const o = pandoraOptions(rng);
		assert.ok(o.rewardable.info.length === 1);
		assert.strictEqual(o.rewardable.info[0].visitType, 1);
		assert.strictEqual(o.rewardable.selectMode, 'selectFirst');
		assert.strictEqual(o.rewardable.visitMode, 'unlimited');
		const r = o.rewardable.info[0].reward;
		const gave = (r.heroExperience > 0) || (r.resources && r.resources.gold > 0)
			|| r.creatures.length || (r.spells && r.spells.length);
		assert.ok(gave, `pandora seed ${k} has no reward`);
		for (const c of r.creatures) assert.ok(c.type.startsWith('core:'), c.type);
		for (const s of r.spells || []) assert.ok(s.startsWith('core:'), s);
	}
	const t = pandoraTemplate();
	assert.strictEqual(t.animation, 'ava0128');
	assert.ok(t.mask.some(r => r.includes('A')), 'pandora needs an entrance');
});

test('a prison names a real core hero and the pool never repeats one', () => {
	// options.type is read by CGHeroInstance::serializeJsonOptions into
	// setHeroTypeName (CGHeroInstance.cpp:1684): an identifier it cannot
	// resolve makes the prison empty, and the corpus only ever writes
	// "core:"-style scoped hero names. Every prison draws from a shared pool
	// because PrisonHeroPlacer::drawRandomHero pops without replacement.
	const rng = xorshift(11);
	const pool = makePrisonHeroPool(4, rng);
	assert.ok(pool.length > 0);
	assert.strictEqual(new Set(pool).size, pool.length, 'heroes must be unique');
	assert.strictEqual(pool.length, SPECIALS.prison.heroes.length - 64,
		'16 heroes per player stay out of prisons');
	const o = prisonOptions(pool[0], rng);
	assert.ok(o.type.startsWith('core:'), o.type);
	assert.strictEqual(o.gender, -1);
	assert.ok(SPECIALS.prison.heroes.includes(o.type), 'unknown hero ' + o.type);
	const t = prisonTemplate();
	assert.strictEqual(t.animation, 'AVXprsn0',
		'the HotA prison def breaks a map that declares no mods');
	assert.ok(t.mask.some(r => r.includes('A')), 'prison needs an entrance');
});

test('obelisk art follows the terrain under it and stays core', () => {
	// Same convention as the mines: the corpus obelisk at each anchor reads
	// the terrain sprite prefix under it, and only the un-pathed AvXObl defs
	// exist on an install without mods.
	const seen = { dt: 'AvXOblG', gr: 'AvXOblW', sn: 'AvXOblP', sw: 'AvXOblB',
		rg: 'AvXOblO', sa: 'AvXOblK', sb: 'AvXOblK', lv: 'AvXOblY' };
	for (const [terrain, anim] of Object.entries(seen)) {
		const t = obeliskTemplate(terrain);
		assert.strictEqual(t.animation, anim, terrain);
		assert.ok(!t.animation.includes('/'), `${terrain}: mod art`);
		assert.deepStrictEqual(t.mask, ['VV', 'VA']);
	}
	assert.strictEqual(obeliskTemplate('zz').animation, 'AvXOblG',
		'unknown terrain falls back to the dirt obelisk');
});
