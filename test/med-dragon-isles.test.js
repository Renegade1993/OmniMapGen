/**
 * med-dragon-isles.test.js - on a one-level Mediterranean the template's dragon junctions are islands in the middle of the sea (K,
 * 2026-10-12, his XL Mediterranean on Coldshadow's Fantasy: "Coldshadow dragon junctions are on the edges. Would prefer these either as
 * a large single island or four smaller ones in the middle"). Each junction's land lies on pieces off the map's edge that hold no other
 * zone's land, and every dragon dwelling stands within 30% of the side from the centre. Before: the junctions were on the land ring, and
 * a first try at islands gave three of the four islands to treasure zones and an unplayed start (water.js adoptWater, generate.js
 * isleAnchors, plan.js chooseTemplateLayout heldIsle, 2026-10-14).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const sight = require('../tools/mapsight/lib/sight');

const DRAGON = /^(frozenCliffs|crystalCavern|magicForest|sulfurousLair)$/i;

test('one-level Mediterranean on Coldshadow: each dragon junction is an island of its own in the middle', { timeout: 290000 }, () => {
	const out = path.join(testTmp(), 'vmapgen_med_isles.vmap');
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--out', out, '--declaremods', '0',
		'--template', "Coldshadow's Fantasy", '--w', '108', '--h', '108', '--players', '4', '--seed', '11', '--underground', '0',
		'--factions', 'random,random,random,random', '--bio.waterShape', '3', '--bio.waterCoverage', '0.45', '--bio.waterContent', '1'],
	{ encoding: 'utf8', timeout: 260000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	const M = sight.load(out), W = M.W, H = M.H, N = W * H;
	const zj = JSON.parse(fs.readFileSync(out + '.zones.json', 'utf8')), typeOf = new Map();
	for (const lv of zj.levels || []) (lv.templateIds || []).forEach((id, k) => typeOf.set(id, lv.templateTypes[k]));
	// land pieces, and whether each reaches the map's edge
	const piece = new Int32Array(N).fill(-1), edge = [];
	for (let s = 0; s < N; s++) {
		if (!M.ground(s) || piece[s] >= 0) continue;
		const id = edge.length, q = [s];
		piece[s] = id;
		let e = false;
		for (let h = 0; h < q.length; h++) {
			const c = q[h], x = c % W, y = (c / W) | 0;
			if (!x || !y || x === W - 1 || y === H - 1) e = true;
			for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
				const u = x + dx, v = y + dy;
				if (u < 0 || v < 0 || u >= W || v >= H) continue;
				const n = v * W + u;
				if (M.ground(n) && piece[n] < 0) { piece[n] = id; q.push(n); }
			}
		}
		edge.push(e);
	}
	const junctions = [...typeOf].filter(([, t]) => t === 'junction').map(([id]) => id);
	assert.strictEqual(junctions.length, 4, 'four junction zones');
	const onPiece = new Map(), mainland = new Map(), isles = new Set();
	for (let c = 0; c < N; c++) {
		if (!M.ground(c)) continue;
		const z = M.zoneAt(0, c % W, (c / W) | 0);
		if (edge[piece[c]]) { mainland.set(z, (mainland.get(z) || 0) + 1); continue; }
		const k = piece[c];
		if (!onPiece.has(k)) onPiece.set(k, new Map());
		onPiece.get(k).set(z, (onPiece.get(k).get(z) || 0) + 1);
	}
	for (const z of junctions) {
		assert.ok((mainland.get(z) || 0) <= 5, `junction ${z} has ${mainland.get(z)} tiles on the land ring`);
		let own = 0;
		for (const [k, m] of onPiece) if (m.has(z)) { own += m.get(z); isles.add(k); }
		assert.ok(own >= 100, `junction ${z} has ${own} tiles of island`);
	}
	for (const k of isles) for (const [z, n] of onPiece.get(k)) assert.ok(junctions.includes(z) || n <= 5, `zone ${z} (${typeOf.get(z)}) has ${n} tiles on a dragon island`);
	const dw = M.objs.filter(o => /^creatureGenerator/.test(o.type) && DRAGON.test(o.subtype || ''));
	for (const o of dw) assert.ok(Math.hypot(o.at[0] - W / 2, o.at[1] - H / 2) <= 0.3 * W, `${o.subtype} at (${o.at}) far from the middle`);
});
