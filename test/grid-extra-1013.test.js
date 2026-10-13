/**
 * grid-extra-1013.test.js - approach-shadow, road-stubs, water-objects and prison-hero of tools/harness/grid_extra.js on hand-built maps
 * (lead's Tuesday order of 2026-10-13; K 10-11: monolith on the gem pond, road terminations, Ayden; K 10-12: loot on the Mediterranean XL water).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { CHECKS, levelOfExp } = require('../tools/harness/grid_extra');

/** A W x H one-level map of open ground; the approach of an object is the three tiles below its entrance cell. */
function fake(W, H, objs, extra = {}) {
	const M = {
		NL: 1, W, H, terr: new Array(W * H).fill('gr'), road: new Uint8Array(W * H), blocked: new Uint8Array(W * H), levels: [{ rows: [] }],
		idx: (l, x, y) => (l * H + y) * W + x, inb: (x, y) => x >= 0 && y >= 0 && x < W && y < H,
		ground: i => M.terr[i] !== 'wa', objs, monsters: objs.filter(o => o.cls === 'monster'), zones: null, regionsOf: () => [], zoneAt: () => 0, ...extra,
	};
	M.approach = o => [-1, 0, 1].filter(d => M.inb(o.entr[0][0] + d, o.entr[0][1] + 1)).map(d => M.idx(0, o.entr[0][0] + d, o.entr[0][1] + 1));
	// the blocked cells of non-pickup objects, as mapsight's load does
	for (const o of objs) if (!o.pickup && o.cls !== 'monster') for (const [x, y] of o.cells) if (M.inb(x, y)) M.blocked[M.idx(0, x, y)] = 1;
	return M;
}
const town = (x, y) => ({ l: 0, cls: 'town', type: 'town', at: [x, y], x, y, entr: [[x, y]], cells: [[x, y]], visitable: true, template: { mask: ['A'] } });
/** A two-way monolith: mask VV / VA, anchor and visiting cell the bottom right one. */
const mono = (x, y) => ({ l: 0, cls: 'monolith', type: 'monolithTwoWay', subtype: 'monolith1', at: [x, y], x, y, entr: [[x, y]], cells: [[x, y]], visitable: true, template: { mask: ['VV', 'VA'] } });
/** The gem pond: mask BBB / BAB, entrance cell (x,y) in the middle of the bottom row, anchor at its right end. */
const pond = (x, y) => ({ l: 0, cls: 'mine', type: 'mine', subtype: 'gemPond', at: [x, y], x: x + 1, y, entr: [[x, y]], cells: [[x - 1, y - 1], [x, y - 1], [x + 1, y - 1], [x - 1, y], [x, y], [x + 1, y]], visitable: true, template: { mask: ['BBB', 'BAB'] } });
const pile = (x, y) => ({ l: 0, cls: 'high', type: 'pandoraBox', at: [x, y], x, y, entr: [[x, y]], cells: [[x, y]], pickup: true, template: { mask: ['A'] } });
const roadRow = (M, y, x0, x1) => { for (let x = x0; x <= x1; x++) M.road[M.idx(0, x, y)] = 1; };

test('approach-shadow: a monolith picture over every approach tile of a pile fails, over one of three is only counted, far away passes (K 10-11 gem pond)', () => {
	// the pile at (10,10) is entered from (9,11), (10,11), (11,11); a monolith at (x,y) has its picture on x-1..x, y-1..y
	const none = CHECKS['approach-shadow'](fake(40, 40, [pile(10, 10), mono(30, 30)]));
	assert.strictEqual(none.pass, true, none.value);
	const one = CHECKS['approach-shadow'](fake(40, 40, [pile(10, 10), mono(9, 12)]));
	assert.strictEqual(one.pass, true, one.value);
	assert.strictEqual(one.nums.partial, 1);
	const all = CHECKS['approach-shadow'](fake(40, 40, [pile(10, 10), mono(9, 12), mono(11, 12)]));
	assert.strictEqual(all.pass, false, all.value);
	assert.ok(/pandoraBox/.test(all.items[0]) && /L0 \(10,10\)/.test(all.items[0]), all.items[0]);
	assert.strictEqual(all.nums.lostTiles, 3);
});

test('approach-shadow: a monolith picture on the cells of a mine fails whatever is left of its approach (K pond: 2 of 6 cells)', () => {
	const r = CHECKS['approach-shadow'](fake(60, 60, [pond(20, 20), mono(20, 21)]));
	assert.strictEqual(r.pass, false, r.value);
	assert.ok(/gemPond/.test(r.items[0]) && /picture cells/.test(r.items[0]), r.items[0]);
	assert.strictEqual(CHECKS['approach-shadow'](fake(60, 60, [pond(20, 20), mono(40, 40)])).pass, true);
	assert.strictEqual(CHECKS['approach-shadow'](fake(60, 60, [pond(20, 20)])).skipped, 'no entrance objects');
});

test('road-stubs: a 4-tile road that reaches one monolith and nothing else fails, one that also reaches a town passes (K 10-11 road terminations)', () => {
	const lone = fake(60, 40, [mono(30, 20), town(5, 5), town(50, 30)]);
	roadRow(lone, 6, 3, 40); roadRow(lone, 31, 40, 55);        // two long roads, so the map has road
	roadRow(lone, 21, 28, 31);                                 // the stub: its tile (30,21) is below the monolith's entrance, a visiting tile
	const bad = CHECKS['road-stubs'](lone);
	assert.strictEqual(bad.pass, false, bad.value);
	assert.strictEqual(bad.nums.stubs, 1);
	assert.ok(/reaches only monolithTwoWay/.test(bad.items[0]), bad.items[0]);
	const joined = fake(60, 40, [mono(30, 20), town(32, 20)]);
	roadRow(joined, 21, 28, 40); roadRow(joined, 5, 3, 40);    // (32,21) is the town's visiting tile and (30,21) the monolith's: one piece joins both
	const ok = CHECKS['road-stubs'](joined);
	assert.strictEqual(ok.pass, true, ok.value);
});

test('road-stubs: a short piece touching no object fails, one that touches a map edge passes, loot does not count as a place', () => {
	const base = () => { const M = fake(60, 40, [town(5, 5), town(50, 30)]); roadRow(M, 6, 3, 50); roadRow(M, 31, 48, 59); return M; };
	const lost = base(); roadRow(lost, 20, 20, 23);
	const r = CHECKS['road-stubs'](lost);
	assert.strictEqual(r.pass, false, r.value);
	assert.ok(/touches no visiting tile/.test(r.items[0]), r.items[0]);
	const edge = base(); roadRow(edge, 20, 0, 3);
	assert.strictEqual(CHECKS['road-stubs'](edge).pass, true);
	const loot = base(); roadRow(loot, 20, 20, 23);
	loot.objs.push(pile(22, 19));
	assert.strictEqual(CHECKS['road-stubs'](loot).pass, false);
});

test('water-objects: a mine with cells on water fails, a flotsam on water passes, a flotsam on land fails (K 10-12 Mediterranean XL)', () => {
	const flot = (x, y) => ({ l: 0, cls: 'low', type: 'flotsam', at: [x, y], x, y, entr: [[x, y]], cells: [[x, y]], pickup: true, template: { mask: ['A'] } });
	const sea = objs => { const M = fake(40, 40, objs); for (let y = 0; y < 40; y++) for (let x = 20; x < 40; x++) M.terr[M.idx(0, x, y)] = 'wa'; return M; };
	assert.strictEqual(CHECKS['water-objects'](fake(40, 40, [pond(10, 10)])).skipped, 'no water');
	const bad = CHECKS['water-objects'](sea([pond(19, 10)]));                // cells x 18..20, x 20 is water
	assert.strictEqual(bad.pass, false, bad.value);
	assert.strictEqual(bad.nums.onWater, 1);
	const good = CHECKS['water-objects'](sea([pond(10, 10), flot(30, 30)]));
	assert.strictEqual(good.pass, true, good.value);
	const onLand = CHECKS['water-objects'](sea([pond(10, 10), flot(5, 5)]));
	assert.strictEqual(onLand.pass, false, onLand.value);
	assert.strictEqual(onLand.nums.onLand, 1);
});

test('prison-hero: the level table gives 15000 level 10, 90000 level 20, 500000 level 30; stats 1/1/2/1 at level 30 fail, 8/9/4/4 at level 20 pass (Ayden, DMB Dev fix)', () => {
	assert.deepStrictEqual([0, 999, 1000, 15000, 90000, 500000].map(levelOfExp), [1, 1, 2, 10, 20, 30]);
	const dir = fs.mkdtempSync(path.join(__dirname, 'prison-'));
	try {
		const file = path.join(dir, 'x.vmap');
		const pr = (name, exp) => ({ l: 0, cls: 'other', type: 'prison', at: [5, 5], x: 5, y: 5, entr: [[5, 5]], cells: [[5, 5]], pickup: true, options: { type: name, experience: exp } });
		const objs = [pr('core:ayden', 500000), pr('core:marius', 90000)];
		assert.ok(/no stats/.test(String(CHECKS['prison-hero'](fake(20, 20, objs, { file })).skipped)), 'no engine log and no stored stats: not judged');
		fs.writeFileSync(file + '.prison.log', 'x global - Prison hero core:ayden: level 30, experience 500000, attack 1, defence 1, power 2, knowledge 1\nx global - Prison hero core:marius: level 20, experience 90000, attack 8, defence 9, power 4, knowledge 4\n');
		const r = CHECKS['prison-hero'](fake(20, 20, objs, { file }));
		assert.strictEqual(r.pass, false, r.value);
		assert.strictEqual(r.items.length, 1);
		assert.ok(/ayden/.test(r.items[0]) && /sum 5/.test(r.items[0]), r.items[0]);
		fs.writeFileSync(file + '.prison.log', 'x global - Prison hero core:ayden: level 30, experience 500000, attack 12, defence 10, power 9, knowledge 5\n');
		assert.strictEqual(CHECKS['prison-hero'](fake(20, 20, [pr('core:ayden', 500000)], { file })).pass, true);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('water-content: an empty sea fails the sea-to-land ratio, a sea with objects at the land density passes (K 10-12 17:55: not enough loot and structures on the water)', () => {
	const flot = (x, y) => ({ l: 0, cls: 'low', type: 'flotsam', at: [x, y], x, y, entr: [[x, y]], cells: [[x, y]], pickup: true, template: { mask: ['A'] } });
	const mk = (objs) => { const M = fake(60, 60, objs); for (let y = 0; y < 60; y++) for (let x = 30; x < 60; x++) M.terr[M.idx(0, x, y)] = 'wa'; return M; };
	const land = []; for (let i = 0; i < 40; i++) land.push(pile(2 + (i % 20), 2 + ((i / 20) | 0) * 3));
	assert.strictEqual(CHECKS['water-content'](fake(60, 60, land)).skipped, 'no water body');
	const empty = CHECKS['water-content'](mk(land));
	assert.strictEqual(empty.pass, false, empty.value);
	assert.strictEqual(empty.nums.seaN, 0);
	const sea = []; for (let i = 0; i < 40; i++) sea.push(flot(32 + (i % 20), 2 + ((i / 20) | 0) * 3));
	const full = CHECKS['water-content'](mk([...land, ...sea]));
	assert.strictEqual(full.nums.seaN, 40);
	assert.strictEqual(full.nums.pickup, 40);
	assert.ok(full.nums.ratio > 0.5 && full.pass === true, full.value);
});
