/**
 * river-road.test.js - rivers over roads (S345, K 2026-11-19: "rivers should generally avoid roads, or perhaps run under them, but they should never run longwise
 * under a road, that looks awful"). On a finished map no river tile that shares a tile with a road touches another such tile (a crossing is one tile at a time);
 * VMAPGEN_RIVER_ROAD=0 is the earlier routing, which ran rivers along roads for many tiles.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv } = require('./_vcmi');
const { readVmap } = require('../src/preview/render');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'src', 'main', 'generate-cli.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'river-road-'));
const RIVERS = new Set(['rw', 'ri', 'rm', 'rl', 'ra', 'lr', 'ww', 'ut', 'pw', 'sr']);
const FLIPS = new Set(['_', '-', '|', '+']);
function layers(code) {
	code = String(code);
	let i = 2;
	while (i < code.length && /[0-9]/.test(code[i])) i++;
	if (FLIPS.has(code[i])) i++;
	const out = [];
	while (i + 2 < code.length) {
		const kind = code.slice(i, i + 2);
		let j = i + 2;
		while (j < code.length && /[0-9]/.test(code[j])) j++;
		if (!FLIPS.has(code[j])) break;
		out.push(kind);
		i = j + 1;
	}
	return out;
}
// river tiles on a road: how many, and how many of them touch (4 steps) another such tile
function count(file) {
	let river = 0, shared = 0, touching = 0;
	for (const lv of readVmap(file).levels) {
		const H = lv.rows.length, W = lv.rows[0].length, both = new Uint8Array(W * H);
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			const L = layers(lv.rows[y][x]), r = L.some(k => RIVERS.has(k)), d = L.some(k => !RIVERS.has(k));
			if (r) river++;
			if (r && d) { both[y * W + x] = 1; shared++; }
		}
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
			if (both[y * W + x] && [[1, 0], [0, 1]].some(([dx, dy]) => x + dx < W && y + dy < H && both[(y + dy) * W + x + dx])) touching++;
	}
	return { river, shared, touching };
}
function make(name, seed, env) {
	const out = path.join(dir, name + '.vmap');
	const r = spawnSync(process.execPath, [CLI, '--w', '108', '--h', '108', '--players', '4', '--seed', String(seed), '--out', out],
		{ encoding: 'utf8', cwd: ROOT, env: { ...genEnv(), ...env }, windowsHide: true, timeout: 280000 });
	assert.strictEqual(r.status, 0, r.stderr);
	return out;
}

test('a river crosses a road one tile at a time and never runs along it', () => {
	for (const seed of [1, 3]) {
		const c = count(make('on' + seed, seed));
		assert.ok(c.river > 100, `seed ${seed}: the map has its rivers (${c.river} tiles)`);
		assert.strictEqual(c.touching, 0, `seed ${seed}: ${c.touching} river tiles on a road touch another`);
	}
});

test('VMAPGEN_RIVER_ROAD=0 is the earlier routing: rivers run along roads', () => {
	const c = count(make('off1', 1, { VMAPGEN_RIVER_ROAD: '0' }));
	assert.ok(c.touching > 10, `the control map has runs along roads (${c.touching})`);
});
