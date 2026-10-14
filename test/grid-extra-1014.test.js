/**
 * grid-extra-1014.test.js - start-resource-guard and guard-blocked of tools/harness/grid_extra.js on hand-built maps
 * (K 2026-10-14: "my wood (being a primary resource) blocked behind high-tier creatures ... least of all in a starting biome";
 * "enchanter got placed behind a crater (decorative blocker) again").
 */
'use strict';

process.env.VCMI_ROOT = process.env.VMAPGEN_TEST_ROOT || 'C:/AI Projects/Heroes 3/VCMI/dmbtest';
const test = require('node:test');
const assert = require('node:assert');
const { CHECKS } = require('../tools/harness/grid_extra');

/** A W x H one-level map of open ground; the approach of an object is the three tiles below its entrance cell. */
function fake(W, H, objs, extra = {}) {
	const M = {
		NL: 1, W, H, terr: new Array(W * H).fill('gr'), road: new Uint8Array(W * H), blocked: new Uint8Array(W * H), levels: [{ rows: [] }],
		idx: (l, x, y) => (l * H + y) * W + x, inb: (x, y) => x >= 0 && y >= 0 && x < W && y < H,
		ground: i => M.terr[i] !== 'wa', objs, monsters: objs.filter(o => o.cls === 'monster'), zones: null, regionsOf: () => [], zoneAt: () => 0, ...extra,
	};
	M.approach = o => [-1, 0, 1].filter(d => M.inb(o.entr[0][0] + d, o.entr[0][1] + 1)).map(d => M.idx(0, o.entr[0][0] + d, o.entr[0][1] + 1));
	for (const o of objs) if (!o.pickup && o.cls !== 'monster') for (const [x, y] of o.cells) if (M.inb(x, y) && o.template.mask.join('').match(/[BA]/)) M.blocked[M.idx(0, x, y)] = 1;
	return M;
}
const town = (x, y) => ({ l: 0, cls: 'town', type: 'town', at: [x, y], x, y, entr: [[x, y]], cells: [[x, y]], visitable: true, template: { mask: ['A'] } });
const sawmill = (x, y) => ({ l: 0, cls: 'mine', type: 'mine', subtype: 'sawmill', at: [x, y], x, y, entr: [[x, y]], cells: [[x, y]], visitable: true, template: { mask: ['A'] } });
const woodPile = (x, y) => ({ l: 0, cls: 'low', type: 'resource', subtype: 'wood', at: [x, y], x, y, entr: [[x, y]], cells: [[x, y]], pickup: true, template: { mask: ['A'] } });
const stack = (x, y, subtype, amount = 10) => ({ l: 0, cls: 'monster', type: 'monster', subtype, options: { amount }, at: [x, y], x, y, entr: [[x, y]], cells: [[x, y]], template: { mask: ['V'] } });
/** a blocking decorative object: the crater, mask VBB / BBB, anchor the bottom right cell */
const crater = (x, y) => ({ l: 0, cls: 'other', type: 'crater', at: [x, y], x, y, entr: [[x, y]], cells: [[x - 2, y - 1], [x - 1, y - 1], [x, y - 1], [x - 2, y], [x - 1, y], [x, y]], visitable: false, template: { mask: ['VBB', 'BBB'] } });
const withStart = (M, x, y) => Object.assign(M, { startList: [{ l: 0, at: [x, y], colour: 'red' }] });

test('start-resource-guard: a sawmill near a start with a tier 7 stack beside it fails, with a tier 1 stack or none passes (K 10-14 wood behind high-tier creatures)', () => {
	const mk = guard => { const o = [town(10, 10), sawmill(14, 12)]; if (guard) o.push(stack(14, 14, guard)); return withStart(fake(60, 60, o), 10, 10); };
	const none = CHECKS['start-resource-guard'](mk(null));
	assert.strictEqual(none.pass, true, none.value);
	const light = CHECKS['start-resource-guard'](mk('pikeman'));
	assert.strictEqual(light.pass, true, light.value);
	const heavy = CHECKS['start-resource-guard'](mk('archangel'));
	assert.strictEqual(heavy.pass, false, heavy.value);
	assert.ok(/sawmill/.test(heavy.items[0]) && /tier 7/.test(heavy.items[0]), heavy.items[0]);
	assert.strictEqual(heavy.nums.bad, 1);
});

test('start-resource-guard: a wood pile with a tier 7 guard is counted but does not fail the map (the engine does it in 1.4% of cases), a stack that does not control it is not counted, and one beyond N tiles of the start is not read', () => {
	const near = withStart(fake(60, 60, [town(10, 10), woodPile(13, 12), stack(13, 14, 'archangel')]), 10, 10);
	const nr = CHECKS['start-resource-guard'](near);
	assert.strictEqual(nr.nums.pilesBad, 1, nr.value);
	assert.strictEqual(nr.nums.minesBad, 0);
	const aside = withStart(fake(60, 60, [town(10, 10), woodPile(13, 12), stack(13, 20, 'archangel')]), 10, 10);
	assert.strictEqual(CHECKS['start-resource-guard'](aside).nums.pilesBad, 0);
	const far = withStart(fake(80, 80, [town(10, 10), sawmill(40, 12), stack(40, 14, 'archangel')]), 10, 10);
	assert.strictEqual(CHECKS['start-resource-guard'](far).skipped, 'no primary resource near a start');
	assert.strictEqual(CHECKS['start-resource-guard'](withStart(fake(60, 60, [town(10, 10)]), 10, 10)).skipped, 'no primary resource near a start');
});

test('guard-blocked: a stack walled in on all eight sides fails, one with a free neighbour passes', () => {
	const wall = (x, y) => ({ l: 0, cls: 'other', type: 'rock', at: [x, y], x, y, entr: [[x, y]], cells: [[x, y]], visitable: false, template: { mask: ['B'] } });
	const ring = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 0], [-1, 1]];
	const sealed = fake(30, 30, [stack(10, 10, 'enchanter'), ...ring.map(([dx, dy]) => wall(10 + dx, 10 + dy))]);
	const bad = CHECKS['guard-blocked'](sealed);
	assert.strictEqual(bad.pass, false, bad.value);
	assert.strictEqual(bad.nums.sealed, 1);
	assert.ok(/enchanter/.test(bad.items[0]) && /no free neighbour/.test(bad.items[0]), bad.items[0]);
	const open = fake(30, 30, [stack(10, 10, 'enchanter'), ...ring.slice(1).map(([dx, dy]) => wall(10 + dx, 10 + dy))]);
	assert.strictEqual(CHECKS['guard-blocked'](open).pass, true);
});

test('guard-blocked: a stack under the picture of a blocking crater drawn after it fails (K 10-14 enchanter behind a crater), one off the picture passes', () => {
	// the crater at (20,20) has its picture on x 18..20, y 19..20; its top left cell (18,19) is passable (V), so a stack can stand there and be drawn over
	const under = fake(40, 40, [crater(20, 20), stack(18, 19, 'enchanter')]);
	const bad = CHECKS['guard-blocked'](under);
	assert.strictEqual(bad.pass, false, bad.value);
	assert.strictEqual(bad.nums.hidden, 1);
	assert.ok(/enchanter/.test(bad.items[0]) && /crater/.test(bad.items[0]), bad.items[0]);
	assert.strictEqual(CHECKS['guard-blocked'](fake(40, 40, [crater(20, 20), stack(25, 25, 'enchanter')])).pass, true);
	// a stack on the tile right of the picture (21,19) is beside the crater and is seen
	assert.strictEqual(CHECKS['guard-blocked'](fake(40, 40, [crater(20, 20), stack(21, 19, 'enchanter')])).pass, true);
	assert.strictEqual(CHECKS['guard-blocked'](fake(40, 40, [stack(5, 5, 'pikeman')])).pass, true);
	assert.strictEqual(CHECKS['guard-blocked'](fake(40, 40, [town(5, 5)])).skipped, 'no monster stacks');
});
