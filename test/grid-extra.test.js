/**
 * grid-extra.test.js - the October 8th checks of tools/harness/grid_extra.js on hand-built maps: each fails on what K showed and passes on its absence.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { CHECKS } = require('../tools/harness/grid_extra');

/** A W x H one-level map of open ground. */
function fake(W, H, objs, extra = {}) {
	const M = {
		NL: 1, W, H, terr: new Array(W * H).fill('gr'), road: new Uint8Array(W * H), blocked: new Uint8Array(W * H), levels: [{ rows: [] }],
		idx: (l, x, y) => (l * H + y) * W + x, inb: (x, y) => x >= 0 && y >= 0 && x < W && y < H,
		ground: () => true, objs, monsters: objs.filter(o => o.cls === 'monster'), zones: null, regionsOf: () => [], zoneAt: () => 0, ...extra,
	};
	M.approach = o => [-1, 0, 1].map(dx => M.idx(0, o.entr[0][0] + dx, o.entr[0][1] + 1)).filter((_, k) => M.inb(o.entr[0][0] + k - 1, o.entr[0][1] + 1));
	return M;
}
const town = (x, y, type = 'town') => ({ l: 0, cls: 'town', type, at: [x, y], x, y, entr: [[x, y]], cells: [[x, y]], visitable: true, template: { mask: ['A'] } });
const players = (...t) => Object.fromEntries(t.map((p, i) => [`p${i}`, { mainTown: { l: 0, x: p[0], y: p[1] } }]));
const roadRow = (M, y, x0, x1) => { for (let x = x0; x <= x1; x++) M.road[M.idx(0, x, y)] = 1; };

test('start-road: a start town with no road at its front tile fails (K islands, 2026-10-08), a joined road passes, a 3-tile stub fails', () => {
	const objs = [town(10, 10), town(30, 30)];
	const M = fake(40, 40, objs, { header: { players: players([10, 10], [30, 30]) } });
	roadRow(M, 31, 25, 39);
	const bad = CHECKS['start-road'](M);
	assert.strictEqual(bad.pass, false, bad.value);
	assert.ok(/\(10,10\)/.test(bad.items[0]), bad.items[0]);
	roadRow(M, 11, 5, 20);
	assert.strictEqual(CHECKS['start-road'](M).pass, true);
	const stub = fake(40, 40, [town(10, 10)], { header: { players: players([10, 10]) } });
	roadRow(stub, 11, 9, 11);
	assert.strictEqual(CHECKS['start-road'](stub).pass, false);
});

test('town-spacing: a start 6 tiles from a castle fails, a wall between them makes the walk long and passes, far towns pass', () => {
	const objs = [town(10, 10), town(16, 10)];
	const M = fake(60, 40, objs, { header: { players: players([10, 10]) } });
	const r = CHECKS['town-spacing'](M);
	assert.strictEqual(r.pass, false, r.value);
	assert.ok(/walking tiles/.test(r.items[0]), r.items[0]);
	// a rock wall of 26 tiles with the way round at one end: the walk is far longer than 15
	for (let y = 0; y < 34; y++) { M.blocked[M.idx(0, 13, y)] = 1; }
	assert.strictEqual(CHECKS['town-spacing'](M).pass, true, CHECKS['town-spacing'](M).value);
	assert.strictEqual(CHECKS['town-spacing'](fake(60, 40, [town(5, 5), town(45, 30)], { header: { players: players([5, 5]) } })).pass, true);
});

test('edge-objects: a 3x3 building on row 1 crosses the top edge and fails, on row 2 it passes', () => {
	const mk = y => ({ l: 0, cls: 'other', type: 'school', subtype: 'school', x: 10, y, at: [10, y], entr: [[10, y]], cells: [], visitable: true, template: { mask: ['VVV', 'VVV', 'VAB'] } });
	assert.strictEqual(CHECKS['edge-objects'](fake(30, 30, [mk(1)])).pass, false);
	assert.strictEqual(CHECKS['edge-objects'](fake(30, 30, [mk(2)])).pass, true);
	const left = { ...mk(5), x: 1, at: [1, 5], entr: [[1, 5]] };
	assert.strictEqual(CHECKS['edge-objects'](fake(30, 30, [left])).pass, false);
});

test('free-standing: a stack beside a pile that stands in the open closes nothing; one that is the only ring over the pile\'s approach closes it', () => {
	const stacks = [];
	for (let i = 0; i < 40; i++) stacks.push({ l: 0, cls: 'monster', type: 'monster', subtype: 'imp', at: [3 + (i % 8) * 4, 3 + ((i / 8) | 0) * 4], x: 0, y: 0, cells: [], entr: [[0, 0]], visitable: false });
	const idle = fake(40, 40, stacks);
	assert.strictEqual(CHECKS['free-standing'](idle).pass, false, CHECKS['free-standing'](idle).value);
	// every stack ringing a one-approach pile (rock on both sides of it): each is needed
	const objs = [];
	const M0 = fake(40, 40, objs);
	for (let i = 0; i < 40; i++) {
		const px = 3 + (i % 8) * 4, py = 3 + ((i / 8) | 0) * 4;
		objs.push({ l: 0, cls: 'low', type: 'resource', subtype: 'gold', pickup: true, at: [px, py], x: px, y: py, entr: [[px, py]], cells: [[px, py]], visitable: true, template: { mask: ['A'] } });
		objs.push({ l: 0, cls: 'monster', type: 'monster', subtype: 'imp', at: [px, py + 1], x: px, y: py + 1, cells: [], entr: [[px, py + 1]], visitable: false });
	}
	M0.monsters = objs.filter(o => o.cls === 'monster');
	// the pile's approach tiles are the three below it; rock in the two corners leaves the middle one, which the stack stands on and rings
	for (const o of objs.filter(o => o.cls === 'low')) { M0.blocked[M0.idx(0, o.x - 1, o.y + 1)] = 1; M0.blocked[M0.idx(0, o.x + 1, o.y + 1)] = 1; }
	const r = CHECKS['free-standing'](M0);
	assert.strictEqual(r.pass, true, r.value);
});

test('road-breaks: a road cut by a two-tile gap near a town fails, the same road whole passes', () => {
	const mk = gap => {
		const M = fake(40, 40, [town(12, 8)], { guardOf: new Int32Array(1600).fill(-1) });
		roadRow(M, 10, 3, 36);
		if (gap) { M.road[M.idx(0, 20, 10)] = 0; M.road[M.idx(0, 21, 10)] = 0; }
		return M;
	};
	const bad = CHECKS['road-breaks'](mk(true));
	assert.strictEqual(bad.pass, false, bad.value);
	assert.ok(/another road at/.test(bad.items[0]), bad.items[0]);
	assert.strictEqual(CHECKS['road-breaks'](mk(false)).pass, true);
});

test('road-ends: a road that stops at a tavern door with another piece 5 tiles beyond fails, the same road with nothing beyond passes (K, 2026-10-08 15:0x)', () => {
	const tavern = { l: 0, cls: 'other', type: 'tavern', subtype: 'tavern', x: 20, y: 20, at: [20, 20], entr: [[20, 20]], cells: [[20, 20]], visitable: true, template: { mask: ['A'] } };
	const mk = beyond => {
		const M = fake(40, 40, [tavern]);
		roadRow(M, 38, 2, 38);
		for (let y = 21; y <= 30; y++) M.road[M.idx(0, 20, y)] = 1;
		if (beyond) for (let y = 11; y <= 15; y++) M.road[M.idx(0, 20, y)] = 1;
		return M;
	};
	const bad = CHECKS['road-ends'](mk(true));
	assert.strictEqual(bad.pass, false, bad.value);
	assert.ok(/another road piece at/.test(bad.items[0]), bad.items[0]);
	assert.strictEqual(CHECKS['road-ends'](mk(false)).pass, true);
});

test('gold-front: a gold mine with a free entrance tile outside every stack ring fails, ringed it passes', () => {
	const mine = { l: 0, cls: 'mine', type: 'mine', subtype: 'goldMine', x: 20, y: 20, at: [20, 20], entr: [[20, 20]], cells: [[20, 20]], visitable: true, template: { mask: ['A'] } };
	const stack = (x, y) => ({ l: 0, cls: 'monster', type: 'monster', subtype: 'imp', at: [x, y], x, y, cells: [], entr: [[x, y]], visitable: false });
	assert.strictEqual(CHECKS['gold-front'](fake(40, 40, [mine])).pass, false);
	// the three tiles below the door (19..21, 21) all lie in the ring of a stack at (20,22)
	assert.strictEqual(CHECKS['gold-front'](fake(40, 40, [mine, stack(20, 22)])).pass, true);
});

test('prison-tiers: 90000 experience in a start zone fails, 15000 there passes, 90000 in a treasure zone passes only with a monster beside it', () => {
	const prison = (exp, x = 5, y = 5) => ({ l: 0, cls: 'low', type: 'prison', subtype: 'prison', pickup: true, options: { experience: exp }, x, y, at: [x, y], entr: [[x, y]], cells: [[x, y]], visitable: true, template: { mask: ['A'] } });
	const stack = (x, y) => ({ l: 0, cls: 'monster', type: 'monster', subtype: 'imp', at: [x, y], x, y, cells: [], entr: [[x, y]], visitable: false });
	const mk = (objs, type) => fake(40, 40, objs, { zones: { zones: new Map([[1, { type }]]), zoneOf: () => 1 }, zoneAt: () => 1 });
	assert.strictEqual(CHECKS['prison-tiers'](mk([prison(90000), stack(5, 6)], 'playerStart')).pass, false);
	assert.strictEqual(CHECKS['prison-tiers'](mk([prison(15000)], 'playerStart')).pass, true);
	assert.strictEqual(CHECKS['prison-tiers'](mk([prison(90000)], 'treasure')).pass, false);
	assert.strictEqual(CHECKS['prison-tiers'](mk([prison(500000), stack(5, 6)], 'treasure')).pass, true);
});

test('prison-tiers: guarded by the approach-tile rule, a stack two tiles off whose ring and rock close every entrance passes, one that leaves a tile open fails (Reviewer R1, e0cfc5c seed 902)', () => {
	const prison = { l: 0, cls: 'low', type: 'prison', subtype: 'prison', pickup: true, options: { experience: 500000 }, x: 5, y: 5, at: [5, 5], entr: [[5, 5]], cells: [[5, 5]], visitable: true, template: { mask: ['A'] } };
	const stack = { l: 0, cls: 'monster', type: 'monster', subtype: 'imp', at: [4, 7], x: 4, y: 7, cells: [], entr: [[4, 7]], visitable: false };
	const mk = rock => {
		const M = fake(40, 40, [prison, stack], { zones: { zones: new Map([[1, { type: 'treasure' }]]), zoneOf: () => 1 }, zoneAt: () => 1 });
		if (rock) M.blocked[M.idx(0, 6, 6)] = 1;
		return M;
	};
	// the entrance tiles are (4,6), (5,6), (6,6); the ring of (4,7) covers the first two, rock the third; no stack is beside the prison
	assert.strictEqual(CHECKS['prison-tiers'](mk(true)).pass, true);
	assert.strictEqual(CHECKS['prison-tiers'](mk(false)).pass, false);
});

test('river-ends: a river that stops in the open fails, one that runs to the map edge passes, one under a visited object fails', () => {
	const W = 20, H = 20;
	const mk = (y1, objs = []) => {
		const rows = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => (x === 10 && y <= y1 ? 'gr0_rw0_' : 'gr0_')));
		return fake(W, H, objs, { levels: [{ rows }] });
	};
	const r = CHECKS['river-ends'](mk(9));
	assert.strictEqual(r.pass, false, r.value);
	assert.ok(/in the open/.test(r.items[0]), r.items[0]);
	assert.strictEqual(CHECKS['river-ends'](mk(H - 1)).pass, true);
	const chest = { l: 0, cls: 'low', type: 'treasureChest', pickup: true, x: 10, y: 5, at: [10, 5], entr: [[10, 5]], cells: [[10, 5]], visitable: true, template: { mask: ['A'] } };
	const under = CHECKS['river-ends'](mk(H - 1, [chest]));
	assert.strictEqual(under.pass, false, under.value);
	assert.ok(/under a visited object/.test(under.items[0]), under.items[0]);
});

test('water: a lake in the middle reads as a sea in the middle, a strip along the left edge as edge strips, a dry map is skipped, a zone with no land is drowned', () => {
	const W = 40, H = 40;
	const mk = wet => {
		const M = fake(W, H, [], { header: { players: {} } });
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (wet(x, y)) M.terr[M.idx(0, x, y)] = 'wt';
		M.ground = i => M.terr[i] !== 'wt';
		return M;
	};
	assert.strictEqual(CHECKS.water(mk(() => false)).skipped, 'dry map');
	const sea = CHECKS.water(mk((x, y) => Math.abs(x - 20) < 10 && Math.abs(y - 20) < 10));
	assert.strictEqual(sea.nums.shapeSeen, 'sea in the middle', sea.value);
	assert.ok(sea.nums.centDist < 0.05 && Math.abs(sea.nums.bodyShareOfMap - 0.2256) < 0.001 && sea.nums.raysLand === 16, JSON.stringify(sea.nums));
	const edge = CHECKS.water(mk(x => x < 8));
	assert.ok(edge.nums.centDist > 0.5 && edge.nums.raysLand < 16, JSON.stringify(edge.nums));
	const strip = CHECKS.water(mk(x => x < 8));
	assert.ok(/^edge strips \(1 side\)/.test(strip.nums.shapeSeen), strip.value);
	const zoned = mk((x, y) => x < 10 && y < 10);
	const zone = (x, y) => (x < 10 && y < 10 ? 1 : 2);
	zoned.zones = { zones: new Map([[1, { type: 'treasure' }], [2, { type: 'playerStart' }]]), zoneOf: (l, x, y) => zone(x, y) };
	zoned.zoneAt = (l, x, y) => zone(x, y);
	const d = CHECKS.water(zoned);
	assert.strictEqual(d.nums.drownedZones, 1, d.value);
	assert.ok(d.items.some(s => /drowned zone 1 \(treasure\)/.test(s)), d.items.join('|'));
});

test('road-corners: a staircase of corner-only steps fails, the same road with the side tile added passes (Reviewer R27, K road report 2026-10-10)', () => {
	const M = fake(40, 40, []);
	roadRow(M, 10, 5, 20);
	roadRow(M, 30, 0, 29);
	for (let k = 1; k <= 3; k++) M.road[M.idx(0, 20 + k, 10 + k)] = 1;
	const bad = CHECKS['road-corners'](M);
	assert.strictEqual(bad.pass, false, bad.value);
	assert.strictEqual(bad.nums.steps, 3);
	for (let k = 1; k <= 3; k++) M.road[M.idx(0, 20 + k - 1, 10 + k)] = 1;
	const ok = CHECKS['road-corners'](M);
	assert.strictEqual(ok.pass, true, ok.value);
	assert.strictEqual(CHECKS['road-corners'](fake(40, 40, [])).skipped, 'the map has almost no road');
});

test('town-loot: a Pandora\'s box two tiles from a town with no monster fails, a monster beside it passes, one 9 tiles away is not beside the town (Reviewer R28)', () => {
	const box = (x, y) => ({ l: 0, cls: 'high', type: 'pandoraBox', at: [x, y], x, y, entr: [[x, y]], cells: [[x, y]], pickup: true });
	const mon = (x, y) => ({ l: 0, cls: 'monster', type: 'monster', at: [x, y], x, y, cells: [[x, y]] });
	const open = fake(40, 40, [town(10, 10), box(11, 13)]);
	const bad = CHECKS['town-loot'](open);
	assert.strictEqual(bad.pass, false, bad.value);
	assert.ok(/pandoraBox L0 \(11,13\)/.test(bad.items[0]), bad.items[0]);
	assert.strictEqual(CHECKS['town-loot'](fake(40, 40, [town(10, 10), box(11, 13), mon(12, 13)])).pass, true);
	assert.strictEqual(CHECKS['town-loot'](fake(40, 40, [town(10, 10), box(20, 20)])).pass, true);
});

test('loot-by-zone: a report that counts dear piles by zone class and names the guard-free ones, never a failure (Reviewer R36)', () => {
	const box = (x, y) => ({ l: 0, cls: 'high', type: 'pandoraBox', at: [x, y], x, y, entr: [[x, y]], cells: [[x, y]], pickup: true });
	const zones = { zones: new Map([[0, { id: 0, type: 'playerStart' }]]), file: 'nofile.json' };
	const M = fake(40, 40, [box(5, 5), box(8, 8)], { zones, zoneAt: () => 0 });
	const r = CHECKS['loot-by-zone'](M);
	assert.strictEqual(r.pass, true, r.value);
	assert.strictEqual(r.nums.start, 2);
	assert.strictEqual(r.nums.none, 2);
	assert.strictEqual(CHECKS['loot-by-zone'](fake(40, 40, [])).skipped, 'no dear piles');
});
