/**
 * measure.js - what a map holds, the same way for the engine's maps and ours.
 *
 * measureRun(side, base, L) reads <base>.vmap (and the zone sidecar of its side) and returns
 *   map:     the tools/map_metrics.js measures (roads at entrances, dwellings by faction, prisons, guards, ...)
 *   classes: objects by class per 1000 land tiles (town, mine, bank, dwelling, monster by tier, artifact, ...)
 *   zones:   template zone id -> { tiles, type, town, objects: { "type:subtype": n } }
 *   hist:    the whole map's { "type:subtype": n }
 * Both sides write the same keys: a monster is "monster:L<tier>" (the engine's concrete creature or our
 * placeholder, by its level), a random artifact is "artifact:any", everything else its own type:subtype.
 * Zones are the template's own ids, so a zone of the engine's map and the same zone of ours meet.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { readVmap, parseTileCode } = require('../../src/preview/render');
const { analyse } = require('../map_metrics');
const { visitableCells } = require('../../src/biome/content');

const bare = s => String(s || '').slice(String(s || '').lastIndexOf(':') + 1).toLowerCase();

function keyOf(o, L) {
	const t = String(o.type), st = o.subtype === undefined ? 'object' : String(o.subtype);
	let m = t.match(/^randomMonsterLevel([1-7])$/);
	if (m) return `monster:L${m[1]}`;
	if (t === 'monster') {
		const c = L.creatureByBare.get(bare(st));
		return `monster:L${c && c.level ? c.level : '?'}`;
	}
	if (/^randomArtifact/.test(t) || t === 'artifact') return 'artifact:any';
	if (t === 'randomResource') return 'resource:random';
	if (t === 'randomTown') return 'town:random';
	if (t === 'randomDwelling') return 'creatureGeneratorCommon:random';
	return `${t}:${st}`;
}

const CLASS = [
	['town', /^town:/], ['mine', /^mine:/], ['bank', /^(creatureBank|dragonUtopia|crypt|derelictShip|shipwreck):/],
	['dwelling', /^creatureGenerator/], ['monster', /^monster:/], ['artifact', /^artifact:/],
	['pandora', /^pandoraBox:/], ['prison', /^prison:/], ['resource', /^(resource|randomResource):/],
	['chest', /^treasureChest:/], ['campfire', /^campfire:/], ['scroll', /^spellScroll:/],
	['quest', /^(seerHut|questGuard|keymasterTent|borderGuard|borderGate):/], ['gate', /^(subterraneanGate|monolithTwoWay|townGate):/],
	['boat', /^(boat|shipyard):/], ['obelisk', /^obelisk:/], ['hero', /^(hero|randomHero):/],
];
const DECOR = /^(mountain|trees?|rock|pineTrees|oakTrees|dirtHills|grassHills|shrub|flowers|lake|crater|mushrooms|deadVegetation|stump|lavaFlow|lavaLake|outcropping|canyon|log|swampFoliage|snowHills|roughHills|sandDune|volcano|mdtBarrels|ptbones|bones|corpse|subterraneanRocks|wastelandsFissures|cactus|reef|kelp|palms|mound|barchanDunes|frozenLake|wstNaturalArch)/i;

function classOf(key) {
	for (const [name, re] of CLASS) if (re.test(key)) return name;
	return DECOR.test(key) ? 'decor' : 'building';
}

function measureRun(side, base, L) {
	const file = base + '.vmap';
	const map = analyse(file, L);
	const { objects, levels } = readVmap(file);
	const W = levels[0].rows[0].length, H = levels[0].rows.length;
	let land = 0;
	for (const lv of levels) for (const row of lv.rows) for (const c of row) { const t = parseTileCode(c).terr; if (t !== 'wt' && t !== 'rc') land++; }
	const hist = {}, classes = {};
	for (const o of objects) {
		const k = keyOf(o, L);
		hist[k] = (hist[k] || 0) + 1;
		const c = classOf(k);
		classes[c] = (classes[c] || 0) + 1;
	}
	for (const c of Object.keys(classes)) classes[c] = 1000 * classes[c] / Math.max(1, land);
	const zones = {};
	let tpl = null;
	if (side === 'engine') {
		const z = JSON.parse(fs.readFileSync(base + '.zones.json', 'utf8'));
		tpl = { asked: z.template, used: z.templateUsed || null, zones: z.templateZones || null };
		for (const q of z.zones) {
			const objs = {};
			for (const [k, n] of Object.entries(q.objects || {})) {
				const [t, st] = k.split(':');
				const kk = keyOf({ type: t, subtype: st }, L);
				objs[kk] = (objs[kk] || 0) + n;
			}
			zones[q.id] = { tiles: q.tiles, type: q.type, town: q.townType, owner: q.owner === undefined ? null : q.owner, objects: objs };
		}
	} else {
		const dump = JSON.parse(fs.readFileSync(base + '.zonedump.json', 'utf8'));
		const idOf = (l, c) => { const lv = dump[l]; if (!lv || !lv.zone) return null; const idx = lv.zone[c]; return lv.ids && lv.ids[idx] !== undefined ? lv.ids[idx] : null; };
		for (let l = 0; l < dump.length; l++) {
			const lv = dump[l];
			if (!lv || !lv.zone) continue;
			for (let c = 0; c < lv.zone.length; c++) {
				const id = idOf(l, c);
				if (id === null) continue;
				const e = zones[id] || (zones[id] = { tiles: 0, type: null, town: null, owner: null, objects: {} });
				e.tiles++;
			}
		}
		for (const o of objects) {
			if (!o.template || !o.template.mask) continue;
			const l = o.l || 0;
			let x = o.x, y = o.y;
			const v = visitableCells(o.template, o.x, o.y)[0];
			if (v) [x, y] = v;
			if (x < 0 || y < 0 || x >= W || y >= H) continue;
			const id = idOf(l, y * W + x);
			if (id === null || !zones[id]) continue;
			const k = keyOf(o, L);
			zones[id].objects[k] = (zones[id].objects[k] || 0) + 1;
		}
	}
	return { side, w: W, h: H, levels: levels.length, land, map, classes, zones, hist, tpl };
}

module.exports = { measureRun, keyOf, classOf };
