/**
 * pickup-off-water.test.js - no land pickup is left standing on water (MapGen Dev's water-objects on 3b5987a: a Pandora's box on the sea
 * beside a shipyard, coast108 seed 1 (89,18), and a treasure chest on the sea, coast108 seed 2 (66,71)). plan.js clearEntranceShadow moves
 * a pickup on water to a dry tile within two steps, or takes it off whatever it is worth. VMAPGEN_SHADOW_LATE is not read here: the
 * function is called directly, so the test fails if the water rule is taken out of it.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { clearEntranceShadow } = require('../src/biome/plan');
const { OCCUPIED, blockingCells } = require('../src/biome/content');
const { pileTemplate } = require('../src/biome/economy');

const W = 12, H = 10;
const lake = () => {
	// water on the right half, x >= 6
	const water = new Uint8Array(W * H), blocked = new Uint8Array(W * H);
	for (let y = 0; y < H; y++) for (let x = 6; x < W; x++) { water[y * W + x] = 1; blocked[y * W + x] = OCCUPIED; }
	return { water, blocked };
};
const pile = (type, x, y) => ({ type, subtype: type, x, y, l: 0, template: pileTemplate('randomResource'), instanceName: `${type}_${x}_${y}_0` });

test('a pickup on water beside the shore moves onto dry ground', () => {
	const { water, blocked } = lake();
	const o = pile('pandoraBox', 6, 5);
	const pl = { objects: [o], p: { water }, roadCells: new Set() };
	const r = clearEntranceShadow(pl, 0, W, H, blocked);
	assert.strictEqual(r.moved, 1);
	assert.ok(blockingCells(o.template, o.x, o.y).every(([x, y]) => !water[y * W + x]), `now at (${o.x},${o.y})`);
});

test('a pickup on water with no dry tile within two steps is taken off, dear or not', () => {
	const { water, blocked } = lake();
	const o = pile('pandoraBox', 10, 5);
	const pl = { objects: [o], p: { water }, roadCells: new Set() };
	const r = clearEntranceShadow(pl, 0, W, H, blocked);
	assert.strictEqual(r.dropped, 1);
	assert.strictEqual(pl.objects.length, 0);
});

const guard = (x, y) => ({ type: 'randomMonsterLevel3', subtype: 'object', x, y, l: 0, template: { animation: 'AVWmrnd0', mask: ['VV', 'VA'] }, options: { amount: 10 } });

test('the guard of a pickup taken off water goes with it when it watches nothing else', () => {
	// the lead, 2026-10-13: the guard (88,18) beside coast108 seed 1's Pandora on the sea stood by nothing once the box went
	const { water, blocked } = lake();
	const o = pile('pandoraBox', 10, 5), g = guard(9, 5);
	const pl = { objects: [o, g], p: { water }, roadCells: new Set(), zone: new Int16Array(W * H) };
	const r = clearEntranceShadow(pl, 0, W, H, blocked);
	assert.strictEqual(r.dropped, 1);
	assert.strictEqual(r.guards, 1);
	assert.deepStrictEqual(pl.objects, []);
});

test('a guard on a zone line stays, a doorway is still guarded', () => {
	const { water, blocked } = lake();
	const o = pile('pandoraBox', 10, 5), g = guard(9, 5);
	const zone = new Int16Array(W * H);
	for (let c = 0; c < W * H; c++) if (c % W >= 9) zone[c] = 1;
	const pl = { objects: [o, g], p: { water }, roadCells: new Set(), zone };
	clearEntranceShadow(pl, 0, W, H, blocked);
	assert.deepStrictEqual(pl.objects, [g]);
});
