// No pickup half hidden under another object's picture (declip.js declipPictures, judged by the pixels the game draws: pictures.js). The case
// is K's map seed 1244039256: a crystal (23,36) wholly under the crystal cavern (24,37), one row above and one tile left of its anchor. A
// mechanism test on a built plan, with the sprites of the suite's install.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { genEnv } = require('./_vcmi');
const { declipPictures } = require('../src/biome/declip');
const { blockingCells, footprintCells, FILL_TYPES } = require('../src/biome/content');
const pics = require('../src/biome/pictures');

const W = 14, H = 12;
const ROOTS = [genEnv().VCMI_ROOT, process.env.VMAPGEN_SPRITE_ROOT].filter(Boolean);
const CAVERN = { animation: 'AVMcrsn0', mask: ['VVVV', 'VVVV', 'VBAB'], visitableFrom: ['---', '+-+', '+++'] };
const CRYSTAL = { animation: 'AVTcrys0', mask: ['VA'], visitableFrom: ['+++', '+-+', '+++'] };
const entry = (type, x, y, template, name) => ({ instanceName: name || `${type}_${x}_${y}_0`, l: 0, x, y, type, subtype: 'object', template });
const blockedOf = plan => {
	const b = new Uint8Array(W * H);
	for (const o of plan.objects) for (const [x, y] of blockingCells(o.template, o.x, o.y)) b[y * W + x] |= 1;
	return b;
};
const readable = !!(pics.spriteOf(CAVERN.animation, ROOTS) && pics.spriteOf(CRYSTAL.animation, ROOTS));

test('a crystal under the crystal cavern\'s picture moves beside it, clear; a crystal in the open stays', { skip: !readable && 'sprites not in the suite install' }, () => {
	const cavern = entry('mine', 6, 6, CAVERN);
	const hidden = entry('resource', 5, 5, CRYSTAL);
	const open = entry('resource', 11, 2, CRYSTAL);
	const plan = { objects: [cavern, hidden, open], openMask: new Uint8Array(W * H).fill(1) };
	const blocked = blockedOf(plan);
	const r = declipPictures(plan, W, H, 0, blocked, blockingCells, footprintCells, ROOTS);
	assert.strictEqual(r.moved, 1);
	assert.ok(Math.max(Math.abs(hidden.x - 5), Math.abs(hidden.y - 5)) <= 2, `beside where it stood: now (${hidden.x},${hidden.y})`);
	assert.ok(!(hidden.x === 5 && hidden.y === 5), 'it left the hidden tile');
	assert.ok(blocked[hidden.y * W + hidden.x] & 1, 'its new tile is marked');
	assert.ok(!(blocked[5 * W + 5] & 1), 'its old tile is free');
	assert.deepStrictEqual([open.x, open.y], [11, 2], 'a crystal in the open stays as placed');
	// run again: nothing is half hidden any more
	assert.deepStrictEqual(declipPictures(plan, W, H, 0, blocked, blockingCells, footprintCells, ROOTS), { moved: 0, left: 0 });
});

test('a guarded crystal moves only inside its guard\'s ring', { skip: !readable && 'sprites not in the suite install' }, () => {
	const cavern = entry('mine', 6, 6, CAVERN);
	const hidden = entry('resource', 5, 5, CRYSTAL);
	const guard = entry('randomMonsterLevel1', 4, 4, FILL_TYPES.creeps[0].tpl, 'guard');   // its ring (3..5, 3..5) holds the crystal's tile
	const plan = { objects: [cavern, hidden, guard], openMask: new Uint8Array(W * H).fill(1) };
	const r = declipPictures(plan, W, H, 0, blockedOf(plan), blockingCells, footprintCells, ROOTS);
	assert.strictEqual(r.moved + r.left, 1);
	assert.ok(Math.max(Math.abs(hidden.x - 4), Math.abs(hidden.y - 4)) <= 1, `still inside the guard's ring: (${hidden.x},${hidden.y})`);
});

test('a crystal with no free tile beside it stays; a sprite that cannot be read moves nothing', { skip: !readable && 'sprites not in the suite install' }, () => {
	const cavern = entry('mine', 6, 6, CAVERN);
	const hidden = entry('resource', 5, 5, CRYSTAL);
	const openMask = new Uint8Array(W * H);
	openMask[5 * W + 5] = 1;
	const plan = { objects: [cavern, hidden], openMask };
	assert.deepStrictEqual(declipPictures(plan, W, H, 0, blockedOf(plan), blockingCells, footprintCells, ROOTS), { moved: 0, left: 1 });
	const plan2 = { objects: [entry('mine', 6, 6, CAVERN), entry('resource', 5, 5, CRYSTAL)], openMask: new Uint8Array(W * H).fill(1) };
	assert.deepStrictEqual(declipPictures(plan2, W, H, 0, blockedOf(plan2), blockingCells, footprintCells, []), { moved: 0, left: 0 });
});
