'use strict';
// mod/template-info.json: what the template picker's details panel reads (K, 2026-10-05); every approved template has an entry
// whose facts match its own template file.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const info = JSON.parse(fs.readFileSync(path.join(ROOT, 'mod', 'template-info.json'), 'utf8')).templates;
const approved = JSON.parse(fs.readFileSync(path.join(ROOT, 'mod', 'approved-templates.json'), 'utf8')).approved;

test('every approved template has a details entry with its facts and a description', () => {
	for (const name of Object.keys(approved)) {
		const t = info[name];
		assert.ok(t, `${name} has no entry in template-info.json`);
		for (const k of ['originalSizeMin', 'originalSizeMax', 'originalLevels', 'playersMin', 'playersMax', 'zones'])
			assert.ok(Number.isFinite(t[k]), `${name}: ${k}`);
		assert.ok(typeof t.description === 'string' && t.description.length > 100, `${name}: description`);
		assert.ok(!/—/.test(t.description), `${name}: an em dash in the description`);
	}
});

test("Coldshadow's Fantasy's entry matches its template file", () => {
	const file = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'rmg', 'templates', 'coldshadowsFantasy.json'), 'utf8'))["Coldshadow's Fantasy"];
	const t = info["Coldshadow's Fantasy"];
	const zones = Object.values(file.zones);
	assert.strictEqual(t.zones, zones.length);
	const kind = k => zones.filter(z => z.type === k).length;
	assert.strictEqual(t.zonesByKind.start, kind('playerStart') + kind('cpuStart'));
	assert.strictEqual(t.zonesByKind.junction, kind('junction'));
	const [lo, hi] = file.players.split('-').map(Number);
	assert.strictEqual(t.playersMin, lo);
	assert.strictEqual(t.playersMax, hi);
	assert.strictEqual(t.originalSizeMin, 144);
	assert.strictEqual(t.originalSizeMax, 252);
	assert.strictEqual(t.originalLevels, 2);
});

test("Coldshadow's Fantasy's original block holds only facts its template file confirms, with sources", () => {
	const file = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'rmg', 'templates', 'coldshadowsFantasy.json'), 'utf8'))["Coldshadow's Fantasy"];
	const o = info["Coldshadow's Fantasy"].original;
	assert.ok(o, 'no original block');
	const zones = Object.values(file.zones);
	assert.strictEqual(o.humanStartZones, zones.filter(z => z.type === 'playerStart').length);
	assert.strictEqual(o.computerStartZones, zones.filter(z => z.type === 'cpuStart').length);
	assert.strictEqual(o.players.replace(' to ', '-'), file.players);
	assert.ok(/^At most 2:/.test(o.humans) && file.humans === '2', 'humans');
	assert.strictEqual(o.zones, zones.length);
	assert.ok(Array.isArray(o.source) && o.source.length >= 2 && o.source.every(s => s.what && (s.url || s.file)), 'sources');
	assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(o.checked), 'checked date');
	assert.ok(!/—/.test(JSON.stringify(o)), 'an em dash in the original block');
});
