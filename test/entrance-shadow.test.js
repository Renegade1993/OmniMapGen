/**
 * entrance-shadow.test.js - a tile under a monolith's or a gate's picture is no way in (K, 2026-10-11, "two-way monolith blocking nearby
 * gem pond"; his small Coldshadow seed 876637007 regenerated: an ore pit (12,2), a gold mine (19,18) and one more object with every open
 * way in under a gate's or monolith's picture, none after). content.js entranceOpen skips a shadowed tile; plan.js fillLevel marks every
 * cell of a monolith's and a gate's picture (markShadow) before the fill, and the fill lays nothing whose picture touches one.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { entranceOpen, pictureOnShadow, markShadow, OCCUPIED } = require('../src/biome/content');
const { mineTemplate, pileTemplate } = require('../src/biome/economy');

const W = 10, H = 10;

test('a mine whose only open way in lies under an entrance picture has no entrance (VMAPGEN_FILL_SHADOW=1)', { skip: process.env.VMAPGEN_FILL_SHADOW !== '1' }, () => {
	const tpl = mineTemplate('orePit'), blocked = new Uint8Array(W * H);
	// the ore pit at (5,5): visiting tile (4,5), entered from (3,5), (5,5) and the row below; all but (4,6) walled
	for (const [x, y] of [[3, 5], [3, 6], [5, 6]]) blocked[y * W + x] = OCCUPIED;
	assert.ok(entranceOpen(tpl, 5, 5, 0, W, H, blocked, null), 'open while (4,6) is plain ground');
	markShadow(blocked, 6 * W + 4);
	assert.ok(!entranceOpen(tpl, 5, 5, 0, W, H, blocked, null), 'shut once (4,6) is under a picture');
});

test('a pile on a tile under an entrance picture is seen as drawn into it', () => {
	const tpl = pileTemplate('randomResource'), blocked = new Uint8Array(W * H);
	assert.ok(!pictureOnShadow(tpl, 4, 4, 0, W, H, blocked));
	markShadow(blocked, 4 * W + 4);
	assert.ok(pictureOnShadow(tpl, 4, 4, 0, W, H, blocked));
});

test("an unguarded prison under a gate's picture moves out of it, inside its own zone", () => {
	// K, 2026-10-12: "prison is inaccesible in my start biome" (his seed 876637007: the prison (12,4), 4 of its tiles and 5 of its 6
	// ways in under the subterranean gate (13,5)'s picture); plan.js clearEntranceShadow moves it up to six tiles within its zone
	const { clearEntranceShadow } = require('../src/biome/plan');
	const W2 = 16, H2 = 10, blocked = new Uint8Array(W2 * H2);
	const prison = { type: 'prison', subtype: 'object', x: 4, y: 4, l: 0, template: pileTemplate('randomResource'), instanceName: 'prison_4_4_0' };
	for (let y = 2; y <= 6; y++) for (let x = 2; x <= 6; x++) if (!(x === 4 && y === 4)) markShadow(blocked, y * W2 + x);
	markShadow(blocked, 4 * W2 + 4);
	const pl = { objects: [prison], p: {}, roadCells: new Set(), zone: new Int16Array(W2 * H2) };
	const r = clearEntranceShadow(pl, 0, W2, H2, blocked);
	assert.strictEqual(r.moved, 1);
	assert.ok(!pictureOnShadow(prison.template, prison.x, prison.y, 0, W2, H2, blocked), `prison at (${prison.x},${prison.y})`);
});

test("two prisons moved out of a gate's picture: the second's picture covers none of the first's tiles", () => {
	// the Opus Reviewer, pass 48 (2026-10-14): clearEntranceShadow never counted a moved pickup's new tiles as taken, so a second one moved
	// after it could land with its picture over the first
	const { clearEntranceShadow } = require('../src/biome/plan');
	const W2 = 20, H2 = 12, blocked = new Uint8Array(W2 * H2);
	const tpl = { animation: 'AVXprison', mask: ['VVV', 'VBA'], visitableFrom: ['+++', '+-+', '+++'] };
	// rows 0 to 6 are under the picture; the first lands at (4,8), and the second's first free tile (6,8) would draw over its door (4,8)
	const a = { type: 'prison', subtype: 'object', x: 10, y: 2, l: 0, template: tpl, instanceName: 'prison_10_2_0' };
	const b = { type: 'prison', subtype: 'object', x: 10, y: 4, l: 0, template: tpl, instanceName: 'prison_10_4_0' };
	for (let y = 0; y <= 6; y++) for (let x = 0; x < W2; x++) markShadow(blocked, y * W2 + x);
	const pl = { objects: [a, b], p: {}, roadCells: new Set(), zone: new Int16Array(W2 * H2) };
	const r = clearEntranceShadow(pl, 0, W2, H2, blocked);
	assert.strictEqual(r.moved, 2);
	const cells = (o, re) => { const out = []; o.template.mask.forEach((row, i) => [...row].forEach((ch, j) => { if (re.test(ch)) out.push((o.y - (o.template.mask.length - 1 - i)) * W2 + o.x - (row.length - 1 - j)); })); return out; };
	const solidA = new Set(cells(a, /[BA]/)), solidB = new Set(cells(b, /[BA]/));
	assert.ok(!cells(b, /[VBA]/).some(c => solidA.has(c)) && !cells(a, /[VBA]/).some(c => solidB.has(c)), `a at (${a.x},${a.y}), b at (${b.x},${b.y})`);
});

test("a guarded major under a gate's picture with its guard's ring all under it moves with its guard", () => {
	// brief item 3 (2026-10-14): K's 876637007 kept a major artifact under the gate (28,26)'s picture, nowhere free in its guard's ring;
	// clearEntranceShadow moves the two together, up to four tiles in its zone, the guard beside it over its open ways in
	const { clearEntranceShadow } = require('../src/biome/plan');
	const W2 = 20, H2 = 12, blocked = new Uint8Array(W2 * H2);
	const tpl = pileTemplate('randomResource');
	const major = { type: 'randomArtifactMajor', subtype: 'object', x: 5, y: 5, l: 0, template: tpl, instanceName: 'major_5_5_0' };
	const guard = { type: 'randomMonster', subtype: 'object', x: 6, y: 5, l: 0, template: tpl, instanceName: 'guard_6_5_0' };
	for (let y = 1; y <= 8; y++) for (let x = 1; x <= 7; x++) markShadow(blocked, y * W2 + x);
	blocked[5 * W2 + 6] |= OCCUPIED;
	// beyond the picture, rock but for a pocket of three tiles, (8,4), (8,5) and (9,5): one guard there takes every way in, as on K's map
	for (let y = 0; y < H2; y++) for (let x = 8; x < W2; x++) if (!((x === 8 && (y === 4 || y === 5)) || (x === 9 && y === 5))) blocked[y * W2 + x] |= OCCUPIED;
	const pl = { objects: [major, guard], p: {}, roadCells: new Set(), zone: new Int16Array(W2 * H2) };
	const r = clearEntranceShadow(pl, 0, W2, H2, blocked);
	assert.strictEqual(r.pairs, 1, JSON.stringify(r));
	assert.ok(!pictureOnShadow(tpl, major.x, major.y, 0, W2, H2, blocked), `major at (${major.x},${major.y})`);
	assert.ok(Math.max(Math.abs(guard.x - major.x), Math.abs(guard.y - major.y)) <= 1, `guard at (${guard.x},${guard.y}), major at (${major.x},${major.y})`);
	assert.ok(pl.objects.includes(guard), 'the guard stays on the map');
	const ways = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]].map(([dx, dy]) => [major.x + dx, major.y + dy]).filter(([x, y]) => !(blocked[y * W2 + x] & OCCUPIED) && !(x === guard.x && y === guard.y));
	assert.ok(ways.every(([x, y]) => Math.max(Math.abs(x - guard.x), Math.abs(y - guard.y)) <= 1), `an open way in outside the guard's ring: ${JSON.stringify(ways)}`);
});
