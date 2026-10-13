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
