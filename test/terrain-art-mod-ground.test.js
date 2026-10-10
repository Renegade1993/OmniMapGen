/**
 * terrain-art-mod-ground.test.js - ground a mod adds does not get an art that belongs to another ground.
 *
 * K, 2026-10-03/04: "still seeing the frozen well in a highlands biome". The corpus knows the eight core grounds, and for
 * anything else terrainArt.js used to keep the art asked for, so a snow-only well (AVXwlsn0, 63 of 63 sightings on snow)
 * stood on highlands, wasteland and deadland. On mod ground a type now keeps an art that real maps stood on at least four
 * core grounds, takes one of those otherwise, and is refused when it has none; what a map cannot do without keeps its art.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { artFor, artNeutral, essential } = require('../src/biome/terrainArt');

const snowWell = { animation: 'AVXwlsn0' };
const rng = () => 0.5;

test('a snow well on mod ground becomes an art that stands on many grounds', () => {
	for (const ground of ['hl', 'ws', 'dl', 'pl', 'dn']) {
		const art = artFor('magicWell', 'magicWell', snowWell, ground, rng);
		assert.ok(art === null || artNeutral(art.animation) === true, ground);
		assert.notStrictEqual(art && String(art.animation).toLowerCase(), 'avxwlsn0', ground);
	}
});

test('an art with no neutral choice is refused on mod ground', () => {
	assert.strictEqual(artFor('stables', 'stables', { animation: 'AVXstbl0' }, 'dl', rng), null);
});

test('what a map cannot do without keeps its art on mod ground', () => {
	const mine = { animation: 'AVMsawl0' };
	assert.strictEqual(artFor('mine', 'sawmill', mine, 'hl', rng), mine);
	assert.ok(essential('subterraneanGate') && essential('creatureGenerator') && essential('monolith'));
});

test('an art from a mod folder is kept on mod ground', () => {
	const arch = { animation: 'hota/wasteland/vanillaStatic/mountains/AVLMtWL7' };
	assert.strictEqual(artFor('wstNaturalArch', 'wstNaturalArch', arch, 'ws', rng), arch);
});

test('VMAPGEN_MOD_GROUND_ART=0 keeps the art asked for', () => {
	process.env.VMAPGEN_MOD_GROUND_ART = '0';
	try { assert.strictEqual(artFor('magicWell', 'magicWell', snowWell, 'hl', rng), snowWell); }
	finally { delete process.env.VMAPGEN_MOD_GROUND_ART; }
});

test('core ground is judged as before', () => {
	assert.strictEqual(artFor('magicWell', 'magicWell', snowWell, 'gr', rng).animation.toLowerCase() === 'avxwlsn0', false);
	assert.deepStrictEqual(artFor('magicWell', 'magicWell', snowWell, 'sn', rng), snowWell);
});
