/**
 * harvest_object_terrains.js - which ground each object's art stands on in real maps.
 *
 * K, 2026-09-30: a cold (frost) magic well and a lean-to on dirt and lava biomes. The
 * game's own object table gives most buildings several templates, one per ground
 * (a frost well for snow, a plain one for grass), and the engine takes the one the
 * ground allows. Our templates were harvested one per type, so a type drew whichever
 * art the harvest kept. This reads the installed real maps (the same corpus the other
 * rates came from) and writes, per art (animation), how many times it stood on each
 * terrain, so a placement can take the art that real maps put on that ground.
 *
 * Usage: node tools/harvest_object_terrains.js [corpus folder] [--out src/biome/objectTerrains.json]
 * Needs VCMI_ROOT (terrain short codes come from the install's own config).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { readVmap, parseTileCode } = require('../src/preview/render');
const { loadIndex } = require('./map_metrics');

const DECOR = /^(mountain|trees?|rock|decor|obstacle|pineTrees|oakTrees|dirtHills|grassHills|shrub|flowers|lake|crater|mushrooms|deadVegetation|stump|lavaFlow|lavaLake|outcropping|canyon|log|swampFoliage|snowHills|roughHills|sandDune|volcano|mdtBarrels|ptbones|bones|corpse|subterraneanRocks|wastelandsFissures|cactus|reef|kelp|flotsam)$/i;

// pickups and guards carry no terrain-specific art, and chests and banks have their own template tables
const SKIP = /^(monster|randomMonster|resource|randomResource|randomArtifact|artifact|spellScroll|treasureChest|creatureBank|dragonUtopia|crypt|randomTown|town)/i;

function harvest(dir) {
	const index = loadIndex();
	const bare = s => String(s || '').slice(String(s || '').lastIndexOf(':') + 1).toLowerCase();
	const shortToTerrain = new Map();
	for (const [short, t] of index.terrains) shortToTerrain.set(short, bare(t.identifier || t.name));
	const out = {};
	let maps = 0;
	for (const f of fs.readdirSync(dir).filter(f => /\.vmap$/i.test(f)).sort()) {
		const { objects, levels } = readVmap(path.join(dir, f));
		maps++;
		const rows = levels.map(l => l.rows);
		for (const o of objects) {
			if (!o.template || !o.template.animation || DECOR.test(o.type) || SKIP.test(o.type)) continue;
			const l = o.l || 0;
			const code = rows[l] && rows[l][o.y] && rows[l][o.y][o.x];
			if (!code) continue;
			const terr = shortToTerrain.get(parseTileCode(code).terr);
			if (!terr) continue;
			const key = String(o.template.animation).toLowerCase();
			const e = out[key] || (out[key] = { type: o.type, subtype: o.subtype, n: 0, terrains: {},
				mask: o.template.mask, visitableFrom: o.template.visitableFrom });
			e.n++;
			e.terrains[terr] = (e.terrains[terr] || 0) + 1;
		}
	}
	// how often each terrain carries an object at all, to tell a ground a type avoids from one it
	// merely had no chance at (terrainArt.js)
	const totals = {};
	for (const e of Object.values(out)) for (const [t, c] of Object.entries(e.terrains)) totals[t] = (totals[t] || 0) + c;
	for (const k of Object.keys(out)) if (out[k].n < 3) delete out[k];
	return { maps, art: out, totals };
}

if (require.main === module) {
	const args = process.argv.slice(2);
	const oi = args.indexOf('--out');
	const outFile = oi >= 0 ? args[oi + 1] : null;
	const dir = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out')
		|| path.join(__dirname, '..', 'corpus', 'MapsArchive', 'RandomMaps');
	const { maps, art, totals } = harvest(dir);
	const doc = { _provenance: `read from ${maps} real maps in corpus/MapsArchive/RandomMaps by tools/harvest_object_terrains.js; `
		+ 'per art (lowercase animation): the object it was on and how many times it stood on each core terrain',
		totals, art };
	if (outFile) { fs.writeFileSync(outFile, JSON.stringify(doc, null, 1)); console.log('wrote', outFile, Object.keys(art).length, 'arts from', maps, 'maps'); }
	else console.log(JSON.stringify(doc, null, 1));
}

module.exports = { harvest };
