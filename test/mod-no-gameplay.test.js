/**
 * mod-no-gameplay.test.js - OmniMapGen changes no gameplay, as VCMI judges it.
 *
 * In a network lobby only the host generates, and the server sends every
 * player the whole game; a friend needs neither the generator nor the mod,
 * because VCMI counts a mod as changing gameplay only when its mod.json has one
 * of the keys ModDescription::affectsGameplay tests (DMB Dev, rc.2). Templates,
 * translations and the mapGenerator section are not among them. If this mod
 * ever took one on, every friend would need it installed to join.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// ModDescription::affectsGameplay (lib/modding/ModDescription.cpp), VCMI 1.7
const GAMEPLAY_KEYS = ['artifacts', 'battlefields', 'creatures', 'factions', 'heroClasses', 'heroes',
	'objects', 'obstacles', 'mapLayers', 'rivers', 'roads', 'settings', 'skills', 'spells', 'terrains'];

test('mod.json has none of the keys VCMI treats as gameplay', () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mod', 'mod.json'), 'utf8'));
	assert.deepStrictEqual(GAMEPLAY_KEYS.filter(k => Object.prototype.hasOwnProperty.call(manifest, k)), [],
		'a gameplay key would make every player in a network game need the mod');
	assert.ok(manifest.mapGenerator && manifest.translations && manifest.templates, 'the three it does carry');
});
