/**
 * road-corners-k.test.js - K, 2026-10-16, his 144x144 six players seed 2042393645: "roads still ending randomly" (the Template Factory's
 * TICKET-003: road tiles that touch only at a corner, drawn by the game as two dead ends; 222 of 346 frozen maps had one). gateroad.js:
 * the last closeDiagonalSteps (allowBlock) joins a step even where only a 2x2 patch can, and takes up a short arm past a step no tile can
 * join; roadNubs takes up a one-tile stub beside a road that runs on past it, and leaves a plain road end alone.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { closeDiagonalSteps, roadNubs } = require('../src/biome/gateroad');
const { blockingCells, visitableCells, allowedDirs } = require('../src/biome/content');

const W = 12, H = 8;
const idx = (x, y) => y * W + x;
const corners = R => { let n = 0; for (const c of R) { const x = c % W, y = (c / W) | 0; for (const [dx, dy] of [[1, 1], [1, -1]]) { const m = idx(x + dx, y + dy); if (x + dx < W && y + dy >= 0 && y + dy < H && R.has(m) && !R.has(idx(x + dx, y)) && !R.has(idx(x, y + dy))) n++; } } return n; };

test('the last diagonal pass joins a step that only a 2x2 patch can join (the road past the guard of K\'s monolith)', () => {
	// two straight roads, row 3 x 0..3 and row 4 x 5..11, joined by a dip at (4,5): (3,4) and (5,4) are free, but each makes a 2x2 with
	// the parallel row 3 road (row 3 x 2..3 above, as round the monolith's door)
	const R = new Set();
	for (let x = 0; x <= 3; x++) R.add(idx(x, 4));
	for (let x = 5; x <= 11; x++) R.add(idx(x, 4));
	for (let x = 2; x <= 4; x++) R.add(idx(x, 3));
	R.add(idx(4, 5));
	const plan = { roadCells: R, objects: [], zone: null };
	const blocked = new Uint8Array(W * H);
	const before = corners(R);
	assert.ok(before > 0, `the setup has corner steps (${before})`);
	const strict = closeDiagonalSteps({ roadCells: new Set(R), objects: [], zone: null }, W, H, 0, blocked, 1, blockingCells);
	const loose = closeDiagonalSteps(plan, W, H, 0, blocked, 1, blockingCells, { allowBlock: true });
	assert.ok(loose.closed >= strict.closed, `allowBlock joins at least as many (${loose.closed} against ${strict.closed})`);
	assert.strictEqual(corners(plan.roadCells), 0, 'no corner step is left');
});

test('a step no tile beside can join loses the short arm past it', () => {
	// road row 2 x 0..5, then a step (5,2)-(6,3) and an arm (6,3),(7,3); the two tiles beside the step, (6,2) and (5,3), are blocked
	const R = new Set();
	for (let x = 0; x <= 5; x++) R.add(idx(x, 2));
	R.add(idx(6, 3)); R.add(idx(7, 3));
	const blocked = new Uint8Array(W * H);
	blocked[idx(6, 2)] = 1; blocked[idx(5, 3)] = 1;
	const plan = { roadCells: R, objects: [], zone: null };
	const out = closeDiagonalSteps(plan, W, H, 0, blocked, 1, blockingCells, { allowBlock: true });
	assert.strictEqual(out.armsCut, 1);
	assert.ok(!R.has(idx(6, 3)) && !R.has(idx(7, 3)) && R.has(idx(5, 2)), 'the arm went, the road stayed');
	assert.strictEqual(corners(R), 0);
});

test('roadNubs takes up a one-tile stub beside a running road and leaves a plain end', () => {
	const R = new Set();
	for (let x = 0; x <= 9; x++) R.add(idx(x, 4));
	R.add(idx(4, 5));                // a stub below the road: one side on (4,4), corners (3,4) and (5,4) on the road
	R.add(idx(10, 3));               // a plain end past the road's end at a corner? no: (10,3) meets (9,4) at a corner only
	const plan = { roadCells: R, objects: [], zone: null };
	const out = roadNubs(plan, W, H, 0, visitableCells, allowedDirs);
	assert.ok(!R.has(idx(4, 5)), 'the stub went');
	assert.ok(R.has(idx(0, 4)) && R.has(idx(9, 4)), 'the road\'s own ends stay');
	assert.ok(R.has(idx(10, 3)), 'a tile with no side on the road is not a stub (the corner pass and the trim judge it)');
	assert.strictEqual(out.cut, 1);
});

// the pairwise grid's corner steps left on arch-c101 (status\FROM-MAP-VISION.md): a road squeezed past a building's body by the cave wall,
// and a road end on a portal's own tile met from its guard at a corner
const longArm = () => { const R = new Set(); for (let x = 0; x <= 5; x++) R.add(idx(x, 2)); for (let x = 6; x <= 11; x++) R.add(idx(x, 3)); return R; };

test('underground, the rock beside a step is dug out when only the step\'s own zone touches it', () => {
	const R = longArm(), om = new Uint8Array(W * H), zone = new Int16Array(W * H);
	for (const c of R) om[c] = 1;
	om[idx(6, 2)] = 1;
	const blocked = new Uint8Array(W * H); blocked[idx(6, 2)] = 1;        // a building's body on one side, rock (5,3) on the other
	const plan = { roadCells: R, objects: [], zone, openMask: om };
	const out = closeDiagonalSteps(plan, W, H, 0, blocked, 1, blockingCells, { allowBlock: true });
	assert.strictEqual(out.carved, 1);
	assert.ok(om[idx(5, 3)] && R.has(idx(5, 3)), 'the rock tile is floor and road');
	assert.strictEqual(corners(R), 0);
});

test('the rock is left where digging it would open a way into another zone', () => {
	const R = longArm(), om = new Uint8Array(W * H), zone = new Int16Array(W * H);
	for (const c of R) om[c] = 1;
	om[idx(6, 2)] = 1; om[idx(4, 4)] = 1; zone[idx(4, 4)] = 1;          // another zone's floor at a corner of the rock tile
	const blocked = new Uint8Array(W * H); blocked[idx(6, 2)] = 1;
	const plan = { roadCells: R, objects: [], zone, openMask: om };
	const out = closeDiagonalSteps(plan, W, H, 0, blocked, 1, blockingCells, { allowBlock: true });
	assert.ok(!out.carved, 'nothing dug');
	assert.ok(!om[idx(5, 3)] && !R.has(idx(5, 3)));
});

test('a road end on an object\'s own tile met at a corner only comes off it', () => {
	const R = new Set([idx(5, 2)]); for (let x = 6; x <= 11; x++) R.add(idx(x, 3));
	const water = new Uint8Array(W * H).fill(1);
	for (const c of R) water[c] = 0;
	const blocked = new Uint8Array(W * H); blocked[idx(5, 2)] = 1; blocked[idx(6, 2)] = 1; water[idx(6, 2)] = 0;   // the portal's tile and body; sea on the other side
	const plan = { roadCells: R, objects: [], zone: null, p: { water } };
	const out = closeDiagonalSteps(plan, W, H, 0, blocked, 1, blockingCells, { allowBlock: true });
	assert.strictEqual(out.endsOff, 1);
	assert.ok(!R.has(idx(5, 2)) && R.has(idx(6, 3)), 'the end came off the portal\'s tile, the road to it stays');
	assert.strictEqual(corners(R), 0);
});

test('a one-tile road on a portal\'s side door beside a road past its bottom door goes; a lone road to a side door stays', () => {
	const { sideDoorStubs } = require('../src/biome/gateroad');
	const mono = { type: 'monolithTwoWay', x: 5, y: 3, l: 0, template: { mask: ['B', 'A'], visitableFrom: ['---', '+-+', '+++'] } };
	const R = new Set(); for (let x = 0; x <= 11; x++) R.add(idx(x, 4));
	R.add(idx(4, 3));                                   // K's (44,98): up from the road onto the portal's left door
	R.add(idx(5, 3));                                   // and the portal's own tile carries road, as on K's map
	const out = sideDoorStubs({ roadCells: R, objects: [mono] }, W, H, 0, visitableCells, allowedDirs);
	assert.strictEqual(out.cut, 1);
	assert.ok(!R.has(idx(4, 3)) && R.has(idx(4, 4)), 'the side-door stub went, the road past the bottom door stayed');
	// the only road to the portal comes in at its side door: it stays
	const R2 = new Set(); for (let x = 0; x <= 4; x++) R2.add(idx(x, 3));
	const out2 = sideDoorStubs({ roadCells: R2, objects: [mono] }, W, H, 0, visitableCells, allowedDirs);
	assert.strictEqual(out2.cut, 0);
	assert.ok(R2.has(idx(4, 3)));
});

test('a town\'s front tile keeps its road even with road on a side door', () => {
	const { sideDoorStubs } = require('../src/biome/gateroad');
	const town = { type: 'town', x: 5, y: 3, l: 0, template: { mask: ['BB', 'BA'], visitableFrom: ['---', '+-+', '+++'] } };
	const R = new Set([idx(5, 4), idx(6, 4), idx(7, 4), idx(8, 4)]);   // front (5,4) and a side door (6,4) both on the road, which ends at the front
	const out = sideDoorStubs({ roadCells: R, objects: [town] }, W, H, 0, visitableCells, allowedDirs);
	assert.ok(R.has(idx(5, 4)), 'the front stays');
	assert.strictEqual(out.cut, 0);
});

test('a doorway road stepping down a shore round its guard is linked straight to the guard (Mediterranean 108 seed 9)', () => {
	// road row 2 x0..2, then (3,3) and (4,4) down the shore; the guard's road (5,2),(5,3),(5,4) and on east. (3,2) is free ground; (3,4) and
	// (4,3) can carry no road (the sea, an oak on the zone line)
	const R = new Set([idx(0, 2), idx(1, 2), idx(2, 2), idx(3, 3), idx(4, 4), idx(5, 2), idx(5, 3), idx(5, 4), idx(6, 4), idx(7, 4), idx(8, 4), idx(9, 4), idx(10, 4)]);
	for (const [x, y] of [[0, 1], [0, 0], [1, 0], [2, 0], [3, 0]]) R.add(idx(x, y));   // the west road runs on (on the map it is long: no arm to take up)
	const water = new Uint8Array(W * H); for (let x = 0; x < W; x++) for (let y = 5; y < H; y++) water[idx(x, y)] = 1;
	water[idx(3, 4)] = 1; water[idx(2, 3)] = 1; water[idx(2, 4)] = 1; water[idx(4, 5)] = 1;
	const blocked = new Uint8Array(W * H); blocked[idx(4, 3)] = 1; blocked[idx(4, 2)] = 1; blocked[idx(4, 1)] = 1; blocked[idx(3, 1)] = 1;
	const plan = { roadCells: R, objects: [], zone: null, p: { water } };
	closeDiagonalSteps(plan, W, H, 0, blocked, 1, blockingCells, { allowBlock: true });
	assert.strictEqual(corners(R), 0, 'no corner step left');
	assert.ok(R.has(idx(0, 2)) && R.has(idx(10, 4)), 'both ends of the road stay');
	// one piece by side steps
	const seen = new Set([idx(0, 2)]), q = [idx(0, 2)];
	for (let h = 0; h < q.length; h++) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const x = q[h] % W + dx, y = ((q[h] / W) | 0) + dy, t = idx(x, y); if (x >= 0 && y >= 0 && x < W && y < H && R.has(t) && !seen.has(t)) { seen.add(t); q.push(t); } }
	assert.ok(seen.has(idx(10, 4)), 'the road is one piece by side steps');
});

// the pairwise grid's corner steps left on 6d0e908 (2026-10-17): a road reaching a gate's door from behind, and a road squeezed between a
// town's corner and the shore
const gate = (x, y) => ({ type: 'subterraneanGate', x, y, l: 0, template: { mask: ['VVVV', 'VVBV', 'VBAB'], visitableFrom: ['---', '+-+', '+++'] } });
const gateRoad = long => {
	// the gate's door (6,4), its body (5,4), (7,4) and (6,3); the road comes in at (7,3) above the door's corner; rock below the door but (7,5)
	const R = new Set([idx(6, 4)]); for (let x = 7; x <= 11; x++) R.add(idx(x, 3));
	if (long) for (let y = 0; y < H; y++) R.add(idx(11, y));
	const blocked = new Uint8Array(W * H);
	for (const [x, y] of [[5, 4], [6, 4], [7, 4], [6, 3], [5, 5], [6, 5], [4, 5]]) blocked[idx(x, y)] = 1;
	return { R, blocked, plan: { roadCells: R, objects: [gate(7, 4)], zone: null } };
};

test('a road that meets a gate\'s door from behind is led to a tile the door is entered from, and the door gives up its road', () => {
	const { R, blocked, plan } = gateRoad(true);
	const out = closeDiagonalSteps(plan, W, H, 0, blocked, 1, blockingCells, { allowBlock: true, visitOf: visitableCells, dirsOf: allowedDirs });
	assert.strictEqual(out.doorsOff, 1);
	assert.ok(!R.has(idx(6, 4)) && R.has(idx(7, 5)), 'the road ends before the door, on the tile it is entered from');
	assert.strictEqual(corners(R), 0);
	// without the door's own data (an older caller) nothing changes there
	const g2 = gateRoad(true);
	closeDiagonalSteps(g2.plan, W, H, 0, g2.blocked, 1, blockingCells, { allowBlock: true });
	assert.ok(g2.R.has(idx(6, 4)), 'no door data, the door keeps its road');
});

test('a gate at the end of a short road keeps its door\'s road', () => {
	const { R, blocked, plan } = gateRoad(false);
	const out = closeDiagonalSteps(plan, W, H, 0, blocked, 1, blockingCells, { allowBlock: true, visitOf: visitableCells, dirsOf: allowedDirs });
	assert.ok(!out.doorsOff && R.has(idx(6, 4)), 'the door kept its road');
	assert.ok(!R.has(idx(7, 5)), 'and the link to the front was taken back');
});

test('a shore tile beside a step between a town\'s corner and the sea becomes land for the road; not where another zone\'s ground touches it', () => {
	const make = () => {
		const R = new Set(); for (let x = 0; x <= 4; x++) R.add(idx(x, 3)); for (let x = 5; x <= 11; x++) R.add(idx(x, 4));
		const water = new Uint8Array(W * H); for (let x = 0; x < W; x++) for (let y = 5; y < H; y++) water[idx(x, y)] = 1;
		for (let x = 0; x <= 4; x++) water[idx(x, 4)] = 1;
		const blocked = new Uint8Array(W * H); blocked[idx(5, 3)] = 1; blocked[idx(5, 2)] = 1; blocked[idx(6, 3)] = 1; blocked[idx(6, 2)] = 1;   // the town's corner
		return { R, water, blocked, zone: new Int16Array(W * H) };
	};
	const a = make();
	const out = closeDiagonalSteps({ roadCells: a.R, objects: [], zone: a.zone, p: { water: a.water } }, W, H, 0, a.blocked, 1, blockingCells, { allowBlock: true });
	assert.strictEqual(out.filled, 1);
	assert.ok(!a.water[idx(4, 4)] && a.R.has(idx(4, 4)), 'the shore tile is land and road');
	assert.strictEqual(corners(a.R), 0);
	const b = make(); b.zone[idx(3, 3)] = 1;
	const out2 = closeDiagonalSteps({ roadCells: b.R, objects: [], zone: b.zone, p: { water: b.water } }, W, H, 0, b.blocked, 1, blockingCells, { allowBlock: true });
	assert.ok(!out2.filled && b.water[idx(4, 4)], 'another zone\'s ground beside it: the water stays');
});

test('the shore fill leaves a coastal town\'s own boat tiles (the Reviewer\'s pass 127)', () => {
	// the shore setup above; a town whose door is (5,2), so (4,4) is its boat tile (CGTownInstance::getOutOffsets: door plus (-1,+2), (+1,+2))
	const R = new Set(); for (let x = 0; x <= 4; x++) R.add(idx(x, 3)); for (let x = 5; x <= 11; x++) R.add(idx(x, 4));
	const water = new Uint8Array(W * H); for (let x = 0; x < W; x++) for (let y = 5; y < H; y++) water[idx(x, y)] = 1;
	for (let x = 0; x <= 4; x++) water[idx(x, 4)] = 1;
	const blocked = new Uint8Array(W * H); blocked[idx(5, 3)] = 1; blocked[idx(5, 2)] = 1; blocked[idx(6, 3)] = 1; blocked[idx(6, 2)] = 1;
	const town = { type: 'town', x: 5, y: 2, l: 0, template: { mask: ['BA'], visitableFrom: ['---', '+-+', '+++'] } };
	const out = closeDiagonalSteps({ roadCells: R, objects: [town], zone: new Int16Array(W * H), p: { water } }, W, H, 0, blocked, 1, blockingCells, { allowBlock: true, visitOf: visitableCells, dirsOf: allowedDirs });
	assert.ok(!out.filled, 'nothing filled');
	assert.ok(water[idx(4, 4)], 'the town\'s boat tile stays water');
});

test('a road on the map\'s outermost row moves a tile in (the Reviewer\'s pass 129, the lead\'s rim order)', () => {
	// a road along row 0 from x 2 to 8, met by roads coming up at x 2 and x 8 from row 3; row 1 is free floor
	const R = new Set(); for (let x = 2; x <= 8; x++) R.add(idx(x, 0)); for (let y = 1; y <= 3; y++) { R.add(idx(2, y)); R.add(idx(8, y)); }
	const blocked = new Uint8Array(W * H);
	const out = closeDiagonalSteps({ roadCells: R, objects: [], zone: null }, W, H, 0, blocked, 1, blockingCells, { allowBlock: true, rimIn: true });
	assert.ok(out.rimIn >= 5, 'tiles moved in (' + out.rimIn + ')');
	assert.ok([...R].every(c => ((c / W) | 0) > 0), 'no road on row 0');
	const seen = new Set([idx(2, 3)]), q = [idx(2, 3)];
	for (let h = 0; h < q.length; h++) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const x = q[h] % W + dx, y = ((q[h] / W) | 0) + dy, u = idx(x, y); if (x >= 0 && y >= 0 && x < W && y < H && R.has(u) && !seen.has(u)) { seen.add(u); q.push(u); } }
	assert.ok(seen.has(idx(8, 3)), 'the road is one piece by side steps');
	// without rimIn nothing moves
	const R2 = new Set(); for (let x = 2; x <= 8; x++) R2.add(idx(x, 0)); for (let y = 1; y <= 3; y++) { R2.add(idx(2, y)); R2.add(idx(8, y)); }
	closeDiagonalSteps({ roadCells: R2, objects: [], zone: null }, W, H, 0, new Uint8Array(W * H), 1, blockingCells, { allowBlock: true });
	assert.ok(R2.has(idx(5, 0)), 'the old rule keeps it');
});
