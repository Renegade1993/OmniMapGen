/**
 * artifact-art.test.js - a concrete artifact wears its own art (C6: K found a
 * Helm of the Alabaster Unicorn drawn as the random artifact's "ART" token).
 * H3's templates as OBJECTS.TXT gives them (h3data.js h3ObjectTemplates), and
 * the pass that puts them on the map's concrete artifacts (artifactArt.js).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { h3ObjectTemplates } = require('../src/parser/h3data');
const { giveArtifactsTheirArt } = require('../src/main/artifactArt');
const { testTmp } = require('./_vcmi');

test('H3 templates from OBJECTS.TXT: an artifact is visitable from every side, a bank from the front and sides', () => {
	const root = path.join(testTmp(), 'h3objects');
	fs.mkdirSync(path.join(root, 'Data'), { recursive: true });
	fs.mkdirSync(path.join(root, 'Sprites'), { recursive: true });
	// the engine's 8x6 grid, its first cell the object's own (blocked and visitable)
	const block = '0' + '1'.repeat(47), visit = '1' + '0'.repeat(47);
	const lines = [
		`AVA0019.def ${block} ${visit} 111111111 000000000 5 19 4 0`,
		`AVA0019b.def ${block} ${visit} 111111111 000000000 5 19 4 0`,
		`AVA0020.def ${block} ${visit} 111111111 000000000 5 20 4 0`,
		`AVCBANK.def ${block} ${visit} 111111111 000000000 16 0 1 0`,
	];
	fs.writeFileSync(path.join(root, 'Data', 'OBJECTS.TXT'), `${lines.length}\r\n${lines.join('\r\n')}\r\n`);
	fs.writeFileSync(path.join(root, 'Sprites', 'AVA0019.MSK'), Buffer.from([2, 1]));
	const arts = h3ObjectTemplates([root], 5);
	assert.strictEqual(arts.size, 2, 'object 5 only');
	// the first line of a subtype is its default; the sprite's .msk trims the grid
	assert.deepStrictEqual(arts.get(19), { animation: 'AVA0019', mask: ['VA'], visitableFrom: ['+++', '+-+', '+++'] });
	assert.deepStrictEqual(h3ObjectTemplates([root], 16).get(0).visitableFrom, ['---', '+-+', '+++']);
});

test('a concrete artifact goes out with its own art, never the random artifact token', () => {
	const token = () => ({ animation: 'AVArand', mask: ['VV', 'VA'], visitableFrom: ['+++', '+-+', '+++'] });
	const objects = [
		{ type: 'artifact', subtype: 'helmOfTheAlabasterUnicorn', template: token() },
		{ type: 'artifact', subtype: 'noSuchArtifact', template: token() },
		{ type: 'artifact', subtype: 'hota:ringOfSuppression', template: { animation: 'hota/artifactsMap/AVA0156', mask: ['VA'] } },
		{ type: 'artifact', subtype: 'mymod:hat', template: token() },
		{ type: 'randomArtifactMinor', subtype: 'object', template: token() },
	];
	const artifacts = new Map([
		['core:helmOfTheAlabasterUnicorn', { h3Index: 19 }],
		['hota:ringOfSuppression', { mapArt: 'hota/artifactsMap/AVA0156.def' }],
		['mymod:hat', { mapArt: 'artifacts/hat/adventure.def' }],
	]);
	const h3Arts = new Map([[19, { animation: 'AVA0019', mask: ['VA'], visitableFrom: ['+++', '+-+', '+++'] }]]);
	assert.deepStrictEqual(giveArtifactsTheirArt(objects, artifacts, h3Arts), { fixed: 2, rolled: 1 });
	assert.deepStrictEqual(objects[0].template.mask, ['VA']);
	assert.strictEqual(objects[0].template.animation, 'AVA0019', 'a core artifact: H3\'s own art by its number');
	assert.strictEqual(objects[1].type, 'randomArtifact', 'no art known: a random artifact, which the engine draws');
	assert.strictEqual(objects[2].template.animation, 'hota/artifactsMap/AVA0156', 'art of its own stays');
	assert.strictEqual(objects[3].template.animation, 'artifacts/hat/adventure', 'a mod\'s art from its config');
	assert.strictEqual(objects[4].template.animation, 'AVArand', 'a random artifact keeps the token the engine replaces');
	assert.ok(!objects.some(o => o.type === 'artifact' && /^avarand$/i.test(o.template.animation)));
});
